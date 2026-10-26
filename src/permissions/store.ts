import { mutateLedgerRecord } from "../ledger/mutation-history.js";
import type { Db } from "../db.js";
import { getClientAuthMode } from "../client-auth/mode.js";
import type { RequestLike, ResolvedClientIdentity, ResponseLike } from "../server.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import { getOperatorId, getUserById, resolveUserOrThrow, UserRegistryError } from "../users/store.js";
import { ulid } from "../users/ids.js";

export const AGENTS_GROUP_ID = "00000000000000000000000001";
export const AGENTS_GROUP_SLUG = "agents";

export const PROJECT_ROLES = ["read", "write", "admin"] as const;
export type ProjectRole = typeof PROJECT_ROLES[number];
export const GLOBAL_CAPABILITIES = [
  "approve_auth",
  "spawn_console",
  "change_settings",
  "backup",
  "open_path",
  "ask.create",
] as const;
export type GlobalCapability = typeof GLOBAL_CAPABILITIES[number];
export type PermissionSubjectType = "user" | "group";

export interface UserGroup {
  id: string;
  slug: string;
  display_name: string;
  kind: "system" | "custom";
  created_at: number;
  updated_at: number;
}

export interface PermissionGrant {
  id: string;
  subject_type: PermissionSubjectType;
  subject_id: string;
  resource_type: "project" | "global";
  resource_id: string | null;
  permission: ProjectRole | GlobalCapability;
  created_at: number;
}

export interface AccessDecision {
  allowed: boolean;
  reason: string;
  user_id: string | null;
  project_id?: string;
  required_role?: ProjectRole;
  effective_role?: ProjectRole | null;
  capability?: GlobalCapability;
  operator: boolean;
  restricted?: boolean;
}

export class PermissionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PermissionError";
  }
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ROLE_RANK: Record<ProjectRole, number> = { read: 1, write: 2, admin: 3 };

function resolveGroup(db: Db, ref: string): UserGroup | null {
  return (db.prepare("SELECT * FROM user_groups WHERE id = ? OR slug = ? LIMIT 1")
    .get(ref, ref) as UserGroup | undefined) ?? null;
}

function resolveGroupOrThrow(db: Db, ref: string): UserGroup {
  const group = resolveGroup(db, ref);
  if (!group) throw new UserRegistryError("not_found", `No user group matches '${ref}'.`);
  return group;
}

export function listGroups(db: Db): UserGroup[] {
  return db.prepare("SELECT * FROM user_groups ORDER BY kind DESC, slug").all() as UserGroup[];
}

export function addGroup(
  db: Db,
  input: { slug: string; display_name?: string },
  now: number = Date.now(),
): UserGroup {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new UserRegistryError("invalid", `Invalid group slug '${input.slug}'.`);
  }
  const displayName = input.display_name?.trim() || slug;
  const existing = resolveGroup(db, slug);
  if (existing) {
    if (existing.kind === "custom" && existing.display_name === displayName) return existing;
    throw new UserRegistryError("conflict", `A group with slug '${slug}' already exists.`);
  }
  const id = ulid(now);

  return mutateLedgerRecord(db, {
    entity_type: "group",
    entity_id: id,
    snapshot: () => db.prepare("SELECT id, slug, display_name, kind FROM user_groups WHERE id = ?").get(id) ?? null,
  }, () => {
    db.prepare(
      `INSERT INTO user_groups (id, slug, display_name, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'custom', ?, ?)`,
    ).run(id, slug, displayName, now, now);
    return resolveGroupOrThrow(db, id);
  });
}

export function removeGroup(db: Db, ref: string): void {
  const group = resolveGroupOrThrow(db, ref);
  if (group.kind === "system") {
    throw new UserRegistryError("forbidden", `System group '${group.slug}' cannot be removed.`);
  }

  return mutateLedgerRecord(db, {
    entity_type: "group",
    entity_id: group.id,
    snapshot: () => db.prepare("SELECT id, slug, display_name, kind FROM user_groups WHERE id = ?").get(group.id) ?? null,
  }, () => {
    for (const grant of listGrants(db, { subject_type: "group", subject_id: group.id })) removeGrant(db, grant.id);
    for (const member of listGroupMembers(db, group.id)) removeGroupMember(db, group.id, member.id);
    db.prepare("DELETE FROM user_groups WHERE id = ?").run(group.id);
  });
}

