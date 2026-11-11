import { migratedFileDb } from './helpers/ledger-fixtures.js';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { workerLedgerReaderPool } from "../src/ledger-reads/index.js";

it("keeps a one-second ledger read off the main loop and transports worker errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-reader-"));
  const dbPath = path.join(root, "ledger.db");
  const db = migratedFileDb(dbPath);
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

it("reads current lineage ledger snapshots on workers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-lineage-reader-"));
  const dbPath = path.join(root, "ledger.db");
  const db = migratedFileDb(dbPath);
  const reader = workerLedgerReaderPool(dbPath, { size: 1 });
  try {
    const insert = db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at,
      session_id, opening_lineage, parent_source, parent_session_id, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', 1, 'Child', ?, ?, 'child', 'codex', 'unindexed-parent', '2026-01-01', '2026-01-01')`);
    insert.run('old', 'codex', '/tmp/old', '2026-01-01', 'duplicate');
    insert.run('new', 'codex', '/tmp/new', '2026-10-01', 'duplicate');
    insert.run('other', 'gemini', '/tmp/other', '2026-10-02', 'other');

    const gaps = await reader.run("lineage_gaps", { since: null, source: null });
    expect(gaps.gaps.map(gap => gap.conversation_id)).toEqual(['other', 'new']);
    expect(gaps.counts.map(count => count.count)).toEqual([1, 1]);
    expect((await reader.run("lineage_gaps", { since: '2026-09-01', source: 'codex' })).gaps.map(gap => gap.conversation_id)).toEqual(['new']);
    db.prepare("UPDATE conversations SET opening_lineage = 'none', parent_source = NULL, parent_session_id = NULL WHERE source = 'codex'").run();
    expect((await reader.run("lineage_gaps", { since: null, source: 'codex' })).gaps).toEqual([]);
  } finally {
    await reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
