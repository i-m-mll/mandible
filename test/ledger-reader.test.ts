import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { workerLedgerReaderPool } from "../src/ledger-reads/index.js";
import { workUnitLivenessFromSnapshot } from "../src/work-unit-utils.js";
import { getChannelRegistry } from "../src/channel-registry.js";
import type { SessionManager } from "../src/session-manager.js";

it("keeps a one-second ledger read off the main loop and transports worker errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-reader-"));
  const dbPath = path.join(root, "ledger.db");
  const db = openDb(dbPath);
  const reader = workerLedgerReaderPool(dbPath, { size: 2 });
  let longestTurnMs = 0;
  let last = performance.now();
  const resolutionMs = 5;
  const timer = setInterval(() => {
    const now = performance.now();
    longestTurnMs = Math.max(longestTurnMs, now - last - resolutionMs);
    last = now;
  }, resolutionMs);
  try {
    const result = await reader.run("diagnostics_delay", { ms: 1000 });
    await new Promise(resolve => setTimeout(resolve, resolutionMs));
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(1000);
    expect(result.iterations).toBeGreaterThan(0);
    expect(longestTurnMs).toBeLessThan(150);
    await expect(reader.run("timeline_projection", {}))
      .rejects.toThrow("project_id or project_ref is required");
  } finally {
    clearInterval(timer);
    await reader.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reads current Inbox and lineage ledger snapshots on workers while retaining daemon-local activity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-inbox-reader-"));
  const dbPath = path.join(root, "ledger.db");
  const db = openDb(dbPath);
  const reader = workerLedgerReaderPool(dbPath, { size: 1 });
  const channels = getChannelRegistry();
  const channelConnected = vi.spyOn(channels, "isChannelConnected").mockReturnValue(false);
  const channelAlive = vi.spyOn(channels, "isAlive").mockReturnValue(false);
  try {
    db.prepare("INSERT INTO sessions (id, app, status, branch, continuation, ended_at) VALUES ('ended', 'claude', 'ended', 'feature/a', 'handoff', '2026-10-01')").run();
    db.prepare("INSERT INTO sessions (id, app, status, branch) VALUES ('active', 'claude', 'active', 'feature/b')").run();
    db.prepare("INSERT INTO console_sessions (id, label, command, status, mandible_session_id, created_at, updated_at) VALUES ('console', 'SDK', 'claude', 'running', 'active', 1, 1)").run();
    db.prepare("INSERT INTO work_units (id, issue_id, repo_id, branch, state, created_at) VALUES ('unit', 'issue', 'fixture', 'feature/b', 'open', 1)").run();
    const insert = db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at,
      session_id, opening_lineage, parent_source, parent_session_id, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', 1, 'Child', ?, ?, 'child', 'codex', 'unindexed-parent', '2026-01-01', '2026-01-01')`);
    insert.run('old', 'codex', '/tmp/old', '2026-01-01', 'duplicate');
    insert.run('new', 'codex', '/tmp/new', '2026-10-01', 'duplicate');
    insert.run('other', 'gemini', '/tmp/other', '2026-10-02', 'other');

    const scoped = await reader.run("inbox", { sessionId: "ended", repos: null, scope: { kind: "scoped", branch: "feature/a", repo: null } });
    expect(scoped.payload.continuations).toEqual([]);
    const global = await reader.run("inbox", { sessionId: "ended", repos: null, scope: { kind: "global" } });
    expect(global.payload.continuations).toMatchObject([{ session_id: 'ended', branch: 'feature/a', repo: null }]);

    const backend = { isProcessing: true };
    const manager = { get: (id: string) => id === "console" ? backend : undefined } as SessionManager;
    const prepare = vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("daemon liveness must not read SQLite"); });
    try {
      const live = workUnitLivenessFromSnapshot(global.liveness, manager);
      const unit = global.payload.work_units[0];
      expect(live(unit)).toMatchObject({ state: 'live', is_processing: true });
      backend.isProcessing = false;
      expect(live(unit)).toMatchObject({ state: 'live', is_processing: false });
      channelConnected.mockReturnValue(true);
      expect(live(unit)).toMatchObject({ state: 'stopped', agent_status: 'stale' });
      channelAlive.mockReturnValue(true);
      expect(live(unit)).toMatchObject({ state: 'live', agent_status: 'active' });
      expect(prepare).not.toHaveBeenCalled();
    } finally { prepare.mockRestore(); }

    const gaps = await reader.run("lineage_gaps", { since: null, source: null });
    expect(gaps.gaps.map(gap => gap.conversation_id)).toEqual(['other', 'new']);
    expect(gaps.counts.map(count => count.count)).toEqual([1, 1]);
    expect((await reader.run("lineage_gaps", { since: '2026-09-01', source: 'codex' })).gaps.map(gap => gap.conversation_id)).toEqual(['new']);
    db.prepare("UPDATE conversations SET opening_lineage = 'none', parent_source = NULL, parent_session_id = NULL WHERE source = 'codex'").run();
    expect((await reader.run("lineage_gaps", { since: null, source: 'codex' })).gaps).toEqual([]);
  } finally {
    channelConnected.mockRestore(); channelAlive.mockRestore();
    await reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
