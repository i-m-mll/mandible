import path from "node:path";
import type { Db } from "./db.js";
import {
  artifactRequiredProjects,
  commitArtifactSourceMove,
  planArtifactSourceMove,
  type ArtifactSource,
} from "./artifact-source.js";
import { mutateLedgerRecord } from "./ledger/mutation-history.js";
import { quoteIdentifier } from "./ledger/project-reference-policy.js";
import { resolveWorkProject } from "./permissions/resources.js";
import { notifyProtectionInputsChanged } from "./protection-inputs.js";

type Locator =
  | { kind: "column"; table: string; column: string }
  | { kind: "json"; table: string; column: string; path: string; discriminator: string };
type Disposition =
  | { disposition: "move"; handler: "column" | "checkout" | "artifact_source" }
  | { disposition: "pin"; reason: string };
export type CheckoutPathPolicy = { key: string; locator: Locator } & Disposition;

const column = (table: string, name: string, policy: Disposition): CheckoutPathPolicy =>
  ({ key: `${table}.${name}`, locator: { kind: "column", table, column: name }, ...policy });
const move = (table: string, name: string) => column(table, name, { disposition: "move", handler: "column" });
const pin = (reason: string, ...keys: string[]) => keys.map(key => {
  const [table, name] = key.split(".");
  return column(table!, name!, { disposition: "pin", reason });
});
const localSource = (table: string, name: string, policy: Disposition): CheckoutPathPolicy => ({
  key: `${table}.${name}:local`,
  locator: { kind: "json", table, column: name, path: "$.path", discriminator: "json_extract(VALUE, '$.kind') = 'local'" },
  ...policy,
});

/**
 * Every stored filesystem path, and whether relocating a checkout moves it or
 * keeps it as recorded. A path-like column missing here blocks relocation.
 */
export const CHECKOUT_PATH_POLICIES: readonly CheckoutPathPolicy[] = [
  move("work_repos", "root"),
  column("ledger_project_checkouts", "root", { disposition: "move", handler: "checkout" }),
  move("branches", "repo_root"),
  move("branches", "worktree_path"),
  move("trash_entries", "repo_root"),
  localSource("artifact_source", "source_json", { disposition: "move", handler: "artifact_source" }),
  ...["source_json", "previous_source_json"].map(name =>
    localSource("artifact_source_move", name, { disposition: "pin", reason: "Immutable source-move history" })),
  ...pin("Immutable artifact custody", "artifact_version.repo_path", "artifact_version.observed_path"),
  ...pin("Approval snapshot", "auth_requests.cwd", "auth_requests.target_repo_root"),
  ...pin("Enumerated authority, not a filesystem path",
    "auth_request_lifecycle_events.authority_path", "work_unit_custody_events.authority_path"),
  ...pin("Session or dispatch working directory as recorded",
    "agent_dispatch_events.cwd", "agent_dispatch_events.prompt_path", "console_sessions.cwd", "sessions.cwd",
    "conversations.cwd", "conversations.project_path"),
  ...pin("Provider transcript source", "conversations.source_path", "conversation_ingest_state.file_path",
    "conversation_source_aliases.root_path", "conversation_source_aliases.relative_path", "conversation_source_aliases.path",
    "console_session_telemetry.transcript_path"),
  ...pin("Workflow run record", "workflow_ingest_state.file_path", "workflow_ingest_state.summary_path",
    "workflow_runs.project_path", "workflow_runs.summary_path", "workflow_runs.script_path", "workflow_workers.transcript_path"),
  ...pin("Checkout-relative path; follows its checkout by id", "space_exports.path", "space_publications.path"),
  ...pin("Completed push record", "push_history.repo_root"),
  ...pin("Signing runtime binding outside checkouts",
    "delegated_signing_runtime_bindings.socket_path", "delegated_signing_runtime_bindings.public_key_path"),
];

const PATH_LIKE_COLUMN = /(^|_)(root|path|cwd)$/;

