import type { Db } from "../db.js";
import type { ConversationSource } from "../parsers/types.js";
import { SessionExecutionStore } from "../session-execution.js";
import { listExecutionOutbox } from "../session-execution-outbox.js";
import { getWorkerAssignments } from "../work-unit-worker.js";
import { ensureExactConversationFresh } from "./freshness.js";
import { scheduleExactPathReparse } from "../ingestion.js";
import { setConversationArchiveState } from "./metadata.js";
import { defaultCodexNativeArchiveAdapter, type CodexNativeArchiveOutcome } from "../conversation-control/codex-native-archive.js";
import { getRetainedChild, getRetainedChildByProvider, type RetainedChild } from "./retention-policy.js";
import { notifyRetentionChanged, observeRetentionChanges, readChildRetentionSettings, rearmChildRetention } from "./retention-state.js";
import type { Logger, SSEEvent } from "../types.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import { broadcast } from "../sse.js";
import { systemAction } from "../identity/resolver.js";

interface RetentionRow {
  conversation_id: string; role: string; last_activity_at: number | null; last_terminal_at: number | null;
  activity_state: "active" | "settled" | "unknown"; activity_generation: number; source_version_id: string | null;
  restored_at: number | null; due_at: number; trigger: "retention" | "resolved-worker" | null;
  attempts: number; native_pending: number;
}

export interface ChildRetentionSchedulerOptions {
  effectsAllowed: boolean;
  executionOutboxDirectory?: string;
  now?: () => number;
  batchSize?: number;
  ensureFresh?: typeof ensureExactConversationFresh;
  scheduleReparse?: typeof scheduleExactPathReparse;
  nativeArchive?: (sessionId: string) => Promise<CodexNativeArchiveOutcome>;
  pendingNativeQueue?: (sessionId: string) => Promise<{ status: "known"; pending: boolean } | { status: "unknown"; reason: string }>;
}

export function scheduleResolvedWorkerArchive(db: Db, provider: ConversationSource, sessionId: string, now = Date.now()): boolean {
  const child = getRetainedChildByProvider(db, provider, sessionId);
  if (!child || child.role !== "worker") return false;
  const settings = readChildRetentionSettings(db);
  if (!settings.enabled || !settings.worker.enabled) return false;
  const assignments = getWorkerAssignments(db, { provider, provider_session_id: sessionId });
  if (!assignments.complete) return false;
  const receipt = db.prepare("SELECT archived_at FROM worker_thread_archives WHERE work_unit_id=? AND thread_id=?");
  if (assignments.resolvedUnitIds.every(id => receipt.get(id, sessionId))) return false;
  db.prepare(`INSERT INTO conversation_retention_state(conversation_id,role,trigger,due_at)
    VALUES (?,'worker','resolved-worker',?) ON CONFLICT(conversation_id) DO UPDATE SET
    trigger='resolved-worker',due_at=CASE WHEN native_pending=1 THEN due_at ELSE excluded.due_at END`)
    .run(child.conversationId, now);
  notifyRetentionChanged(db);
  return true;
}

