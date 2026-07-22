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
  OperatorNotConfiguredError,
  isEvidenceMethod,
  localDefaultAttribution,
  mintShadowUser,
  normalizeBindingValue,
  projectActorType,
  resolveSessionAttribution,
  systemAction,
} from "../src/identity/resolver.js";
import type { UserKind } from "../src/users/types.js";
import type { LedgerActorInput, LedgerActorType } from "../src/ledger/types.js";

if (false) {
  // Compile-time regression lock: removing the required attribution field must
  // make this @ts-expect-error directive fail as unused.
  // @ts-expect-error LedgerActorInput requires explicit attribution.
  const unattributedActor: LedgerActorInput = {};
  void unattributedActor;
}

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
  it("rejects missing attribution at runtime instead of inventing a system principal", () => {
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    const projectId = createProject();
    const attributed = { attribution: systemAction() };
    const issue = store.createIssue({ project_id: projectId, title: "Attributed", ...attributed });
    const other = store.createIssue({ project_id: projectId, title: "Target", ...attributed });
    const comment = store.addComment(issue.id, { body: "Before", ...attributed });
    const conflict = store.recordConflict({
      adapter: "git_bug",
      project_id: projectId,
      entity_type: "issue",
      entity_id: issue.id,
      field: "title",
      local_value: "a",
      remote_value: "b",
      ...attributed,
    });

    const missing = /explicit attribution context/;
    expect(() => store.createIssue({ project_id: projectId, title: "Missing" } as never)).toThrow(missing);
    expect(() => store.updateIssue(issue.id, { title: "Missing" }, {} as never)).toThrow(missing);
    expect(() => store.addComment(issue.id, { body: "Missing" } as never)).toThrow(missing);
    expect(() => store.addIssueCheckpoint(issue.id, { kind: "note", payload: {} } as never)).toThrow(missing);
    expect(() => store.updateComment(comment.id, { body: "Missing" }, {} as never)).toThrow(missing);
    expect(() => store.setLabel(issue.id, "missing", true, "mandible", {} as never)).toThrow(missing);
    expect(() => store.recordEvent({
      entity_type: "issue",
      entity_id: issue.id,
      event_type: "missing",
      project_id: projectId,
    } as never)).toThrow(missing);
    expect(() => store.upsertIssueRelationship({
      source_issue_id: issue.id,
      target_issue_id: other.id,
      relationship_type: "related",
    } as never)).toThrow(missing);
    expect(() => store.linkRelationshipEdges({
      source_entity: { entity_type: "issue", entity_id: issue.id },
      target_entities: [{ entity_type: "issue", entity_id: other.id }],
    } as never)).toThrow(missing);
    expect(() => store.recordExternalRef({
      entity_type: "issue",
      entity_id: issue.id,
      adapter: "git_bug",
      external_id: "missing",
      external_kind: "git_bug_issue",
    } as never)).toThrow(missing);
    expect(() => store.recordConflict({
      adapter: "git_bug",
      entity_type: "issue",
      entity_id: issue.id,
      field: "missing",
      local_value: null,
      remote_value: null,
    } as never)).toThrow(missing);
    expect(() => store.resolveConflict(conflict.id, { resolution: "missing" } as never)).toThrow(missing);
    const outbox = store.listOutbox({ adapter: "git_bug", status: "pending" })[0];
    expect(() => store.markOutbox(outbox.id, "applied", {}, {} as never)).toThrow(missing);

    expect(store.getIssue(issue.id).title).toBe("Attributed");
    expect(store.getComment(comment.id).body).toBe("Before");
  });

  it("rejects malformed and inactive attribution principals at runtime", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    const create = (userId: unknown) => store.createIssue({
      project_id: projectId,
      title: "Malformed principal",
      attribution: { user_id: userId, evidence_method: "system_internal" },
    } as never);

    expect(() => create(null)).toThrow(/non-empty attribution user_id/);
    expect(() => create(42)).toThrow(/non-empty attribution user_id/);
    expect(() => create("   ")).toThrow(/non-empty attribution user_id/);

    const retired = createUser(db, { slug: "retired", kind: "agent", display_name: "Retired" });
    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(retired.id);
    expect(() => create(retired.id)).toThrow(/is not active/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_issues").get()).toEqual({ n: 0 });
  });

  it("snapshots stateful JavaScript attribution exactly once before persistence", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    let attributionReads = 0;
    let userReads = 0;
    let methodReads = 0;
    const candidate = {
      get user_id() {
        userReads += 1;
        return userReads === 1 ? SYSTEM_USER_ID : null;
      },
      get evidence_method() {
        methodReads += 1;
        return methodReads === 1 ? "system_internal" : "forged_after_validation";
      },
    };
    const input = {
      project_id: projectId,
      title: "Stateful attribution",
      get attribution() {
        attributionReads += 1;
        return attributionReads === 1 ? candidate : null;
      },
    };

    const issue = store.createIssue(input as never);
    expect(attributionReads).toBe(1);
    expect(userReads).toBe(1);
    expect(methodReads).toBe(1);
    expect(issue.author_user_id).toBe(SYSTEM_USER_ID);
    expect(issue.evidence_method).toBe("system_internal");
    expect(store.listEvents({ entity_type: "issue", entity_id: issue.id })[0]).toMatchObject({
      actor_user_id: SYSTEM_USER_ID,
      evidence_method: "system_internal",
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM ledger_events WHERE actor_user_id IS NULL OR evidence_method = 'forged_after_validation'",
    ).get()).toEqual({ n: 0 });
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

    const issue = store.createIssue({
      project_id: projectId,
      title: "Iso",
      attribution: { user_id: author.id, evidence_method: "session_claim" },
    });
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
    let missingOperator: unknown;
    try {
      localDefaultAttribution(db);
    } catch (error) {
      missingOperator = error;
    }
    expect(missingOperator).toBeInstanceOf(OperatorNotConfiguredError);
    expect(missingOperator).toMatchObject({
      code: "operator_not_configured",
      hint: "Run `mandible user setup` to create the local operator first.",
      retryable: false,
    });
    setupOperator(db, { display_name: "Operator" });
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

  it("rejects conflicting signals, retired owners, and out-of-scope bindings", () => {
    const a = createUser(db, { slug: "signal-a", kind: "agent", display_name: "Signal A" });
    const b = createUser(db, { slug: "signal-b", kind: "agent", display_name: "Signal B" });
    addBinding(db, a.id, { binding_type: "provider_session_env", value: "session-a" });
    addBinding(db, b.id, { binding_type: "app_name", value: "app-b" });
    expect(resolveSessionAttribution(db, {
      provider_session_env: "session-a",
      app_name: "app-b",
    })).toBeNull();

    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(a.id);
    expect(resolveSessionAttribution(db, { provider_session_env: "session-a" })).toBeNull();

    const scoped = createUser(db, { slug: "scoped", kind: "agent", display_name: "Scoped" });
    addBinding(db, scoped.id, { binding_type: "process_pattern", value: "worker", scope: "project-a" });
    expect(resolveSessionAttribution(db, { process_pattern: "worker" })).toBeNull();
    expect(resolveSessionAttribution(db, {
      process_pattern: "worker",
      binding_scope: "project-b",
    })).toBeNull();
    expect(resolveSessionAttribution(db, {
      process_pattern: "worker",
      binding_scope: "project-a",
    })?.user_id).toBe(scoped.id);
  });

  it("accepts multiple signals only when they converge on one active user", () => {
    const agent = createUser(db, { slug: "converged", kind: "agent", display_name: "Converged" });
    addBinding(db, agent.id, { binding_type: "provider_session_env", value: "session-c" });
    addBinding(db, agent.id, { binding_type: "app_name", value: "app-c" });
    expect(resolveSessionAttribution(db, {
      provider_session_env: "session-c",
      app_name: "app-c",
    })?.user_id).toBe(agent.id);
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

  it("rejects external-author bindings owned by non-external or retired users", () => {
    const human = createUser(db, { slug: "human", kind: "human", display_name: "Human" });
    addBinding(db, human.id, {
      binding_type: "external_author",
      value: "Ada",
      scope: "git_bug::p1",
    });
    expect(() => mintShadowUser(db, {
      adapter: "git_bug",
      project_id: "p1",
      author_name: "Ada",
    })).toThrow(/ineligible owner/);

    const external = createUser(db, { slug: "retired-ext", kind: "external", display_name: "Retired" });
    addBinding(db, external.id, {
      binding_type: "external_author",
      value: "Grace",
      scope: "git_bug::p1",
    });
    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(external.id);
    expect(() => mintShadowUser(db, {
      adapter: "git_bug",
      project_id: "p1",
      author_name: "Grace",
    })).toThrow(/ineligible owner/);
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
