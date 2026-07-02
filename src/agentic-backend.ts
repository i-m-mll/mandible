import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { ConsoleSession, ConsoleSessionStatus, ConsoleStreamEvent } from "./types.js";

export type BackendType = "pty" | "sdk" | "spawn" | "acp";
export type PermissionDecision =
  | "deny"
  | "allow"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface PermissionRequest {
  id: string;
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  created_at: number;
  expires_at: number;
  title?: string;
  display_name?: string;
  description?: string;
  blocked_path?: string;
  decision_reason?: string;
  agent_id?: string;
}

export interface BackendStatusEvent {
  kind: "started" | "stopped" | "exit";
  status: ConsoleSessionStatus;
  exitCode?: number;
  signal?: number | string | null;
  started_at?: number | null;
  stopped_at?: number | null;
}

export type BackendMetaUpdate = Partial<
  Pick<
    ConsoleSession,
    | "label"
    | "args"
    | "cwd"
    | "provider_session_id"
    | "cols"
    | "rows"
    | "status"
    | "pid"
    | "exit_code"
    | "started_at"
    | "stopped_at"
    | "updated_at"
    | "allowed_tools"
    | "mandible_session_id"
    | "resume_at_message"
    | "channel_enabled"
  >
>;

export interface AgenticBackend extends EventEmitter {
  readonly id: string;
  meta: ConsoleSession;
  start(): void;
  stop(signal?: string): void;
  destroy(): void;
  clear(): void;
  sendPrompt(text: string): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  addWsClient(ws: WebSocket): void;
  removeWsClient(ws: WebSocket): void;
  getBufferSnapshot(): Buffer;
  getStreamEvents(): ConsoleStreamEvent[];
  ingestStructuredEvent(event: ConsoleStreamEvent): void;
  ingestText(data: string): void;
}

export interface PermissionAwareBackend {
  getPendingPermissions(): PermissionRequest[];
  resolvePermission(requestId: string, decision: PermissionDecision): boolean;
}

export interface ConfigurableBackend<TOptions> {
  updateOptions(options: TOptions): void;
}

export interface UsageAwareBackend<TUsage> {
  getUsage(): TUsage[];
}
