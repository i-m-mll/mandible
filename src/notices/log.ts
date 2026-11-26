import { randomUUID } from "node:crypto";
import { exactAgentRef, hookAgentIdentity, normalizeAmbientProviderIdentity, parseExactAgentRef, type AmbientProviderIdentity } from "../ambient-provider-identity.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import type { Db } from "../db.js";
import type { SqliteStatement } from "../sqlite.js";
import { holdsResponsibility, type ResponsibilityHolder } from "../responsibility.js";
import { resolveSessionAlias } from "../session-liveness.js";
import { broadcast } from "../sse.js";
import { NOTICE_SEPARATOR } from "../parsers/hook-adapters.js";
import {
  MESSAGE_SIZE, NOTICE_PROVIDERS, noticeBasis, noticeBasisAdvanced,
  type NoticeBasis, type NoticeCaller, type NoticeProvider, type OutcomeReporter,
} from "./contract.js";
import { frameMessage } from "./messages.js";
import { renderNotice } from "./render.js";

/** Who answers for a request now, as `AuthQueue.requestResponsibility` gives it. */
export interface RequestHolder {
  owner_user_id: string | null;
  responsibility_session_id: string | null;
  work_unit_id: string | null;
}

/**
 * Why a notice is raised. A `transition` is the request's status moving into
 * `NOTICE_STATUSES` and may start a notice; a `change` is any later write to
 * outcome state and only continues a request that already has one; a
 * `passed_over` is the user acting on a request another session answers for,
 * which that session is told of whatever the report says.
 */
export type NoticeCause =
  | { kind: "transition"; actor: ResponsibilityHolder | null }
  | { kind: "change" }
  | { kind: "passed_over" };

interface Recipient { provider: NoticeProvider; session_id: string; agent_ref: string }

interface LatestRow {
  id: string;
  delivered_at: number | null;
  basis: string | null;
  recipient_provider: string;
  recipient_id: string;
  responsible_agent_ref: string;
}

interface OwedBase { id: string; subject_id: string; recipient_id: string; responsible_agent_ref: string }
type OwedRow =
  | OwedBase & { subject_kind: "auth_request"; text: string | null; sender_agent_ref: null }
  | OwedBase & { subject_kind: "reminder"; text: string; sender_agent_ref: null }
  | OwedBase & { subject_kind: "message"; text: string; sender_agent_ref: string | null };

/** A delivered notice rendered before bases were stored told an open request with nothing failed or kept. */
function storedBasis(json: string | null): NoticeBasis {
  return json === null ? { open: true, items: [] } : JSON.parse(json) as NoticeBasis;
}

/**
 * The session half of the notification log: raising a notice when an approval
 * request's outcome changes, and handing every owed row (a settlement notice,
 * a fired reminder, a message) to its recipient at the recipient's next hook.
 */
export class NoticeLog {
  private readonly owed: SqliteStatement;
  private readonly latest: SqliteStatement;

  constructor(
    private readonly db: Db,
    private readonly reporter: OutcomeReporter,
    private readonly holder: (requestId: string) => RequestHolder | null,
    private readonly now: () => number = Date.now,
  ) {
    // Session-addressed rows by session, for the main thread only; messages by exact agent.
    this.owed = db.prepare(`SELECT id, subject_kind, subject_id, recipient_id, responsible_agent_ref, sender_agent_ref, text, raised_at, rowid AS seq FROM notifications
      WHERE ?3 AND recipient_provider = ?1 AND recipient_id = ?2 AND delivered_at IS NULL AND recipient_kind = 'session' AND subject_kind <> 'message'
      UNION ALL
      SELECT id, subject_kind, subject_id, recipient_id, responsible_agent_ref, sender_agent_ref, text, raised_at, rowid AS seq FROM notifications
      WHERE responsible_agent_ref = ?4 AND delivered_at IS NULL AND subject_kind = 'message'
      ORDER BY raised_at, seq`);
    this.latest = db.prepare(`SELECT id, delivered_at, basis, recipient_provider, recipient_id, responsible_agent_ref
      FROM notifications WHERE subject_kind = 'auth_request' AND subject_id = ? ORDER BY raised_at DESC, rowid DESC LIMIT 1`);
  }

