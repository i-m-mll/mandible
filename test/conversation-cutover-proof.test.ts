import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditCutover,
  buildCompactDestination,
  inspectSourceBinding,
  runRestoreDrill,
  stableJson,
} from "../scripts/conversation-cutover-proof.mjs";

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
  const db = new Database(source);
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
    const rebuilt = new Database(destination, { readonly: true });
    expect(rebuilt.prepare("SELECT content FROM conversation_blocks WHERE id = 'block-legacy'").pluck().get()).toBe("kept");
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
    const db = new Database(source);
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
