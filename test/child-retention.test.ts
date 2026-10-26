import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { setDb, type Db } from "../src/db.js";
import { CodexParser } from "../src/parsers/codex.js";
import { ClaudeParser } from "../src/parsers/claude.js";
import { linkIngestedConversation } from "../src/conversation-lineage.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { ChildRetentionScheduler, scheduleResolvedWorkerArchive, type ChildRetentionSchedulerOptions } from "../src/conversations/retention.js";
import { projectChildRetentionActivity, readChildRetentionSettings, writeChildRetentionSettings } from "../src/conversations/retention-state.js";
import { reconcileIngestedChildRetention } from "../src/conversations/retention-ingestion.js";
import { setConversationArchiveState } from "../src/conversations/metadata.js";
import { getRetainedChild } from "../src/conversations/retention-policy.js";
import { SessionExecutionStore } from "../src/session-execution.js";
import { systemAction } from "../src/identity/resolver.js";
import type { ParseResult } from "../src/parsers/types.js";
import { DOMAIN_EVENTS } from "../src/contracts.js";

const HOUR = 3600000;
const epoch = Date.parse("2026-01-01T00:00:00Z");
const parentSession = "00000000-0000-4000-8000-000000000001";
let db: Db;
let clock: number;
let sequence: number;
let schedulers: ChildRetentionScheduler[];
const actor = { actor_type: "system" as const, actor_id: "test", attribution: systemAction() };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  clock = epoch + HOUR;
  vi.setSystemTime(clock);
  db = migratedMemoryDb(); setDb(db); sequence = 1; schedulers = [];
});
afterEach(async () => { for (const scheduler of schedulers) await scheduler.stop(); db.close(); vi.useRealTimers(); });

function move(time: number): void { clock = time; vi.setSystemTime(time); }
function archived(id: string): boolean { return Boolean(db.prepare("SELECT 1 FROM conversation_archive_states WHERE conversation_id=?").get(id)); }
function state(id: string): Record<string, unknown> { return db.prepare("SELECT * FROM conversation_retention_state WHERE conversation_id=?").get(id) as Record<string, unknown>; }
function scheduler(options: Partial<ChildRetentionSchedulerOptions> = {}) {
  const service = new ChildRetentionScheduler(db, () => undefined, { effectsAllowed: true, now: () => clock, ...options });
  schedulers.push(service); service.start(); return service;
}

