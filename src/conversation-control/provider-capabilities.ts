import type { ProviderAdapterCapabilities, ProviderAdapterMode } from "./types.js";

export type ProviderAdapterProfile = {
  provider: "claude_code" | "codex";
  adapter_id: string;
  capabilities: ProviderAdapterCapabilities;
};

export const CLAUDE_SDK_MANAGED_PROFILE: ProviderAdapterProfile = Object.freeze({
  provider: "claude_code",
  adapter_id: "claude-stream-json-v1",
  capabilities: Object.freeze({
    mode: "sdk-managed",
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

/**
 * Native-background Claude is an attachment profile, not an SDK controller.
 * The spawn authority may select it explicitly, but must never project SDK
 * streaming, steering, or permission callbacks for this mode.
 */
export const CLAUDE_NATIVE_BACKGROUND_PROFILE: ProviderAdapterProfile = Object.freeze({
  provider: "claude_code",
  adapter_id: "claude-native-background-v1",
  capabilities: Object.freeze({
    mode: "native-background",
    resume_provider_session: false,
    resume_message_anchor: false,
    send: false,
    steer: false,
    queue: false,
    stop: true,
    remove: true,
    structured_deltas: false,
    lifecycle_callbacks: true,
    permission_callbacks: false,
    terminal_attach: true,
    logs: true,
    initial_message_acceptance: "unavailable",
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
  if (provider === "claude_code" && mode === "native-background") return CLAUDE_NATIVE_BACKGROUND_PROFILE;
  if (provider === "codex" && mode === "app-server-managed") return CODEX_APP_SERVER_PROFILE;
  return null;
}
