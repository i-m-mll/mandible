/**
 * Shared ledger/database fixtures for tests (issue c4f456c).
 *
 * Six test files carried drifted private copies of `createMigratedDb()` and
 * several carried near-identical `createLedgerProject` / `createLedgerIssue`
 * factories. The copies disagreed on three things: whether an operator user is
 * seeded, whether an agent user (and its provider-session binding) is seeded,
 * and whether the new database is installed as the `src/db.ts` singleton.
 * Those disagreements are real per-test requirements, so they are parameters
 * here rather than a single hard-coded behaviour.
 *
 * Two families of issue factory exist and both are kept:
 * - `createLedgerProject` / `createLedgerIssue` go through the production
 *   `resolveProjectForCheckout` + `LedgerStore` paths.
 * - `insertRawLedgerProject` / `insertRawLedgerCheckout` / `insertRawLedgerIssue`
 *   write rows directly, for tests that need exact ids and timestamps or run
 *   against a hand-built subset schema rather than a full migration.
 */
import SqliteDatabase from "../../src/sqlite.ts";
import fs from "node:fs";
import path from "node:path";

import { migrate, setDb, type Db } from "../../src/db.js";
import { systemAction } from "../../src/identity/resolver.js";
import { resolveProjectForCheckout, type ResolvedLedgerProject } from "../../src/ledger/projects.js";
import { LedgerStore } from "../../src/ledger/store.js";
import type { CreateLedgerIssueInput, LedgerAliasInput } from "../../src/ledger/store.js";
import type { LedgerIssue } from "../../src/ledger/types.js";
import { addBinding, createUser, setupOperator } from "../../src/users/store.js";
import type { User } from "../../src/users/types.js";

export const SYSTEM_ACTOR = { attribution: systemAction() };

// --- databases -------------------------------------------------------------

export interface OperatorSeed {
  slug: string;
  display_name?: string;
}

export interface AgentSeed {
  slug: string;
  display_name?: string;
  /**
   * When set, adds a `provider_session_env` binding with this value. Issue
   * a64d2de: a provider-session binding mints session_claim attribution only
   * for an agent principal, so tests that drive an agent-session request bind
   * the session env to an agent rather than to the human operator.
   */
  sessionEnv?: string;
}

export interface CreateMigratedDbOptions {
  /** SqliteDatabase file to open. Defaults to a private in-memory database. */
  path?: string;
  /** Seed a local human operator. Auth tests need one to attribute and approve. */
  operator?: OperatorSeed;
  /** Seed an agent user, optionally with a provider-session binding. */
  agent?: AgentSeed;
  /**
   * Install the database as the `src/db.ts` singleton. Required by tests whose
   * route handlers resolve state through `getDb()`; omitted elsewhere so a test
   * that does not need the singleton does not install one.
   */
  setGlobal?: boolean;
  /** Fixed clock for seeded users. Callers that pinned `1` keep pinning `1`. */
  now?: number;
  /** Pragmas applied before `migrate()`. */
  pragmas?: string[];
}

export interface MigratedDbSeeds {
  operator?: User;
  agent?: User;
}

function seedUsers(db: Db, options: CreateMigratedDbOptions): MigratedDbSeeds {
  const seeds: MigratedDbSeeds = {};
  if (options.operator) {
    const input = {
      slug: options.operator.slug,
      display_name: options.operator.display_name ?? options.operator.slug,
    };
    seeds.operator = options.now === undefined
      ? setupOperator(db, input)
      : setupOperator(db, input, options.now);
  }
  if (options.agent) {
    const input = {
      slug: options.agent.slug,
      kind: "agent" as const,
      display_name: options.agent.display_name ?? options.agent.slug,
    };
    const agent = options.now === undefined
      ? createUser(db, input)
      : createUser(db, input, options.now);
    seeds.agent = agent;
    if (options.agent.sessionEnv) {
      addBinding(db, agent.id, {
        binding_type: "provider_session_env",
        value: options.agent.sessionEnv,
      });
    }
  }
  return seeds;
}

