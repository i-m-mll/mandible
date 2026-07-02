import type { ConversationBlock } from '../api';
import type { StreamEvent } from '../components/stream-renderer/types';

export type ContextUsageSource = 'statusline' | 'mirror_exact' | 'mirror_approx';
export type ContextUsageSeverity = 'info' | 'warning' | 'danger';

export type ContextUsage = {
  source: ContextUsageSource;
  percent: number;
  usedTokens?: number;
  totalTokens?: number;
  windowTokens?: number;
  approximate: boolean;
  model?: string;
  updatedAt?: number;
};

export type UsageRateLimit = {
  label: string;
  usedPercent: number;
  resetsAt?: string | null;
};

export type TokenUsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type ChatUsageSummary = {
  context?: ContextUsage;
  rateLimits: UsageRateLimit[];
  tokenTotals?: TokenUsageTotals;
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
    used_percentage?: number | null;
    context_window_size?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  } | null;
  rate_limits?: {
    five_hour?: { used_percentage?: number | null; resets_at?: string | null } | null;
    seven_day?: { used_percentage?: number | null; resets_at?: string | null } | null;
  } | null;
  received_at?: number | null;
};

type UsageRow = Record<string, unknown>;

const SOURCE_LABELS: Record<ContextUsageSource, string> = {
  statusline: 'Statusline',
  mirror_exact: 'Mirror exact',
  mirror_approx: 'Mirror approximate',
};

const SOURCE_PRIORITY: Record<ContextUsageSource, number> = {
  statusline: 3,
  mirror_exact: 2,
  mirror_approx: 1,
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
      const priority = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
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
  const telemetryContext = contextFromTelemetry(input.telemetry);
  const mirrorContext = selectContextUsage([
    contextFromEvents(input.events ?? []),
    contextFromBlocks(input.blocks ?? []),
  ]);
  const context = selectContextUsage([telemetryContext, mirrorContext]);
  const rateLimits = rateLimitsFromTelemetry(input.telemetry);
  const tokenTotals = tokenTotalsFromTelemetry(input.telemetry)
    ?? tokenTotalsFromUsageRows(input.usageRows ?? [])
    ?? tokenTotalsFromContext(context);

  if (!context && rateLimits.length === 0 && !tokenTotals) {
    return undefined;
  }

  const updatedAt = Math.max(
    context?.updatedAt ?? 0,
    numberOrZero(input.telemetry?.received_at),
    latestUsageRowTime(input.usageRows ?? []),
  ) || undefined;

  return {
    context,
    rateLimits,
    tokenTotals,
    sourceLabel: context ? SOURCE_LABELS[context.source] : input.telemetry ? 'Statusline' : 'Usage',
    updatedAt,
  };
}

function contextFromTelemetry(telemetry: StatuslineTelemetry | null | undefined): ContextUsage | undefined {
  const windowData = telemetry?.context_window;
  const percent = numberOrNull(windowData?.used_percentage);
  if (percent === null) {
    return undefined;
  }
  const inputTokens = numberOrNull(windowData?.input_tokens);
  const cacheCreation = numberOrNull(windowData?.cache_creation_input_tokens) ?? 0;
  const cacheRead = numberOrNull(windowData?.cache_read_input_tokens) ?? 0;
  const usedTokens = inputTokens === null ? undefined : inputTokens + cacheCreation + cacheRead;
  return {
    source: 'statusline',
    percent: clampPercent(percent),
    usedTokens,
    totalTokens: tokenTotal([
      inputTokens,
      windowData?.output_tokens,
      windowData?.cache_creation_input_tokens,
      windowData?.cache_read_input_tokens,
    ]),
    windowTokens: numberOrNull(windowData?.context_window_size) ?? undefined,
    approximate: false,
    model: telemetry?.model ?? undefined,
    updatedAt: numberOrNull(telemetry?.received_at) ?? undefined,
  };
}

function contextFromEvents(events: StreamEvent[]): ContextUsage | undefined {
  const candidates: ContextUsage[] = [];
  for (const event of events) {
    const raw = contextUsageRecord(event);
    if (raw) {
      candidates.push(contextFromRecord(raw, Date.now()));
    }
    if (event.type === 'assistant' && 'message' in event) {
      const message = (event as { message?: { usage?: unknown; model?: string } }).message;
      const approximate = contextFromClaudeUsage(message?.usage, message?.model);
      if (approximate) {
        candidates.push(approximate);
      }
    }
    if (event.type === 'token_count') {
      const exact = contextFromCodexTokenCount(event);
      if (exact) {
        candidates.push(exact);
      }
    }
  }
  return candidates[candidates.length - 1];
}

function contextFromBlocks(blocks: ConversationBlock[]): ContextUsage | undefined {
  const candidates: ContextUsage[] = [];
  for (const block of blocks) {
    const metadata = parseMetadata(block.metadata_json);
    const raw = contextUsageRecord(metadata);
    if (raw) {
      candidates.push(contextFromRecord(raw, block.timestamp ? Date.parse(block.timestamp) : undefined));
    }
  }
  return candidates[candidates.length - 1];
}

