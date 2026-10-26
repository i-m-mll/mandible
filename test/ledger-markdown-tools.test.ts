import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
import {
  renderIssueMarkdown,
} from "../src/ledger/issue-markdown-export.js";
import {
  auditEscapedMarkdownBodies,
  normalizeEscapedMarkdownBodies,
} from "../src/ledger/markdown-body.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-markdown-"));
  db = migratedMemoryDb();
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

    const eventsBefore = db.prepare("SELECT id, event_type FROM ledger_events ORDER BY rowid").all();
    const result = auditEscapedMarkdownBodies(db, { issue_refs: [issue.id] });

    expect(result.dry_run).toBe(true);
    expect(result.counts).toEqual({ issue_bodies: 1, comments: 1, changed: 2 });
    expect(store.getIssue(issue.id).body).toBe("First\\n\\nSecond\\n- item");
    expect(store.getComment(comment.id).body).toBe("Comment\\n\\nDetails");
    expect(db.prepare("SELECT id, event_type FROM ledger_events ORDER BY rowid").all()).toEqual(eventsBefore);
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
