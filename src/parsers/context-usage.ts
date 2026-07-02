import type { BlockMetadata } from "./types.js";

type JsonRecord = Record<string, unknown>;

const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000;

const CLAUDE_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/opus/i, 200_000],
  [/sonnet/i, 200_000],
  [/haiku/i, 200_000],
  [/claude/i, 200_000],
];

export type ClaudeUsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export function effectiveClaudeInputTokens(usage: ClaudeUsageLike | undefined): number | null {
  if (!usage) {
    return null;
  }
  const total =
    finiteNumber(usage.input_tokens) +
    finiteNumber(usage.cache_read_input_tokens) +
    finiteNumber(usage.cache_creation_input_tokens);
  return total > 0 ? total : null;
}

export function claudeContextWindowForModel(model: string | null | undefined): number {
  if (!model) {
    return DEFAULT_CLAUDE_CONTEXT_WINDOW;
  }
  return CLAUDE_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_CLAUDE_CONTEXT_WINDOW;
}

export function buildClaudeApproxContextUsage(
  usage: ClaudeUsageLike | undefined,
  model: string | null | undefined,
): BlockMetadata["context_usage"] | undefined {
  const usedTokens = effectiveClaudeInputTokens(usage);
  if (!usedTokens) {
    return undefined;
  }
  const windowTokens = claudeContextWindowForModel(model);
  return {
    source: "mirror_approx",
    used_tokens: usedTokens,
    total_tokens: usedTokens + finiteNumber(usage?.output_tokens),
    window_tokens: windowTokens,
    percent: clampPercent((usedTokens / windowTokens) * 100),
    approximate: true,
    model: model ?? undefined,
  };
}

export function extractCodexTokenCountContextUsage(event: unknown): BlockMetadata["context_usage"] | undefined {
  const payload = isRecord(event) ? event : {};
  const info = isRecord(payload.info) ? payload.info : payload;
  const usage = isRecord(info.total_token_usage)
    ? info.total_token_usage
    : isRecord(info.token_usage)
      ? info.token_usage
      : null;
  const windowTokens = integerOrNull(info.model_context_window)
    ?? integerOrNull(info.context_window)
    ?? integerOrNull(info.context_window_tokens);
  if (!usage || !windowTokens || windowTokens <= 0) {
    return undefined;
  }
  const totalTokens = totalUsageTokens(usage);
  if (!totalTokens || totalTokens <= 0) {
    return undefined;
  }
  return {
    source: "mirror_exact",
    used_tokens: totalTokens,
    total_tokens: totalTokens,
    window_tokens: windowTokens,
    percent: clampPercent((totalTokens / windowTokens) * 100),
    approximate: false,
  };
}

function totalUsageTokens(usage: JsonRecord): number | null {
  const explicit =
    integerOrNull(usage.total_tokens)
    ?? integerOrNull(usage.total)
    ?? integerOrNull(usage.all_tokens);
  if (explicit !== null) {
    return explicit;
  }
  const total =
    finiteNumber(usage.input_tokens)
    + finiteNumber(usage.cached_input_tokens)
    + finiteNumber(usage.cache_read_input_tokens)
    + finiteNumber(usage.cache_creation_input_tokens)
    + finiteNumber(usage.output_tokens)
    + finiteNumber(usage.reasoning_output_tokens);
  return total > 0 ? total : null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function finiteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function integerOrNull(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed > 0 ? Math.trunc(parsed) : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
