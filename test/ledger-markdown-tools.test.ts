import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
import {
  ISSUE_MARKDOWN_EXPORT_CONFIG_SETTING,
  exportIssueMarkdownFiles,
  renderIssueMarkdown,
} from "../src/ledger/issue-markdown-export.js";
import {
  auditEscapedMarkdownBodies,
  normalizeEscapedMarkdownBodies,
  normalizeEscapedMarkdownBody,
} from "../src/ledger/markdown-body.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";

let tempDir = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-markdown-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createProject() {
  const root = path.join(tempDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name: "repo",
    workRepoId: "repo",
    defaultBranch: "main",
    remoteUrl: "git@github.com:mll/mandible.git",
  }).project;
}

describe("ledger escaped Markdown audit and normalization", () => {
  it("audits likely escaped legacy bodies without changing rows or recording events", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.id,
      title: "Escaped",
      body: "First\\n\\nSecond\\n- item",
      created_at: 1000,
    });
    const comment = store.addComment(issue.id, {
      ...SYSTEM_ACTOR,
      body: "Comment\\n\\nDetails",
      created_at: 1100,
    });

    const result = auditEscapedMarkdownBodies(db, { issue_refs: [issue.id] });

    expect(result.dry_run).toBe(true);
    expect(result.counts).toEqual({ issue_bodies: 1, comments: 1, changed: 2 });
    expect(store.getIssue(issue.id).body).toBe("First\\n\\nSecond\\n- item");
    expect(store.getComment(comment.id).body).toBe("Comment\\n\\nDetails");
    expect(db.prepare("SELECT event_type FROM ledger_events ORDER BY occurred_at").all())
      .toEqual([{ event_type: "issue.created" }, { event_type: "comment.created" }]);
  });

  it("normalizes only through explicit apply targets and records normalization events", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.id,
      title: "Normalize",
      body: "First\\n\\nSecond with `literal\\nexample`\\n- item",
      created_at: 1000,
    });
    const comment = store.addComment(issue.id, {
      ...SYSTEM_ACTOR,
      body: "Comment\\n\\nDetails",
      created_at: 1100,
    });

    const dryRun = normalizeEscapedMarkdownBodies(db, { scope: { issue_refs: [issue.id] } });
    expect(dryRun.applied).toBe(false);
    expect(store.getIssue(issue.id).body).toContain("\\n\\n");

    const result = normalizeEscapedMarkdownBodies(db, {
      apply: true,
      actor: SYSTEM_ACTOR,
      scope: { issue_refs: [issue.id] },
    });

    expect(result.applied).toBe(true);
    expect(result.normalized).toBe(2);
    expect(store.getIssue(issue.id).body).toBe("First\n\nSecond with `literal\\nexample`\n- item");
    expect(store.getComment(comment.id).body).toBe("Comment\n\nDetails");
    const events = db.prepare(
      "SELECT entity_type, entity_id, event_type FROM ledger_events WHERE event_type = 'markdown_body.normalized' ORDER BY entity_type, entity_id",
    ).all();
    expect(events).toEqual([
      { entity_type: "comment", entity_id: comment.id, event_type: "markdown_body.normalized" },
      { entity_type: "issue", entity_id: issue.id, event_type: "markdown_body.normalized" },
    ]);
    expect(store.listBodyRevisions({ entity_type: "issue_body", entity_id: issue.id })
      .map((revision) => revision.snapshot_body)).toEqual([
        "First\\n\\nSecond with `literal\\nexample`\\n- item",
        "First\n\nSecond with `literal\\nexample`\n- item",
      ]);
    expect(store.listBodyRevisions({ entity_type: "comment_body", entity_id: comment.id })
      .map((revision) => revision.snapshot_body)).toEqual([
        "Comment\\n\\nDetails",
        "Comment\n\nDetails",
      ]);
  });

  it("refuses apply without explicit target scope or all-matches opt-in", () => {
    expect(() => normalizeEscapedMarkdownBodies(db, { apply: true, actor: SYSTEM_ACTOR })).toThrow(
      /requires explicit targets/,
    );
  });

  it("preserves intentional Markdown code spans while normalizing surrounding text", () => {
    expect(normalizeEscapedMarkdownBody("A\\n`B\\nC`\\n```json\n{\"x\":\"y\\n\"}\n```\\nD")).toBe(
      "A\n`B\\nC`\n```json\n{\"x\":\"y\\n\"}\n```\nD",
    );
  });
});

