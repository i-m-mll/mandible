import type { ProviderAdapterCapabilities, ProviderAdapterMode } from "./types.js";

export type ProviderAdapterProfile = {
  provider: "claude_code" | "codex";
  adapter_id: string;
  capabilities: ProviderAdapterCapabilities;
};

export const CLAUDE_SDK_MANAGED_PROFILE: ProviderAdapterProfile = Object.freeze({
  provider: "claude_code",
  adapter_id: "claude-agent-sdk-v1",
  capabilities: Object.freeze({
    mode: "sdk-managed",
    resume_provider_session: true,
    resume_message_anchor: true,
    send: true,
    steer: false,
    queue: true,
    stop: true,
    remove: false,
    structured_deltas: true,
    lifecycle_callbacks: true,
    permission_callbacks: true,
    terminal_attach: false,
    logs: false,
    initial_message_acceptance: "provider-protocol",
  }),
});

export const CODEX_APP_SERVER_PROFILE: ProviderAdapterProfile = Object.freeze({
  provider: "codex",
  adapter_id: "codex-app-server-v2",
  capabilities: Object.freeze({
    mode: "app-server-managed",
    resume_provider_session: true,
    resume_message_anchor: false,
    send: true,
    steer: true,
    queue: false,
    stop: true,
    remove: false,
    structured_deltas: true,
    lifecycle_callbacks: true,
    permission_callbacks: true,
    terminal_attach: false,
    logs: false,
    initial_message_acceptance: "provider-protocol",
  }),
});

export function defaultProviderMode(provider: "claude_code" | "codex"): ProviderAdapterMode {
  return provider === "claude_code" ? "sdk-managed" : "app-server-managed";
}

export function providerAdapterProfile(
  provider: "claude_code" | "codex",
  mode: ProviderAdapterMode = defaultProviderMode(provider),
): ProviderAdapterProfile | null {
  if (provider === "claude_code" && mode === "sdk-managed") return CLAUDE_SDK_MANAGED_PROFILE;
  if (provider === "codex" && mode === "app-server-managed") return CODEX_APP_SERVER_PROFILE;
  return null;
}