/**
 * Open a migrated database and apply the requested seeding. The caller keeps
 * ownership of the handle and is responsible for closing it.
 */
export function createMigratedDb(options: CreateMigratedDbOptions = {}): Db {
  return createMigratedDbWithSeeds(options).db;
}

/**
 * `createMigratedDb()` plus the seeded users, for tests that need the operator
 * or agent id rather than just their existence.
 */
export function createMigratedDbWithSeeds(
  options: CreateMigratedDbOptions = {},
): { db: Db; seeds: MigratedDbSeeds } {
  const db = new SqliteDatabase(options.path ?? ":memory:");
  for (const pragma of options.pragmas ?? []) {
    db.pragma(pragma);
  }
  migrate(db);
  if (options.setGlobal) setDb(db);
  return { db, seeds: seedUsers(db, options) };
}

// --- production-path ledger factories --------------------------------------

export interface CreateLedgerProjectOptions {
  /** Defaults to the basename of `root`. */
  name?: string;
  workRepoId?: string | null;
  /** Forwarded only when set; checkout identity is sensitive to these. */
  defaultBranch?: string;
  remoteUrl?: string | null;
  /** Create `root` on disk first; checkout identity reads the real path. */
  mkdir?: boolean;
}

/** Resolve (creating if needed) a ledger project for a checkout root. */
export function createLedgerProject(
  db: Db,
  root: string,
  options: CreateLedgerProjectOptions = {},
): ResolvedLedgerProject {
  if (options.mkdir) fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name: options.name ?? path.basename(root),
    workRepoId: options.workRepoId,
    ...(options.defaultBranch === undefined ? {} : { defaultBranch: options.defaultBranch }),
    ...(options.remoteUrl === undefined ? {} : { remoteUrl: options.remoteUrl }),
  });
}

export interface CreateLedgerIssueOptions
  extends Omit<CreateLedgerIssueInput, keyof typeof SYSTEM_ACTOR | "title" | "body"> {
  title?: string;
  body?: string;
  /** Shorthand for a single `git_bug_short` alias. */
  alias?: string;
  /** Reuse an existing store instance instead of constructing one. */
  store?: LedgerStore;
}

/** Create a ledger issue through the production `LedgerStore` write path. */
export function createLedgerIssue(db: Db, options: CreateLedgerIssueOptions): LedgerIssue {
  const { alias, store: providedStore, title, body, ...rest } = options;
  const store = providedStore ?? new LedgerStore(db);
  const aliases: LedgerAliasInput[] | undefined = rest.aliases
    ?? (alias ? [{ alias_kind: "git_bug_short", alias }] : undefined);
  return store.createIssue({
    ...SYSTEM_ACTOR,
    ...rest,
    title: title ?? "Ledger issue",
    body: body ?? "Body",
    ...(aliases ? { aliases } : {}),
  });
}

// --- raw-row ledger factories ----------------------------------------------

type Conflict = "ignore" | "replace";

function conflictClause(conflict: Conflict | undefined): string {
  return conflict === "replace" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
}

export interface RawLedgerProjectOptions {
  /** Defaults to `prj_<name>`, matching the fixtures this replaced. */
  id?: string;
  name: string;
  displayName?: string;
  /** Written only when provided, so minimal fixtures keep the column defaults. */
  projectKey?: string;
  remoteIdentity?: string;
  upstreamIdentity?: string;
  namespacePolicy?: string;
  conflict?: Conflict;
  now?: number;
}

