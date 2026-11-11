import { randomUUID } from "node:crypto";
import { normalizeAmbientProviderIdentity, parseExactAgentRef, type AmbientProviderIdentity } from "../ambient-provider-identity.js";
import type { Db } from "../db.js";
import type { SqliteStatement } from "../sqlite.js";
import { holdsResponsibility, type ResponsibilityActor } from "../responsibility.js";
import { resolveSessionAlias } from "../session-liveness.js";
import { NOTICE_PROVIDERS, outcomeReportDigest, type NoticeProvider, type OutcomeReporter } from "./contract.js";
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
 * outcome state and only continues a request that already has one.
 */
export type NoticeCause =
  | { kind: "transition"; actor: ResponsibilityActor | null }
  | { kind: "change" };

interface Recipient { provider: NoticeProvider; session_id: string; agent_ref: string }

interface LatestRow {
  id: string;
  delivered_at: number | null;
  digest: string | null;
  recipient_provider: string;
  recipient_id: string;
  responsible_agent_ref: string;
}

interface OwedRow { id: string; subject_id: string; recipient_id: string; responsible_agent_ref: string }

/**
 * The session half of the notification log for approval requests: raising a
 * notice when a request's outcome changes, and handing the owed notices to the
 * session that answers for the request at the start of its next turn.
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
    this.owed = db.prepare(`SELECT id, subject_id, recipient_id, responsible_agent_ref FROM notifications
      WHERE recipient_provider = ? AND recipient_id = ? AND delivered_at IS NULL AND recipient_kind = 'session'
      ORDER BY raised_at, rowid`);
    this.latest = db.prepare(`SELECT id, delivered_at, digest, recipient_provider, recipient_id, responsible_agent_ref
      FROM notifications WHERE subject_kind = 'auth_request' AND subject_id = ? ORDER BY raised_at DESC, rowid DESC LIMIT 1`);
  }

  /**
   * Idempotent. An undelivered notice is left to be rendered at delivery and
   * follows responsibility; a delivered one is followed by a new notice only
   * when the report differs from the one it was rendered from.
   */
  raise(requestId: string, cause: NoticeCause): void {
    const latest = this.latest.get(requestId) as LatestRow | undefined;
    if (!latest && cause.kind === "change") return;
    const holder = this.holder(requestId);
    const undelivered = latest && latest.delivered_at === null ? latest : null;
    if (cause.kind === "transition" && cause.actor && holder && holdsResponsibility(this.db, holder, cause.actor)) {
      if (undelivered) this.db.prepare("DELETE FROM notifications WHERE id = ?").run(undelivered.id);
      return;
    }
    const recipient = holder ? this.recipient(requestId, holder) : null;
    if (undelivered) {
      if (!recipient) this.db.prepare("DELETE FROM notifications WHERE id = ?").run(undelivered.id);
      else if (recipient.provider !== undelivered.recipient_provider || recipient.session_id !== undelivered.recipient_id
        || recipient.agent_ref !== undelivered.responsible_agent_ref) {
        this.db.prepare("UPDATE notifications SET recipient_provider = ?, recipient_id = ?, responsible_agent_ref = ? WHERE id = ?")
          .run(recipient.provider, recipient.session_id, recipient.agent_ref, undelivered.id);
      }
      return;
    }
    if (!recipient) return;
    if (latest) {
      const report = this.reporter(requestId);
      if (!report || outcomeReportDigest(report) === latest.digest) return;
    }
    this.db.prepare(`INSERT INTO notifications (id, subject_kind, subject_id, recipient_kind, recipient_provider,
      recipient_id, responsible_agent_ref, raised_at) VALUES (?, 'auth_request', ?, 'session', ?, ?, ?, ?)`)
      .run(randomUUID(), requestId, recipient.provider, recipient.session_id, recipient.agent_ref, this.now());
  }

  /** The notices owed to one session, rendered now. Nothing owed is one indexed read. */
  collect(provider: NoticeProvider, sessionId: string): Array<{ id: string; text: string }> {
    const rows = this.owed.all(provider, sessionId) as OwedRow[];
    if (rows.length === 0) return [];
    return this.db.transaction(() => rows.flatMap((row) => {
      const report = this.reporter(row.subject_id);
      if (!report) return [];
      const holder = parseExactAgentRef(row.responsible_agent_ref);
      if (!holder) throw new Error(`Notification ${row.id} names no exact agent.`);
      const base = (this.db.prepare("SELECT base_branch FROM auth_requests WHERE id = ?").get(row.subject_id) as
        { base_branch: string | null } | undefined)?.base_branch ?? "base";
      const text = renderNotice(report, { ...holder, session_id: row.recipient_id }, base);
      this.db.prepare("UPDATE notifications SET digest = ?, text = ? WHERE id = ?").run(outcomeReportDigest(report), text, row.id);
      return [{ id: row.id, text }];
    })).immediate();
  }

  /**
   * Marks rendered notices delivered. A report that changed after its notice
   * was rendered is owed again.
   */
  delivered(ids: readonly string[]): void {
    const mark = this.db.prepare(`UPDATE notifications SET delivered_at = ?
      WHERE id = ? AND recipient_kind = 'session' AND delivered_at IS NULL AND text IS NOT NULL RETURNING subject_id`);
    this.db.transaction(() => {
      for (const id of ids) {
        const row = mark.get(this.now(), id) as { subject_id: string } | undefined;
        if (row) this.raise(row.subject_id, { kind: "change" });
      }
    }).immediate();
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
