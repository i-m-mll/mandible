import { createHash, randomUUID } from "node:crypto";
import { exactAgentRef } from "../ambient-provider-identity.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import type { Db } from "../db.js";
import type { RequestOrigin } from "../request-origin.js";
import { broadcast } from "../sse.js";
import { NOTICE_PROVIDERS } from "./contract.js";

/** The CLI's display form of a `rem_<ULID>` id: the time part and seven random characters. */
function short(taskId: string): string {
  return taskId.slice(0, taskId.indexOf("_") + 18);
}

/**
 * Raise the notice of a fired reminder for the root session of the agent that
 * armed it, `origin` being the creation's request origin. A reminder armed
 * outside any agent session has no session notice. The text never changes, so
 * it is rendered here rather than at delivery.
 */
export function raiseReminderNotice(
  db: Db,
  reminder: { taskId: string; message: string },
  origin: RequestOrigin | null,
  raisedAt: number,
): void {
  if (!origin || !(NOTICE_PROVIDERS as readonly string[]).includes(origin.provider)) return;
  const agent = { ...origin, agent_id: origin.agent_id ?? origin.session_id };
  const session = origin.session_id ?? origin.agent_id!;
  const armedBy = agent.agent_id !== session ? ` (armed by agent ${agent.agent_id})` : "";
  const text = `Mandible: reminder ${short(reminder.taskId)} fired: ${reminder.message.replace(/\s+/g, " ").trim()}${armedBy}`;
  const id = randomUUID();
  db.prepare(`INSERT INTO notifications (id, subject_kind, subject_id, recipient_kind, recipient_provider, recipient_id,
    responsible_agent_ref, raised_at, digest, text) VALUES (?, 'reminder', ?, 'session', ?, ?, ?, ?, ?, ?)`)
    .run(id, reminder.taskId, origin.provider, session, exactAgentRef(agent), raisedAt,
      createHash("sha256").update(text).digest("hex"), text);
  broadcast(DOMAIN_EVENTS.NOTIFICATION_CHANGED, { id });
}
