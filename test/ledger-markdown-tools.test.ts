import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
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

  it("rewrites hash-form app links to path routes once, leaving code and path forms alone", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const body = [
      "- [i](http://localhost:19420/#/issues?repo=dotfiles&issue=e70757d&sidebar=hidden)",
      "- [i2](https://app.mandible.localhost:19420/#/issues?issue=abc1234&comment=3)",
      "- [a](http://127.0.0.1:19420/#/auth?request=7e5d7c0a&sidebar=hidden)",
      "- [s](http://localhost:19420/#/artifacts?series=artifact-series%3A044feafc&version=2&sidebar=hidden)",
      "- [r](http://localhost:19420/#/artifacts?ref=artifact-version%3A93aa73ed332a)",
      "- [b](http://localhost:19420/#/artifacts?artifact=artifact-blob%3Adf4dfc1c&sidebar=hidden)",
      "- [f](http://localhost:19420/#/briefing?briefing=9105d191&agent_session=bde91858)",
      "- [g](http://localhost:19420/#/briefing?group=study&agent_session=bde91858)",
      "- bare http://localhost:19420/#/auth?request=5c5c3abd. Then mandible:///issues?repo=mandible&issue=59181bf",
      "- kept: `http://localhost:19420/#/issues?issue=e70757d` mandible:///auth/7e5d7c0a http://localhost:19420/r/issue/abc",
    ].join("\n");
    const issue = store.createIssue({ ...SYSTEM_ACTOR, project_id: project.id, title: "Links", body, created_at: 1000 });

    const apply = () => normalizeEscapedMarkdownBodies(db, {
      apply: true,
      actor: SYSTEM_ACTOR,
      normalize_all_matches: true,
      rules: ["app-links"],
    });

    expect(apply().normalized).toBe(1);
    expect(store.getIssue(issue.id).body).toBe([
      "- [i](https://app.mandible.localhost:19420/issue/dotfiles/e70757d?sidebar=hidden)",
      "- [i2](https://app.mandible.localhost:19420/issue/abc1234?comment=3)",
      "- [a](https://app.mandible.localhost:19420/auth/7e5d7c0a?sidebar=hidden)",
      "- [s](https://app.mandible.localhost:19420/artifact/artifact-series:044feafc@2?sidebar=hidden)",
      "- [r](https://app.mandible.localhost:19420/artifact/artifact-version:93aa73ed332a)",
      "- [b](https://app.mandible.localhost:19420/artifact/artifact-blob:df4dfc1c?sidebar=hidden)",
      "- [f](https://app.mandible.localhost:19420/briefing/9105d191?agent_session=bde91858)",
      "- [g](https://app.mandible.localhost:19420/briefing?group=study&agent_session=bde91858)",
      "- bare https://app.mandible.localhost:19420/auth/5c5c3abd. Then mandible:///issue/mandible/59181bf",
      "- kept: `http://localhost:19420/#/issues?issue=e70757d` mandible:///auth/7e5d7c0a http://localhost:19420/r/issue/abc",
    ].join("\n"));
    expect(apply().normalized).toBe(0);
  });

  it("refuses apply without explicit target scope or all-matches opt-in", () => {
    expect(() => normalizeEscapedMarkdownBodies(db, { apply: true, actor: SYSTEM_ACTOR })).toThrow(
      /requires explicit targets/,
    );
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