/** Unclassified path-like columns and stale policy locators; empty when the manifest covers the schema. */
export function checkoutPathCoverage(db: Db): string[] {
  const errors: string[] = [];
  const declared = new Set<string>();
  for (const policy of CHECKOUT_PATH_POLICIES) {
    const { table, column } = policy.locator;
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[];
    if (!columns.some(candidate => candidate.name === column)) errors.push(`missing declared locator: ${policy.key}`);
    if (policy.locator.kind === "column") declared.add(`${table}.${column}`);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    for (const { name: col } of db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as { name: string }[]) {
      if (PATH_LIKE_COLUMN.test(col) && !declared.has(`${name}.${col}`)) errors.push(`unclassified path column: ${name}.${col}`);
    }
  }
  return errors;
}

export interface CheckoutRelocation { old_root: string; new_root: string }

export type RelocationFailure =
  | { code: "invalid_root"; message: string }
  | { code: "nested_roots"; message: string }
  | { code: "schema_coverage"; message: string; unclassified: string[] }
  | { code: "destination_occupied"; message: string; occupants: Array<{ key: string; value: string }> }
  | { code: "artifact_source"; message: string; artifact_id: string };
export type RelocationResult<T> = { ok: true; value: T } | { ok: false; error: RelocationFailure };

/**
 * `unchanged`: nothing under the old root and the new root is registered.
 * `not_found`: neither root is registered. `moved` counts rewritten rows per
 * policy key, plus `repos.json` entries.
 */
export interface RelocationReport extends CheckoutRelocation {
  status: "relocated" | "unchanged" | "not_found";
  moved: Record<string, number>;
}

const fail = <T>(error: RelocationFailure): RelocationResult<T> => ({ ok: false, error });

