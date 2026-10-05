/** Billing metadata retained for historical Claude sessions and user-launched tools. */
export function isClaudeCommand(command: string | null | undefined): boolean {
  return typeof command === "string" && command.trim().toLowerCase() === "claude";
}

export type AnthropicBillingMode = "api_key" | "subscription";

export interface AnthropicBillingPosture {
  mode: AnthropicBillingMode;
  /** Env var that decided the posture, when one did. */
  source: string | null;
  note: string;
}

const API_KEY_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export function describeAnthropicBilling(
  env: Record<string, string | undefined> = process.env,
): AnthropicBillingPosture {
  const source = API_KEY_ENV_KEYS.find((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (source) {
    return {
      mode: "api_key",
      source,
      note:
        `${source} is set in the daemon environment, so this Claude session bills to ` +
        "the Anthropic API, not to a Claude subscription.",
    };
  }
  return {
    mode: "subscription",
    source: null,
    note:
      "No Anthropic API key in the daemon environment; this Claude session uses the " +
      "local Claude Code credentials and their subscription limits.",
  };
}
