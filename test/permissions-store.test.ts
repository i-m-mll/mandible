import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import {
  addGrant,
  addGroup,
  addGroupMember,
  evaluateGlobalCapability,
  evaluateProjectAccess,
  GLOBAL_CAPABILITIES,
  PROJECT_ROLES,
  projectAccessSettings,
  setProjectRestricted,
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

  it("preserves unrestricted defaults and operator implicit admin", () => {
    const project = addProject(db, { project_key: "p", display_name: "P" });
    const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" });
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });

    expect(evaluateProjectAccess(db, {
      identity: identity(agent), project_id: project.id, required_role: "admin",
    })).toMatchObject({ allowed: true, reason: "project_unrestricted" });
    setProjectRestricted(db, project.id, true);
    expect(evaluateProjectAccess(db, {
      identity: identity(operator), project_id: project.id, required_role: "admin",
    })).toMatchObject({ allowed: true, operator: true, effective_role: "admin" });
    expect(evaluateProjectAccess(db, {
      identity: { ...identity(operator), slug: "stale-operator-claim" },
      project_id: project.id,
      required_role: "admin",
    })).toMatchObject({ allowed: false, reason: "ambiguous_or_inactive_identity" });
    expect(evaluateGlobalCapability(db, {
      identity: { ...identity(operator), slug: "stale-operator-claim" },
      capability: "change_settings",
    })).toMatchObject({ allowed: false, reason: "ambiguous_or_inactive_identity" });
  });

  it.each([
    ["read", "read", true],
    ["read", "write", false],
    ["write", "read", true],
    ["write", "write", true],
    ["write", "admin", false],
    ["admin", "admin", true],
  ] as const)("direct user role %s against required %s => %s", (granted, required, allowed) => {
    const project = addProject(db, { project_key: "p", display_name: "P" });
    const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" });
    setProjectRestricted(db, project.id, true);
    addGrant(db, {
      subject_type: "user", subject: agent.id, resource_type: "project",
      resource: project.id, permission: granted,
    });
    expect(evaluateProjectAccess(db, {
      identity: identity(agent), project_id: project.id, required_role: required,
    }).allowed).toBe(allowed);
  });

  it("combines group project roles and global capabilities", () => {
    const project = addProject(db, { project_key: "p", display_name: "P" });
    const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" });
    const group = addGroup(db, { slug: "writers", display_name: "Writers" });
    addGroupMember(db, group.id, agent.id);
    setProjectRestricted(db, project.id, true);
    addGrant(db, { subject_type: "group", subject: group.id, resource_type: "project",
      resource: project.id, permission: "write" });
    addGrant(db, { subject_type: "group", subject: group.id, resource_type: "global",
      permission: "spawn_console" });

    expect(evaluateProjectAccess(db, {
      identity: identity(agent), project_id: project.id, required_role: "write",
    })).toMatchObject({ allowed: true, effective_role: "write" });
    expect(evaluateGlobalCapability(db, {
      identity: identity(agent), capability: "spawn_console",
    })).toMatchObject({ allowed: true, reason: "grant" });
    expect(evaluateGlobalCapability(db, {
      identity: identity(agent), capability: "backup",
    })).toMatchObject({ allowed: false, reason: "global_capability_required" });
    expect(projectAccessSettings(db, project.id).grants).toHaveLength(1);
  });

  it.each(
    (["user", "group"] as const).flatMap((subjectType) =>
      PROJECT_ROLES.map((role) => [subjectType, role] as const),
    ),
  )("strict matrix project subject=%s role=%s", (subjectType, role) => {
    const project = addProject(db, { project_key: "p", display_name: "P" });
    const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" });
    setProjectRestricted(db, project.id, true);
    setClientAuthMode(db, "strict");
    let subject = agent.id;
    if (subjectType === "group") {
      const group = addGroup(db, { slug: "matrix", display_name: "Matrix" });
      addGroupMember(db, group.id, agent.id);
      subject = group.id;
    }
    addGrant(db, { subject_type: subjectType, subject, resource_type: "project",
      resource: project.id, permission: role });
    expect(evaluateProjectAccess(db, {
      identity: identity(agent), project_id: project.id, required_role: role,
    })).toMatchObject({ allowed: true, effective_role: role });
  });

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
    addGrant(db, { subject_type: subjectType, subject, resource_type: "global", permission: capability });
    expect(evaluateGlobalCapability(db, { identity: identity(agent), capability }))
      .toMatchObject({ allowed: true, reason: "grant" });
  });

  it("denies anonymous access and fails closed on identity mismatch", () => {
    const project = addProject(db, { project_key: "p", display_name: "P" });
    const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" });
    setProjectRestricted(db, project.id, true);

    setClientAuthMode(db, "strict");
    expect(evaluateProjectAccess(db, {
      identity: null, project_id: project.id, required_role: "write",
    })).toMatchObject({ allowed: false, reason: "authentication_required" });
    expect(evaluateProjectAccess(db, {
      identity: { ...identity(agent), slug: "claimed-operator" },
      project_id: project.id,
      required_role: "write",
    })).toMatchObject({ allowed: false, reason: "ambiguous_or_inactive_identity" });
  });
});
