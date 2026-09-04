import type { ConversationControllerAdapter } from "./adapter.js";
import type { ProviderAdapterEvent, ProviderDeliveryReceipt, Result } from "./types.js";
import type { ProviderAdapterProfile } from "./provider-capabilities.js";

/**
 * Narrow handoff owned by provider adapters. The spawn authority owns request
 * idempotency and conversation-shell creation; this contract supplies only the
 * selected provider mode, exact receipts, and provider events.
 */
export type ManagedSpawnAdapterBinding = {
  kind: "managed-controller";
  profile: ProviderAdapterProfile;
  controller: ConversationControllerAdapter;
};

export type ClaudeNativeBackgroundIdentity = {
  provider: "claude_code";
  mode: "native-background";
  provider_session_id: string;
  background_reference: string;
};

export type ClaudeNativeBackgroundAuthority = {
  identity: ClaudeNativeBackgroundIdentity;
  stop(): Promise<Result<void, Error>>;
  remove(): Promise<Result<void, Error>>;
  readLogs(): Promise<Result<readonly string[], Error>>;
  attachTerminal(): Promise<Result<{ attachment_reference: string }, Error>>;
};

export type NativeBackgroundSpawnAdapterBinding = {
  kind: "native-background-attachment";
  profile: ProviderAdapterProfile;
  authority: ClaudeNativeBackgroundAuthority;
};

export type ProviderSpawnAdapterBinding = ManagedSpawnAdapterBinding | NativeBackgroundSpawnAdapterBinding;

export type ProviderSpawnAdapterSink = {
  acceptInitialMessageReceipt(receipt: ProviderDeliveryReceipt): void;
  acceptProviderEvent(event: ProviderAdapterEvent): void;
};
