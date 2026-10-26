import type { Db } from "../db.js";
import type { ConversationBlock } from "../parsers/types.js";
import { getRetainedChild } from "./retention-policy.js";
import { CHILD_RETENTION_SETTINGS_KEY, CHILD_RETENTION_SETTINGS_SCHEMA, DEFAULT_CHILD_RETENTION_SETTINGS, type ChildRetentionSettings } from "./retention-contract.js";

const listeners = new WeakMap<Db, () => void>();
export function observeRetentionChanges(db: Db, listener: () => void): () => void {
  listeners.set(db, listener);
  return () => { listeners.delete(db); };
}
export function notifyRetentionChanged(db: Db): void { db.afterCommit(() => listeners.get(db)?.()); }

export function readChildRetentionSettings(db: Db): ChildRetentionSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CHILD_RETENTION_SETTINGS_KEY) as { value: string } | undefined;
  return row ? CHILD_RETENTION_SETTINGS_SCHEMA.parse(JSON.parse(row.value)) : structuredClone(DEFAULT_CHILD_RETENTION_SETTINGS);
}

export function writeChildRetentionSettings(db: Db, value: ChildRetentionSettings, now = Date.now()): void {
  const settings = CHILD_RETENTION_SETTINGS_SCHEMA.parse(value);
  db.transaction(() => {
    db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(CHILD_RETENTION_SETTINGS_KEY, JSON.stringify(settings), now);
    db.prepare(`UPDATE conversation_retention_state SET activity_generation = activity_generation + 1,
      attempts = 0, due_at = CASE
      WHEN ? = 0 THEN NULL
      WHEN native_pending = 1 THEN ?
      WHEN role = 'planner' AND ? AND ? THEN MAX(COALESCE(last_activity_at,?),COALESCE(restored_at,0)) + ?
      WHEN role = 'archaeologist' AND ? AND ? THEN MAX(COALESCE(last_activity_at,?),COALESCE(restored_at,0)) + ?
      WHEN trigger = 'resolved-worker' AND ? AND ? THEN ? ELSE NULL END`)
      .run(settings.enabled ? 1 : 0, now, settings.enabled ? 1 : 0, settings.planner.enabled ? 1 : 0, now, settings.planner.idleHours * 3600000,
        settings.enabled ? 1 : 0, settings.archaeologist.enabled ? 1 : 0, now, settings.archaeologist.idleHours * 3600000,
        settings.enabled ? 1 : 0, settings.worker.enabled ? 1 : 0, now);
  })();
  notifyRetentionChanged(db);
}

export function rearmChildRetention(db: Db, conversationId: string): void {
  const settings = readChildRetentionSettings(db);
  db.prepare(`UPDATE conversation_retention_state SET due_at = CASE
    WHEN native_pending = 1 THEN due_at
    WHEN ? = 0 THEN NULL
    WHEN role = 'planner' AND ? THEN MAX(COALESCE(last_activity_at,0),COALESCE(restored_at,0)) + ?
    WHEN role = 'archaeologist' AND ? THEN MAX(COALESCE(last_activity_at,0),COALESCE(restored_at,0)) + ?
    WHEN trigger = 'resolved-worker' AND ? THEN COALESCE(due_at,0)
    ELSE NULL END, trigger = CASE WHEN role IN ('planner','archaeologist') THEN 'retention' ELSE trigger END
    WHERE conversation_id = ?`).run(settings.enabled ? 1 : 0,
    settings.planner.enabled ? 1 : 0, settings.planner.idleHours * 3600000,
    settings.archaeologist.enabled ? 1 : 0, settings.archaeologist.idleHours * 3600000,
    settings.worker.enabled ? 1 : 0, conversationId);
  notifyRetentionChanged(db);
}

export function projectChildRetentionActivity(db: Db, conversationId: string,
  blocks: readonly Pick<ConversationBlock, "type" | "role" | "timestamp" | "position" | "metadata">[]): void {
  const child = getRetainedChild(db, conversationId);
  if (!child) return;
  const previous = db.prepare(`SELECT role,last_activity_at, last_input_at, last_terminal_at, activity_state,
    activity_generation FROM conversation_retention_state WHERE conversation_id = ?`).get(conversationId) as {
    role: string; last_activity_at: number | null; last_input_at: number | null; last_terminal_at: number | null;
    activity_state: string; activity_generation: number;
  } | undefined;
  let activity = previous?.last_activity_at ?? 0;
  let input = previous?.last_input_at ?? 0;
  let terminal = previous?.last_terminal_at ?? 0;
  let state = previous?.activity_state ?? "unknown";
  for (const block of blocks) {
    const timestamp = Date.parse(block.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const event = block.metadata.source_event_type;
    const terminalEvent = block.metadata.execution_state === "settled" || event === "task_complete" || event === "turn_aborted";
    const userInput = block.type === "user_message" && block.role === "user" && event !== "user_meta";
    const meaningful = userInput || terminalEvent || event === "task_started"
      || ["assistant_message", "thinking", "plan", "tool_use", "tool_result"].includes(block.type);
    if (!meaningful) continue;
    if (userInput) input = Math.max(input, timestamp);
    if (terminalEvent) terminal = Math.max(terminal, timestamp);
    if (timestamp >= activity) {
      activity = timestamp;
      state = terminalEvent ? "settled" : "active";
    }
  }
  const changed = child.role !== previous?.role || activity !== (previous?.last_activity_at ?? 0)
    || input !== (previous?.last_input_at ?? 0) || terminal !== (previous?.last_terminal_at ?? 0) || state !== previous?.activity_state;
  const source = db.prepare("SELECT current_version_id FROM conversation_sources WHERE conversation_id = ? LIMIT 1")
    .get(conversationId) as { current_version_id: string | null } | undefined;
  db.prepare(`INSERT INTO conversation_retention_state(conversation_id,role,last_activity_at,last_input_at,last_terminal_at,
    activity_state,activity_generation,source_version_id) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(conversation_id) DO UPDATE SET role=excluded.role,last_activity_at=excluded.last_activity_at,
    last_input_at=excluded.last_input_at,last_terminal_at=excluded.last_terminal_at,activity_state=excluded.activity_state,
    activity_generation=excluded.activity_generation,source_version_id=excluded.source_version_id,
    native_pending=CASE WHEN ? THEN 0 ELSE native_pending END,
    attempts=CASE WHEN ? THEN 0 ELSE attempts END`).run(conversationId, child.role, activity || null, input || null,
    terminal || null, state, (previous?.activity_generation ?? 0) + (changed ? 1 : 0), source?.current_version_id ?? null,
    changed ? 1 : 0, changed ? 1 : 0);
  if (changed || !previous) rearmChildRetention(db, conversationId);
}

export function restoreChildRetention(db: Db, conversationId: string, now = Date.now()): void {
  const child = getRetainedChild(db, conversationId);
  if (!child) return;
  db.prepare(`INSERT INTO conversation_retention_state(conversation_id,role) VALUES (?,?) ON CONFLICT DO NOTHING`)
    .run(conversationId, child.role);
  db.prepare(`UPDATE conversation_retention_state SET restored_at=?, activity_generation=activity_generation+1,
    native_pending=0,attempts=0,trigger=NULL,due_at=NULL,last_native_outcome=NULL,provider_archived=1 WHERE conversation_id=?`).run(now, conversationId);
  rearmChildRetention(db, conversationId);
}