  /**
   * Idempotent. An undelivered notice is left to be rendered at delivery and
   * follows responsibility. Once the latest notice is delivered, a `transition`
   * or a `passed_over` always raises a new one; a `change` raises one only when the report's basis
   * advanced past the basis that notice told (`noticeBasisAdvanced`), and
   * otherwise records the current basis on it, so a step that recovers and
   * fails again is news again.
   */
  raise(requestId: string, cause: NoticeCause): void {
    const latest = this.latest.get(requestId) as LatestRow | undefined;
    if (!latest && cause.kind !== "transition") return;
    const holder = this.holder(requestId);
    const undelivered = latest && latest.delivered_at === null ? latest : null;
    if (cause.kind === "transition" && cause.actor && holder && holdsResponsibility(this.db, holder, cause.actor)) {
      if (undelivered) this.remove(undelivered.id);
      return;
    }
    const recipient = holder ? this.recipient(requestId, holder) : null;
    if (undelivered) {
      if (!recipient) this.remove(undelivered.id);
      else if (recipient.provider !== undelivered.recipient_provider || recipient.session_id !== undelivered.recipient_id
        || recipient.agent_ref !== undelivered.responsible_agent_ref) {
        this.db.prepare("UPDATE notifications SET recipient_provider = ?, recipient_id = ?, responsible_agent_ref = ? WHERE id = ?")
          .run(recipient.provider, recipient.session_id, recipient.agent_ref, undelivered.id);
        this.changed(undelivered.id);
      }
      return;
    }
    if (!recipient) return;
    if (latest && cause.kind === "change") {
      const report = this.reporter(requestId);
      if (!report) return;
      const current = noticeBasis(report);
      if (!noticeBasisAdvanced(storedBasis(latest.basis), current)) {
        this.db.prepare("UPDATE notifications SET basis = ? WHERE id = ?").run(JSON.stringify(current), latest.id);
        return;
      }
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO notifications (id, subject_kind, subject_id, recipient_kind, recipient_provider,
      recipient_id, responsible_agent_ref, raised_at) VALUES (?, 'auth_request', ?, 'session', ?, ?, ?, ?)`)
      .run(id, requestId, recipient.provider, recipient.session_id, recipient.agent_ref, this.now());
    this.changed(id);
  }

  /**
   * The rows owed to the calling hook, rendered now, in the order they were
   * raised: the session's notices when it is the main thread, and the messages
   * addressed to its exact agent, each framed. The rows taken are the longest
   * prefix that fits `MESSAGE_SIZE.hook_call_bytes` once joined, and at least
   * the first; the rest stay owed to the next call. Nothing owed is one indexed read.
   */
  collect(caller: NoticeCaller): Array<{ id: string; text: string }> {
    const ref = exactAgentRef(hookAgentIdentity(caller.provider, caller.session_id, caller.agent_id));
    const main = caller.agent_id === undefined || caller.agent_id === caller.session_id;
    const rows = this.owed.all(caller.provider, caller.session_id, main ? 1 : 0, ref) as OwedRow[];
    if (rows.length === 0) return [];
    return this.db.transaction(() => {
      const taken: Array<{ id: string; text: string }> = [];
      let bytes = 0;
      for (const row of rows) {
        const text = this.render(row);
        if (text === null) continue;
        const size = Buffer.byteLength(text, "utf8") + (taken.length > 0 ? NOTICE_SEPARATOR.length : 0);
        if (taken.length > 0 && bytes + size > MESSAGE_SIZE.hook_call_bytes) break;
        taken.push({ id: row.id, text });
        bytes += size;
      }
      return taken;
    }).immediate();
  }

  /** A row's text as handed over: a message framed, a reminder as raised, a settlement notice rendered from the current report. */
  private render(row: OwedRow): string | null {
    if (row.subject_kind === "message") return frameMessage(row.id, row.sender_agent_ref, row.text);
    if (row.subject_kind !== "auth_request") return row.text;
    const report = this.reporter(row.subject_id);
    if (!report) return null;
    const holder = parseExactAgentRef(row.responsible_agent_ref);
    if (!holder) throw new Error(`Notification ${row.id} names no exact agent.`);
    const base = (this.db.prepare("SELECT base_branch FROM auth_requests WHERE id = ?").get(row.subject_id) as
      { base_branch: string | null } | undefined)?.base_branch ?? "base";
    const text = renderNotice(report, { ...holder, session_id: row.recipient_id }, base);
    this.db.prepare("UPDATE notifications SET basis = ?, text = ?, review_submission_id = ? WHERE id = ?")
      .run(JSON.stringify(noticeBasis(report)), text, report.review_submission_id ?? null, row.id);
    this.changed(row.id);
    return text;
  }

  /**
   * Marks rendered notices delivered. A report whose basis advanced after its
   * notice was rendered is owed again.
   */
  delivered(ids: readonly string[]): void {
    const mark = this.db.prepare(`UPDATE notifications SET delivered_at = ?
      WHERE id = ? AND recipient_kind = 'session' AND delivered_at IS NULL AND text IS NOT NULL RETURNING subject_kind, subject_id`);
    this.db.transaction(() => {
      for (const id of ids) {
        const row = mark.get(this.now(), id) as { subject_kind: string; subject_id: string } | undefined;
        if (!row) continue;
        this.changed(id);
        if (row.subject_kind === "auth_request") this.raise(row.subject_id, { kind: "change" });
      }
    }).immediate();
  }

  private remove(id: string): void {
    this.db.prepare("DELETE FROM notifications WHERE id = ?").run(id);
    this.changed(id);
  }

  private changed(id: string): void {
    this.db.afterCommit(() => broadcast(DOMAIN_EVENTS.NOTIFICATION_CHANGED, { id }));
  }

  private recipient(requestId: string, holder: RequestHolder): Recipient | null {
    const session = holder.responsibility_session_id;
    if (!session) return null;
    const ref = parseExactAgentRef(session) ? session : resolveSessionAlias(this.db, session)?.agent_ref ?? null;
    const agent = ref ? parseExactAgentRef(ref) : null;
    if (!ref || !agent || !(NOTICE_PROVIDERS as readonly string[]).includes(agent.provider)) return null;
    return { provider: agent.provider as NoticeProvider, session_id: this.enclosingSession(agent, requestId, holder.work_unit_id), agent_ref: ref };
  }

  /**
   * A Claude ref carries its session. A Codex thread's session is recorded in
   * the origin of an act the thread performed: the latest responsibility
   * transfer, the work unit's custody assignment, or the submission.
   */
  private enclosingSession(agent: AmbientProviderIdentity, requestId: string, workUnitId: string | null): string {
    if (agent.session_id) return agent.session_id;
    const entity = workUnitId ? ["work_unit", workUnitId] : ["auth_request", requestId];
    const origins = [
      this.db.prepare(`SELECT request_origin_json AS origin FROM responsibility_events
        WHERE entity_kind = ? AND entity_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 1`).get(...entity),
      workUnitId ? this.db.prepare(`SELECT request_origin_json AS origin FROM work_unit_custody_events
        WHERE work_unit_id = ? ORDER BY new_generation DESC LIMIT 1`).get(workUnitId) : undefined,
      this.db.prepare(`SELECT request_origin_json AS origin FROM auth_request_lifecycle_events
        WHERE auth_request_id = ? AND event_type = 'submitted' ORDER BY revision LIMIT 1`).get(requestId),
    ] as Array<{ origin: string | null } | undefined>;
    for (const row of origins) {
      const origin = row?.origin ? normalizeAmbientProviderIdentity(JSON.parse(row.origin)) : null;
      if (origin?.provider === agent.provider && origin.agent_id === agent.agent_id && origin.session_id) return origin.session_id;
    }
    return agent.agent_id!;
  }
}
