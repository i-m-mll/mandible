type JsonRecord = Record<string, unknown>;

export type UsageProvenance =
  | "codex_token_count"
  | "claude_statusline"
  | "claude_transcript";

export type CurrentContext =
  | {
      availability: "available";
      precision: "exact" | "approximate";
      percent: number;
      usedTokens?: number;
    }
  | {
      availability: "unavailable";
      reason: string;
    };

export type TokenAccounting = {
  scope: "task_total" | "latest_usage" | "statusline_total" | "message";
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export type NormalizedUsageTelemetry = {
  provider: "codex" | "claude";
  provenance: UsageProvenance;
  currentContext: CurrentContext;
  modelWindowTokens?: number;
  model?: string;
  accounting: TokenAccounting[];
  currentUsage?: TokenAccounting;
};

const CODEX_OCCUPANCY_UNAVAILABLE =
  "Codex token_count reports cumulative accounting and model capacity, not resident context occupancy.";
const CLAUDE_TRANSCRIPT_OCCUPANCY_UNAVAILABLE =
  "Claude transcript usage is message accounting; current context requires statusline telemetry.";

export function normalizeCodexTokenCount(event: unknown): NormalizedUsageTelemetry | undefined {
  const payload = isRecord(event) ? event : {};
  const info = isRecord(payload.info) ? payload.info : payload;
  const total = usageAccounting(info.total_token_usage, "task_total");
  const latest = usageAccounting(info.last_token_usage ?? info.last, "latest_usage");
  const modelWindowTokens = positiveInteger(info.model_context_window)
    ?? positiveInteger(info.context_window)
    ?? positiveInteger(info.context_window_tokens);
  if (!total && !latest && !modelWindowTokens) return undefined;
  return {
    provider: "codex",
    provenance: "codex_token_count",
    currentContext: {
      availability: "unavailable",
      reason: CODEX_OCCUPANCY_UNAVAILABLE,
    },
    ...(modelWindowTokens ? { modelWindowTokens } : {}),
    accounting: [total, latest].filter((value): value is TokenAccounting => Boolean(value)),
  };
}

export function normalizeClaudeTranscriptUsage(
  usage: unknown,
  model: string | null | undefined,
): NormalizedUsageTelemetry | undefined {
  const accounting = usageAccounting(usage, "message", true);
  if (!accounting) return undefined;
  return {
    provider: "claude",
    provenance: "claude_transcript",
    currentContext: {
      availability: "unavailable",
      reason: CLAUDE_TRANSCRIPT_OCCUPANCY_UNAVAILABLE,
    },
    ...(model ? { model } : {}),
    accounting: [accounting],
  };
}

export function normalizeClaudeStatusline(payload: unknown): NormalizedUsageTelemetry | undefined {
  const root = isRecord(payload) ? payload : {};
  const context = isRecord(root.context_window) ? root.context_window : {};
  const currentUsage = usageAccounting(context.current_usage, "message", true);
  const totalInputTokens = nonNegativeNumber(context.total_input_tokens);
  const totalOutputTokens = nonNegativeNumber(context.total_output_tokens);
  const percent = nonNegativeNumber(context.used_percentage);
  const modelWindowTokens = positiveInteger(context.context_window_size);
  const model = modelName(root.model);
  if (percent === null && totalInputTokens === null && totalOutputTokens === null
      && modelWindowTokens === null && !currentUsage) {
    return undefined;
  }
  const currentContext: CurrentContext = percent === null
    ? { availability: "unavailable", reason: "Claude statusline did not provide used_percentage." }
    : {
        availability: "available",
        precision: "exact",
        percent: clampPercent(percent),
        ...(totalInputTokens === null ? {} : { usedTokens: totalInputTokens }),
      };
  const totals: TokenAccounting | undefined = totalInputTokens === null && totalOutputTokens === null
    ? undefined
    : {
        scope: "statusline_total",
        ...(totalInputTokens === null ? {} : { inputTokens: totalInputTokens }),
        ...(totalOutputTokens === null ? {} : { outputTokens: totalOutputTokens }),
        ...((totalInputTokens ?? 0) + (totalOutputTokens ?? 0) > 0
          ? { totalTokens: (totalInputTokens ?? 0) + (totalOutputTokens ?? 0) }
          : {}),
      };
  return {
    provider: "claude",
    provenance: "claude_statusline",
    currentContext,
    ...(modelWindowTokens ? { modelWindowTokens } : {}),
    ...(model ? { model } : {}),
    accounting: totals ? [totals] : [],
    ...(currentUsage ? { currentUsage } : {}),
  };
}

/** Safely upgrades persisted pre-contract metadata without reviving its occupancy inference. */
export function normalizePersistedUsage(value: unknown): NormalizedUsageTelemetry | undefined {
  const record = isRecord(value) ? value : {};
  if (isNormalizedUsageTelemetry(record)) return record;
  if (record.source === "mirror_exact") {
    const totalTokens = positiveInteger(record.total_tokens) ?? positiveInteger(record.used_tokens);
    const modelWindowTokens = positiveInteger(record.window_tokens);
    return {
      provider: "codex",
      provenance: "codex_token_count",
      currentContext: { availability: "unavailable", reason: CODEX_OCCUPANCY_UNAVAILABLE },
      ...(modelWindowTokens ? { modelWindowTokens } : {}),
      accounting: totalTokens ? [{ scope: "task_total", totalTokens }] : [],
    };
  }
  if (record.source === "mirror_approx") {
    const accounting = usageAccounting({
      total_tokens: record.total_tokens,
      input_tokens: record.used_tokens,
    }, "message");
    return {
      provider: "claude",
      provenance: "claude_transcript",
      currentContext: { availability: "unavailable", reason: CLAUDE_TRANSCRIPT_OCCUPANCY_UNAVAILABLE },
      ...(typeof record.model === "string" ? { model: record.model } : {}),
      accounting: accounting ? [accounting] : [],
    };
  }
  return undefined;
}

function usageAccounting(
  value: unknown,
  scope: TokenAccounting["scope"],
  cacheIsAdditional = false,
): TokenAccounting | undefined {
  const usage = isRecord(value) ? value : null;
  if (!usage) return undefined;
  const inputTokens = nonNegativeNumber(usage.input_tokens);
  const cachedInputTokens = nonNegativeNumber(usage.cached_input_tokens);
  const cacheCreationInputTokens = nonNegativeNumber(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = nonNegativeNumber(usage.cache_read_input_tokens);
  const outputTokens = nonNegativeNumber(usage.output_tokens);
  const reasoningOutputTokens = nonNegativeNumber(usage.reasoning_output_tokens);
  const explicitTotal = nonNegativeNumber(usage.total_tokens ?? usage.total ?? usage.all_tokens);
  const reconstructedTotal = inputTokens === null && outputTokens === null
      && (!cacheIsAdditional || (cacheCreationInputTokens === null && cacheReadInputTokens === null))
    ? null
    : (inputTokens ?? 0) + (outputTokens ?? 0)
      + (cacheIsAdditional ? (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0) : 0);
  const totalTokens = explicitTotal ?? reconstructedTotal;
  if ([inputTokens, cachedInputTokens, cacheCreationInputTokens, cacheReadInputTokens,
    outputTokens, reasoningOutputTokens, totalTokens].every((v) => v === null)) {
    return undefined;
  }
  return {
    scope,
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
    ...(cacheCreationInputTokens === null ? {} : { cacheCreationInputTokens }),
    ...(cacheReadInputTokens === null ? {} : { cacheReadInputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
    ...(reasoningOutputTokens === null ? {} : { reasoningOutputTokens }),
    ...(totalTokens === null ? {} : { totalTokens }),
  };
}

function isNormalizedUsageTelemetry(value: JsonRecord): value is NormalizedUsageTelemetry & JsonRecord {
  return (value.provider === "codex" || value.provider === "claude")
    && typeof value.provenance === "string"
    && isRecord(value.currentContext)
    && Array.isArray(value.accounting);
}

function modelName(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  for (const candidate of [value.display_name, value.name, value.id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function positiveInteger(value: unknown): number | null {
  const parsed = nonNegativeNumber(value);
  return parsed !== null && parsed > 0 ? Math.trunc(parsed) : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
