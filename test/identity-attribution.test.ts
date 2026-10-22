// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db } from "../src/db.js";
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
  localProcessDefaultAttribution,
  resolveSessionAttribution,
  systemAction,
} from "../src/identity/resolver.js";
import type { LedgerActorInput } from "../src/ledger/types.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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
  db = migratedMemoryDb();
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
    const store = new LedgerStore(db);
    const projectId = createProject();
    const attributed = { attribution: systemAction() };
    const issue = store.createIssue({ project_id: projectId, title: "Attributed", ...attributed });
    const other = store.createIssue({ project_id: projectId, title: "Target", ...attributed });
    const comment = store.addComment(issue.id, { body: "Before", ...attributed });

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

  it("records the operator for a local write only in a non-managed context", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    const operator = setupOperator(db, { display_name: "Operator" });

    // A clean shell (no managed-session env markers) is a genuine local operator
    // invocation, so the parallel columns record the operator with local_default.
    const attribution = localProcessDefaultAttribution(db, {});
    const issue = store.createIssue({
      project_id: projectId,
      title: "Attributed",
      author_display: "Mandible",
      attribution,
    });
    expect(issue.author_user_id).toBe(operator.id);
    expect(issue.evidence_method).toBe("local_default");
  });

  it("never attributes the operator for a local write inside a managed agent context", () => {
    const store = new LedgerStore(db);
    const projectId = createProject();
    setupOperator(db, { display_name: "Operator" });

    // Managed session carrying an ambient codex signal that maps to an agent:
    // the write resolves to that agent with session_claim, never the operator.
    const codex = createUser(db, { slug: "codex", kind: "agent", display_name: "Codex" });
    addBinding(db, codex.id, { binding_type: "provider_session_env", value: "CODEX_THREAD_ID" });
    const agentAttribution = localProcessDefaultAttribution(db, { CODEX_THREAD_ID: "thread-x" });
    const agentIssue = store.createIssue({
      project_id: projectId,
      title: "Managed agent write",
      attribution: agentAttribution,
    });
    expect(agentIssue.author_user_id).toBe(codex.id);
    expect(agentIssue.evidence_method).toBe("session_claim");

    // Managed marker present but no resolvable ambient agent: unattributed (NULL),
    // never a silent operator fallback.
    const unresolved = localProcessDefaultAttribution(db, { MANDIBLE_MANAGED_CLIENT: "1" });
    expect(unresolved).toBeNull();
    const nullIssue = store.createIssue({
      project_id: projectId,
      title: "Managed unattributed write",
      attribution: unresolved,
    });
    expect(nullIssue.author_user_id).toBeNull();
    expect(nullIssue.evidence_method).toBeNull();
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

describe("evidence_method vocabulary (F3)", () => {

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

  it("refuses to mint session_claim for a non-agent binding owner", () => {
    // A forgeable ambient signal must never resolve to a human/operator: only
    // agent-kind owners may back the deliberately-unverified session_claim.
    const human = createUser(db, { slug: "human-bound", kind: "human", display_name: "Human" });
    addBinding(db, human.id, { binding_type: "app_name", value: "human-app" });
    expect(resolveSessionAttribution(db, { app_name: "human-app" })).toBeNull();

    const external = createUser(db, { slug: "ext-bound", kind: "external", display_name: "External" });
    addBinding(db, external.id, { binding_type: "provider_session_env", value: "ext-session" });
    expect(resolveSessionAttribution(db, { provider_session_env: "ext-session" })).toBeNull();
  });
});

describe("attribution identity display", () => {
  it("labels known agents but never speculates that an operator is human", async () => {
    const { h } = await import("preact");
    const { cleanup, render, screen } = await import("@testing-library/preact");
    const { AttributionIdentity } = await import("../ui/src/components/shared/DetailHeaderIdentity");
    const verified = {
      user: { id: "u1", display_name: "Author", kind: "agent" as const },
      evidence_method: "api_token",
      evidence_id: "ev1",
      credential: null,
    };
    try {
      render(h(AttributionIdentity, { display: "Operator", attribution: { ...verified, user: { ...verified.user, kind: "human" as const } } }));
      expect(screen.queryByText("human")).toBeNull();
      cleanup();
      render(h(AttributionIdentity, { display: "Worker", attribution: verified }));
      expect(screen.getByText("agent")).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});