function contextFromRecord(raw: Record<string, unknown>, updatedAt?: number): ContextUsage {
  const source = raw.source === 'statusline' || raw.source === 'mirror_exact' || raw.source === 'mirror_approx'
    ? raw.source
    : 'mirror_approx';
  const percent = numberOrNull(raw.percent)
    ?? percentFromTokens(numberOrNull(raw.used_tokens), numberOrNull(raw.window_tokens))
    ?? 0;
  return {
    source,
    percent: clampPercent(percent),
    usedTokens: numberOrNull(raw.used_tokens) ?? undefined,
    totalTokens: numberOrNull(raw.total_tokens) ?? undefined,
    windowTokens: numberOrNull(raw.window_tokens) ?? undefined,
    approximate: raw.approximate === true || source === 'mirror_approx',
    model: typeof raw.model === 'string' ? raw.model : undefined,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
  };
}

function contextFromCodexTokenCount(event: StreamEvent): ContextUsage | undefined {
  const info = recordOrNull((event as { info?: unknown }).info) ?? recordOrNull((event as { payload?: unknown }).payload);
  const usage = recordOrNull(info?.total_token_usage) ?? recordOrNull(info?.token_usage);
  const windowTokens = numberOrNull(info?.model_context_window) ?? numberOrNull(info?.context_window);
  if (!usage || !windowTokens) return undefined;
  const totalTokens =
    numberOrNull(usage.total_tokens)
    ?? tokenTotal([
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens,
      usage.output_tokens,
      usage.reasoning_output_tokens,
    ]);
  if (!totalTokens) return undefined;
  return {
    source: 'mirror_exact',
    percent: clampPercent((totalTokens / windowTokens) * 100),
    usedTokens: totalTokens,
    totalTokens,
    windowTokens,
    approximate: false,
  };
}

export function effectiveClaudeInputTokens(usage: unknown): number | undefined {
  const record = recordOrNull(usage);
  if (!record) return undefined;
  const total = tokenTotal([
    record.input_tokens,
    record.cache_read_input_tokens,
    record.cache_creation_input_tokens,
  ]);
  return total && total > 0 ? total : undefined;
}

function contextFromClaudeUsage(usage: unknown, model: string | undefined): ContextUsage | undefined {
  const usedTokens = effectiveClaudeInputTokens(usage);
  if (!usedTokens) return undefined;
  const windowTokens = claudeContextWindow(model);
  return {
    source: 'mirror_approx',
    percent: clampPercent((usedTokens / windowTokens) * 100),
    usedTokens,
    totalTokens: usedTokens + (numberOrNull(recordOrNull(usage)?.output_tokens) ?? 0),
    windowTokens,
    approximate: true,
    model,
  };
}

function claudeContextWindow(_model: string | undefined): number {
  return 200_000;
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

function tokenTotalsFromTelemetry(telemetry: StatuslineTelemetry | null | undefined): TokenUsageTotals | undefined {
  const context = telemetry?.context_window;
  if (!context) return undefined;
  const totalTokens = tokenTotal([
    context.input_tokens,
    context.output_tokens,
    context.cache_creation_input_tokens,
    context.cache_read_input_tokens,
  ]);
  if (!totalTokens) return undefined;
  return {
    inputTokens: numberOrNull(context.input_tokens) ?? undefined,
    outputTokens: numberOrNull(context.output_tokens) ?? undefined,
    cacheCreationTokens: numberOrNull(context.cache_creation_input_tokens) ?? undefined,
    cacheReadTokens: numberOrNull(context.cache_read_input_tokens) ?? undefined,
    totalTokens,
  };
}

function tokenTotalsFromUsageRows(rows: UsageRow[]): TokenUsageTotals | undefined {
  const totals: TokenUsageTotals = {};
  let found = false;
  for (const row of rows) {
    found = addNumber(totals, 'inputTokens', row.input_tokens) || found;
    found = addNumber(totals, 'outputTokens', row.output_tokens) || found;
    found = addNumber(totals, 'cacheCreationTokens', row.cache_creation_input_tokens) || found;
    found = addNumber(totals, 'cacheReadTokens', row.cache_read_input_tokens) || found;
    found = addNumber(totals, 'costUsd', row.cost_usd) || found;
  }
  if (!found) return undefined;
  totals.totalTokens = tokenTotal([
    totals.inputTokens,
    totals.outputTokens,
    totals.cacheCreationTokens,
    totals.cacheReadTokens,
  ]) ?? undefined;
  return totals;
}

function tokenTotalsFromContext(context: ContextUsage | undefined): TokenUsageTotals | undefined {
  if (!context?.totalTokens) return undefined;
  return { totalTokens: context.totalTokens };
}

function latestUsageRowTime(rows: UsageRow[]): number {
  return rows.reduce((latest, row) => Math.max(latest, numberOrZero(row.recorded_at)), 0);
}

function addNumber(target: TokenUsageTotals, key: keyof TokenUsageTotals, raw: unknown): boolean {
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

function contextUsageRecord(value: unknown): Record<string, unknown> | null {
  const record = recordOrNull(value);
  return recordOrNull(record?.context_usage);
}

function percentFromTokens(used: number | null, windowTokens: number | null): number | null {
  return used !== null && windowTokens !== null && windowTokens > 0 ? (used / windowTokens) * 100 : null;
}

function tokenTotal(values: unknown[]): number | null {
  const total = values.reduce((sum, value) => sum + (numberOrNull(value) ?? 0), 0);
  return total > 0 ? total : null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
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
