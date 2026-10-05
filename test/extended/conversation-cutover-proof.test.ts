import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditCutover,
  buildCompactDestination,
  buildLegacyReclaimedDestination,
  buildSparseConversationStructureCache,
  inspectLegacyReclaimReadiness,
  inspectSourceBinding,
  runRestoreDrill,
  stableJson,
} from "../../scripts/conversation-cutover-proof.mjs";
import { migrate } from "../../src/db.js";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-cutover-proof-"));
  roots.push(root);
  const source = path.join(root, "source.sqlite");
  const db = new SqliteDatabase(source);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_conversation_id TEXT REFERENCES conversations(id),
      is_sidechain INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT
    );
    CREATE TABLE conversation_blocks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      type TEXT NOT NULL,
      role TEXT NOT NULL,
      content BLOB NOT NULL,
      compressed INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      parent_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      dag_uuid TEXT,
      dag_parent_uuid TEXT
    );
    CREATE TABLE workflow_workers (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id)
    );
    CREATE TABLE conversation_search_cache (conversation_id TEXT, body TEXT);
  `);
  db.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)")
    .run("conv-live", "codex", "session-live", null, 0, null);
  db.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)")
    .run("conv-legacy", "claude_code", "session-legacy", "conv-live", 1, "agent-1");
  db.prepare("INSERT INTO conversation_blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("block-live", "conv-live", "message", "user", "hello", 0, 0, null, '{"b":2,"a":1}', "dag-1", null);
  db.prepare("INSERT INTO conversation_blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("block-legacy", "conv-legacy", "message", "assistant", "kept", 0, 0, null, '{}', "dag-2", "dag-1");
  db.prepare("INSERT INTO workflow_workers VALUES (?, ?, ?)").run("worker-1", "workflow-1", "conv-live");
  db.prepare("INSERT INTO conversation_search_cache VALUES (?, ?)").run("conv-live", "hello");
  db.close();
  return { root, source };
}

function liveProjection() {
  return {
    identity: {
      id: "conv-live",
      source: "codex",
      session_id: "session-live",
      parent_conversation_id: null,
      is_sidechain: 0,
      agent_id: null,
    },
    blocks: [{
      id: "block-live",
      type: "message",
      role: "user",
      content_sha256: sha256("hello"),
      metadata: { b: 2, a: 1 },
      position: 0,
      parent_id: null,
      dag_uuid: "dag-1",
      dag_parent_uuid: null,
    }],
    annotations: [],
    relationships: [
      { type: "parent_child", source: "conv-live", target: "conv-legacy" },
      { type: "workflow_worker", source: "workflow-1", target: "worker-1" },
    ],
  };
}

function passingEvidence(source: string) {
  const metric = { p95_ms: 10, budget_ms: 20, peak_rss_bytes: 100, rss_budget_bytes: 200 };
  return {
    binding: inspectSourceBinding(source),
    conversation_evidence: [{
      conversation_id: "conv-live",
      classification: "verified-live-source",
      verified: true,
      projection: liveProjection(),
    }],
    search: {
      adapter_verified: true,
      comparisons: [
        { query: "é\n?", legacy_results: ["block-live"], source_results: ["block-live"] },
        { query: "x", legacy_results: [], source_results: [] },
      ],
    },
    performance: {
      cold_detail: metric,
      hot_detail: metric,
      cold_search: metric,
      hot_search: metric,
    },
    gates: {
      locator_refresh: { pass: true, adapter: "source-test" },
      security_redaction: { pass: true, adapter: "cache-test" },
      rollback_kill_switch: {
        pass: true,
        adapter: "runtime-test",
        evidence: {
          retention_days: 31,
          legacy_database_verified: true,
          kill_switch_tested: true,
          default_reader_unchanged: true,
        },
      },
    },
  };
}

describe("conversation cutover compact rebuild", () => {
  it("keeps the source byte-identical, excludes disposable cache, and reports exact table parity", () => {
    const { root, source } = fixture();
    const before = fs.readFileSync(source);
    const destination = path.join(root, "compact.sqlite");
    const report = buildCompactDestination({ source, destination });

    expect(report.pass).toBe(true);
    expect(report.excluded_tables).toEqual(["conversation_search_cache"]);
    expect(fs.readFileSync(source)).toEqual(before);
    const rebuilt = new SqliteDatabase(destination, { readonly: true });
    expect(rebuilt.prepare("SELECT content FROM conversation_blocks WHERE id = 'block-legacy'").get()?.content).toBe("kept");
    expect(rebuilt.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_search_cache'").get()).toBeUndefined();
    expect(rebuilt.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(rebuilt.pragma("foreign_key_check")).toEqual([]);
    rebuilt.close();
  });

  it("refuses an existing destination and source aliases", () => {
    const { root, source } = fixture();
    expect(() => buildCompactDestination({ source, destination: source })).toThrow(/distinct/);
    const destination = path.join(root, "occupied.sqlite");
    fs.writeFileSync(destination, "owned");
    expect(() => buildCompactDestination({ source, destination })).toThrow(/already exists/);
    expect(fs.readFileSync(destination, "utf8")).toBe("owned");
    const productionAlias = path.join(os.userInfo().homedir, ".mandible", "mandible.db");
    expect(() => buildCompactDestination({ source, destination: productionAlias })).toThrow(/production database alias/);
    const aliasRoot = path.join(root, "production-alias");
    fs.symlinkSync(path.dirname(productionAlias), aliasRoot);
    expect(() => buildCompactDestination({ source, destination: path.join(aliasRoot, "mandible.db") }))
      .toThrow(/production database alias/);
  });

  it("recovers only its marked partial output after interruption", () => {
    const { root, source } = fixture();
    const destination = path.join(root, "compact.sqlite");
    expect(() => buildCompactDestination({ source, destination, interruptAfterTables: 1 })).toThrow(/interruption/);
    expect(fs.existsSync(`${destination}.rebuild-in-progress.json`)).toBe(true);
    expect(fs.existsSync(`${destination}.partial`)).toBe(true);
    const recovered = buildCompactDestination({ source, destination });
    expect(recovered.recovered_partial).toBe(true);
    expect(fs.existsSync(`${destination}.rebuild-in-progress.json`)).toBe(false);
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("preserves pre-existing foreign-key violations without creating new ones", () => {
    const { root, source } = fixture();
    const sourceDb = new SqliteDatabase(source);
    sourceDb.pragma("foreign_keys = OFF");
    sourceDb.prepare("INSERT INTO workflow_workers VALUES (?, ?, ?)")
      .run("orphan-worker", "old-workflow", "missing-conversation");
    sourceDb.close();

    const destination = path.join(root, "compact-with-orphan.sqlite");
    const report = buildCompactDestination({ source, destination });
    expect(report).toMatchObject({
      pass: true,
      foreign_key_parity: { source: 1, destination: 1, match: true },
      foreign_key_violations: [{
        table: "workflow_workers",
        rowid: 2,
        parent: "conversations",
        fkid: 0,
      }],
    });
    const rebuilt = new SqliteDatabase(destination, { readonly: true });
    expect(rebuilt.pragma("foreign_key_check")).toHaveLength(1);
    rebuilt.close();
  });

  it("proves exact projected digests for deliberately reclaimed conversation tables", () => {
    const { root, source } = fixture();
    const sourceDb = new SqliteDatabase(source);
    sourceDb.exec(`
      CREATE TABLE conversation_normalization_checkpoints (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE conversation_structural_blocks (
        id TEXT PRIMARY KEY,
        normalization_checkpoint_id TEXT REFERENCES conversation_normalization_checkpoints(id),
        body TEXT NOT NULL
      );
      INSERT INTO conversation_normalization_checkpoints VALUES ('checkpoint-one', '{"kind":"codex-model-metadata","version":1}');
      INSERT INTO conversation_normalization_checkpoints VALUES ('orphaned-checkpoint', '{"strategy":"replay-prefix"}');
      INSERT INTO conversation_structural_blocks VALUES ('structural-one', 'checkpoint-one', 'exact body');
    `);
    sourceDb.prepare("INSERT INTO conversation_normalization_checkpoints VALUES (?, ?)").run(
      "large-obsolete-checkpoint",
      JSON.stringify({ strategy: "replay-prefix", obsolete_payload: "x".repeat(2 * 1024 * 1024) }),
    );
    sourceDb.close();

    const destination = path.join(root, "compact-reclaimed-checkpoints.sqlite");
    const report = buildCompactDestination({
      source,
      destination,
      reclaimConversationCheckpoints: true,
    });
    expect(report.table_parity.conversation_normalization_checkpoints).toMatchObject({ match: true });
    expect(report.table_parity.conversation_structural_blocks).toMatchObject({ match: true });
    expect(report.table_parity.conversation_normalization_checkpoints.source)
      .toEqual(report.table_parity.conversation_normalization_checkpoints.destination);
    expect(report.table_parity.conversation_structural_blocks.source)
      .toEqual(report.table_parity.conversation_structural_blocks.destination);
    expect(report.copied_rows.conversation_normalization_checkpoints).toBe(1);
    expect(report.destination.size_bytes).toBeLessThan(512 * 1024);

    const rebuilt = new SqliteDatabase(destination, { readonly: true });
    expect(rebuilt.prepare("SELECT * FROM conversation_structural_blocks").get()).toEqual({
      id: "structural-one",
      normalization_checkpoint_id: "checkpoint-one",
      body: "exact body",
    });
    expect(rebuilt.prepare("SELECT id FROM conversation_normalization_checkpoints ORDER BY id").all())
      .toEqual([{ id: "checkpoint-one" }]);
    rebuilt.close();
  });
});

describe("legacy storage reclaim", () => {
  it("moves only integer navigation coordinates into the disposable sparse cache", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-sparse-cache-"));
    roots.push(root);
    const source = path.join(root, "source.db");
    const destination = path.join(root, "structure.db");
    const db = new SqliteDatabase(source);
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, source_hash TEXT NOT NULL,
        block_count INTEGER NOT NULL
      );
      CREATE TABLE conversation_sources (
        conversation_id TEXT NOT NULL, provider TEXT NOT NULL, current_version_id TEXT,
        parser_format TEXT NOT NULL, parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL, redaction_epoch INTEGER NOT NULL
      );
      CREATE TABLE conversation_source_versions (id TEXT PRIMARY KEY, content_sha256 TEXT NOT NULL);
      CREATE TABLE conversation_structural_blocks (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_version_id TEXT,
        status TEXT NOT NULL, provider_key TEXT NOT NULL, position INTEGER NOT NULL,
        type TEXT NOT NULL, role TEXT NOT NULL,
        parent_block_id TEXT, record_offset INTEGER, record_length INTEGER,
        record_ordinal INTEGER, sub_block_ordinal INTEGER NOT NULL
      );
      INSERT INTO conversations VALUES ('conv', 'codex', 'hash', 2);
      INSERT INTO conversation_sources VALUES ('conv', 'codex', 'version', 'provider-jsonl', '1', '1', 0);
      INSERT INTO conversation_source_versions VALUES ('version', 'hash');
      INSERT INTO conversation_structural_blocks VALUES
        ('block-0', 'conv', 'version', 'current', 'tool:call-1:tool_use:0:record:1:10:hash', 0, 'tool_use', 'assistant', NULL, 10, 20, 1, 0),
        ('block-1', 'conv', 'version', 'current', 'tool:call-1:tool_result:0:record:2:30:hash', 1, 'tool_result', 'tool', 'block-0', 30, 40, 2, 0);
    `);
    db.close();

    const report = buildSparseConversationStructureCache({ source, destination });
    expect(report).toMatchObject({ pass: true, conversations: 1, blocks: 2, tool_links: 1 });
    const cache = new SqliteDatabase(destination, { readonly: true });
    expect(cache.prepare(`
      SELECT position, type_code, role_code, parent_position,
             record_offset, record_length, record_ordinal, sub_block_ordinal
        FROM cache_blocks ORDER BY position
    `).all()).toEqual([
      { position: 0, type_code: 4, role_code: 1, parent_position: null, record_offset: 10, record_length: 20, record_ordinal: 1, sub_block_ordinal: 0 },
      { position: 1, type_code: 5, role_code: 3, parent_position: 0, record_offset: 30, record_length: 40, record_ordinal: 2, sub_block_ordinal: 0 },
    ]);
    expect(cache.prepare("SELECT name FROM pragma_table_info('cache_blocks') ORDER BY cid").all())
      .not.toContainEqual({ name: "content" });
    cache.close();
  });

  it("refuses reclaim while any legacy conversation payload remains", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-reclaim-legacy-"));
    roots.push(root);
    const source = path.join(root, "mandible.db");
    const db = new SqliteDatabase(source);
    migrate(db);
    db.prepare(`
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        block_count, session_id, tags, created_at, updated_at
      ) VALUES ('legacy-conversation', 'codex', '/tmp/legacy', 'hash', 1, 'legacy',
                'now', 1, 'legacy-session', '[]', 'now', 'now')
    `).run();
    db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, position, metadata_json
      ) VALUES ('legacy-block', 'legacy-conversation', 'assistant_message', 'assistant',
                'must remain', 0, '{}')
    `).run();
    db.close();

    const readiness = inspectLegacyReclaimReadiness({ source });
    expect(readiness).toMatchObject({ pass: false, legacy_payloads: 1 });
    expect(readiness.errors).toContain("1 legacy conversation block payloads remain");
  });

  it("requires recorded log verification and builds a compact destination without legacy logs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-reclaim-proof-"));
    roots.push(root);
    const source = path.join(root, "mandible.db");
    const logDbPath = path.join(root, "operational-logs.db");
    const destination = path.join(root, "reclaimed.db");
    const db = new SqliteDatabase(source);
    migrate(db);
    db.prepare(`
      INSERT INTO daemon_log (id, ts, level, event, subsystem, fields_json)
      VALUES ('legacy-one', 100, 'info', 'legacy', 'test', '{}')
    `).run();
    db.close();

    const logDb = new SqliteDatabase(logDbPath);
    logDb.exec(`
      CREATE TABLE operational_log_copy_state (
        source_path TEXT PRIMARY KEY, last_ts INTEGER, last_id TEXT,
        completed_at INTEGER, verified_at INTEGER,
        verified_legacy_rows INTEGER, verified_primary_rows INTEGER,
        legacy_high_water_ts INTEGER, legacy_high_water_id TEXT,
        legacy_high_water_rows INTEGER, legacy_generation_rowid INTEGER,
        copied_rows INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      )
    `);
    logDb.prepare(`
      INSERT INTO operational_log_copy_state VALUES (?, 100, 'legacy-one', 1, 2, 1, 1, 100, 'legacy-one', 1, 1, 1, 2)
    `).run(fs.realpathSync.native(source));
    logDb.close();

    expect(inspectLegacyReclaimReadiness({ source, logDb: logDbPath })).toMatchObject({ pass: true });
    const report = buildLegacyReclaimedDestination({ source, destination, logDb: logDbPath });
    expect(report).toMatchObject({
      pass: true,
      structure_cache: { pass: true },
      rebuild: { reclaimed_dense_conversation_index: true },
    });
    const rebuilt = new SqliteDatabase(destination, { readonly: true });
    expect(rebuilt.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daemon_log'").get())
      .toBeUndefined();
    expect(rebuilt.prepare("SELECT COUNT(*) AS count FROM conversation_normalization_checkpoints").get())
      .toEqual({ count: 0 });
    rebuilt.close();
    const original = new SqliteDatabase(source, { readonly: true });
    expect(original.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 1 });
    original.close();
  });
});

describe("conversation cutover audit", () => {
  it("classifies legacy bodies, checks full projections, and remains a deterministic NO-GO checklist", () => {
    const { root, source } = fixture();
    const destination = path.join(root, "compact.sqlite");
    const rebuild = buildCompactDestination({ source, destination });
    const restore = {
      binding: inspectSourceBinding(source),
      pass: true,
      run_id: "restore-one",
      destination_root: path.join(root, "restore-one"),
      original_provider_roots_used: false,
      metadata: { integrity_check: "ok", foreign_key_violations: [] },
      custody: { pass: true, manifest_present: true },
      collision_policy: "destination-must-not-exist",
    };
    const options = {
      source,
      evidence: passingEvidence(source),
      rebuildReport: rebuild,
      restoreDrillReports: [restore, {
        ...restore,
        run_id: "restore-two",
        destination_root: path.join(root, "restore-two"),
      }],
    };
    const first = auditCutover(options);
    const second = auditCutover(options);
    expect(first).toMatchObject({
      report_kind: "source-bound-evidence-checklist",
      decision: "NO-GO",
      pass: false,
      go_authority: false,
    });
    expect(first.failed_gates).toEqual(["automated_go_authority"]);
    expect(first.gates.coverage.counts).toEqual({
      "verified-live-source": 1,
      "verified-managed-custody": 0,
      "legacy-body-only": 1,
    });
    expect(first.gates.dual_read_shadow).toMatchObject({ pass: true, compared: 1, mismatches: [] });
    expect(stableJson(first)).toBe(stableJson(second));
  });

  it("fails closed on projection/search mismatch, missing provider evidence, and missing restore drills", () => {
    const { source } = fixture();
    const evidence = passingEvidence(source);
    evidence.conversation_evidence[0].projection.blocks[0].role = "assistant";
    delete (evidence.conversation_evidence[0].projection as { annotations?: unknown }).annotations;
    evidence.search.comparisons[0].source_results = [];
    delete evidence.gates.locator_refresh;
    const report = auditCutover({ source, evidence });
    expect(report.decision).toBe("NO-GO");
    expect(report.failed_gates).toEqual(expect.arrayContaining([
      "dual_read_shadow",
      "exact_search_parity",
      "locator_refresh",
      "compact_rebuild",
      "fresh_machine_recovery",
    ]));
    expect(report.gates.locator_refresh.errors).toEqual(["missing_adapter_evidence"]);
    expect(report.gates.dual_read_shadow.mismatches[0].mismatches).toEqual(expect.arrayContaining(["blocks", "annotations"]));
  });

  it("retains missing-provider conversations as legacy-body-only", () => {
    const { source } = fixture();
    const report = auditCutover({
      source,
      evidence: {
        binding: inspectSourceBinding(source),
        conversation_evidence: [{ conversation_id: "conv-live", error: "missing_provider_root" }],
      },
    });
    expect(report.gates.coverage.pass).toBe(true);
    expect(report.gates.coverage.counts["legacy-body-only"]).toBe(2);
    expect(report.gates.coverage.conversations.find((row: { conversation_id: string }) => row.conversation_id === "conv-live")?.evidence_error)
      .toBe("missing_provider_root");
    expect(report.decision).toBe("NO-GO");
  });

  it("rejects unbound pass assertions and duplicate restore-run evidence", () => {
    const { root, source } = fixture();
    const evidence = passingEvidence(source);
    delete (evidence as { binding?: unknown }).binding;
    const binding = inspectSourceBinding(source);
    const restore = {
      binding,
      pass: true,
      run_id: "reused-run",
      destination_root: path.join(root, "same-restore"),
      original_provider_roots_used: false,
      metadata: { integrity_check: "ok", foreign_key_violations: [] },
      custody: { pass: true, manifest_present: true },
      collision_policy: "destination-must-not-exist",
    };
    const report = auditCutover({
      source,
      evidence,
      restoreDrillReports: [restore, { ...restore }],
    });
    expect(report.gates.evidence_binding).toMatchObject({
      pass: false,
      errors: ["unbound_or_mismatched_evidence_packet"],
    });
    expect(report.gates.locator_refresh).toMatchObject({ pass: false, errors: ["unbound_evidence_packet"] });
    expect(report.gates.fresh_machine_recovery).toMatchObject({
      pass: false,
      completed: 2,
      distinct_run_ids: 1,
      distinct_destinations: 1,
    });
    expect(report.decision).toBe("NO-GO");
  });

  it("rejects evidence bound before the source database changes", () => {
    const { source } = fixture();
    const evidence = passingEvidence(source);
    const db = new SqliteDatabase(source);
    db.prepare("UPDATE conversation_blocks SET content = ? WHERE id = ?").run("changed", "block-live");
    db.close();

    const report = auditCutover({ source, evidence });
    expect(report.gates.evidence_binding).toMatchObject({
      pass: false,
      errors: ["unbound_or_mismatched_evidence_packet"],
    });
    expect(report.decision).toBe("NO-GO");
  });

  it("prints one machine-readable NO-GO result and names every missing CLI gate", () => {
    const { root, source } = fixture();
    const evidencePath = path.join(root, "evidence.json");
    fs.writeFileSync(evidencePath, "{}\n", "utf8");
    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), "scripts", "conversation-cutover-proof.mjs"),
      "audit",
      "--source", source,
      "--evidence", evidencePath,
      "--json",
    ], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.decision).toBe("NO-GO");
    expect(report.failed_gates).toEqual(expect.arrayContaining([
      "dual_read_shadow",
      "exact_search_parity",
      "parser_performance",
      "locator_refresh",
      "security_redaction",
      "compact_rebuild",
      "fresh_machine_recovery",
      "rollback_kill_switch",
    ]));
    expect(result.stdout.trim().split(/\n/)[0]).toBe("{");
  });
});

describe("fresh-machine restore drill", () => {
  it("restores metadata plus verified custody without provider roots and detects corrupt custody", () => {
    const { root, source } = fixture();
    const metadataSql = path.join(root, "metadata.sql");
    fs.writeFileSync(metadataSql, "CREATE TABLE durable (id TEXT PRIMARY KEY); INSERT INTO durable VALUES ('one');", "utf8");
    const custody = path.join(root, "custody-input");
    fs.mkdirSync(custody);
    fs.writeFileSync(path.join(custody, "manifest.json"), '{"format":"test"}\n');
    fs.writeFileSync(path.join(custody, "native.jsonl"), "native bytes\n");
    fs.writeFileSync(
      path.join(custody, "SHA256SUMS"),
      `${sha256(fs.readFileSync(path.join(custody, "manifest.json")))}  manifest.json\n${sha256(fs.readFileSync(path.join(custody, "native.jsonl")))}  native.jsonl\n`,
    );
    const restoredRoot = path.join(root, "fresh-machine-one");
    const report = runRestoreDrill({ source, metadataSql, custodyRoot: custody, destinationRoot: restoredRoot });
    expect(report).toMatchObject({ pass: true, original_provider_roots_used: false });
    expect(report).toMatchObject({
      report_kind: "fresh-machine-restore-evidence",
      binding: inspectSourceBinding(source),
      destination_root: fs.realpathSync.native(restoredRoot),
    });
    expect(typeof report.run_id).toBe("string");
    expect(() => runRestoreDrill({ source, metadataSql, custodyRoot: custody, destinationRoot: restoredRoot })).toThrow(/already exists/);

    const second = runRestoreDrill({
      source,
      metadataSql,
      custodyRoot: custody,
      destinationRoot: path.join(root, "fresh-machine-two"),
    });
    expect(second.pass).toBe(true);

    fs.writeFileSync(path.join(custody, "native.jsonl"), "corrupt\n");
    expect(() => runRestoreDrill({
      source,
      metadataSql,
      custodyRoot: custody,
      destinationRoot: path.join(root, "fresh-machine-corrupt"),
    })).toThrow(/verification failed/);
  });

  it("rejects symlinked custody inputs even when their target hash matches", () => {
    const { root, source } = fixture();
    const metadataSql = path.join(root, "metadata.sql");
    fs.writeFileSync(metadataSql, "CREATE TABLE durable (id TEXT PRIMARY KEY);", "utf8");
    const outside = path.join(root, "outside-native.jsonl");
    fs.writeFileSync(outside, "outside\n");
    const custody = path.join(root, "custody-symlink");
    fs.mkdirSync(custody);
    fs.writeFileSync(path.join(custody, "manifest.json"), "{}\n");
    fs.symlinkSync(outside, path.join(custody, "native.jsonl"));
    fs.writeFileSync(
      path.join(custody, "SHA256SUMS"),
      `${sha256(fs.readFileSync(path.join(custody, "manifest.json")))}  manifest.json\n${sha256(fs.readFileSync(outside))}  native.jsonl\n`,
    );
    expect(() => runRestoreDrill({
      source,
      metadataSql,
      custodyRoot: custody,
      destinationRoot: path.join(root, "fresh-machine-symlink"),
    })).toThrow(/verification failed/);
  });
});
