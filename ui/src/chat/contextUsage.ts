import type { ConversationBlock } from '../api';
import type { StreamEvent } from '../components/stream-renderer/types';
import {
  normalizeClaudeStatusline,
  normalizeClaudeTranscriptUsage,
  normalizeCodexTokenCount,
  normalizePersistedUsage,
  type NormalizedUsageTelemetry,
  type TokenAccounting,
  type UsageProvenance,
} from '../../../src/parsers/context-usage.js';

export type ContextUsageSeverity = 'info' | 'warning' | 'danger';

export type ContextUsage = {
  availability: 'available' | 'unavailable';
  provenance: UsageProvenance;
  percent?: number;
  usedTokens?: number;
  windowTokens?: number;
  precision: 'exact' | 'approximate' | 'unavailable';
  reason?: string;
  model?: string;
  updatedAt?: number;
};

export type UsageRateLimit = {
  label: string;
  usedPercent: number;
  resetsAt?: string | null;
};

export type TokenUsageTotals = {
  label: string;
  scope: 'task_total' | 'latest_usage' | 'statusline_total' | 'message' | 'session';
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type ChatUsageSummary = {
  context: ContextUsage;
  rateLimits: UsageRateLimit[];
  accounting: TokenUsageTotals[];
  sourceLabel: string;
  updatedAt?: number;
};

export type StatuslineTelemetry = {
  telemetry_key?: string;
  console_session_id?: string | null;
  provider_session_id?: string | null;
  transcript_path?: string | null;
  model?: string | null;
  context_window?: {
    total_input_tokens?: number | null;
    total_output_tokens?: number | null;
    used_percentage?: number | null;
    context_window_size?: number | null;
    current_usage?: {
      input_tokens?: number | null;
      output_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    } | null;
  } | null;
  rate_limits?: {
    five_hour?: { used_percentage?: number | null; resets_at?: string | null } | null;
    seven_day?: { used_percentage?: number | null; resets_at?: string | null } | null;
  } | null;
  received_at?: number | null;
};

type UsageRow = Record<string, unknown>;
type NumericAccountingKey =
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'reasoningOutputTokens'
  | 'cacheCreationTokens'
  | 'cacheReadTokens'
  | 'totalTokens'
  | 'costUsd';

const PROVENANCE_LABELS: Record<UsageProvenance, string> = {
  claude_statusline: 'Claude statusline',
  codex_token_count: 'Codex token_count',
  claude_transcript: 'Claude transcript',
};

const PROVENANCE_PRIORITY: Record<UsageProvenance, number> = {
  claude_statusline: 3,
  codex_token_count: 2,
  claude_transcript: 1,
};

export function getContextSeverity(percent: number): ContextUsageSeverity {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'info';
}

export function selectContextUsage(candidates: Array<ContextUsage | undefined | null>): ContextUsage | undefined {
  return candidates
    .filter((candidate): candidate is ContextUsage => Boolean(candidate))
    .sort((a, b) => {
      const available = Number(b.availability === 'available') - Number(a.availability === 'available');
      if (available !== 0) return available;
      const priority = PROVENANCE_PRIORITY[b.provenance] - PROVENANCE_PRIORITY[a.provenance];
      if (priority !== 0) return priority;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    })[0];
}

export function deriveChatUsageSummary(input: {
  telemetry?: StatuslineTelemetry | null;
  events?: StreamEvent[];
  blocks?: ConversationBlock[];
  usageRows?: UsageRow[];
}): ChatUsageSummary | undefined {
  const normalized = selectNormalizedUsage([
    normalizedFromTelemetry(input.telemetry),
    normalizedFromEvents(input.events ?? []),
    normalizedFromBlocks(input.blocks ?? []),
  ]);
  const rateLimits = rateLimitsFromTelemetry(input.telemetry);
  const rowAccounting = accountingFromUsageRows(input.usageRows ?? []);
  if (!normalized && rateLimits.length === 0 && !rowAccounting) return undefined;

  const updatedAt = Math.max(
    numberOrZero(input.telemetry?.received_at),
    latestUsageRowTime(input.usageRows ?? []),
  ) || undefined;
  const context = normalized
    ? contextFromNormalized(normalized, updatedAt)
    : {
        availability: 'unavailable' as const,
        provenance: 'claude_transcript' as const,
        precision: 'unavailable' as const,
        reason: 'No authoritative current-context telemetry is available.',
        updatedAt,
      };
  const accounting = normalized
    ? accountingFromNormalized(normalized)
    : rowAccounting ? [rowAccounting] : [];
  if (rowAccounting && !accounting.some((entry) => entry.scope === 'session')) accounting.push(rowAccounting);
  return {
    context,
    rateLimits,
    accounting,
    sourceLabel: normalized ? PROVENANCE_LABELS[normalized.provenance] : input.telemetry ? 'Claude statusline' : 'Usage records',
    updatedAt,
  };
}

function normalizedFromTelemetry(telemetry: StatuslineTelemetry | null | undefined): NormalizedUsageTelemetry | undefined {
  return telemetry ? normalizeClaudeStatusline(telemetry) : undefined;
}

function normalizedFromEvents(events: StreamEvent[]): NormalizedUsageTelemetry | undefined {
  const candidates: NormalizedUsageTelemetry[] = [];
  for (const event of events) {
    const embedded = usageTelemetryRecord(event);
    const persisted = normalizePersistedUsage(embedded);
    if (persisted) candidates.push(persisted);
    if (event.type === 'assistant' && 'message' in event) {
      const message = (event as { message?: { usage?: unknown; model?: string } }).message;
      const transcript = normalizeClaudeTranscriptUsage(message?.usage, message?.model);
      if (transcript) candidates.push(transcript);
    }
    if (event.type === 'token_count') {
      const codex = normalizeCodexTokenCount(event);
      if (codex) candidates.push(codex);
    }
  }
  return candidates.at(-1);
}

function normalizedFromBlocks(blocks: ConversationBlock[]): NormalizedUsageTelemetry | undefined {
  const candidates: NormalizedUsageTelemetry[] = [];
  for (const block of blocks) {
    const metadata = parseMetadata(block.metadata_json);
    const normalized = normalizePersistedUsage(metadata.usage_telemetry ?? metadata.context_usage);
    if (normalized) candidates.push(normalized);
  }
  return candidates.at(-1);
}

function selectNormalizedUsage(candidates: Array<NormalizedUsageTelemetry | undefined>): NormalizedUsageTelemetry | undefined {
  return candidates
    .filter((candidate): candidate is NormalizedUsageTelemetry => Boolean(candidate))
    .sort((a, b) => {
      const available = Number(b.currentContext.availability === 'available')
        - Number(a.currentContext.availability === 'available');
      if (available !== 0) return available;
      return PROVENANCE_PRIORITY[b.provenance] - PROVENANCE_PRIORITY[a.provenance];
    })[0];
}

function contextFromNormalized(telemetry: NormalizedUsageTelemetry, updatedAt?: number): ContextUsage {
  if (telemetry.currentContext.availability === 'unavailable') {
    return {
      availability: 'unavailable',
      provenance: telemetry.provenance,
      precision: 'unavailable',
      reason: telemetry.currentContext.reason,
      windowTokens: telemetry.modelWindowTokens,
      model: telemetry.model,
      updatedAt,
    };
  }
  return {
    availability: 'available',
    provenance: telemetry.provenance,
    precision: telemetry.currentContext.precision,
    percent: telemetry.currentContext.percent,
    usedTokens: telemetry.currentContext.usedTokens,
    windowTokens: telemetry.modelWindowTokens,
    model: telemetry.model,
    updatedAt,
  };
}

function accountingFromNormalized(telemetry: NormalizedUsageTelemetry): TokenUsageTotals[] {
  const entries = telemetry.accounting.map(accountingSummary);
  if (telemetry.currentUsage) entries.push({ ...accountingSummary(telemetry.currentUsage), label: 'Current request' });
  return entries;
}

function accountingSummary(accounting: TokenAccounting): TokenUsageTotals {
  const label = accounting.scope === 'task_total' ? 'Task total'
    : accounting.scope === 'latest_usage' ? 'Latest reported usage'
      : accounting.scope === 'statusline_total' ? 'Statusline totals'
      : 'Message usage';
  return {
    label,
    scope: accounting.scope,
    inputTokens: accounting.inputTokens,
    outputTokens: accounting.outputTokens,
    cachedInputTokens: accounting.cachedInputTokens,
    cacheCreationTokens: accounting.cacheCreationInputTokens,
    cacheReadTokens: accounting.cacheReadInputTokens,
    reasoningOutputTokens: accounting.reasoningOutputTokens,
    totalTokens: accounting.totalTokens,
  };
}

function rateLimitsFromTelemetry(telemetry: StatuslineTelemetry | null | undefined): UsageRateLimit[] {
  const rateLimits = telemetry?.rate_limits;
  return [
    { label: '5-hour', limit: rateLimits?.five_hour },
    { label: 'Weekly', limit: rateLimits?.seven_day },
  ].flatMap(({ label, limit }) => {
    const usedPercent = numberOrNull(limit?.used_percentage);
    return usedPercent === null ? [] : [{
      label,
      usedPercent: clampPercent(usedPercent),
      resetsAt: limit?.resets_at ?? null,
    }];
  });
}

function accountingFromUsageRows(rows: UsageRow[]): TokenUsageTotals | undefined {
  const totals: TokenUsageTotals = { label: 'Session tokens', scope: 'session' };
  let found = false;
  for (const row of rows) {
    found = addNumber(totals, 'inputTokens', row.input_tokens) || found;
    found = addNumber(totals, 'outputTokens', row.output_tokens) || found;
    found = addNumber(totals, 'cacheCreationTokens', row.cache_creation_input_tokens) || found;
    found = addNumber(totals, 'cacheReadTokens', row.cache_read_input_tokens) || found;
    found = addNumber(totals, 'costUsd', row.cost_usd) || found;
  }
  if (!found) return undefined;
  totals.totalTokens = totalOf([totals.inputTokens, totals.outputTokens]);
  return totals;
}

function latestUsageRowTime(rows: UsageRow[]): number {
  return rows.reduce((latest, row) => Math.max(latest, numberOrZero(row.recorded_at)), 0);
}

function addNumber(target: TokenUsageTotals, key: NumericAccountingKey, raw: unknown): boolean {
  const value = numberOrNull(raw);
  if (value === null) return false;
  target[key] = (target[key] ?? 0) + value;
  return true;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    return recordOrNull(parsed) ?? {};
  } catch {
    return {};
  }
}

function usageTelemetryRecord(value: unknown): unknown {
  const record = recordOrNull(value);
  return record?.usage_telemetry ?? record?.context_usage;
}

function totalOf(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
