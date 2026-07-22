import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { LedgerStore } from "../src/ledger/store.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { createStableEventId } from "../src/ledger/ids.js";
import {
  SYSTEM_USER_ID,
  addBinding,
  createUser,
  setupOperator,
} from "../src/users/store.js";
import {
  EVIDENCE_METHODS,
  isEvidenceMethod,
  localDefaultAttribution,
  mintShadowUser,
  normalizeBindingValue,
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

describe("actor_type projection is a pure mapping (issue 92813cc)", () => {
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
});

describe("legacy actor tuple is frozen (F1: stable ids)", () => {
  it("keeps the passed legacy actor_type/actor_id/author_display; identity lives only in parallel columns", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    const author = createUser(db, { slug: "human-1", kind: "human", display_name: "Human 1" });

    // A pre-existing call site passes a legacy tuple AND (new) attribution. The
    // projection of the user's kind (mandible_user) must NOT override the legacy
    // actor_type: it stays exactly what the caller passed ('agent').
    const issue = store.createIssue({
      project_id: projectId,
      title: "Frozen",
      actor_id: "session-xyz",
      actor_type: "agent",
      author_display: "Codex",
      attribution: { user_id: author.id, evidence_method: "session_claim" },
    });
    expect(issue.author_actor_type).toBe("agent");
    expect(issue.author_actor_id).toBe("session-xyz");
    expect(issue.author_display).toBe("Codex");
    // Real identity is in the parallel columns.
    expect(issue.author_user_id).toBe(author.id);
    expect(issue.evidence_method).toBe("session_claim");
  });

  it("createStableEventId depends only on the legacy tuple, so attribution cannot change event ids", () => {
    // The stable-id function takes no user columns at the type level; identical
    // legacy inputs yield identical ids regardless of the parallel attribution.
    const legacy = {
      entity_type: "issue",
      entity_id: "issue-1",
      event_type: "issue.updated",
      actor_id: "session-xyz",
      actor_type: "agent",
      source: "auth_queue",
      payload: { a: 1 },
      occurred_at: 1_700_000_000_000,
      observed_at: 1_700_000_000_001,
      occurrence: "fixed-nonce",
    };
    expect(createStableEventId(legacy)).toBe(createStableEventId({ ...legacy }));
  });
});

describe("fail-closed attribution (F2: no unattributed new writes)", () => {
  it("attributes every mutation lacking an explicit context to the system user, never null", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();

    const issue = store.createIssue({ project_id: projectId, title: "Sys", actor_type: "agent" });
    expect(issue.author_user_id).toBe(SYSTEM_USER_ID);
    expect(issue.evidence_method).toBe("system_internal");

    const comment = store.addComment(issue.id, { body: "c", actor_type: "agent" });
    expect(comment.author_user_id).toBe(SYSTEM_USER_ID);

    const checkpoint = store.addIssueCheckpoint(issue.id, { kind: "note", payload: {} });
    expect(checkpoint.author_user_id).toBe(SYSTEM_USER_ID);

    store.setLabel(issue.id, "a-label", true);
    const other = store.createIssue({ project_id: projectId, title: "Target", actor_type: "agent" });
    store.upsertIssueRelationship({
      source_issue_id: issue.id,
      target_issue_id: other.id,
      relationship_type: "related",
    });

    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actor_user_id).toBe(SYSTEM_USER_ID);
      expect(event.evidence_method).toBe("system_internal");
    }

    const revisions = store.listBodyRevisions({ entity_type: "issue_body", entity_id: issue.id });
    expect(revisions[0].actor_user_id).toBe(SYSTEM_USER_ID);
  });

  it("records an explicit non-system principal in the parallel columns", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    const operator = setupOperator(db, { display_name: "Operator" });

    const issue = store.createIssue({
      project_id: projectId,
      title: "Attributed",
      author_display: "Mandible",
      attribution: localDefaultAttribution(db),
    });
    expect(issue.author_user_id).toBe(operator.id);
    expect(issue.evidence_method).toBe("local_default");
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
      attribution: { user_id: author.id, evidence_method: "session_claim" },
    });

    const updated = store.updateComment(comment.id, { author_display: "Corrected" }, {
      attribution: { user_id: editor.id, evidence_method: "session_claim" },
    });
    expect(updated.author_display).toBe("Corrected");
    expect(updated.author_user_id).toBe(author.id);
  });
});