export class ChildRetentionScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  private detach: (() => void) | null = null;
  private readonly now: () => number;
  private readonly batchSize: number;
  constructor(private readonly db: Db, private readonly logger: Logger, private readonly options: ChildRetentionSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.batchSize = options.batchSize ?? 16;
  }

  start(): void {
    if (!this.stopped || !this.options.effectsAllowed) return;
    this.stopped = false;
    this.detach = observeRetentionChanges(this.db, () => this.arm());
    // Seed only positively declared children. No native history is read here.
    const children = this.db.prepare(`SELECT id FROM conversations WHERE opening_lineage='child'
      AND parent_conversation_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM conversation_retention_state r WHERE r.conversation_id=conversations.id)`).all() as { id: string }[];
    for (const { id } of children) {
      const child = getRetainedChild(this.db, id);
      if (!child) continue;
      this.db.prepare(`INSERT INTO conversation_retention_state(conversation_id,role) VALUES (?,?)`).run(id, child.role);
      rearmChildRetention(this.db, id);
    }
    const workers = this.db.prepare(`SELECT DISTINCT worker_provider,worker_provider_session_id FROM work_units
      WHERE state='resolved' AND worker_provider IS NOT NULL AND worker_provider_session_id IS NOT NULL`).all() as {
        worker_provider: ConversationSource; worker_provider_session_id: string;
      }[];
    for (const worker of workers) scheduleResolvedWorkerArchive(this.db, worker.worker_provider, worker.worker_provider_session_id, this.now());
    this.arm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.detach?.();
    this.detach = null;
    await this.running;
  }

  observe(event: SSEEvent): void {
    if (this.stopped) return;
    const data = event.data as Record<string, unknown>;
    if (event.type === "ledger:event:created" && data.entity_type === "work_unit" && typeof data.entity_id === "string") {
      const unit = this.db.prepare("SELECT worker_provider,worker_provider_session_id FROM work_units WHERE id=?").get(data.entity_id) as {
        worker_provider: ConversationSource | null; worker_provider_session_id: string | null;
      } | undefined;
      if (unit?.worker_provider && unit.worker_provider_session_id) {
        scheduleResolvedWorkerArchive(this.db, unit.worker_provider, unit.worker_provider_session_id, this.now());
      }
    }
    if (event.type === DOMAIN_EVENTS.SESSION_EXECUTION_UPDATED) {
      const provider = data.provider === "claude" ? "claude_code" : data.provider === "codex" ? "codex" : null;
      if (provider && typeof data.provider_session_id === "string") {
        const child = getRetainedChildByProvider(this.db, provider, data.provider_session_id);
        if (child) rearmChildRetention(this.db, child.conversationId);
      }
    }
    if (event.type === DOMAIN_EVENTS.CONVERSATION_CONTROL_UPDATED && typeof data.conversation_id === "string") {
      rearmChildRetention(this.db, data.conversation_id);
    }
  }

  runDue(): Promise<void> {
    if (!this.options.effectsAllowed || this.stopped) return Promise.resolve();
    this.running ??= this.processDue().finally(() => { this.running = null; this.arm(); });
    return this.running;
  }

  private arm(): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const row = this.db.prepare(`SELECT due_at FROM conversation_retention_state
      WHERE due_at IS NOT NULL ORDER BY due_at,conversation_id LIMIT 1`).get() as { due_at: number } | undefined;
    if (!row) return;
    this.timer = setTimeout(() => { this.timer = null; void this.runDue().catch(error => {
      this.logger("error", "child_retention_failed", { error: String(error) });
    }); }, Math.min(2147483647, Math.max(0, row.due_at - this.now())));
    this.timer.unref?.();
  }

  private row(id: string): RetentionRow | undefined {
    return this.db.prepare("SELECT * FROM conversation_retention_state WHERE conversation_id=?").get(id) as RetentionRow | undefined;
  }

  private defer(row: RetentionRow, reason: string): void {
    const attempts = row.attempts + 1;
    const delay = Math.min(6 * 3600000, 60000 * 2 ** Math.min(12, attempts - 1));
    this.db.prepare(`UPDATE conversation_retention_state SET attempts=?,due_at=?,last_native_outcome=?
      WHERE conversation_id=? AND activity_generation=?`).run(attempts, this.now() + delay,
      JSON.stringify({ status: "deferred", reason }), row.conversation_id, row.activity_generation);
  }

  private async processDue(): Promise<void> {
    const rows = this.db.prepare(`SELECT * FROM conversation_retention_state WHERE due_at IS NOT NULL AND due_at<=?
      ORDER BY due_at,conversation_id LIMIT ?`).all(this.now(), this.batchSize) as RetentionRow[];
    for (const row of rows) {
      if (this.stopped) break;
      try { await this.processOne(row); }
      catch (error) { this.defer(row, String(error)); this.logger("warn", "child_retention_deferred", { conversation_id: row.conversation_id, error: String(error) }); }
    }
  }

  private eligible(child: RetainedChild, row: RetentionRow): boolean {
    const settings = readChildRetentionSettings(this.db);
    if (!settings.enabled || !settings[child.role].enabled) return false;
    if (child.role === "worker") return row.trigger === "resolved-worker"
      && getWorkerAssignments(this.db, { provider: child.provider, provider_session_id: child.sessionId }).complete;
    return true;
  }

  private executionSettled(child: RetainedChild, row: RetentionRow): boolean {
    const control = this.db.prepare(`SELECT controller_state,turn_state FROM conversation_control_state WHERE conversation_id=?`)
      .get(child.conversationId) as { controller_state: string; turn_state: string } | undefined;
    if (control && (["starting", "running", "waiting", "stopping"].includes(control.controller_state)
      || ["queued", "running", "waiting-user", "waiting-permission", "unknown"].includes(control.turn_state))) return false;
    if (this.db.prepare(`SELECT 1 FROM conversation_control_outbox WHERE conversation_id=?
      AND state IN ('pending','delivering','uncertain') LIMIT 1`).get(child.conversationId)) return false;
    if (this.options.executionOutboxDirectory) {
      try {
        const pending = listExecutionOutbox(this.options.executionOutboxDirectory);
        if (pending.entries.length || pending.temps.length) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    const execution = child.provider === "gemini" ? null
      : new SessionExecutionStore(this.db).read(child.provider === "claude_code" ? "claude" : "codex", child.sessionId);
    if (execution && execution.observed_at >= (row.last_terminal_at ?? 0)) {
      return execution.state.kind !== "working" && execution.state.kind !== "unknown";
    }
    return row.activity_state === "settled";
  }

  private async processOne(original: RetentionRow): Promise<void> {
    const child = getRetainedChild(this.db, original.conversation_id);
    if (!child || !this.eligible(child, original)) {
      this.db.prepare("UPDATE conversation_retention_state SET due_at=NULL WHERE conversation_id=?").run(original.conversation_id);
      return;
    }
    const marker = this.db.prepare("SELECT archived_at FROM conversation_archive_states WHERE conversation_id=?")
      .get(child.conversationId) as { archived_at: number } | undefined;
    if (marker && !original.native_pending) {
      this.db.prepare("UPDATE conversation_retention_state SET due_at=NULL WHERE conversation_id=?").run(child.conversationId);
      return;
    }
    const fresh = await (this.options.ensureFresh ?? ensureExactConversationFresh)(this.db, child.conversationId);
    if (!fresh.sourceId || !fresh.sourcePath) { this.defer(original, "source_unavailable"); return; }
    const current = this.row(child.conversationId);
    if (!current || current.activity_generation !== original.activity_generation) return;
    if (!current.last_activity_at || !current.source_version_id) {
      (this.options.scheduleReparse ?? scheduleExactPathReparse)(fresh.sourcePath, fresh.sourceId, child.conversationId);
      this.defer(current, "activity_projection_pending");
      return;
    }
    if (!this.executionSettled(child, current)) { this.defer(current, "execution_or_dispatch_pending"); return; }
    if (!this.eligible(child, current)) return;
    if (child.role !== "worker") {
      const settings = readChildRetentionSettings(this.db);
      const hours = child.role === "planner" ? settings.planner.idleHours : settings.archaeologist.idleHours;
      if (this.now() < Math.max(current.last_activity_at, current.restored_at ?? 0) + hours * 3600000) {
        rearmChildRetention(this.db, child.conversationId); return;
      }
    }
    if (child.provider === "codex" && this.options.pendingNativeQueue) {
      const queue = await this.options.pendingNativeQueue(child.sessionId);
      if (queue.status === "known" && queue.pending) { this.defer(current, "native_queue_pending"); return; }
    }
    if (this.stopped || this.row(child.conversationId)?.activity_generation !== current.activity_generation) return;
    this.db.transaction(() => {
      setConversationArchiveState(this.db, { conversation_id: child.conversationId, archived: true,
        cause: current.trigger ?? "retention" }, { actor_type: "system", actor_id: "child-retention", attribution: systemAction() });
      if (child.role === "worker") {
        const units = getWorkerAssignments(this.db, { provider: child.provider, provider_session_id: child.sessionId });
        const record = this.db.prepare(`INSERT INTO worker_thread_archives(work_unit_id,thread_id,archived_at,attempts)
          VALUES(?,?,?,0) ON CONFLICT(work_unit_id,thread_id) DO UPDATE SET archived_at=excluded.archived_at`);
        for (const id of units.resolvedUnitIds) record.run(id, child.sessionId, this.now());
      }
      this.db.prepare(`UPDATE conversation_retention_state SET native_pending=?,due_at=?,attempts=0
        WHERE conversation_id=?`).run(child.provider === "codex" ? 1 : 0, child.provider === "codex" ? this.now() : null, child.conversationId);
    })();
    if (child.provider !== "codex") return;
    if (this.stopped || this.row(child.conversationId)?.activity_generation !== current.activity_generation) return;
    const outcome = await (this.options.nativeArchive ?? (id => defaultCodexNativeArchiveAdapter.archive(id)))(child.sessionId);
    if (this.row(child.conversationId)?.activity_generation !== current.activity_generation) return;
    const success = outcome.status === "archived" || outcome.status === "already_archived";
    this.db.prepare(`UPDATE conversation_retention_state SET native_pending=?,last_native_outcome=?,due_at=?,attempts=?
      WHERE conversation_id=? AND activity_generation=?`).run(success ? 0 : 1, JSON.stringify(outcome),
      success ? null : this.now() + Math.min(6 * 3600000, 60000 * 2 ** Math.min(12, current.attempts)),
      success ? 0 : current.attempts + 1, child.conversationId, current.activity_generation);
    broadcast(DOMAIN_EVENTS.CONVERSATION_UPDATED, { id: child.conversationId,
      retention_native_status: outcome.status, retention_native_reason: "reason" in outcome ? outcome.reason : null });
  }
}
