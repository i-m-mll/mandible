import type { Db } from "../db.js";
import { resolveProjectRef } from "./project-registry.js";

type Locator =
  | { kind: "column"; table: string; column: string }
  | { kind: "json"; table: string; column: string; path: string; discriminator: string }
  | { kind: "repository"; table: string; column: string };
type Disposition = { disposition: "move" } | { disposition: "merge"; handler: "checkout" | "grants" | "feed" }
  | { disposition: "pin"; reason: string };
export type ProjectReferencePolicy = {
  key: string;
  locator: Locator;
} & Disposition;

const column = (table: string, name: string, policy: Disposition): ProjectReferencePolicy =>
  ({ key: `${table}.${name}`, locator: { kind: "column", table, column: name }, ...policy });
const move = (table: string, name = "project_id") => column(table, name, { disposition: "move" });
const pin = (table: string, name: string, reason: string) => column(table, name, { disposition: "pin", reason });

/** Mutable namespace references and immutable identity references share this contract. */
export const PROJECT_REFERENCE_POLICIES: readonly ProjectReferencePolicy[] = [
  move("ledger_issues"), move("ledger_issue_aliases"), move("ledger_body_revisions"),
  move("ledger_relationship_edges", "source_project_id"), move("ledger_relationship_edges", "target_project_id"),
  move("ledger_commit_issue_links"), move("ledger_reconciliation_mismatches"),
  move("artifact", "source_project_id"), move("project_artifact_associations"), move("spaces"),
  move("trash_entries"), move("auth_request_merge_succeeded_facts"), move("briefing_destination_mutations"),
  column("ledger_project_checkouts", "project_id", { disposition: "merge", handler: "checkout" }),
  column("permission_grants", "resource_id", { disposition: "merge", handler: "grants" }),
  column("ledger_change_feed_state", "project_id", { disposition: "merge", handler: "feed" }),
  column("ledger_change_log", "project_id", { disposition: "merge", handler: "feed" }),
  pin("auth_clearances", "project_id", "Immutable clearance scope, including expired and revoked clearances"),
  pin("artifact_version", "source_project_id", "Immutable artifact custody"),
  pin("conversation_spawn_requests", "project_id", "Frozen spawn request and replay identity"),
  pin("managed_tasks", "project_id", "Reminder request digest binds the owning project"),
  pin("managed_task_events", "project_id", "Immutable reminder event scope"),
  ...["source_json", "previous_source_json"].flatMap(name => ["artifact_source", "artifact_source_move"]
    .filter(table => table !== "artifact_source" || name === "source_json")
    .map((table): ProjectReferencePolicy => ({ key: `${table}.${name}:repo`, locator: { kind: "json", table, column: name,
      path: "$.project_id", discriminator: "json_extract(VALUE, '$.kind') = 'repo'" },
      disposition: "pin", reason: "Registered repository source and immutable source lineage" }))),
  { key: "conversation_spawn_requests.request_json:placement", locator: { kind: "json", table: "conversation_spawn_requests",
    column: "request_json", path: "$.placement.project_id",
    discriminator: "json_extract(VALUE, '$.schema') IN ('mandible-conversation-spawn-request@1','mandible-conversation-spawn-request@2','mandible-conversation-spawn-request@3')" },
    disposition: "pin", reason: "Frozen typed spawn placement" },
  { key: "managed_task_revisions.payload_json:predicate", locator: { kind: "json", table: "managed_task_revisions",
    column: "payload_json", path: "$.predicate.project_id",
    discriminator: "json_extract(VALUE, '$.schema') = 'mandible-reminder@1' AND json_extract(VALUE, '$.predicate.kind') = 'auth_merge_count_gte'" },
    disposition: "pin", reason: "Frozen reminder predicate" },
  ...[{ table: "work_units", column: "repo_id" },
    ...["repo", "cwd", "target_repo_root"].map(column => ({ table: "auth_requests", column }))]
    .map((locator): ProjectReferencePolicy => ({ key: `${locator.table}.${locator.column}:repository`, locator: { kind: "repository", ...locator },
      disposition: "pin", reason: "Durable work-unit or approval repository identity" })),
];

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Discover FKs independently of their spelling and ON DELETE behavior. */
export function discoverProjectReferences(db: Db): Array<{ table: string; column: string }> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return tables.flatMap(({ name }) => (db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all() as { table: string; from: string }[])
    .filter(fk => fk.table === "ledger_projects").map(fk => ({ table: name, column: fk.from })));
}

export function projectReferenceCoverage(db: Db): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  const columns = new Map<string, number>();
  for (const policy of PROJECT_REFERENCE_POLICIES) {
    if (keys.has(policy.key)) errors.push(`duplicate policy: ${policy.key}`);
    keys.add(policy.key);
    const { table, column } = policy.locator;
    const schema = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[];
    if (!schema.some(col => col.name === column)) errors.push(`missing declared locator: ${policy.key}`);
    if (policy.locator.kind === "column") {
      const key = `${table}.${column}`;
      columns.set(key, (columns.get(key) ?? 0) + 1);
    }
  }
  for (const fk of discoverProjectReferences(db)) {
    const key = `${fk.table}.${fk.column}`;
    if (columns.get(key) !== 1) errors.push(`unclassified or duplicate project FK: ${key}`);
  }
  return errors;
}

/** Returns row identities so occurrences and distinct affected rows remain separate. */
export function projectReferenceRows(db: Db, policy: ProjectReferencePolicy, projectId: string): number[] {
  const locator = policy.locator;
  const table = quoteIdentifier(locator.table), column = quoteIdentifier(locator.column);
  if (locator.kind === "column") {
    return (db.prepare(`SELECT rowid AS row_id FROM ${table} WHERE ${column} = ?`).all(projectId) as { row_id: number }[]).map(row => row.row_id);
  }
  if (locator.kind === "json") {
    return (db.prepare(`SELECT rowid AS row_id FROM ${table} WHERE ${locator.discriminator.replaceAll("VALUE", column)} AND json_extract(${column}, ?) = ?`)
      .all(locator.path, projectId) as { row_id: number }[]).map(row => row.row_id);
  }
  const refs = db.prepare(`SELECT DISTINCT ${column} AS ref FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`).all() as { ref: string }[];
  const matching = refs.filter(({ ref }) => {
    const resolved = resolveProjectRef(db, ref);
    return resolved.ok ? resolved.project.id === projectId : resolved.reason === "ambiguous"
      && resolved.candidates.some(candidate => {
        const candidateProject = resolveProjectRef(db, candidate);
        return candidateProject.ok && candidateProject.project.id === projectId;
      });
  });
  return matching.flatMap(({ ref }) => (db.prepare(`SELECT rowid AS row_id FROM ${table} WHERE ${column} = ?`).all(ref) as { row_id: number }[]).map(row => row.row_id));
}