export function isAtOrUnder(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function relocatePath(relocation: CheckoutRelocation, candidate: string): string {
  return isAtOrUnder(relocation.old_root, candidate)
    ? relocation.new_root + candidate.slice(relocation.old_root.length)
    : candidate;
}

export function parseCheckoutRelocation(oldRoot: unknown, newRoot: unknown): RelocationResult<CheckoutRelocation> {
  if (typeof oldRoot !== "string" || typeof newRoot !== "string" || !path.isAbsolute(oldRoot) || !path.isAbsolute(newRoot)) {
    return fail({ code: "invalid_root", message: "old_root and new_root must be absolute paths" });
  }
  const relocation = { old_root: path.resolve(oldRoot), new_root: path.resolve(newRoot) };
  if (isAtOrUnder(relocation.old_root, relocation.new_root) || isAtOrUnder(relocation.new_root, relocation.old_root)) {
    return fail({ code: "nested_roots", message: "old_root and new_root must be distinct and not nested" });
  }
  return { ok: true, value: relocation };
}

/** `?1` is the root; `?2` and `?3` bound the binary range of strings that begin with `root/`. */
const SUBTREE = (col: string) => `(${col} = ?1 OR (${col} >= ?2 AND ${col} < ?3))`;
const subtreeArgs = (root: string) => [root, `${root}/`, `${root}0`];

type LocalSourceRow = { artifact_id: string; revision: number; source: ArtifactSource & { kind: "local" } };

function localSources(db: Db, root: string): LocalSourceRow[] {
  const rows = db.prepare(
    "SELECT artifact_id, revision, source_json FROM artifact_source WHERE json_extract(source_json, '$.kind') = 'local'",
  ).all() as { artifact_id: string; revision: number; source_json: string }[];
  return rows
    .map(row => ({ artifact_id: row.artifact_id, revision: row.revision, source: JSON.parse(row.source_json) as LocalSourceRow["source"] }))
    .filter(row => isAtOrUnder(root, row.source.path));
}

function policyValues(db: Db, policy: CheckoutPathPolicy, root: string): string[] {
  if (policy.locator.kind === "json") return localSources(db, root).map(row => row.source.path);
  const col = quoteIdentifier(policy.locator.column);
  return (db.prepare(`SELECT ${col} AS value FROM ${quoteIdentifier(policy.locator.table)} WHERE ${SUBTREE(col)}`)
    .all(...subtreeArgs(root)) as { value: string }[]).map(row => row.value);
}

export interface RelocateCheckoutRowsInput {
  relocation: CheckoutRelocation;
  /** `repos.json` entries the caller rewrites in the same transaction. */
  config_entries: number;
  actor: string;
  /** Throws to refuse; runs inside the transaction before any write. */
  authorize: (projectIds: string[]) => void;
}

/**
 * Rewrites every moved path at or under `old_root`. Callers run it inside an
 * immediate transaction and roll back when it fails.
 */
export function relocateCheckoutRows(db: Db, input: RelocateCheckoutRowsInput): RelocationResult<RelocationReport> {
  const unclassified = checkoutPathCoverage(db);
  if (unclassified.length) {
    return fail({ code: "schema_coverage", message: "Path columns lack a relocation policy", unclassified });
  }
  const { relocation } = input;
  const moves = CHECKOUT_PATH_POLICIES.filter(
    (policy): policy is CheckoutPathPolicy & { disposition: "move" } => policy.disposition === "move",
  );
  const moved: Record<string, number> = Object.fromEntries(
    moves.map(policy => [policy.key, policyValues(db, policy, relocation.old_root).length]),
  );
  moved["repos.json"] = input.config_entries;
  const total = Object.values(moved).reduce((sum, n) => sum + n, 0);
  const occupants = moves.flatMap(policy =>
    policyValues(db, policy, relocation.new_root).slice(0, 5).map(value => ({ key: policy.key, value })));
  if (total === 0) {
    return { ok: true, value: { status: occupants.length ? "unchanged" : "not_found", ...relocation, moved } };
  }
  if (occupants.length) {
    return fail({ code: "destination_occupied", message: `${relocation.new_root} already holds registered paths`, occupants });
  }

  const checkouts = db.prepare(
    `SELECT id, project_id, root FROM ledger_project_checkouts WHERE ${SUBTREE("root")}`,
  ).all(...subtreeArgs(relocation.old_root)) as { id: string; project_id: string; root: string }[];
  const trashProjects = db.prepare(
    `SELECT DISTINCT project_id FROM trash_entries WHERE ${SUBTREE("repo_root")}`,
  ).all(...subtreeArgs(relocation.old_root)) as { project_id: string }[];
  const workRepos = db.prepare(`SELECT id, root FROM work_repos WHERE ${SUBTREE("root")}`)
    .all(...subtreeArgs(relocation.old_root)) as { id: string; root: string }[];
  const sources = localSources(db, relocation.old_root);
  input.authorize([...new Set([
    ...checkouts.map(row => row.project_id),
    ...trashProjects.map(row => row.project_id),
    ...workRepos.flatMap(row => {
      const project = resolveWorkProject(db, row.id);
      const resolved = project.ok ? project : resolveWorkProject(db, row.root);
      return resolved.ok ? [resolved.project_id] : [];
    }),
    ...sources.flatMap(row => artifactRequiredProjects(db, row.artifact_id, row.source)),
  ])].sort());

  const now = Date.now();
  for (const checkout of checkouts) {
    mutateLedgerRecord(db, {
      entity_type: "checkout",
      entity_id: checkout.id,
      project_id: checkout.project_id,
      payload: { relocation },
      snapshot: () => db.prepare("SELECT id, project_id, work_repo_id, root, name, default_branch, remote_url FROM ledger_project_checkouts WHERE id = ?").get(checkout.id) ?? null,
    }, () => {
      db.prepare("UPDATE ledger_project_checkouts SET root = ?, updated_at = ? WHERE id = ?")
        .run(relocatePath(relocation, checkout.root), now, checkout.id);
    });
  }
  for (const policy of moves) {
    if (policy.handler !== "column" || policy.locator.kind !== "column") continue;
    const col = quoteIdentifier(policy.locator.column);
    db.prepare(`UPDATE ${quoteIdentifier(policy.locator.table)} SET ${col} = ?4 || substr(${col}, length(?1) + 1) WHERE ${SUBTREE(col)}`)
      .run(...subtreeArgs(relocation.old_root), relocation.new_root);
  }
  for (const row of sources) {
    const plan = planArtifactSourceMove(db, {
      artifact_id: row.artifact_id,
      expected_revision: row.revision,
      source: { kind: "local", path: relocatePath(relocation, row.source.path) },
      actor: input.actor,
    });
    const committed = plan.ok ? commitArtifactSourceMove(db, plan.value, now) : plan;
    if (!committed.ok) {
      return fail({ code: "artifact_source", message: committed.error.message, artifact_id: row.artifact_id });
    }
  }
  if (checkouts.length) db.afterCommit(() => notifyProtectionInputsChanged("checkout:relocate"));
  return { ok: true, value: { status: "relocated", ...relocation, moved } };
}
