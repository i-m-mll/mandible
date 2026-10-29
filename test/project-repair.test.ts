import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRODUCTION_EFFECTS } from "../src/security/operation-policy.js";
import type { Db } from "../src/db.js";
import { addProject, addOrUpdateCheckout, repairRegistry, resolveProjectRef, type RepairResult } from "../src/ledger/project-registry.js";
import { discoverProjectReferences, projectReferenceCoverage } from "../src/ledger/project-reference-policy.js";
import { LedgerStore } from "../src/ledger/store.js";
import { systemAction } from "../src/identity/resolver.js";
import { withLedgerMutationActor } from "../src/ledger/mutation-history.js";
import { onProtectionInputsChanged } from "../src/protection-inputs.js";
import { addGrant, removeGrant, addGroup, addGroupMember, setProjectRestricted, evaluateProjectAccess, evaluateGlobalCapability } from "../src/permissions/store.js";
import { addCredential, addDelegatedSigningLease, createUser, setupOperator } from "../src/users/store.js";
import type { ResolvedClientIdentity } from "../src/server.js";
import { ConversationSpawnService } from "../src/conversation-spawn/service.js";
import { createManagedReminder } from "../src/managed-reminders.js";
import { parseManagedReminderCreateRequest } from "../src/managed-reminder-parser.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import * as sse from "../src/sse.js";

let db: Db;
let root: string;
beforeEach(() => { db = migratedMemoryDb(); root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-repair-"))); });
afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
function ok(result: RepairResult) {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function pair() {
  const source = addProject(db, { project_key: "source" });
  const target = addProject(db, { project_key: "target" });
  return { source, target, merge: { source: source.id, target: target.id } };
}
const identity = (user: { id: string; slug: string }): ResolvedClientIdentity => ({
  user_id: user.id, slug: user.slug, method: "api_token", credential_id: null, source: "in_process", effect_ceiling: PRODUCTION_EFFECTS,
});
const issue = (project_id: string, title: string, kind: "bug" | "maintenance" = "bug") => new LedgerStore(db)
  .createIssue({ project_id, title, body: "Retain exact issue content", kind, attribution: systemAction(), actor_type: "system", author_display: "System" });
function snapshot() {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}

it.each(["CASCADE", "SET NULL"])("blocks even an empty unclassified differently named %s FK", action => {
  const { merge } = pair();
  expect(projectReferenceCoverage(db)).toEqual([]);
  expect(discoverProjectReferences(db)).toContainEqual({ table: "permission_grants", column: "resource_id" });
  db.exec(`CREATE TABLE future_scope(id TEXT PRIMARY KEY, owner_namespace TEXT REFERENCES ledger_projects(id) ON DELETE ${action})`);
  const before = snapshot();
  const plan = ok(repairRegistry(db, { merge }));
  expect(plan.merge!.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "schema_coverage", value: expect.stringContaining("future_scope.owner_namespace") })]));
  expect(repairRegistry(db, { merge, apply: true })).toMatchObject({ ok: false, error: { code: "merge_conflict" } });
  expect(snapshot()).toEqual(before);
});

it("unions explicit grants without changing revocation or approval authority", () => {
  const { source, target, merge } = pair();
  const user = createUser(db, { slug: "grantee", kind: "agent", display_name: "Agent" });
  const group = addGroup(db, { slug: "team" });
  const owner = setupOperator(db, { slug: "owner" });
  addGroupMember(db, group.id, user.id);
  setProjectRestricted(db, source.id, true); setProjectRestricted(db, target.id, true);
  const grant = (project: string, permission: string, subject_type: "user" | "group" = "user") => addGrant(db, {
    subject_type, subject: subject_type === "user" ? user.id : group.id, resource_type: "project", resource: project, permission,
  }, 100);
  const duplicate = grant(source.id, "read");
  const survivor = grant(target.id, "read");
  const stronger = grant(source.id, "admin");
  const groupGrant = grant(source.id, "write", "group");
  const global = addGrant(db, { subject_type: "user", subject: user.id, resource_type: "global", permission: "spawn_console" });
  const before = snapshot();
  const plan = ok(repairRegistry(db, { merge }));
  expect(plan.merge!.grant_coalescences).toEqual([{ source_id: duplicate.id, survivor_id: survivor.id }]);
  expect(plan.merge!.moves).toContainEqual(expect.objectContaining({ key: "permission_grants.resource_id", rows: 3 }));
  expect(snapshot()).toEqual(before);
  ok(withLedgerMutationActor({ attribution: { user_id: user.id, evidence_method: "api_token" } }, () => repairRegistry(db, { merge, apply: true })));
  expect(db.prepare("SELECT * FROM permission_grants ORDER BY id").all()).toEqual([
    survivor, { ...stronger, resource_id: target.id }, { ...groupGrant, resource_id: target.id }, global,
  ].sort((a, b) => a.id.localeCompare(b.id)));
  expect(evaluateProjectAccess(db, { identity: identity(user), project_id: target.id, required_role: "admin" })).toMatchObject({ allowed: true, effective_role: "admin" });
  removeGrant(db, stronger.id);
  expect(evaluateProjectAccess(db, { identity: identity(user), project_id: target.id, required_role: "admin" })).toMatchObject({ allowed: false, effective_role: "write" });
  removeGrant(db, groupGrant.id);
  expect(evaluateProjectAccess(db, { identity: identity(user), project_id: target.id, required_role: "read" })).toMatchObject({ allowed: true, effective_role: "read" });
  expect(evaluateGlobalCapability(db, { identity: identity(user), capability: "approve_auth" }).allowed).toBe(false);
  expect(evaluateProjectAccess(db, { identity: identity(owner), project_id: target.id, required_role: "admin" })).toMatchObject({ allowed: true, operator: true });
  const event = db.prepare("SELECT * FROM ledger_events WHERE entity_id=? AND event_type='grant.deleted'").get(duplicate.id) as Record<string, unknown>;
  expect(event).toMatchObject({ actor_user_id: user.id, evidence_method: "api_token" });
  expect(JSON.parse(event.payload_json as string)).toMatchObject({ survivor_id: survivor.id });
});

