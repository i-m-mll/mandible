import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import {
  addGrant,
  addGroup,
  addGroupMember,
  evaluateGlobalCapability,
  GLOBAL_CAPABILITIES,
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

  it.each(
    (["user", "group"] as const).flatMap((subjectType) =>
      GLOBAL_CAPABILITIES.map((capability) => [subjectType, capability] as const),
    ),
  )("strict matrix global subject=%s capability=%s", (subjectType, capability) => {
    const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" });
    setClientAuthMode(db, "strict");
    let subject = agent.id;
    if (subjectType === "group") {
      const group = addGroup(db, { slug: "matrix", display_name: "Matrix" });
      addGroupMember(db, group.id, agent.id);
      subject = group.id;
    }
    addGrant(db, { subject_type: subjectType, subject, permission: capability });
    expect(evaluateGlobalCapability(db, { identity: identity(agent), capability }))
      .toMatchObject({ allowed: true, reason: "grant" });
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
    expect(evaluateGlobalCapability(db, { identity: identity(agent), capability: "backup" })).toMatchObject({ allowed: true, reason: "grant" });
    expect(() => addGrant(db, { subject_type: "user", subject: agent.id, permission: "read", resource_type: "project", resource: "unused" } as never)).toThrow("retired");
    expect(() => addGrant(db, { subject_type: "user", subject: agent.id, permission: "backup", resource_type: "global" } as never)).toThrow("retired");
    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(agent.id);
    expect(evaluateGlobalCapability(db, { identity: identity(agent), capability: "backup" })).toMatchObject({ allowed: false, reason: "ambiguous_or_inactive_identity" });
    expect(db.prepare("SELECT id FROM permission_grants").all()).toEqual([{ id: grant.id }]);
  } finally { db.close(); }
});