describe("ledger issue Markdown export", () => {
  it("renders stable deterministic Markdown without runtime metadata", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.id,
      title: "Export Me",
      body: "Body",
      labels: ["feature"],
      created_at: 1000,
      aliases: [{ alias_kind: "git_bug_short", alias: "abc1234" }],
    });
    store.addComment(issue.id, {
      ...SYSTEM_ACTOR,
      body: "A comment",
      author_display: "Codex",
      actor_type: "agent",
      created_at: 2000,
    });

    const first = renderIssueMarkdown(buildLedgerIssueDetailProjection(db, issue.id));
    const second = renderIssueMarkdown(buildLedgerIssueDetailProjection(db, issue.id));

    expect(first).toBe(second);
    expect(first).toContain("# Export Me");
    expect(first).toContain("## Comments");
    expect(first).toContain("1970-01-01T00:00:01.000Z");
    expect(first).not.toContain("generated_at");
    expect(first).not.toContain("event_nonce");
  });

  it("exports selected issues to stable paths and overwrites content on update", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.id,
      title: "Export Path",
      body: "Before",
      created_at: 1000,
    });
    const outDir = path.join(tempDir, "exports");

    const first = exportIssueMarkdownFiles(db, { out_dir: outDir, issue_refs: [issue.id] });
    expect(first.files).toHaveLength(1);
    expect(first.files[0].path).toMatch(/exports\/mandible--prj_.*\/[a-z0-9]+\.md$/);
    expect(fs.readFileSync(first.files[0].path, "utf8")).toContain("Before");

    store.updateIssue(issue.id, { body: "After" }, SYSTEM_ACTOR);
    const second = exportIssueMarkdownFiles(db, { out_dir: outDir, issue_refs: [issue.id] });

    expect(second.files[0].path).toBe(first.files[0].path);
    expect(fs.readFileSync(second.files[0].path, "utf8")).toContain("After");
  });

  it("runs all configured exports from settings", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.id,
      title: "Configured",
      body: "Configured body",
      created_at: 1000,
    });
    const outDir = path.join(tempDir, "configured");
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(ISSUE_MARKDOWN_EXPORT_CONFIG_SETTING, JSON.stringify([
        { out_dir: outDir, project_refs: [project.id] },
      ]), 1000);

    const result = exportIssueMarkdownFiles(db, { all_configured: true });

    expect(result.configured_exports).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(fs.readFileSync(result.files[0].path, "utf8")).toContain("Configured body");
  });
});

describe("Markdown body escape detection", () => {
  it("detects repeated literal escaped newlines with few real newlines", async () => {
    const { detectAccidentalEscapedMarkdown } = await import("../src/ledger/markdown-body.js");
    expect(detectAccidentalEscapedMarkdown("Implemented change.\\n\\nDetails:\\n- item")).toMatchObject({
      suspicious: true,
      literal_newline_count: 3,
      actual_newline_count: 0,
    });
    expect(detectAccidentalEscapedMarkdown("Implemented change.\n\nDetails:\n- item").suspicious).toBe(false);
  });

  it("ignores code-ish intentional escaped newline examples", async () => {
    const { detectAccidentalEscapedMarkdown } = await import("../src/ledger/markdown-body.js");
    expect(detectAccidentalEscapedMarkdown("```json\n{\"body\":\"a\\n\\nb\"}\n```").suspicious).toBe(false);
    expect(detectAccidentalEscapedMarkdown("{\"body\":\"a\\n\\nb\"}").suspicious).toBe(false);
    expect(detectAccidentalEscapedMarkdown("Use `\\n\\n` for a blank escaped line.").suspicious).toBe(false);
  });
});