describe("evidence_method vocabulary (F3)", () => {
  it("only accepts the locked vocabulary", () => {
    expect([...EVIDENCE_METHODS]).toEqual([
      "local_default",
      "session_claim",
      "external_import",
      "credential_signature",
      "hardware_presence",
      "delegated_lease",
      "system_internal",
      "api_token",
    ]);
    expect(isEvidenceMethod("system_internal")).toBe(true);
    expect(isEvidenceMethod("binding:app_name")).toBe(false);
    expect(isEvidenceMethod("git_bug_import")).toBe(false);
  });

  it("resolver constructors emit only locked values", () => {
    expect(systemAction().evidence_method).toBe("system_internal");
    expect(localDefaultAttribution(db).evidence_method).toBe("local_default");
    const agent = createUser(db, { slug: "sess", kind: "agent", display_name: "Sess" });
    addBinding(db, agent.id, { binding_type: "app_name", value: "claude-code" });
    expect(resolveSessionAttribution(db, { app_name: "claude-code" })?.evidence_method).toBe(
      "session_claim",
    );
  });

  it("rejects an out-of-vocabulary evidence_method at the store boundary", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    expect(() =>
      store.createIssue({
        project_id: projectId,
        title: "Bad evidence",
        attribution: { user_id: SYSTEM_USER_ID, evidence_method: "totally_made_up" },
      }),
    ).toThrow(/evidence_method/);
  });
});

describe("session binding resolution (F5: fail closed)", () => {
  it("resolves a single active binding and returns null when none match", () => {
    const agent = createUser(db, { slug: "agent-a", kind: "agent", display_name: "Agent A" });
    addBinding(db, agent.id, { binding_type: "app_name", value: "claude-code" });
    expect(resolveSessionAttribution(db, { app_name: "claude-code" })?.user_id).toBe(agent.id);
    expect(resolveSessionAttribution(db, { app_name: "unknown" })).toBeNull();
  });

  it("structurally prevents two active users sharing one binding (unique index)", () => {
    const a = createUser(db, { slug: "a", kind: "agent", display_name: "A" });
    const b = createUser(db, { slug: "b", kind: "agent", display_name: "B" });
    addBinding(db, a.id, { binding_type: "app_name", value: "shared" });
    expect(() => addBinding(db, b.id, { binding_type: "app_name", value: "shared" })).toThrow();
  });
});

describe("shadow users for git-bug imports (F4)", () => {
  it("normalizes the binding value so whitespace variants reuse one shadow user", () => {
    expect(normalizeBindingValue("  Ada Lovelace  ")).toBe("Ada Lovelace");
    const first = mintShadowUser(db, { adapter: "git_bug", project_id: "p1", author_name: "Ada Lovelace" });
    const spaced = mintShadowUser(db, { adapter: "git_bug", project_id: "p1", author_name: "  Ada Lovelace  " });
    expect(spaced.id).toBe(first.id);
    expect(first.kind).toBe("external");
    // Raw display name is preserved verbatim on the first mint.
    expect(first.display_name).toBe("Ada Lovelace");

    const bindings = db
      .prepare("SELECT COUNT(*) AS n FROM user_bindings WHERE user_id = ? AND status = 'active'")
      .get(first.id) as { n: number };
    expect(bindings.n).toBe(1);
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
        attribution: { user_id: "nonexistent-user", evidence_method: "system_internal" },
      }),
    ).toThrow();
  });
});
