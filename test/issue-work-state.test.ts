import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
import { getLedgerIssueContentDigest, getLedgerIssueHead } from "../src/ledger/issue-heads.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { buildUmbrellaStatus } from "../src/routes/issues.js";

// Issue d9e59e8 — work units are the single source of an issue's branches and
// in-progress state, and a coordinator's issue head notices their lifecycle.

const SYSTEM_ACTOR = { attribution: systemAction() };
let tempDir = "";
let db: Db;
let store: LedgerStore;
let projectId = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-work-state-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
  store = new LedgerStore(db);
  const root = path.join(tempDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  projectId = resolveProjectForCheckout(db, {
    root,
    name: "repo",
    defaultBranch: "main",
    remoteUrl: "git@github.com:mll/work-state.git",
  }).project.id;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeIssue(title: string, kind: "umbrella" | "feature" = "feature") {
  return store.createIssue({ ...SYSTEM_ACTOR, project_id: projectId, title, kind, priority: "normal" });
}

function claim(id: string, issueId: string, branch: string, state = "open", createdAt = 100): void {
  db.prepare(
    `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, created_at, ledger_issue_id)
     VALUES (?, ?, 'repo', ?, 'solo', ?, ?, ?)`,
  ).run(id, issueId.slice(0, 7), branch, state, createdAt, issueId);
}

function childSummary(umbrellaId: string): Record<string, unknown> {
  const status = buildUmbrellaStatus(db, umbrellaId) as { children: Array<Record<string, unknown>> };
  return status.children[0];
}

describe("work-unit derived issue facts", () => {
  it("umbrella child summaries and issue detail derive branch and in-progress state from a work unit", () => {
    const umbrella = makeIssue("Umbrella", "umbrella");
    const child = makeIssue("Child");
    store.linkRelationshipEdges({
      source_entity: { entity_type: "issue", entity_id: umbrella.id },
      target_entities: [{ entity_type: "issue", entity_id: child.id }],
      link_type: "parent_child",
      actor: SYSTEM_ACTOR,
    });
    expect(childSummary(umbrella.id)).toMatchObject({ worker_status: "none", branches: [] });

    claim("wu-live", child.id, "feature/live");
    claim("wu-gone", child.id, "feature/gone", "abandoned", 50);
    store.addIssueBranch(child.id, "feature/manual", "superseded", SYSTEM_ACTOR);
    const expectedBranches = [
      { branch: "feature/live", role: "primary", work_unit_id: "wu-live", work_unit_state: "open" },
      { branch: "feature/manual", role: "superseded", work_unit_id: null, work_unit_state: null },
    ];
    expect(childSummary(umbrella.id)).toMatchObject({ worker_status: "in_progress", branches: expectedBranches });
    const detail = buildLedgerIssueDetailProjection(db, child.id);
    expect(detail.worker_status).toBe("in_progress");
    expect(detail.issue_branches).toMatchObject(expectedBranches);

    // An explicit statement wins over a live lane.
    store.setWorkerStatus(child.id, "blocked", SYSTEM_ACTOR);
    expect(childSummary(umbrella.id)).toMatchObject({ worker_status: "blocked" });

    // A resolved lane keeps naming its branch but no longer means in progress.
    store.setWorkerStatus(child.id, "none", SYSTEM_ACTOR);
    db.prepare("UPDATE work_units SET state = 'resolved', resolved_at = 300 WHERE id = 'wu-live'").run();
    const resolved = buildLedgerIssueDetailProjection(db, child.id);
    expect(resolved.worker_status).toBe("none");
    expect(resolved.issue_branches[0]).toMatchObject({ branch: "feature/live", work_unit_state: "resolved" });
  });

  it("issue heads change when a work unit is claimed, committed, or resolved, without moving the content digest", () => {
    const issue = makeIssue("Lane");
    const contentDigest = getLedgerIssueContentDigest(db, issue.id);
    const seen = [getLedgerIssueHead(db, issue.id).digest];
    expect(seen[0]).toBe(contentDigest);

    const at = Date.now() + 1_000;
    claim("wu-1", issue.id, "feature/lane", "open", at);
    seen.push(getLedgerIssueHead(db, issue.id).digest);
    db.prepare("UPDATE work_units SET state = 'committed', activated_at = ? WHERE id = 'wu-1'").run(at + 1);
    seen.push(getLedgerIssueHead(db, issue.id).digest);
    db.prepare("UPDATE work_units SET state = 'resolved', resolved_at = ? WHERE id = 'wu-1'").run(at + 2);
    const head = getLedgerIssueHead(db, issue.id);
    seen.push(head.digest);

    expect(new Set(seen).size).toBe(4);
    expect(head).toMatchObject({ last_event_kind: "work_unit.resolved", last_event_at: at + 2 });
    expect(getLedgerIssueContentDigest(db, issue.id)).toBe(contentDigest);
  });
});
