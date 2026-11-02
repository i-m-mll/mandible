import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db } from "../src/db.js";
import {
  addGrant,
  addGroup,
  addGroupMember,
  evaluateGlobalCapability,
  removeGrant,
  removeGroupMember,
  } from "../src/permissions/store.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import type { ResolvedClientIdentity } from "../src/server.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

function identity(user: { id: string; slug: string }): ResolvedClientIdentity {
  return {
    user_id: user.id,
    slug: user.slug,
    method: "api_token",
    credential_id: null,
    source: "http_bearer",
  };
}

describe("permission evaluator", () => {
  let db: Db;

  beforeEach(() => {
    db = migratedMemoryDb();
  });

  afterEach(() => db.close());

  it("tracks direct and group authority without leaking grants, and revokes both immediately", () => {
    setClientAuthMode(db, "strict");
    const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" });
    const unrelated = createUser(db, { slug: "other", kind: "agent", display_name: "Other" });
    const group = addGroup(db, { slug: "operators", display_name: "Operators" });
    const allowed = (user: typeof agent) => evaluateGlobalCapability(db, { identity: identity(user), capability: "backup" }).allowed;
    expect(allowed(agent)).toBe(false);
    const direct = addGrant(db, { subject_type: "user", subject: agent.id, permission: "backup" });
    expect(allowed(agent)).toBe(true);
    expect(evaluateGlobalCapability(db, { identity: identity(agent), capability: "spawn_console" }).allowed).toBe(false);
    expect(allowed(unrelated)).toBe(false);
    removeGrant(db, direct.id);
    expect(allowed(agent)).toBe(false);
    addGroupMember(db, group.id, agent.id);
    const inherited = addGrant(db, { subject_type: "group", subject: group.id, permission: "backup" });
    expect(allowed(agent)).toBe(true);
    expect(allowed(unrelated)).toBe(false);
    removeGroupMember(db, group.id, agent.id);
    expect(allowed(agent)).toBe(false);
    addGroupMember(db, group.id, agent.id);
    expect(allowed(agent)).toBe(true);
    removeGrant(db, inherited.id);
    expect(allowed(agent)).toBe(false);
  });
});

it("preserves global capability authority, identity validity, and visible rejection of obsolete grants", () => {
  const db = migratedMemoryDb();
  try {
    setClientAuthMode(db, "strict");
    const operator = setupOperator(db, { slug: "global-operator", display_name: "Operator" });
    const agent = createUser(db, { slug: "global-agent", kind: "agent", display_name: "Agent" });
    expect(evaluateGlobalCapability(db, { identity: null, capability: "backup" })).toMatchObject({ allowed: false, reason: "authentication_required" });
    expect(evaluateGlobalCapability(db, { identity: identity(operator), capability: "backup" })).toMatchObject({ allowed: true, operator: true });
    expect(evaluateGlobalCapability(db, { identity: { ...identity(operator), slug: "wrong" }, capability: "backup" })).toMatchObject({ allowed: false });
    expect(evaluateGlobalCapability(db, { identity: identity(agent), capability: "backup" })).toMatchObject({ allowed: false });
    const grant = addGrant(db, { subject_type: "user", subject: agent.id, permission: "backup" });
    expect(() => addGrant(db, { subject_type: "user", subject: agent.id, permission: "read", resource_type: "project", resource: "unused" } as never)).toThrow("retired");
    expect(() => addGrant(db, { subject_type: "user", subject: agent.id, permission: "backup", resource_type: "global" } as never)).toThrow("retired");
    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(agent.id);
    expect(evaluateGlobalCapability(db, { identity: identity(agent), capability: "backup" })).toMatchObject({ allowed: false, reason: "ambiguous_or_inactive_identity" });
    expect(db.prepare("SELECT id FROM permission_grants").all()).toEqual([{ id: grant.id }]);
  } finally { db.close(); }
});