async function child(provider: "codex" | "claude_code", role = "archaeologist"): Promise<{ id: string; nativeId: string; parsed: ParseResult; file: string }> {
  const n = ++sequence;
  const id = `child-${n}`;
  const nativeId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const parent = `parent-${provider}`;
  const marker = `[mandible child parent=${provider === "claude_code" ? "claude" : "codex"}:${parentSession} parent-role=coordinator role=${role}]`;
  const file = path.join(testRuntimeRoot, "home", provider === "codex" ? ".codex/sessions" : ".claude/projects/fixture", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = provider === "codex" ? [
    { type: "session_meta", timestamp: new Date(epoch).toISOString(), payload: { id: nativeId, cwd: testRuntimeRoot } },
    { type: "response_item", timestamp: new Date(epoch).toISOString(), payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } },
    { type: "response_item", timestamp: new Date(epoch + 1000).toISOString(), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Result" }] } },
    { type: "event_msg", timestamp: new Date(epoch + 2000).toISOString(), payload: { type: "task_complete", turn_id: "turn" } },
  ] : [
    { uuid: `${id}-u`, type: "user", timestamp: new Date(epoch).toISOString(), sessionId: nativeId, message: { role: "user", content: marker } },
    { uuid: `${id}-a`, type: "assistant", timestamp: new Date(epoch + 2000).toISOString(), sessionId: nativeId,
      message: { id: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Result" }] } },
  ];
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const parsed = await (provider === "codex" ? new CodexParser() : new ClaudeParser()).parse(file);
  if (!parsed) throw new Error("fixture failed to parse");
  const insert = db.prepare(`INSERT OR IGNORE INTO conversations(id,source,source_path,source_hash,source_mtime,title,started_at,session_id,created_at,updated_at)
    VALUES(?,?,?,?,1,?,'2026-01-01',?,'2026-01-01','2026-01-01')`);
  insert.run(parent, provider, "/parent", "parent", "Parent", parentSession);
  insert.run(id, provider, file, parsed.conversation.source_hash, "Child", nativeId);
  linkIngestedConversation(db, { ...parsed.conversation, id }, parsed);
  await new ConversationSourceStore(db).recordConversation({ conversationId: id, provider, nativeSessionId: nativeId, filePath: file,
    expectedContentHash: parsed.conversation.source_hash, sourceSnapshot: parsed.sourceSnapshot,
    structuralMode: "replace", blocks: [], ...CURRENT_CONVERSATION_SOURCE_EPOCHS });
  reconcileIngestedChildRetention(db, id, file, parsed.blocks);
  return { id, nativeId, parsed, file };
}

describe("indexed child retention", () => {
  it("uses native normalized clocks for both providers and preserves deadlines on metadata reparse", async () => {
    const codex = await child("codex");
    const claude = await child("claude_code", "planner");
    expect(state(codex.id)).toMatchObject({ last_input_at: epoch, last_terminal_at: epoch + 2000, activity_state: "settled", due_at: epoch + 2000 + 3 * HOUR });
    expect(state(claude.id)).toMatchObject({ last_terminal_at: epoch + 2000, activity_state: "settled", due_at: epoch + 2000 + 48 * HOUR });
    const generation = state(codex.id).activity_generation;
    move(epoch + 2 * HOUR);
    projectChildRetentionActivity(db, codex.id, codex.parsed.blocks);
    expect(state(codex.id)).toMatchObject({ activity_generation: generation, due_at: epoch + 2000 + 3 * HOUR });
    const fresh = vi.fn(async (_db: Db, id: string) => ({ conversationId: id, sourceId: "source", sourcePath: codex.file, refreshed: false }));
    const native = vi.fn(async () => ({ status: "archived" as const }));
    const service = scheduler({ ensureFresh: fresh, nativeArchive: native });
    await service.runDue(); expect(fresh).not.toHaveBeenCalled();
    clock = epoch + 2000 + 3 * HOUR;
    await vi.advanceTimersByTimeAsync(HOUR + 2000);
    expect(archived(codex.id)).toBe(true); expect(archived(claude.id)).toBe(false);
    expect(fresh.mock.calls.map(call => call[1])).toEqual([codex.id]);
    expect(native).toHaveBeenCalledWith(codex.nativeId);
    reconcileIngestedChildRetention(db, codex.id, codex.file, [{ type: "user_message", role: "user", position: 100,
      timestamp: new Date(clock + 1000).toISOString(), metadata: { source_event_type: "user" } }]);
    expect(archived(codex.id)).toBe(false);
    expect(state(codex.id)).toMatchObject({ last_input_at: clock + 1000, activity_state: "active", due_at: clock + 1000 + 3 * HOUR,
      last_native_outcome: null });
  });

  it("defers active or unknown execution and unavailable freshness without consulting native history", async () => {
    const chat = await child("codex");
    move(epoch + 4 * HOUR);
    new SessionExecutionStore(db).apply({ provider: "codex", provider_session_id: chat.nativeId, source: "codex_hook", event: "UserPromptSubmit",
      turn_id: "silent", state: { kind: "working" }, observed_at: epoch + 3000 });
    const native = vi.fn(async () => ({ status: "archived" as const }));
    let unavailable = false;
    const service = scheduler({ nativeArchive: native, ensureFresh: async () => {
      if (unavailable) throw new Error("freshness_pending");
      return { conversationId: chat.id, sourceId: "source", sourcePath: chat.file, refreshed: false };
    } });
    await service.runDue(); expect(archived(chat.id)).toBe(false);
    expect(state(chat.id).last_native_outcome).toContain("execution_or_dispatch_pending");
    new SessionExecutionStore(db).apply({ provider: "codex", provider_session_id: chat.nativeId, source: "codex_hook", event: "Stop",
      turn_id: "old", state: { kind: "stopped" }, observed_at: epoch + 4000 });
    projectChildRetentionActivity(db, chat.id, [{ type: "user_message", role: "user", timestamp: new Date(epoch + 5000).toISOString(),
      position: 100, metadata: { source_event_type: "user" } }]);
    await service.runDue(); expect(archived(chat.id)).toBe(false);
    new SessionExecutionStore(db).apply({ provider: "codex", provider_session_id: chat.nativeId, source: "codex_hook", event: "SessionStart",
      turn_id: null, state: { kind: "unknown" }, observed_at: clock });
    move(clock + 60000); await service.runDue(); expect(archived(chat.id)).toBe(false);
    unavailable = true; move(clock + 120000); await service.runDue();
    expect(state(chat.id).last_native_outcome).toContain("freshness_pending");
    expect(native).not.toHaveBeenCalled();
  });

  it("recovers native retry after restart while local restore suppresses stale archive echoes", async () => {
    const chat = await child("codex");
    move(epoch + 4 * HOUR);
    const fresh = async () => ({ conversationId: chat.id, sourceId: "source", sourcePath: chat.file, refreshed: false });
    const first = scheduler({ ensureFresh: fresh, nativeArchive: async () => ({ status: "deferred", reason: "desktop_writer_owned" }) });
    await first.runDue(); expect(archived(chat.id)).toBe(true); expect(state(chat.id).native_pending).toBe(1);
    await first.stop();
    let interruptWithInput = false;
    const native = vi.fn(async () => {
      if (interruptWithInput) {
        await Promise.resolve();
        const applied = new SessionExecutionStore(db).apply({ provider: "codex", provider_session_id: chat.nativeId,
          source: "codex_hook", event: "UserPromptSubmit", turn_id: "resumed", state: { kind: "working" }, observed_at: clock });
        second.observe({ type: DOMAIN_EVENTS.SESSION_EXECUTION_UPDATED, timestamp: new Date(clock).toISOString(),
          data: { provider: "codex", provider_session_id: chat.nativeId, observation: applied.observation } });
      }
      return { status: "archived" as const };
    });
    const second = scheduler({ ensureFresh: fresh, nativeArchive: native });
    move(clock + 60000); await second.runDue();
    expect(native).toHaveBeenCalledTimes(1); expect(state(chat.id).native_pending).toBe(0);
    setConversationArchiveState(db, { conversation_id: chat.id, archived: false, cause: "manual" }, actor);
    const restoredDue = state(chat.id).due_at;
    reconcileIngestedChildRetention(db, chat.id, "/native/archived_sessions/echo.jsonl", chat.parsed.blocks);
    expect(archived(chat.id)).toBe(false); expect(state(chat.id).due_at).toBe(restoredDue);
    const settings = readChildRetentionSettings(db); settings.enabled = false; writeChildRetentionSettings(db, settings, clock);
    move(clock + 100 * HOUR); await second.runDue(); expect(native).toHaveBeenCalledTimes(1);
    expect(archived(chat.id)).toBe(false);
    settings.enabled = true; writeChildRetentionSettings(db, settings, clock); interruptWithInput = true;
    await second.runDue(); expect(archived(chat.id)).toBe(false); expect(native).toHaveBeenCalledTimes(2);
    expect(state(chat.id)).toMatchObject({ native_pending: 0, last_native_outcome: null, restored_at: clock, due_at: clock + 3 * HOUR });
  });

  it("keeps native descendants outside the archive effect and preserves local cleanup when queue knowledge is unavailable", async () => {
    const chat = await child("codex");
    db.prepare(`INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,title,started_at,session_id,
      parent_source,parent_session_id,parent_conversation_id,is_sidechain,created_at,updated_at)
      VALUES('active-descendant','codex','/unread','hash',1,'Active','2026-01-01','native-descendant','codex',?,?,1,'2026-01-01','2026-01-01')`)
      .run(chat.nativeId, chat.id);
    const native = vi.fn(async () => ({ status: "archived" as const }));
    const service = scheduler({ nativeArchive: native, ensureFresh: async () => ({ conversationId: chat.id, sourceId: "source", sourcePath: chat.file, refreshed: false }) });
    move(epoch + 4 * HOUR); await service.runDue();
    expect(archived(chat.id)).toBe(true); expect(archived("active-descendant")).toBe(false);
    expect(state(chat.id).last_native_outcome).toContain("native_descendants_present");
    expect(native).not.toHaveBeenCalled();
    await service.stop();
    db.prepare("DELETE FROM conversations WHERE id='active-descendant'").run();
    const retry = scheduler({ nativeArchive: native, pendingNativeQueue: async () => ({ status: "unknown", reason: "writer unavailable" }),
      ensureFresh: async () => ({ conversationId: chat.id, sourceId: "source", sourcePath: chat.file, refreshed: false }) });
    move(clock + 60000); await retry.runDue();
    expect(archived(chat.id)).toBe(true); expect(state(chat.id).last_native_outcome).toContain("native_queue_unavailable");
    expect(native).not.toHaveBeenCalled();
  });

  it("gates resolved workers by positive lineage and every outstanding assignment, then deduplicates after restore", async () => {
    const chat = await child("claude_code", "worker");
    db.prepare(`INSERT INTO work_units(id,issue_id,repo_id,state,worker_provider,worker_provider_session_id,created_at)
      VALUES('done','','mandible','resolved','claude_code',?,1),('held','','mandible','open','claude_code',?,1)`).run(chat.nativeId, chat.nativeId);
    expect(scheduleResolvedWorkerArchive(db, "claude_code", chat.nativeId, clock)).toBe(false);
    db.prepare("UPDATE work_units SET state='resolved' WHERE id='held'").run();
    expect(scheduleResolvedWorkerArchive(db, "claude_code", chat.nativeId, clock)).toBe(true);
    const service = scheduler({ ensureFresh: async () => ({ conversationId: chat.id, sourceId: "source", sourcePath: chat.file, refreshed: false }) });
    await service.runDue(); expect(archived(chat.id)).toBe(true);
    setConversationArchiveState(db, { conversation_id: chat.id, archived: false, cause: "manual" }, actor);
    expect(scheduleResolvedWorkerArchive(db, "claude_code", chat.nativeId, clock)).toBe(false);
    db.prepare("UPDATE conversations SET opening_lineage='successor' WHERE id=?").run(chat.id);
    expect(getRetainedChild(db, chat.id)).toBeNull();
    expect(scheduleResolvedWorkerArchive(db, "claude_code", chat.nativeId, clock)).toBe(false);
    await service.stop();
    const codex = await child("codex", "worker");
    db.prepare(`INSERT INTO work_units(id,issue_id,repo_id,state,worker_provider,worker_provider_session_id,created_at)
      VALUES('changing','','mandible','resolved','codex',?,1)`).run(codex.nativeId);
    expect(scheduleResolvedWorkerArchive(db, "codex", codex.nativeId, clock)).toBe(true);
    const race = scheduler({ ensureFresh: async () => ({ conversationId: codex.id, sourceId: "source", sourcePath: codex.file, refreshed: false }),
      pendingNativeQueue: async () => { db.prepare("UPDATE work_units SET state='open' WHERE id='changing'").run(); return { status: "known", pending: false }; },
      nativeArchive: async () => { throw new Error("must not archive reassigned work"); } });
    await race.runDue(); expect(archived(codex.id)).toBe(false);
  });

  it("keeps a large unrelated index and previews free of native calls before a deadline", async () => {
    const chat = await child("codex");
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,title,started_at,session_id,created_at,updated_at)
      SELECT 'root-'||x,'codex','/unread-large-history/'||x,'hash',1,'Root','2026-01-01','native-'||x,'2026-01-01','2026-01-01' FROM n`);
    const fresh = vi.fn(); const native = vi.fn();
    const service = scheduler({ ensureFresh: fresh, nativeArchive: native });
    await service.runDue(); expect(fresh).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
    expect(db.prepare(`EXPLAIN QUERY PLAN SELECT conversation_id FROM conversation_retention_state WHERE due_at IS NOT NULL AND due_at<=? ORDER BY due_at,conversation_id LIMIT 16`).all(clock))
      .toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining("idx_conversation_retention_due") })]));
    await service.stop(); const preview = scheduler({ effectsAllowed: false, ensureFresh: fresh, nativeArchive: native });
    move(epoch + 100 * HOUR); await preview.runDue();
    expect(archived(chat.id)).toBe(false); expect(fresh).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  });
});
