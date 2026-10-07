import type { SessionRunOptionChoice } from "./session-run-options.js";

/**
 * Pre-start choices for providers whose authoritative inventory is only
 * available after a session begins. Keep the display names current when the
 * provider client is upgraded. The default model uses its exact provider ID so
 * launch provenance records the requested model without alias resolution.
 */
export const DEFAULT_CLAUDE_CODE_MODEL = "claude-opus-5-5";

export const CLAUDE_CODE_BOOTSTRAP_MODELS = [
  { value: "fable", label: "Fable 5.1" },
  { value: DEFAULT_CLAUDE_CODE_MODEL, label: "Opus 5.5" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "haiku", label: "Haiku 4.5" },
] satisfies readonly SessionRunOptionChoice[];

export const CLAUDE_CODE_BOOTSTRAP_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
].map((value) => ({
  value,
  label: value === "xhigh" ? "Extra high" : value[0].toUpperCase() + value.slice(1),
})) satisfies readonly SessionRunOptionChoice[];