it("ignores an unrelated existing orphan while keeping enforcement enabled", () => {
  const { merge } = pair();
  db.pragma("foreign_keys=OFF");
  db.prepare("INSERT INTO spaces(id, title, project_id, created_at, updated_at) VALUES ('orphan','orphan','missing',1,1)").run();
  db.pragma("foreign_keys=ON");
  const orphan = db.prepare("SELECT * FROM spaces WHERE id='orphan'").get();
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  expect(violations).toHaveLength(1);
  ok(repairRegistry(db, { merge, apply: true }));
  expect(db.prepare("SELECT * FROM spaces WHERE id='orphan'").get()).toEqual(orphan);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual(violations);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
});

it("rolls back keys, grants, checkout history, both feeds, and notifications after a late invalid FK write", () => {
  const { source, target, merge } = pair();
  const checkout = addOrUpdateCheckout(db, source.id, { root: path.join(root, "source"), work_repo_id: "repair-source", default_branch: "main" });
  issue(source.id, "Source"); issue(target.id, "Destination");
  const user = createUser(db, { slug: "rollback", kind: "agent", display_name: "Rollback" });
  addGrant(db, { subject_type: "user", subject: user.id, resource_type: "project", resource: source.id, permission: "read" });
  db.prepare("UPDATE ledger_projects SET project_key='' WHERE id=?").run(source.id);
  db.exec("CREATE TRIGGER fail_project_delete AFTER DELETE ON ledger_projects BEGIN INSERT INTO spaces(id,title,project_id,created_at,updated_at) VALUES ('invalid','Invalid','missing',1,1); END");
  const before = snapshot();
  const publish = vi.spyOn(sse, "broadcast");
  const protection = vi.fn(); const dispose = onProtectionInputsChanged(protection);
  try {
    const result = repairRegistry(db, { merge, apply: true });
    expect(result).toMatchObject({ ok: false, error: { code: "constraint" } });
    expect(snapshot()).toEqual(before);
    expect(publish).not.toHaveBeenCalled(); expect(protection).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER fail_project_delete");
    const report = ok(repairRegistry(db, { merge, apply: true }));
    expect(report.key_backfills).toHaveLength(1);
    expect(protection).toHaveBeenCalledTimes(1);
    expect(resolveProjectRef(db, checkout.checkout.root)).toMatchObject({ ok: true, project: { id: target.id }, checkout: { id: checkout.checkout.id } });
  } finally { dispose(); }
});

