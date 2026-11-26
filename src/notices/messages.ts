import { randomUUID } from "node:crypto";
import { exactAgentRef, hookAgentIdentity, parseExactAgentRef } from "../ambient-provider-identity.js";
import { DOMAIN_EVENTS, type SessionExecutionObservation, type SessionExecutionState } from "../contracts.js";
import type { Db } from "../db.js";
import { SessionExecutionStore } from "../session-execution.js";
import { broadcast } from "../sse.js";
import { MESSAGE_SIZE, NOTICE_PROVIDERS, type NoticeProvider } from "./contract.js";
import { latestWakeAttempt } from "./wake/reconciler.js";
import type { WakeFailureCode } from "./wake/types.js";

/** The CLI's display form of a message id. */
export function shortMessageId(id: string): string {
  return id.slice(0, 8);
}

/**
 * The body as sent, between a header naming the message and its sender (so the
 * recipient can reply with `--to`) and an end line. The id is assigned at send,
 * so no body can contain its own end line.
 */
export function frameMessage(id: string, sender: string | null, body: string): string {
  const short = shortMessageId(id);
  return `Mandible: message ${short} from ${sender ?? "a shell"}:\n${body}\nMandible: end of message ${short}`;
}

export interface MessageView {
  id: string;
  short_id: string;
  sender_agent_ref: string | null;
  recipient_agent_ref: string;
  text: string;
  sent_at: number;
  delivered_at: number | null;
  /** The recipient session's last recorded execution state, where Mandible records one. */
  recipient_execution: { state: SessionExecutionState; observed_at: number } | null;
  reach: MessageReach;
}

/**
 * Whether the message has reached, or will reach, its recipient, from current
 * state. Every case but `delivered` leaves the message owed.
 */
export type MessageReach =
  | { kind: "delivered"; at: number }
  /** No wake: the running turn's hooks deliver. */
  | { kind: "working"; observed_at: number }
  /** A provider accepted the wake; not yet delivered. */
  | { kind: "woken"; at: number }
  | { kind: "wake_in_progress"; since: number }
  /** Delivered at the recipient's next turn. `not_main_thread`: only a session's main thread is woken. */
  | { kind: "not_woken"; reason: WakeFailureCode | "not_main_thread" | "not_attempted"; detail: string | null }
  | { kind: "ended"; observed_at: number }
  /** No hook has run in a session with that id. */
  | { kind: "unknown" };

export type MessageError =
  | { code: "invalid_recipient"; error: string }
  | { code: "too_large"; error: string }
  | { code: "not_found"; error: string }
  | { code: "ambiguous_id"; error: string };

export type MessageResult<T> = { ok: true; value: T } | { ok: false; error: MessageError };

interface MessageRow {
  id: string;
  recipient_provider: NoticeProvider;
  recipient_id: string;
  responsible_agent_ref: string;
  sender_agent_ref: string | null;
  raised_at: number;
  delivered_at: number | null;
  text: string;
}

const COLUMNS = "id, recipient_provider, recipient_id, responsible_agent_ref, sender_agent_ref, raised_at, delivered_at, text";

function view(db: Db, row: MessageRow): MessageView {
  const execution = (row.recipient_provider === "claude" || row.recipient_provider === "codex")
    ? new SessionExecutionStore(db).read(row.recipient_provider, row.recipient_id) : null;
  return {
    id: row.id, short_id: shortMessageId(row.id), sender_agent_ref: row.sender_agent_ref, recipient_agent_ref: row.responsible_agent_ref,
    text: row.text, sent_at: row.raised_at, delivered_at: row.delivered_at,
    recipient_execution: execution ? { state: execution.state, observed_at: execution.observed_at } : null,
    reach: reach(db, row, execution),
  };
}

