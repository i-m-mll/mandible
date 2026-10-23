import * as z from "zod";
import { DOMAIN_EVENTS, SESSION_EXECUTION_STATE_SCHEMA, type SessionExecutionObservation, type SessionExecutionProvider, type SessionExecutionState } from "./contracts.js";
import type { Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { broadcast } from "./sse.js";

const nativeText = z.string().min(1).max(256).refine((value) => value.trim().length > 0);
const optionalText = z.string().nullable().optional();
const envelope = z.object({
  provider: z.enum(["claude", "codex"]), session_id: nativeText,
  hook_event_name: nativeText, turn_id: nativeText.nullable().optional(),
  source: nativeText.nullable().optional(), reason: optionalText,
  agent_id: nativeText.nullable().optional(), error: nativeText.optional(),
  error_details: optionalText, last_assistant_message: optionalText,
});
export type ExternalExecutionPayload = z.infer<typeof envelope>;
export type ExecutionTransition = Pick<SessionExecutionObservation, "provider" | "provider_session_id" | "event" | "turn_id" | "state"> & (
  | { source: "claude_hook" | "codex_hook"; controller_instance_id?: never; controller_generation?: never }
  | { source: "claude_sdk_hook" | "codex_app_server"; controller_instance_id: string; controller_generation: number }
) & { preserve_existing?: boolean };
export type ExecutionWriteResult =
  | { status: "applied" | "unchanged" | "handled_by_managed_observer"; observation: SessionExecutionObservation | null }
  | { status: "stale_controller"; observation: SessionExecutionObservation | null };

/** Pure provider hook mapping, also used by the SDK callbacks. */
export function mapSessionExecutionHook(payload: unknown):
  { ok: true; value: ExecutionTransition; ignored: boolean } | { ok: false; error: string } {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) return { ok: false, error: "invalid_execution_payload" };
  const p = parsed.data;
  let state: SessionExecutionState;
  switch (p.hook_event_name) {
    case "SessionStart":
      if (p.source && !["startup", "resume", "clear", "fork", "compact"].includes(p.source)) return { ok: false, error: "invalid_session_start_source" };
      state = { kind: "unknown" }; break;
    case "UserPromptSubmit": state = { kind: "working" }; break;
    case "Stop": state = { kind: "stopped" }; break;
    case "SessionEnd": state = { kind: "ended", reason: p.reason ?? null }; break;
    case "Interrupt":
      if (p.provider !== "codex") return { ok: false, error: "unsupported_execution_event" };
      state = { kind: "interrupted" }; break;
    case "StopFailure":
      if (p.provider !== "claude" || !p.error?.trim()) return { ok: false, error: "invalid_failure_payload" };
      state = { kind: "failure", error: { type: p.error, details: p.error_details ?? null, message: p.last_assistant_message ?? null, data: null } }; break;
    default: return { ok: false, error: "unsupported_execution_event" };
  }
  return { ok: true, ignored: !!p.agent_id && p.agent_id !== p.session_id, value: {
    provider: p.provider, provider_session_id: p.session_id,
    source: p.provider === "claude" ? "claude_hook" : "codex_hook",
    event: p.hook_event_name, turn_id: p.turn_id ?? null, state,
    preserve_existing: p.hook_event_name === "SessionStart" && p.source === "compact",
  } };
}

export class SessionExecutionStore {
  constructor(private readonly db: Db) {}

  read(provider: SessionExecutionProvider, sessionId: string): SessionExecutionObservation | null {
    if (!tableExists(this.db, "provider_session_execution")) return null;
    const row = this.db.prepare("SELECT * FROM provider_session_execution WHERE provider = ? AND provider_session_id = ?").get(provider, sessionId) as {
      provider: SessionExecutionProvider; provider_session_id: string; source: SessionExecutionObservation["source"];
      controller_instance_id: string | null; controller_generation: number | null; state_json: string;
      native_event: string; native_turn_id: string | null; observed_at: number;
    } | undefined;
    if (!row) return null;
    return { provider: row.provider, provider_session_id: row.provider_session_id, source: row.source,
      controller_instance_id: row.controller_instance_id, controller_generation: row.controller_generation,
      state: SESSION_EXECUTION_STATE_SCHEMA.parse(JSON.parse(row.state_json)), event: row.native_event,
      turn_id: row.native_turn_id, observed_at: row.observed_at };
  }

  apply(input: ExecutionTransition): ExecutionWriteResult {
    const result = this.db.transaction((): ExecutionWriteResult => {
      const previous = this.read(input.provider, input.provider_session_id);
      const owner = this.db.prepare(`SELECT controller_instance_id, generation FROM conversation_control_state
        WHERE provider IN (?, ?) AND provider_session_id = ? AND owner_kind = 'mandible'`).get(
        input.provider, input.provider === "claude" ? "claude_code" : "codex", input.provider_session_id,
      ) as { controller_instance_id: string; generation: number } | undefined;
      const managed = input.source === "claude_sdk_hook" || input.source === "codex_app_server";
      if (!managed && owner) return { status: "handled_by_managed_observer", observation: previous };
      if (managed && (!owner || owner.controller_instance_id !== input.controller_instance_id || owner.generation !== input.controller_generation)) {
        return { status: "stale_controller", observation: previous };
      }
      if ((input.provider === "claude") !== input.source.startsWith("claude")) throw new Error("Execution source/provider mismatch");
      nativeText.parse(input.provider_session_id);
      nativeText.parse(input.event);
      const sameRuntime = previous?.source === input.source
        && previous.controller_instance_id === (input.controller_instance_id ?? null)
        && previous.controller_generation === (input.controller_generation ?? null);
      const state = SESSION_EXECUTION_STATE_SCHEMA.parse(input.preserve_existing && sameRuntime ? previous!.state : input.state);
      const observation: SessionExecutionObservation = { provider: input.provider, provider_session_id: input.provider_session_id,
        source: input.source, controller_instance_id: input.controller_instance_id ?? null, controller_generation: input.controller_generation ?? null,
        state, event: input.event, turn_id: input.turn_id, observed_at: Date.now() };
      if (previous && JSON.stringify({ ...previous, observed_at: 0 }) === JSON.stringify({ ...observation, observed_at: 0 })) return { status: "unchanged", observation: previous };
      this.db.prepare(`INSERT INTO provider_session_execution
        (provider, provider_session_id, source, controller_instance_id, controller_generation, state_json, native_event, native_turn_id, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, provider_session_id) DO UPDATE SET source=excluded.source,
        controller_instance_id=excluded.controller_instance_id, controller_generation=excluded.controller_generation,
        state_json=excluded.state_json, native_event=excluded.native_event, native_turn_id=excluded.native_turn_id, observed_at=excluded.observed_at`).run(
        observation.provider, observation.provider_session_id, observation.source, observation.controller_instance_id,
        observation.controller_generation, JSON.stringify(state), observation.event, observation.turn_id, observation.observed_at,
      );
      return { status: "applied", observation };
    })();
    if (result.status === "applied" && result.observation) broadcast(DOMAIN_EVENTS.SESSION_EXECUTION_UPDATED, {
      provider: input.provider, provider_session_id: input.provider_session_id, observation: result.observation,
    });
    return result;
  }
}

export function readSessionExecution(db: Db, provider: string | null, sessionId: string | null): SessionExecutionObservation | null {
  const normalized = provider === "claude_code" ? "claude" : provider;
  return sessionId && (normalized === "claude" || normalized === "codex") ? new SessionExecutionStore(db).read(normalized, sessionId) : null;
}
