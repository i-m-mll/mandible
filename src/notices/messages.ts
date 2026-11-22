import { createHash, randomUUID } from "node:crypto";
import { parseExactAgentRef } from "../ambient-provider-identity.js";
import { DOMAIN_EVENTS, type SessionExecutionState } from "../contracts.js";
import type { Db } from "../db.js";
import { SessionExecutionStore } from "../session-execution.js";
import { broadcast } from "../sse.js";
import { NOTICE_PROVIDERS, type NoticeProvider } from "./contract.js";

/** The CLI's display form of a message id. */
export function shortMessageId(id: string): string {
  return id.slice(0, 8);
}

/** One line: the message's short id and its sender, so the recipient can reply with `--to`. */
export function renderMessage(id: string, sender: string | null, text: string): string {
  return `Mandible: message ${shortMessageId(id)} from ${sender ?? "a shell"}: ${text.replace(/\s+/g, " ").trim()}`;
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
}

export type MessageError =
  | { code: "invalid_recipient"; error: string }
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
  };
}

/** Stores a message for one exact agent of a known provider; it is delivered by the recipient's own hooks. */
export function sendMessage(db: Db, input: { to: string; text: string; sender: string | null }, now: number = Date.now()):
  MessageResult<MessageView> {
  const recipient = parseExactAgentRef(input.to);
  if (!recipient || !(NOTICE_PROVIDERS as readonly string[]).includes(recipient.provider)) {
    return { ok: false, error: { code: "invalid_recipient", error: `${input.to} is not an exact agent ref of ${NOTICE_PROVIDERS.join(", ")}.` } };
  }
  const id = randomUUID();
  const text = renderMessage(id, input.sender, input.text);
  db.prepare(`INSERT INTO notifications (id, subject_kind, subject_id, recipient_kind, recipient_provider, recipient_id,
    responsible_agent_ref, sender_agent_ref, raised_at, digest, text) VALUES (?, 'message', ?, 'session', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, id, recipient.provider, recipient.session_id ?? recipient.agent_id!, input.to, input.sender, now,
      createHash("sha256").update(text).digest("hex"), text);
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