function reach(db: Db, row: MessageRow, execution: SessionExecutionObservation | null): MessageReach {
  if (row.delivered_at !== null) return { kind: "delivered", at: row.delivered_at };
  if (row.recipient_provider !== "antigravity") {
    if (!execution) return { kind: "unknown" };
    if (execution.state.kind === "ended") return { kind: "ended", observed_at: execution.observed_at };
    if (execution.state.kind === "working") return { kind: "working", observed_at: execution.observed_at };
  }
  if (row.responsible_agent_ref !== exactAgentRef(hookAgentIdentity(row.recipient_provider, row.recipient_id, undefined))) {
    return { kind: "not_woken", reason: "not_main_thread", detail: null };
  }
  // An attempt before the session's last observation belongs to an earlier idle spell.
  const attempt = latestWakeAttempt(db, row.recipient_provider, row.recipient_id, execution?.observed_at ?? 0);
  if (!attempt) return { kind: "not_woken", reason: "not_attempted", detail: null };
  if (attempt.outcome === null) return { kind: "wake_in_progress", since: attempt.attempted_at };
  if (attempt.outcome === "woken") return { kind: "woken", at: attempt.finished_at! };
  return { kind: "not_woken", reason: attempt.outcome, detail: attempt.error };
}

/** The provider session a recipient ref lives in: a Claude ref's session, otherwise the ref's own id. */
export function recipientSession(ref: string): { provider: NoticeProvider; session_id: string } | null {
  const recipient = parseExactAgentRef(ref);
  if (!recipient || !(NOTICE_PROVIDERS as readonly string[]).includes(recipient.provider)) return null;
  return { provider: recipient.provider as NoticeProvider, session_id: recipient.session_id ?? recipient.agent_id! };
}

/** Stores a message's body, as sent, for one exact agent of a known provider; it is delivered by the recipient's own hooks. */
export function sendMessage(db: Db, input: { to: string; text: string; sender: string | null }, now: number = Date.now()):
  MessageResult<MessageView> {
  const recipient = recipientSession(input.to);
  if (!recipient) {
    return { ok: false, error: { code: "invalid_recipient", error: `${input.to} is not an exact agent ref of ${NOTICE_PROVIDERS.join(", ")}.` } };
  }
  const bytes = Buffer.byteLength(input.text, "utf8");
  if (bytes > MESSAGE_SIZE.body_bytes) {
    return { ok: false, error: { code: "too_large", error: `The message is ${bytes} bytes; a message is at most ${MESSAGE_SIZE.body_bytes}. `
      + "Put the content in a file or the ledger and send its path." } };
  }
  const id = randomUUID();
  const { text } = input;
  db.prepare(`INSERT INTO notifications (id, subject_kind, subject_id, recipient_kind, recipient_provider, recipient_id,
    responsible_agent_ref, sender_agent_ref, raised_at, text) VALUES (?, 'message', ?, 'session', ?, ?, ?, ?, ?, ?)`)
    .run(id, id, recipient.provider, recipient.session_id, input.to, input.sender, now, text);
  db.afterCommit(() => broadcast(DOMAIN_EVENTS.NOTIFICATION_CHANGED, { id }));
  return { ok: true, value: view(db, db.prepare(`SELECT ${COLUMNS} FROM notifications WHERE id = ?`).get(id) as MessageRow) };
}

/** One message by its id or a unique prefix of it. */
export function getMessage(db: Db, id: string): MessageResult<MessageView> {
  const rows = /^[0-9a-f-]+$/i.test(id)
    ? db.prepare(`SELECT ${COLUMNS} FROM notifications WHERE subject_kind = 'message' AND id LIKE ? || '%' LIMIT 2`)
      .all(id.toLowerCase()) as MessageRow[]
    : [];
  if (rows.length === 0) return { ok: false, error: { code: "not_found", error: `No message ${id}.` } };
  if (rows.length > 1) return { ok: false, error: { code: "ambiguous_id", error: `${id} names more than one message.` } };
  return { ok: true, value: view(db, rows[0]) };
}

/** The agent's sent and received messages, newest first. */
export function listMessages(db: Db, agentRef: string, limit = 50): MessageView[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM notifications WHERE subject_kind = 'message'
    AND (responsible_agent_ref = ?1 OR sender_agent_ref = ?1) ORDER BY raised_at DESC, id DESC LIMIT ?2`).all(agentRef, limit) as MessageRow[];
  return rows.map((row) => view(db, row));
}
