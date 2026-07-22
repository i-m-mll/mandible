import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { LedgerStore } from "../src/ledger/store.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import {
  SYSTEM_USER_ID,
  addBinding,
  createUser,
  setupOperator,
} from "../src/users/store.js";
import {
  localDefaultAttribution,
  mintShadowUser,
  projectActorType,
  resolveSessionAttribution,
  systemAction,
} from "../src/identity/resolver.js";
import type { UserKind } from "../src/users/types.js";
import type { LedgerActorType } from "../src/ledger/types.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-identity-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createProject(): string {
  const root = path.join(tempDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name: "repo",
    defaultBranch: "main",
    remoteUrl: "git@github.com:mll/mandible.git",
  }).project.id;
}

describe("actor_type projection (issue 92813cc)", () => {
  it("maps each user kind to its lossy actor_type projection", () => {
    const cases: Array<[UserKind, LedgerActorType]> = [
      ["human", "mandible_user"],
      ["agent", "agent"],
      ["system", "system"],
      ["external", "external_adapter"],
    ];
    for (const [kind, actorType] of cases) {
      expect(projectActorType(kind)).toBe(actorType);
    }
  });

  it("writes actor_type as the projection of the attributed user's kind", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    const kinds: Array<[UserKind, LedgerActorType]> = [
      ["human", "mandible_user"],
      ["agent", "agent"],
      ["external", "external_adapter"],
    ];
    let n = 0;
    for (const [kind, expected] of kinds) {
      const user = createUser(db, { slug: `u-${kind}-${n}`, kind, display_name: `U ${kind}` });
      n += 1;
      const issue = store.createIssue({
        project_id: projectId,
        title: `Issue ${kind}`,
        actor_type: "external_adapter", // deliberately wrong; projection must override
        attribution: { user_id: user.id, evidence_method: "test" },
      });
      expect(issue.author_actor_type).toBe(expected);
      expect(issue.author_user_id).toBe(user.id);
      expect(issue.evidence_method).toBe("test");
    }
  });
});

describe("resolver attribution constructors", () => {
  it("systemAction resolves to the seeded system user", () => {
    const ctx = systemAction("unit");
    expect(ctx.user_id).toBe(SYSTEM_USER_ID);
    expect(ctx.evidence_method).toBe("unit");
  });

  it("localDefault resolves to the operator, else falls back to system", () => {
    expect(localDefaultAttribution(db).user_id).toBe(SYSTEM_USER_ID);
    const operator = setupOperator(db, { display_name: "Operator", email: "op@example.com" });
    const ctx = localDefaultAttribution(db);
    expect(ctx.user_id).toBe(operator.id);
    expect(ctx.evidence_method).toBe("local_default");
  });

  it("resolves a session write via an active binding", () => {
    const agent = createUser(db, { slug: "agent-a", kind: "agent", display_name: "Agent A" });
    addBinding(db, agent.id, { binding_type: "app_name", value: "claude-code" });
    const resolved = resolveSessionAttribution(db, { app_name: "claude-code" });
    expect(resolved?.user_id).toBe(agent.id);
    expect(resolveSessionAttribution(db, { app_name: "unknown" })).toBeNull();
  });
});

describe("ledger write attribution", () => {
  it("populates parallel user columns on issues, comments, and events", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    const operator = setupOperator(db, { display_name: "Operator" });
    const attribution = { user_id: operator.id, evidence_method: "local_default" };

    const issue = store.createIssue({
      project_id: projectId,
      title: "Attributed",
      body: "Body",
      author_display: "Mandible",
      attribution,
    });
    expect(issue.author_user_id).toBe(operator.id);

    const comment = store.addComment(issue.id, {
      body: "A comment",
      author_display: "Mandible",
      attribution,
    });
    expect(comment.author_user_id).toBe(operator.id);
    expect(comment.evidence_method).toBe("local_default");

    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actor_user_id).toBe(operator.id);
    }

    const revisions = store.listBodyRevisions({ entity_type: "issue_body", entity_id: issue.id });
    expect(revisions[0].actor_user_id).toBe(operator.id);
  });

  it("leaves user columns null for legacy callers without attribution", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    const issue = store.createIssue({
      project_id: projectId,
      title: "Legacy",
      actor_type: "agent",
      author_display: "Codex",
    });
    expect(issue.author_user_id).toBeNull();
    expect(issue.evidence_method).toBeNull();
    expect(issue.author_actor_type).toBe("agent");
  });

  it("isolates author_display edits from user attribution", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    const author = createUser(db, { slug: "author", kind: "human", display_name: "Author" });
    const editor = createUser(db, { slug: "editor", kind: "agent", display_name: "Editor" });

    const issue = store.createIssue({ project_id: projectId, title: "Iso" });
    const comment = store.addComment(issue.id, {
      body: "Original",
      author_display: "Author",
      attribution: { user_id: author.id, evidence_method: "test" },
    });

    // A display-only correction, attributed to a different actor, must not
    // rewrite the comment's author_user_id.
    const updated = store.updateComment(comment.id, { author_display: "Corrected" }, {
      attribution: { user_id: editor.id, evidence_method: "test" },
    });
    expect(updated.author_display).toBe("Corrected");
    expect(updated.author_user_id).toBe(author.id);
  });
});

describe("shadow users for git-bug imports", () => {
  it("mints one external user per adapter+author and reuses it idempotently", () => {
    const first = mintShadowUser(db, { adapter: "git_bug", project_id: "p1", author_name: "Ada Lovelace" });
    const again = mintShadowUser(db, { adapter: "git_bug", project_id: "p1", author_name: "Ada Lovelace" });
    expect(first.id).toBe(again.id);
    expect(first.kind).toBe("external");
    expect(first.display_name).toBe("Ada Lovelace");
  });

  it("never merges equal names across different adapters", () => {
    const gitBug = mintShadowUser(db, { adapter: "git_bug", project_id: "p1", author_name: "Same Name" });
    const github = mintShadowUser(db, { adapter: "github", project_id: "p1", author_name: "Same Name" });
    expect(gitBug.id).not.toBe(github.id);
  });
});

describe("migration v108 schema", () => {
  it("adds nullable parallel attribution columns", () => {
    const columns = (name: string) =>
      (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string; notnull: number }>);
    const has = (table: string, column: string) =>
      columns(table).some((c) => c.name === column && c.notnull === 0);

    expect(has("ledger_issues", "author_user_id")).toBe(true);
    expect(has("ledger_issues", "evidence_method")).toBe(true);
    expect(has("ledger_issues", "evidence_id")).toBe(true);
    expect(has("ledger_comments", "author_user_id")).toBe(true);
    expect(has("ledger_issue_checkpoints", "author_user_id")).toBe(true);
    expect(has("ledger_events", "actor_user_id")).toBe(true);
    expect(has("ledger_body_revisions", "actor_user_id")).toBe(true);
    expect(has("ledger_body_revisions", "redacted_by_user_id")).toBe(true);
    expect(has("ledger_relationship_edges", "actor_user_id")).toBe(true);
  });

  it("enforces the user foreign key fail-closed", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    expect(() =>
      store.createIssue({
        project_id: projectId,
        title: "Bad attribution",
        attribution: { user_id: "nonexistent-user", evidence_method: "test" },
      }),
    ).toThrow();
  });
});