/** Insert a `ledger_projects` row with exactly the columns the caller names. */
export function insertRawLedgerProject(db: Db, options: RawLedgerProjectOptions): string {
  const id = options.id ?? `prj_${options.name}`;
  const now = options.now ?? 1;
  const columns: string[] = ["id", "display_name"];
  const values: unknown[] = [id, options.displayName ?? options.name];
  const optional: Array<[string, unknown]> = [
    ["project_key", options.projectKey],
    ["remote_identity", options.remoteIdentity],
    ["upstream_identity", options.upstreamIdentity],
    ["namespace_policy", options.namespacePolicy],
  ];
  for (const [column, value] of optional) {
    if (value === undefined) continue;
    columns.push(column);
    values.push(value);
  }
  columns.push("created_at", "updated_at");
  values.push(now, now);
  db.prepare(
    `${conflictClause(options.conflict)} INTO ledger_projects (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(values as never[]));
  return id;
}

export interface RawLedgerCheckoutOptions {
  /** Defaults to `checkout_<name>`. */
  id?: string;
  projectId: string;
  name: string;
  root: string;
  /** Defaults to `name`; pass `null` for an unlinked checkout. */
  workRepoId?: string | null;
  defaultBranch?: string;
  remoteUrl?: string;
  conflict?: Conflict;
  now?: number;
}

/** Insert a `ledger_project_checkouts` row with the columns the caller names. */
export function insertRawLedgerCheckout(db: Db, options: RawLedgerCheckoutOptions): string {
  const id = options.id ?? `checkout_${options.name}`;
  const now = options.now ?? 1;
  const columns: string[] = ["id", "project_id", "work_repo_id", "root", "name"];
  const values: unknown[] = [
    id,
    options.projectId,
    options.workRepoId === undefined ? options.name : options.workRepoId,
    options.root,
    options.name,
  ];
  const optional: Array<[string, unknown]> = [
    ["default_branch", options.defaultBranch],
    ["remote_url", options.remoteUrl],
  ];
  for (const [column, value] of optional) {
    if (value === undefined) continue;
    columns.push(column);
    values.push(value);
  }
  columns.push("created_at", "updated_at");
  values.push(now, now);
  db.prepare(
    `${conflictClause(options.conflict)} INTO ledger_project_checkouts (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(values as never[]));
  return id;
}

export interface RawLedgerIssueAliasOptions {
  alias: string;
  aliasKind?: string;
  externalId?: string;
  source?: string;
  isPrimary?: boolean;
}

export interface RawLedgerIssueOptions {
  id: string;
  projectId: string;
  /** Defaults to the first 7 characters of the issue id. */
  shortId?: string;
  title?: string;
  body?: string;
  status?: string;
  kind?: string;
  priority?: string;
  authorActorType?: string;
  authorDisplay?: string;
  source?: string;
  now?: number;
  alias?: RawLedgerIssueAliasOptions;
}

/** Insert a `ledger_issues` row (and optionally one alias row) directly. */
export function insertRawLedgerIssue(db: Db, options: RawLedgerIssueOptions): string {
  const now = options.now ?? 1;
  const columns: string[] = ["id", "short_id", "project_id", "title", "status"];
  const values: unknown[] = [
    options.id,
    options.shortId ?? options.id.slice(0, 7),
    options.projectId,
    options.title ?? `Issue ${options.id}`,
    options.status ?? "open",
  ];
  const optional: Array<[string, unknown]> = [
    ["body", options.body],
    ["kind", options.kind],
    ["priority", options.priority],
    ["author_actor_type", options.authorActorType],
    ["author_display", options.authorDisplay],
    ["source", options.source],
  ];
  for (const [column, value] of optional) {
    if (value === undefined) continue;
    columns.push(column);
    values.push(value);
  }
  columns.push("created_at", "updated_at");
  values.push(now, now);
  db.prepare(
    `INSERT INTO ledger_issues (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(values as never[]));

  if (options.alias) {
    db.prepare(
      `INSERT INTO ledger_issue_aliases (
        issue_id, alias_kind, project_id, alias, external_id, source, is_primary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      options.id,
      options.alias.aliasKind ?? "git_bug_short",
      options.projectId,
      options.alias.alias,
      options.alias.externalId ?? options.alias.alias,
      options.alias.source ?? "git_bug",
      options.alias.isPrimary === false ? 0 : 1,
      now,
    );
  }
  return options.id;
}