export function listGroupMembers(db: Db, ref: string): Array<{
  id: string;
  slug: string;
  kind: string;
  display_name: string;
}> {
  const group = resolveGroupOrThrow(db, ref);
  return db.prepare(
    `SELECT u.id, u.slug, u.kind, u.display_name
       FROM user_group_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?
      ORDER BY u.slug`,
  ).all(group.id) as Array<{ id: string; slug: string; kind: string; display_name: string }>;
}

export function addGroupMember(
  db: Db,
  groupRef: string,
  userRef: string,
  now: number = Date.now(),
): void {
  const group = resolveGroupOrThrow(db, groupRef);
  const user = resolveUserOrThrow(db, userRef);

  return mutateLedgerRecord(db, {
    entity_type: "group_member",
    entity_id: group.id + ":" + user.id,
    payload: { group_id: group.id, user_id: user.id },
    snapshot: () => db.prepare("SELECT group_id, user_id FROM user_group_members WHERE group_id = ? AND user_id = ?").get(group.id, user.id) ?? null,
  }, () => {
    db.prepare(
      `INSERT OR IGNORE INTO user_group_members (group_id, user_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(group.id, user.id, now);
  });
}

export function removeGroupMember(db: Db, groupRef: string, userRef: string): void {
  const group = resolveGroupOrThrow(db, groupRef);
  const user = resolveUserOrThrow(db, userRef);

  return mutateLedgerRecord(db, {
    entity_type: "group_member",
    entity_id: group.id + ":" + user.id,
    payload: { group_id: group.id, user_id: user.id },
    snapshot: () => db.prepare("SELECT group_id, user_id FROM user_group_members WHERE group_id = ? AND user_id = ?").get(group.id, user.id) ?? null,
  }, () => {
    db.prepare("DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?")
      .run(group.id, user.id);
  });
}

export function ensureAgentGroupMembership(db: Db, userId: string, now: number = Date.now()): void {
  const user = getUserById(db, userId);
  if (!user || user.kind !== "agent") return;
  addGroupMember(db, AGENTS_GROUP_ID, user.id, now);
}

function resolveSubjectId(db: Db, type: PermissionSubjectType, ref: string): string {
  return type === "user" ? resolveUserOrThrow(db, ref).id : resolveGroupOrThrow(db, ref).id;
}

export function addGrant(db: Db, input: {
  subject_type: PermissionSubjectType;
  subject: string;
  resource_type: "project" | "global";
  resource?: string;
  permission: string;
}, now: number = Date.now()): PermissionGrant {
  const subjectId = resolveSubjectId(db, input.subject_type, input.subject);
  let resourceId: string | null = null;
  if (input.resource_type === "project") {
    if (!(PROJECT_ROLES as readonly string[]).includes(input.permission)) {
      throw new UserRegistryError("invalid", `Invalid project role '${input.permission}'.`);
    }
    const resolved = resolveProjectRef(db, input.resource ?? "");
    if ((!resolved.ok && resolved.reason === "ambiguous")) throw new UserRegistryError("conflict", "Project reference is ambiguous.");
    if (!resolved.ok) {
      throw new UserRegistryError("not_found", `No project matches '${input.resource ?? ""}'.`);
    }
    resourceId = resolved.project.id;
  } else if (!(GLOBAL_CAPABILITIES as readonly string[]).includes(input.permission)) {
    throw new UserRegistryError("invalid", `Invalid global capability '${input.permission}'.`);
  }

  const existing = db.prepare(
    `SELECT * FROM permission_grants
      WHERE subject_type = ? AND subject_id = ? AND resource_type = ?
        AND resource_id IS ? AND permission = ?`,
  ).get(input.subject_type, subjectId, input.resource_type, resourceId, input.permission) as
    PermissionGrant | undefined;
  if (existing) return existing;
  const id = ulid(now);

  return mutateLedgerRecord(db, {
    entity_type: "grant",
    entity_id: id,
    payload: { subject_id: subjectId },
    project_id: resourceId,
    snapshot: () => db.prepare("SELECT id, subject_type, subject_id, resource_type, resource_id, permission FROM permission_grants WHERE id = ?").get(id) ?? null,
  }, () => {
    db.prepare(
      `INSERT INTO permission_grants (
         id, subject_type, subject_id, resource_type, resource_id, permission, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.subject_type, subjectId, input.resource_type, resourceId, input.permission, now);
    return db.prepare("SELECT * FROM permission_grants WHERE id = ?").get(id) as PermissionGrant;
  });
}

export function removeGrant(db: Db, id: string): void {
  const grant = db.prepare("SELECT * FROM permission_grants WHERE id = ?").get(id) as PermissionGrant | undefined;
  return mutateLedgerRecord(db, {
    entity_type: "grant",
    entity_id: id,
    project_id: grant?.resource_id,
    payload: { subject_id: grant?.subject_id },
    snapshot: () => db.prepare("SELECT id, subject_type, subject_id, resource_type, resource_id, permission FROM permission_grants WHERE id = ?").get(id) ?? null,
  }, () => {

    const result = db.prepare("DELETE FROM permission_grants WHERE id = ?").run(id);
    if (result.changes === 0) throw new UserRegistryError("not_found", `No permission grant '${id}'.`);
  });
}

export function listGrants(db: Db, filter: {
  subject_type?: PermissionSubjectType;
  subject_id?: string;
  resource_type?: "project" | "global";
  resource_id?: string;
} = {}): PermissionGrant[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    clauses.push(`${key} = ?`);
    params.push(value);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM permission_grants${where} ORDER BY created_at, id`)
    .all(...params) as PermissionGrant[];
}

export function setProjectRestricted(db: Db, projectRef: string, restricted: boolean): string {
  const resolved = resolveProjectRef(db, projectRef);
  if ((!resolved.ok && resolved.reason === "ambiguous")) throw new UserRegistryError("conflict", "Project reference is ambiguous.");
  if (!resolved.ok) {
    throw new UserRegistryError("not_found", `No project matches '${projectRef}'.`);
  }

  return mutateLedgerRecord(db, {
    entity_type: "project",
    entity_id: resolved.project.id,
    project_id: resolved.project.id,
    snapshot: () => db.prepare("SELECT id, restricted FROM ledger_projects WHERE id = ?").get(resolved.project.id) ?? null,
  }, () => {
    db.prepare("UPDATE ledger_projects SET restricted = ?, updated_at = ? WHERE id = ?")
      .run(restricted ? 1 : 0, Date.now(), resolved.project.id);
    return resolved.project.id;
  });
}

export function projectAccessSettings(db: Db, projectRef: string): {
  project_id: string;
  restricted: boolean;
  grants: PermissionGrant[];
} {
  const resolved = resolveProjectRef(db, projectRef);
  if ((!resolved.ok && resolved.reason === "ambiguous")) throw new UserRegistryError("conflict", "Project reference is ambiguous.");
  if (!resolved.ok) {
    throw new UserRegistryError("not_found", `No project matches '${projectRef}'.`);
  }
  const row = db.prepare("SELECT restricted FROM ledger_projects WHERE id = ?")
    .get(resolved.project.id) as { restricted: number };
  return {
    project_id: resolved.project.id,
    restricted: row.restricted === 1,
    grants: listGrants(db, { resource_type: "project", resource_id: resolved.project.id }),
  };
}

function identityIsValid(db: Db, identity: ResolvedClientIdentity): boolean {
  const user = getUserById(db, identity.user_id);
  return Boolean(user && user.status === "active" && user.slug === identity.slug);
}

function subjectPredicateSql(): string {
  return `(g.subject_type = 'user' AND g.subject_id = ?)
    OR (g.subject_type = 'group' AND EXISTS (
      SELECT 1 FROM user_group_members m
       WHERE m.group_id = g.subject_id AND m.user_id = ?
    ))`;
}

export function evaluateProjectAccess(db: Db, input: {
  identity: ResolvedClientIdentity | null;
  project_id: string;
  required_role: ProjectRole;
}): AccessDecision {
  const operatorId = getOperatorId(db);
  if (input.identity && !identityIsValid(db, input.identity)) {
    return { allowed: false, reason: "ambiguous_or_inactive_identity", user_id: input.identity.user_id,
      project_id: input.project_id, required_role: input.required_role, effective_role: null,
      operator: false };
  }
  if (input.identity && operatorId !== null && input.identity.user_id === operatorId) {
    return { allowed: true, reason: "operator_implicit_admin", user_id: operatorId,
      project_id: input.project_id, required_role: input.required_role, effective_role: "admin",
      operator: true, restricted: true };
  }
  if (!input.identity) {
    const allowed = getClientAuthMode(db) === "compat";
    return { allowed, reason: allowed ? "compat_anonymous_bypass" : "authentication_required",
      user_id: null, project_id: input.project_id, required_role: input.required_role,
      effective_role: null, operator: false };
  }
  const project = db.prepare("SELECT restricted FROM ledger_projects WHERE id = ?")
    .get(input.project_id) as { restricted: number } | undefined;
  if (!project) {
    return { allowed: false, reason: "project_not_found", user_id: input.identity.user_id,
      project_id: input.project_id, required_role: input.required_role, effective_role: null,
      operator: false };
  }
  if (project.restricted !== 1) {
    return { allowed: true, reason: "project_unrestricted", user_id: input.identity.user_id,
      project_id: input.project_id, required_role: input.required_role, effective_role: "admin",
      operator: false, restricted: false };
  }
  const rows = db.prepare(
    `SELECT g.permission FROM permission_grants g
      WHERE g.resource_type = 'project' AND g.resource_id = ?
        AND (${subjectPredicateSql()})`,
  ).all(input.project_id, input.identity.user_id, input.identity.user_id) as Array<{ permission: ProjectRole }>;
  const effectiveRole = rows.reduce<ProjectRole | null>((best, row) => (
    !best || ROLE_RANK[row.permission] > ROLE_RANK[best] ? row.permission : best
  ), null);
  const allowed = effectiveRole !== null && ROLE_RANK[effectiveRole] >= ROLE_RANK[input.required_role];
  return { allowed, reason: allowed ? "grant" : "project_permission_required",
    user_id: input.identity.user_id, project_id: input.project_id,
    required_role: input.required_role, effective_role: effectiveRole,
    operator: false, restricted: true };
}

export function evaluateGlobalCapability(db: Db, input: {
  identity: ResolvedClientIdentity | null;
  capability: GlobalCapability;
}): AccessDecision {
  const operatorId = getOperatorId(db);
  if (input.identity && !identityIsValid(db, input.identity)) {
    return { allowed: false, reason: "ambiguous_or_inactive_identity",
      user_id: input.identity.user_id, capability: input.capability, operator: false };
  }
  if (input.identity && operatorId !== null && input.identity.user_id === operatorId) {
    return { allowed: true, reason: "operator_implicit_admin", user_id: operatorId,
      capability: input.capability, operator: true };
  }
  if (!input.identity) {
    const allowed = getClientAuthMode(db) === "compat";
    return { allowed, reason: allowed ? "compat_anonymous_bypass" : "authentication_required",
      user_id: null, capability: input.capability, operator: false };
  }
  const grant = db.prepare(
    `SELECT 1 FROM permission_grants g
      WHERE g.resource_type = 'global' AND g.permission = ?
        AND (${subjectPredicateSql()}) LIMIT 1`,
  ).get(input.capability, input.identity.user_id, input.identity.user_id);
  return { allowed: Boolean(grant), reason: grant ? "grant" : "global_capability_required",
    user_id: input.identity.user_id, capability: input.capability, operator: false };
}

export function requireProjectAccess(
  db: Db,
  req: Pick<RequestLike, "client_identity">,
  projectId: string,
  requiredRole: ProjectRole,
): AccessDecision {
  const decision = evaluateProjectAccess(db, {
    identity: req.client_identity ?? null,
    project_id: projectId,
    required_role: requiredRole,
  });
  if (!decision.allowed) {
    throw new PermissionError(
      decision.reason === "authentication_required" ? 401 : 403,
      decision.reason,
      decision.reason === "authentication_required"
        ? "Authentication is required for this restricted project."
        : `Project ${requiredRole} permission is required.`,
    );
  }
  return decision;
}

export function requireGlobalCapability(
  db: Db,
  req: RequestLike,
  capability: GlobalCapability,
): AccessDecision {
  const decision = evaluateGlobalCapability(db, {
    identity: req.client_identity ?? null,
    capability,
  });
  if (!decision.allowed) {
    throw new PermissionError(
      decision.reason === "authentication_required" ? 401 : 403,
      decision.reason,
      decision.reason === "authentication_required"
        ? "Authentication is required."
        : `Global capability '${capability}' is required.`,
    );
  }
  return decision;
}

export function sendPermissionError(res: ResponseLike, error: PermissionError): void {
  res.status(error.status).json({ error: error.message, code: error.code });
}
