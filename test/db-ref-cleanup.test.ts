import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCopiedDbRefCleanup } from "../scripts/rewrite-copied-db-refs.mjs";

let tempDir = "";
let dbPath = "";
let db: Database.Database;

const issueId = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const otherIssueId = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd";
const artifactHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const collidingArtifactHash = `aaaaaaa${"b".repeat(57)}`;
const malformedReferenceHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const commentId = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const authId = "123e4567-e89b-12d3-a456-426614174000";
const sessionId = "sess_abcdef12345";
const workUnitId = "70e3ed5f-3290-4323-942b-b745ec38fda3";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-ref-cleanup-"));
  dbPath = path.join(tempDir, "mandible.db");
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE ledger_issues (
      id TEXT PRIMARY KEY,
      short_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE ledger_issue_aliases (
      issue_id TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      external_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ledger_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL
    );
    CREATE TABLE ledger_body_revisions (
      id TEXT PRIMARY KEY,
      snapshot_body TEXT NOT NULL
    );
    CREATE TABLE ledger_events (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      algorithm TEXT NOT NULL DEFAULT 'sha256',
      content_hash TEXT NOT NULL,
      uri TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      reference_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE artifact_aliases (
      id TEXT PRIMARY KEY,
      artifact_id TEXT,
      scheme TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_ref TEXT NOT NULL,
      locator_json TEXT NOT NULL DEFAULT '{}',
      resolution_status TEXT NOT NULL DEFAULT 'resolved'
    );
    CREATE TABLE auth_requests (
      id TEXT PRIMARY KEY,
      spec_content TEXT,
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      diff_summary TEXT
    );
    CREATE TABLE ledger_work_unit_issue_links (
      work_unit_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE ledger_auth_issue_links (
      auth_request_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE conversation_blocks (
      id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE work_units (
      id TEXT PRIMARY KEY
    );
  `);
  db.prepare("INSERT INTO ledger_issues (id, short_id, project_id, body) VALUES (?, ?, ?, ?)").run(
    issueId,
    "abcdef0",
    "prj_mandible",
    [
      "See #abcdef0 and issue abcdef0.",
      "Commit abcdef0 should stay bare.",
      "Already [issue:abcdef0] and code `#abcdef0` stay.",
      "Link [#abcdef0](https://example.test) stays.",
      `Artifact artifact://sha256/${artifactHash} changes.`,
      "Naked artifact:aaaaaaa changes.",
      "Repo locator repo://mandible@main/results/report.md changes.",
      `Typed comment:abcdef0#com_2 auth:${authId.slice(0, 8)} session:${sessionId.slice(0, 8)} work_unit:${workUnitId.slice(0, 8)} change.`,
      "Event name auth:resolved stays naked.",
    ].join("\n"),
  );
  db.prepare("INSERT INTO ledger_issues (id, short_id, project_id, body) VALUES (?, ?, ?, ?)").run(
    otherIssueId,
    "1234567",
    "prj_mandible",
    "Other",
  );
  db.prepare(
    "INSERT INTO ledger_issue_aliases (issue_id, alias_kind, project_id, alias, source, is_primary) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(issueId, "legacy", "prj_mandible", "iss_legacy", "test", 0);
  db.prepare("INSERT INTO ledger_comments (id, issue_id, ordinal, body) VALUES (?, ?, ?, ?)").run(
    "comment-1",
    issueId,
    1,
    "Legacy iss_legacy and sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa. Plan artifact: `artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.",
  );
  db.prepare("INSERT INTO ledger_comments (id, issue_id, ordinal, body) VALUES (?, ?, ?, ?)").run(
    commentId,
    issueId,
    2,
    "Referenced comment target.",
  );
  db.prepare("INSERT INTO ledger_body_revisions (id, snapshot_body) VALUES (?, ?)").run(
    "revision-1",
    "Parent #abcdef0.",
  );
  db.prepare("INSERT INTO ledger_events (id, payload_json) VALUES (?, ?)").run(
    "event-1",
    JSON.stringify({ body: "Event issue:abcdef0 and file://tmp/artifacts/sha256/aa/" + artifactHash }),
  );
  db.prepare("INSERT INTO artifacts (id, content_hash, uri, metadata_json, reference_json) VALUES (?, ?, ?, ?, ?)").run(
    "artifact:sha256:" + artifactHash,
    artifactHash,
    "artifact://sha256/" + artifactHash,
    JSON.stringify({ ref: "artifact:sha256:" + artifactHash }),
    JSON.stringify({ notes: "See artifact://" + "sha256/" + artifactHash }),
  );
  db.prepare("INSERT INTO artifacts (id, content_hash, uri) VALUES (?, ?, ?)").run(
    "artifact:sha256:" + collidingArtifactHash,
    collidingArtifactHash,
    "file:///tmp/artifacts/sha256/aa/" + collidingArtifactHash,
  );
  db.prepare("INSERT INTO artifacts (id, content_hash, uri, metadata_json, reference_json) VALUES (?, ?, ?, ?, ?)").run(
    "artifact:ref:malformed-sha",
    malformedReferenceHash,
    "artifact://sha256/",
    JSON.stringify({ title: "artifact://sha256/", locator: { uri: "artifact://sha256/" } }),
    JSON.stringify({ normalized_ref: "artifact://sha256/", locator: { uri: "artifact://sha256/" } }),
  );
  db.prepare(
    "INSERT INTO artifact_aliases (id, artifact_id, scheme, alias, normalized_ref, locator_json, resolution_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "alias-1",
    "artifact:sha256:" + artifactHash,
    "artifact",
    "artifact://sha256/" + artifactHash,
    "artifact://sha256/" + artifactHash,
    JSON.stringify({ ref: "sha256:" + artifactHash }),
    "resolved",
  );
  db.prepare(
    "INSERT INTO artifact_aliases (id, artifact_id, scheme, alias, normalized_ref, locator_json, resolution_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "alias-repo",
    "artifact:sha256:" + artifactHash,
    "repo",
    "repo://mandible@main/results/report.md",
    "repo://mandible@main/results/report.md",
    JSON.stringify({ repo_id: "mandible", ref: "main", path: "results/report.md" }),
    "resolved",
  );
  db.prepare(
    "INSERT INTO artifact_aliases (id, artifact_id, scheme, alias, normalized_ref, locator_json, resolution_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("alias-bad", null, "artifact", "artifact://sha256/", "artifact://sha256/", "{}", "unresolved");
  db.prepare("INSERT INTO auth_requests (id, spec_content, output, diff_summary) VALUES (?, ?, ?, ?)").run(
    "auth-1",
    "Spec references #abcdef0.",
    "Merge commit abcdef0",
    "Diff mentions iss_legacy. Artifact sha256:" + artifactHash,
  );
  db.prepare("INSERT INTO auth_requests (id, spec_content, output, diff_summary) VALUES (?, ?, ?, ?)").run(
    authId,
    "Secondary auth row.",
    "",
    "",
  );
  db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);
  db.prepare("INSERT INTO work_units (id) VALUES (?)").run(workUnitId);
  db.prepare("INSERT INTO ledger_work_unit_issue_links (work_unit_id, issue_id, metadata_json) VALUES (?, ?, ?)").run(
    workUnitId,
    issueId,
    JSON.stringify({ legacy_issue_id: "iss_legacy", repo_id: "mandible", note: "See iss_legacy" }),
  );
  db.prepare("INSERT INTO ledger_auth_issue_links (auth_request_id, issue_id, metadata_json) VALUES (?, ?, ?)").run(
    authId,
    issueId,
    JSON.stringify({ legacy_issue_id: "iss_legacy", repo_id: "mandible", source_fields: ["issue_references"] }),
  );
  db.prepare("INSERT INTO conversation_blocks (id, metadata_json) VALUES (?, ?)").run(
    "block-1",
    JSON.stringify({ provider_url: "/api/ledger/issues/iss_legacy", text: "native log iss_legacy" }),
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("copied DB ref cleanup", () => {
  it("rewrites candidate refs while leaving source DB unchanged", async () => {
    const report = await runCopiedDbRefCleanup({
      sourceDb: dbPath,
      outputDir: path.join(tempDir, "out"),
      apply: true,
      timestamp: "20260609T000000Z",
    });

    expect(report.integrity_check).toBe("ok");
    expect(report.summary.issue_refs_rewritten).toBeGreaterThanOrEqual(5);
    expect(report.summary.legacy_issue_refs_rewritten).toBeGreaterThanOrEqual(5);
    expect(report.summary.legacy_issue_aliases_removed).toBe(1);
    expect(report.summary.legacy_issue_metadata_cleaned).toBe(2);
    expect(report.summary.artifact_refs_rewritten).toBeGreaterThanOrEqual(6);
    expect(report.summary.naked_typed_refs_bracketed).toBeGreaterThanOrEqual(1);
    expect(report.summary.malformed_artifact_aliases_removed).toBe(1);
    expect(report.summary.malformed_artifacts_removed).toBe(1);
    expect(report.removed_artifacts).toEqual([
      expect.objectContaining({
        id: "artifact:ref:malformed-sha",
        reason: "malformed reference artifact removed",
      }),
    ]);
    expect(fs.existsSync(report.backup_db)).toBe(true);
    expect(fs.existsSync(report.candidate_db)).toBe(true);
    expect(fs.existsSync(report.report_path)).toBe(true);

    const sourceBody = db.prepare("SELECT body FROM ledger_issues WHERE id = ?").get(issueId) as { body: string };
    expect(sourceBody.body).toContain("#abcdef0");

    const candidate = new Database(report.candidate_db, { readonly: true, fileMustExist: true });
    try {
      const issue = candidate.prepare("SELECT body FROM ledger_issues WHERE id = ?").get(issueId) as { body: string };
      expect(issue.body).toContain("[issue:abcdef0]");
      expect(issue.body).toContain("Commit abcdef0 should stay bare.");
      expect(issue.body).toContain("`#abcdef0`");
      expect(issue.body).toContain("[#abcdef0](https://example.test)");
      expect(issue.body).toContain("[artifact:aaaaaaaa]");
      expect(issue.body).toContain("[artifact:repo://mandible@main/results/report.md]");
      expect(issue.body).toContain("Naked artifact:aaaaaaa changes.");
      expect(issue.body).toContain("[comment:abcdef0#com_2]");
      expect(issue.body).toContain("[auth:123e4567]");
      expect(issue.body).toContain("[session:sess_abc]");
      expect(issue.body).toContain("[work_unit:70e3ed5f]");
      expect(issue.body).toContain("auth:resolved stays naked.");
      expect(issue.body).not.toContain("artifact://sha256/" + artifactHash);

      const event = candidate.prepare("SELECT payload_json FROM ledger_events WHERE id = 'event-1'").get() as { payload_json: string };
      expect(JSON.parse(event.payload_json)).toEqual({
        body: "Event [issue:abcdef0] and file://tmp/artifacts/sha256/aa/" + artifactHash,
      });

      const comment = candidate.prepare("SELECT body FROM ledger_comments WHERE id = 'comment-1'").get() as { body: string };
      expect(comment.body).toContain("Legacy [issue:abcdef0]");
      expect(comment.body).toContain("Plan artifact: [artifact:aaaaaaaa].");

      const auth = candidate.prepare("SELECT spec_content, output, diff_summary FROM auth_requests WHERE id = 'auth-1'").get() as {
        spec_content: string;
        output: string;
        diff_summary: string;
      };
      expect(auth.spec_content).toBe("Spec references [issue:abcdef0].");
      expect(auth.output).toBe("Merge commit abcdef0");
      expect(auth.diff_summary).toBe("Diff mentions [issue:abcdef0]. Artifact sha256:" + artifactHash);

      const legacyAliasCount = candidate.prepare(
        "SELECT COUNT(*) AS count FROM ledger_issue_aliases WHERE alias GLOB 'iss_*' OR external_id GLOB 'iss_*'",
      ).get() as { count: number };
      expect(legacyAliasCount.count).toBe(0);

      const workLink = candidate.prepare("SELECT metadata_json FROM ledger_work_unit_issue_links").get() as { metadata_json: string };
      const workMetadata = JSON.parse(workLink.metadata_json);
      expect(workMetadata).not.toHaveProperty("legacy_issue_id");
      expect(workMetadata.note).toBe("See [issue:abcdef0]");

      const authLink = candidate.prepare("SELECT metadata_json FROM ledger_auth_issue_links").get() as { metadata_json: string };
      const authMetadata = JSON.parse(authLink.metadata_json);
      expect(authMetadata).not.toHaveProperty("legacy_issue_id");
      expect(authMetadata.source_fields).toEqual(["issue_references"]);

      const block = candidate.prepare("SELECT metadata_json FROM conversation_blocks WHERE id = 'block-1'").get() as { metadata_json: string };
      expect(block.metadata_json).toContain("[issue:abcdef0]");
      expect(block.metadata_json).not.toContain("iss_legacy");

      const aliasCount = candidate.prepare("SELECT COUNT(*) AS count FROM artifact_aliases WHERE id = 'alias-bad'").get() as { count: number };
      expect(aliasCount.count).toBe(0);

      const malformedArtifactCount = candidate.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE id = 'artifact:ref:malformed-sha'").get() as { count: number };
      expect(malformedArtifactCount.count).toBe(0);
    } finally {
      candidate.close();
    }
  });
});