it("refuses disabled FK enforcement and malformed/same/unknown project references without backfilling", () => {
  const { source, merge } = pair();
  db.prepare("UPDATE ledger_projects SET project_key='' WHERE id=?").run(source.id);
  const before = snapshot();
  db.pragma("foreign_keys=OFF");
  expect(repairRegistry(db, { merge, apply: true })).toMatchObject({ ok: false, error: { code: "foreign_keys_disabled" } });
  db.pragma("foreign_keys=ON");
  for (const input of [{ merge: { source: source.id } }, { apply: "true" }, { force: true }]) {
    expect(repairRegistry(db, input as never)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  }
  expect(repairRegistry(db, { apply: true, merge: { source: source.id, target: source.id } })).toMatchObject({ ok: false, error: { code: "same_project" } });
  expect(repairRegistry(db, { apply: true, merge: { source: source.id, target: "missing" } })).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(snapshot()).toEqual(before);
  expect(ok(repairRegistry(db)).key_backfills).toHaveLength(1);
  expect(snapshot()).toEqual(before);
});

it.each(["alias", "association", "singleton", "restricted_policy"] as const)("reports %s collisions with no row loss", kind => {
  const { source, target, merge } = pair();
  if (kind === "alias") {
    const sameIssue = issue(source.id, "Shared issue");
    db.prepare("INSERT INTO ledger_issue_aliases(issue_id,alias_kind,project_id,alias,source,created_at) VALUES (?,'other',?,'shared','first',1),(?,'other',?,'shared','second',2)").run(sameIssue.id, source.id, sameIssue.id, target.id);
  } else if (kind === "association") {
    db.prepare("INSERT INTO project_artifact_associations(id,project_id,target_type,target_id,role,title,created_at,updated_at) VALUES ('a',?,'artifact','logical','report','First',1,1),('b',?,'artifact','logical','report','Second',1,1)").run(source.id, target.id);
  } else if (kind === "singleton") { issue(source.id, "Source maintenance", "maintenance"); issue(target.id, "Target maintenance", "maintenance"); }
  else setProjectRestricted(db, source.id, true);
  const before = snapshot();
  expect(ok(repairRegistry(db, { merge })).merge!.conflicts).toContainEqual(expect.objectContaining({ kind }));
  expect(repairRegistry(db, { merge, apply: true })).toMatchObject({ ok: false, error: { code: "merge_conflict" } });
  expect(snapshot()).toEqual(before);
});

it("preserves feed event identity and target order, appends the source stream, and blocks gaps", () => {
  const { source, target, merge } = pair();
  issue(source.id, "Source 1"); issue(target.id, "Target 1"); issue(source.id, "Source 2");
  const rows = (id: string) => db.prepare("SELECT sequence,event_id FROM ledger_change_log WHERE project_id=? ORDER BY sequence").all(id) as {sequence:number;event_id:string}[];
  const src = rows(source.id), dst = rows(target.id);
  const removed = src[1];
  db.prepare("DELETE FROM ledger_change_log WHERE project_id=? AND sequence=?").run(source.id, removed.sequence);
  const before = snapshot();
  expect(ok(repairRegistry(db, { merge })).merge!.conflicts).toContainEqual(expect.objectContaining({ kind: "feed_continuity" }));
  expect(repairRegistry(db, { merge, apply: true }).ok).toBe(false); expect(snapshot()).toEqual(before);
  db.prepare("INSERT INTO ledger_change_log(project_id,sequence,event_id,recorded_at) VALUES (?,?,?,1)").run(source.id, removed.sequence, removed.event_id);
  ok(repairRegistry(db, { merge, apply: true }));
  expect(rows(target.id).slice(0, dst.length + src.length).map(row => row.event_id)).toEqual([...dst,...src].map(row => row.event_id));
  expect(rows(target.id).map(row => row.sequence)).toEqual(Array.from({length:rows(target.id).length}, (_,i) => i+1));
  expect(db.prepare("SELECT * FROM ledger_change_feed_state WHERE project_id=?").get(source.id)).toBeUndefined();
});

it.each(["spawn", "reminder", "artifact-source", "artifact-lineage", "work-unit", "approval"])("pins %s identity, preserving exact bytes and digests", kind => {
  const { source, target, merge } = pair();
  const checkout = addOrUpdateCheckout(db, source.id, { root: path.join(root, "pin"), work_repo_id: "pin-repo" }).checkout;
  const user = createUser(db, { slug: "pin-agent", kind: "agent", display_name: "Pin" });
  let expected: string;
  if (kind === "spawn") {
    expect(new ConversationSpawnService(db).reserve({ schema: "mandible-conversation-spawn-request@3", idempotency_key: "1fa1f7d2-c898-4a7e-a3c7-c9bbc6982311", provider: "codex",
      placement: { kind: "project", project_id: source.id, checkout_id: checkout.id } }).ok).toBe(true);
    const counted = ok(repairRegistry(db, { merge })).merge!;
    expect(counted.reference_occurrences).toBe(counted.distinct_rows + 1);
    // A conflicting projection cannot hide the immutable payload reference.
    const other = addOrUpdateCheckout(db, target.id, { root: path.join(root, "other") }).checkout;
    db.prepare("UPDATE conversation_spawn_requests SET project_id=?,checkout_id=?").run(target.id, other.id);
    expected = "conversation_spawn_requests.request_json:placement";
  } else if (kind === "reminder") {
    createManagedReminder(db, parseManagedReminderCreateRequest({ schema: "mandible-reminder@1", project: source.id, message: "Keep digest", idempotency_key: "pin-reminder",
      predicate: { kind: "auth_merge_count_gte", project: source.id, threshold: 1 } }), { userId: user.id, evidenceMethod: "api_token" });
    expected = "managed_task_revisions.payload_json:predicate";
  } else if (kind.startsWith("artifact")) {
    db.prepare("INSERT INTO artifact(id,identity_key,source_project_id,created_at,updated_at) VALUES ('artifact','pin',?,1,1)").run(source.id);
    const locator = JSON.stringify({ kind: "repo", project_id: source.id, path: "report.md" });
    if (kind === "artifact-source") {
      db.prepare("INSERT INTO artifact_source(artifact_id,source_json,revision,updated_at) VALUES ('artifact',?,1,1)").run(locator);
      expected = "artifact_source.source_json:repo";
    } else {
      db.prepare("INSERT INTO artifact_source_move(id,artifact_id,previous_source_json,source_json,previous_revision,revision,actor,created_at) VALUES ('move','artifact',?,?,1,2,'test',1)").run(locator, JSON.stringify({kind:"managed",producer_key:"new"}));
      expected = "artifact_source_move.previous_source_json:repo";
    }
  } else if (kind === "work-unit") {
    db.prepare("INSERT INTO work_units(id,issue_id,repo_id,state,created_at) VALUES ('unit','historical',?,'resolved',1)").run(source.project_key);
    expected = "work_units.repo_id:repository";
  } else {
    db.prepare("INSERT INTO auth_requests(id,command,title,status,created_at,updated_at,expires_at,repo,target_repo_root) VALUES ('request','merge','Historical','completed',1,1,2,'unknown',?)").run(checkout.root);
    expected = "auth_requests.target_repo_root:repository";
  }
  const before = snapshot();
  expect(ok(repairRegistry(db, { merge })).merge!.conflicts).toContainEqual(expect.objectContaining({ kind: "historical_reference", value: expected, count: 1 }));
  expect(repairRegistry(db, { merge, apply: true })).toMatchObject({ ok: false, error: { code: "merge_conflict" } });
  expect(snapshot()).toEqual(before);
});

it.each(["active", "expired", "revoked"])("pins %s clearance scope without changing authority", state => {
  const { source, merge } = pair();
  const owner = setupOperator(db, { slug: "owner" });
  const agent = createUser(db, { slug: "clearance-agent", kind: "agent", display_name: "Agent" });
  const credential = addCredential(db, agent.id, { type: "api_token", fingerprint: "agent-token-fingerprint" });
  const delegated = addCredential(db, owner.id, { type: "delegated_ssh_key", fingerprint: `SHA256:${"C".repeat(43)}`,
    public_material: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"C".repeat(20)} test` });
  addDelegatedSigningLease(db, { id: "lease", credential_id: delegated.id, owner_user_id: owner.id,
    minted_at: 1, expires_at: 100, mint_method: "fresh_presence" });
  db.prepare(`INSERT INTO auth_clearances(id,issuer_user_id,grantee_user_id,grantee_credential_id,project_id,
    base_branch,head_branch,action,issued_at,expires_at,max_uses,revoked_at,revoked_by_user_id,runtime_epoch,signing_lease_id)
    VALUES ('clearance',?,?,?,?,'main','feature/pin','merge',1,?,1,?,?,'epoch','lease')`)
    .run(owner.id, agent.id, credential.id, source.id, state === "active" ? Date.now()+60_000 : 100,
      state === "revoked" ? 50 : null, state === "revoked" ? owner.id : null);
  const before = snapshot();
  expect(ok(repairRegistry(db, { merge })).merge!.conflicts).toContainEqual(expect.objectContaining({ value: "auth_clearances.project_id", count: 1 }));
  expect(repairRegistry(db, { merge, apply: true }).ok).toBe(false);
  expect(snapshot()).toEqual(before);
});

it("pins Git custody without rewriting version identity or the logical owner", () => {
  const { source, merge } = pair();
  const hash = "a".repeat(64);
  db.prepare("INSERT INTO artifact(id,identity_key,source_project_id,created_at,updated_at) VALUES ('artifact','git',?,1,1)").run(source.id);
  db.prepare("INSERT INTO artifact_blob(id,content_hash,created_at) VALUES ('blob',?,1)").run(hash);
  db.prepare(`INSERT INTO artifact_version(id,artifact_id,version_no,blob_id,source_kind,content_hash,source_project_id,
    repo_path,commit_sha,custody_mode,created_at) VALUES ('version','artifact',1,'blob','tracked_repo',?,?,'report.md',?,'git',1)`)
    .run(hash, source.id, "b".repeat(40));
  const before = snapshot();
  expect(ok(repairRegistry(db, { merge })).merge!.conflicts).toContainEqual(expect.objectContaining({ value: "artifact_version.source_project_id", count: 1 }));
  expect(repairRegistry(db, { merge, apply: true }).ok).toBe(false);
  expect(snapshot()).toEqual(before);
});
