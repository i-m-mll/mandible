// Executor task inventory store (issue 0bc2279).
//
// Mandible is the OBSERVER here, not the scheduler. An executor posts complete
// generations; this module decides only three things:
//
//   - Is the payload exactly the declared shape? Validation is fail-closed and
//     total: an unrecognized key anywhere is a 400, not a silently dropped
//     field, because a publisher that sends a field Mandible ignores would
//     otherwise believe a fact is on record when it is not.
//   - Have we seen these exact bytes already? Identity is a SHA-256 over the
//     canonical (parser-reconstructed, fixed key order) generation. A replay
//     writes nothing and returns the original receipt.
//   - What does the newest generation per executor say? The view is derived by
//     query at read time. There is no projection table and no mutable task
//     row, so a stale or reordered post cannot corrupt the view — the newest
//     generation either wins whole or does not appear.
//
// Everything else is the executor's word. Freshness is the one judgment
// Mandible adds, and it is computed from `observed_at` alone.
//
// Authorization lives at the route boundary (src/routes/tasks.ts); this module
// takes an already-resolved principal.

import { createHash, randomUUID } from "node:crypto";

import { getSetting } from "./client-auth/settings-kv.js";
import {
  TASK_INVENTORY_SCHEMA,
  TASK_INVENTORY_UNKNOWN,
  type TaskActivationFacts,
  type TaskBundleFacts,
  type TaskCircuitState,
  type TaskExecutorFreshness,
  type TaskExecutorIdentity,
  type TaskExecutorSummary,
  type TaskGuardFacts,
  type TaskInventoryEntry,
  type TaskInventoryGeneration,
  type TaskInventoryPostResult,
  type TaskInventoryResponse,
  type TaskInventoryView,
  type TaskKillSwitchState,
  type TaskManagementMode,
  type TaskRunFacts,
  type TaskRunOutcome,
  type TaskRunSlot,
  type TaskStalenessClaim,
} from "./contracts.js";
import { getDb, type Db } from "./db.js";

/**
 * How long after `observed_at` an executor's generation stops counting as a
 * current picture. Publishers are expected to post at least hourly, so three
 * hours is "you have missed several cycles" rather than "you are a little
 * late". Exported so the response can name the horizon it applied.
 */
export const TASK_INVENTORY_STALE_AFTER_MS = 3 * 60 * 60 * 1_000;

/**
 * Settings key holding the publisher -> permitted executor-name mapping:
 * `{"<user-slug>": ["<executor-name>", ...]}`. Matching is EXACT: an executor
 * name is an identity, not a namespace prefix. An identity with no mapping
 * cannot post, and a malformed override maps nobody.
 */
export const TASK_INVENTORY_EXECUTORS_KEY = "tasks.inventory.executors";
export const DEFAULT_TASK_INVENTORY_EXECUTORS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({ "agent-schedule": Object.freeze(["agent-schedule"]) });

export class TaskInventoryValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "TaskInventoryValidationError";
  }
}

// --- validation primitives --------------------------------------------------

function fail(message: string): never {
  throw new TaskInventoryValidationError(message);
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * The fail-closed core. Every object in the payload is checked against its
 * exact key set, so a typo'd or invented field is reported at its own path
 * instead of being dropped.
 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    fail(`${field} has unknown field(s): ${extra.sort().join(", ")}`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return (value as string).trim();
}

function requireIntegerMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail(`${field} must be an integer epoch-milliseconds timestamp`);
  }
  return value as number;
}

/** `unknown` is the ONLY admissible absence. null/undefined/'' are rejected. */
function maybe<T>(
  value: unknown,
  field: string,
  parse: (value: unknown, field: string) => T,
): T | typeof TASK_INVENTORY_UNKNOWN {
  if (value === TASK_INVENTORY_UNKNOWN) return TASK_INVENTORY_UNKNOWN;
  if (value === undefined || value === null) {
    fail(`${field} is required; send '${TASK_INVENTORY_UNKNOWN}' when the value is not known`);
  }
  return parse(value, field);
}

function enumParser<T extends string>(values: readonly T[]) {
  return (value: unknown, field: string): T => {
    if (typeof value !== "string" || !values.includes(value as T)) {
      fail(`${field} must be one of: ${values.join(", ")}, or '${TASK_INVENTORY_UNKNOWN}'`);
    }
    return value as T;
  };
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value as boolean;
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer`);
  }
  return value as number;
}

const CIRCUIT_STATES: readonly TaskCircuitState[] = ["closed", "open", "half_open"];
const KILL_SWITCH_STATES: readonly TaskKillSwitchState[] = ["engaged", "clear"];
const STALENESS_CLAIMS: readonly TaskStalenessClaim[] = ["fresh", "stale"];
const RUN_OUTCOMES: readonly TaskRunOutcome[] = ["success", "failure", "timeout", "cancelled"];
const MANAGEMENT_MODES: readonly TaskManagementMode[] = ["external"];

// --- generation validation --------------------------------------------------

const GENERATION_KEYS = ["schema", "executor", "observed_at", "tasks"] as const;
const EXECUTOR_KEYS = ["name", "version", "capabilities"] as const;
const TASK_KEYS = [
  "task_id",
  "display_name",
  "management_mode",
  "bundle",
  "activation",
  "guards",
  "last_run",
  "last_failure",
] as const;
const BUNDLE_KEYS = ["commit", "content_hash", "execution_hash", "deployed_at"] as const;
const ACTIVATION_KEYS = ["config_enabled", "locally_activated"] as const;
const GUARD_KEYS = [
  "circuit",
  "retry_attempt",
  "retry_next_at",
  "kill_switch",
  "staleness",
] as const;
const RUN_KEYS = [
  "run_id",
  "started_at",
  "finished_at",
  "outcome",
  "bundle_commit",
  "content_hash",
  "execution_hash",
  "config_hash",
  "detail",
] as const;

function parseExecutor(value: unknown): TaskExecutorIdentity {
  const record = objectAt(value, "executor");
  rejectUnknownKeys(record, EXECUTOR_KEYS, "executor");
  const capabilities = record.capabilities;
  if (!Array.isArray(capabilities) || capabilities.some((entry) => typeof entry !== "string")) {
    fail("executor.capabilities must be an array of strings (use [] for none)");
  }
  return {
    name: requireString(record.name, "executor.name"),
    version: maybe(record.version, "executor.version", requireString),
    capabilities: (capabilities as string[]).map((entry) => entry.trim()).filter(Boolean),
  };
}

function parseBundle(value: unknown, field: string): TaskBundleFacts | typeof TASK_INVENTORY_UNKNOWN {
  if (value === TASK_INVENTORY_UNKNOWN) return TASK_INVENTORY_UNKNOWN;
  const record = objectAt(value, field);
  rejectUnknownKeys(record, BUNDLE_KEYS, field);
  return {
    commit: maybe(record.commit, `${field}.commit`, requireString),
    content_hash: maybe(record.content_hash, `${field}.content_hash`, requireString),
    execution_hash: maybe(record.execution_hash, `${field}.execution_hash`, requireString),
    deployed_at: maybe(record.deployed_at, `${field}.deployed_at`, requireIntegerMs),
  };
}

function parseActivation(value: unknown, field: string): TaskActivationFacts {
  const record = objectAt(value, field);
  rejectUnknownKeys(record, ACTIVATION_KEYS, field);
  return {
    config_enabled: maybe(record.config_enabled, `${field}.config_enabled`, parseBoolean),
    locally_activated: maybe(record.locally_activated, `${field}.locally_activated`, parseBoolean),
  };
}

function parseRetryNextAt(value: unknown, field: string): number | "none" {
  if (value === "none") return "none";
  return requireIntegerMs(value, field);
}

function parseGuards(value: unknown, field: string): TaskGuardFacts {
  const record = objectAt(value, field);
  rejectUnknownKeys(record, GUARD_KEYS, field);
  return {
    circuit: maybe(record.circuit, `${field}.circuit`, enumParser(CIRCUIT_STATES)),
    retry_attempt: maybe(record.retry_attempt, `${field}.retry_attempt`, parseNonNegativeInteger),
    retry_next_at: maybe(record.retry_next_at, `${field}.retry_next_at`, parseRetryNextAt),
    kill_switch: maybe(record.kill_switch, `${field}.kill_switch`, enumParser(KILL_SWITCH_STATES)),
    staleness: maybe(record.staleness, `${field}.staleness`, enumParser(STALENESS_CLAIMS)),
  };
}

function parseRunFacts(value: unknown, field: string): TaskRunFacts {
  const record = objectAt(value, field);
  rejectUnknownKeys(record, RUN_KEYS, field);
  return {
    run_id: maybe(record.run_id, `${field}.run_id`, requireString),
    started_at: maybe(record.started_at, `${field}.started_at`, requireIntegerMs),
    finished_at: maybe(record.finished_at, `${field}.finished_at`, requireIntegerMs),
    outcome: maybe(record.outcome, `${field}.outcome`, enumParser(RUN_OUTCOMES)),
    bundle_commit: maybe(record.bundle_commit, `${field}.bundle_commit`, requireString),
    content_hash: maybe(record.content_hash, `${field}.content_hash`, requireString),
    execution_hash: maybe(record.execution_hash, `${field}.execution_hash`, requireString),
    config_hash: maybe(record.config_hash, `${field}.config_hash`, requireString),
    detail: maybe(record.detail, `${field}.detail`, requireString),
  };
}

/** `never` (it did not happen) and `unknown` (we cannot say) stay distinct. */
function parseRunSlot(value: unknown, field: string): TaskRunSlot {
  if (value === TASK_INVENTORY_UNKNOWN) return TASK_INVENTORY_UNKNOWN;
  if (value === "never") return "never";
  if (value === undefined || value === null) {
    fail(
      `${field} is required; send 'never' when it has not happened or `
        + `'${TASK_INVENTORY_UNKNOWN}' when the executor cannot say`,
    );
  }
  return parseRunFacts(value, field);
}

function parseTask(value: unknown, index: number): TaskInventoryEntry {
  const field = `tasks[${index}]`;
  const record = objectAt(value, field);
  rejectUnknownKeys(record, TASK_KEYS, field);
  return {
    task_id: requireString(record.task_id, `${field}.task_id`),
    display_name: requireString(record.display_name, `${field}.display_name`),
    management_mode: enumParser(MANAGEMENT_MODES)(
      record.management_mode,
      `${field}.management_mode`,
    ),
    bundle: parseBundle(record.bundle, `${field}.bundle`),
    activation: parseActivation(record.activation, `${field}.activation`),
    guards: parseGuards(record.guards, `${field}.guards`),
    last_run: parseRunSlot(record.last_run, `${field}.last_run`),
    last_failure: parseRunSlot(record.last_failure, `${field}.last_failure`),
  };
}

/**
 * Validate an untrusted body into a typed generation. The returned object is
 * rebuilt field by field in declared order, which is what makes
 * `taskInventoryDigest` canonical without a separate serializer.
 */
export function parseTaskInventoryGeneration(body: unknown): TaskInventoryGeneration {
  const record = objectAt(body, "request body");
  rejectUnknownKeys(record, GENERATION_KEYS, "request body");
  const schema = requireString(record.schema, "schema");
  if (schema !== TASK_INVENTORY_SCHEMA) {
    throw new TaskInventoryValidationError(
      `unsupported schema '${schema}'; expected '${TASK_INVENTORY_SCHEMA}'`,
    );
  }
  const tasks = record.tasks;
  if (!Array.isArray(tasks)) fail("tasks must be an array");

  const parsed: TaskInventoryGeneration = {
    schema: TASK_INVENTORY_SCHEMA,
    executor: parseExecutor(record.executor),
    observed_at: requireIntegerMs(record.observed_at, "observed_at"),
    tasks: tasks.map((task, index) => parseTask(task, index)),
  };

  // A generation is a complete snapshot, so a duplicated task id would make the
  // projection ambiguous about which row is the task.
  const seen = new Set<string>();
  for (const task of parsed.tasks) {
    if (seen.has(task.task_id)) fail(`duplicate task_id '${task.task_id}' in generation`);
    seen.add(task.task_id);
  }
  return parsed;
}

/** SHA-256 over the canonical (parser-ordered) generation. */
export function taskInventoryDigest(generation: TaskInventoryGeneration): string {
  return createHash("sha256").update(JSON.stringify(generation)).digest("hex");
}

// --- publisher mapping ------------------------------------------------------

export function readTaskExecutorPublishers(db: Db = getDb()): Record<string, string[]> {
  const raw = getSetting(db, TASK_INVENTORY_EXECUTORS_KEY);
  if (!raw) {
    return Object.fromEntries(
      Object.entries(DEFAULT_TASK_INVENTORY_EXECUTORS).map(([slug, names]) => [slug, [...names]]),
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const mapping: Record<string, string[]> = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      mapping[slug] = value.filter((entry): entry is string => typeof entry === "string");
    }
    return mapping;
  } catch {
    // A malformed override is fail-closed: nobody may publish.
    return {};
  }
}

/** True when `slug` may post generations naming `executorName`. */
export function publisherMayPostInventory(
  db: Db,
  slug: string,
  executorName: string,
): boolean {
  const names = readTaskExecutorPublishers(db)[slug];
  return Boolean(names && names.includes(executorName));
}

// --- receipts ---------------------------------------------------------------

interface GenerationRow {
  id: string;
  digest: string;
  schema_id: string;
  executor_name: string;
  executor_version: string;
  capabilities_json: string;
  observed_at: number;
  task_count: number;
  payload_json: string;
  posted_by_user_id: string;
  created_at: number;
}

export interface RecordGenerationOptions {
  postedByUserId: string;
  now?: number;
}

/**
 * Append one generation. Replay of a known digest writes nothing and returns
 * the ORIGINAL receipt (including its first `posted_by_user_id`'s generation
 * id), so a retrying publisher and a first-time publisher get answers that
 * differ only in `stored`.
 */
export function recordTaskInventoryGeneration(
  db: Db,
  generation: TaskInventoryGeneration,
  options: RecordGenerationOptions,
): TaskInventoryPostResult {
  const now = options.now ?? Date.now();
  const digest = taskInventoryDigest(generation);

  const run = db.transaction((): TaskInventoryPostResult => {
    const existing = db
      .prepare("SELECT * FROM task_inventory_generations WHERE digest = ?")
      .get(digest) as GenerationRow | undefined;
    if (existing) {
      return {
        generation_id: existing.id,
        digest: existing.digest,
        stored: false,
        executor: existing.executor_name,
        task_count: existing.task_count,
        observed_at: existing.observed_at,
      };
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO task_inventory_generations (
         id, digest, schema_id, executor_name, executor_version, capabilities_json,
         observed_at, task_count, payload_json, posted_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      digest,
      generation.schema,
      generation.executor.name,
      generation.executor.version,
      JSON.stringify(generation.executor.capabilities),
      generation.observed_at,
      generation.tasks.length,
      JSON.stringify(generation),
      options.postedByUserId,
      now,
    );
    return {
      generation_id: id,
      digest,
      stored: true,
      executor: generation.executor.name,
      task_count: generation.tasks.length,
      observed_at: generation.observed_at,
    };
  });
  return run();
}

// --- projection -------------------------------------------------------------

/**
 * Mandible's only judgment about executor-reported state: how old the picture
 * is. Never derived from anything the executor claims about itself.
 */
export function deriveExecutorFreshness(
  observedAt: number | null,
  now: number,
  staleAfterMs: number = TASK_INVENTORY_STALE_AFTER_MS,
): TaskExecutorFreshness {
  if (observedAt === null || !Number.isFinite(observedAt)) return "unknown";
  // A generation observed in the future is not evidence of freshness; it is a
  // clock we cannot reason about.
  const age = now - observedAt;
  if (age < 0) return "unknown";
  return age > staleAfterMs ? "stale" : "current";
}

function parseStoredGeneration(row: GenerationRow): TaskInventoryGeneration | null {
  try {
    // Stored bytes were validated on the way in; re-parsing keeps a hand-edited
    // or future-schema row from reaching the view as a half-shaped object.
    return parseTaskInventoryGeneration(JSON.parse(row.payload_json));
  } catch {
    return null;
  }
}

export interface TaskInventoryViewOptions {
  now?: number;
  staleAfterMs?: number;
}

/**
 * The read surface: the newest generation per executor, projected. "Newest" is
 * `observed_at` first (the executor's own clock for its own snapshots), then
 * receipt time, then rowid — so a late-arriving older snapshot never displaces
 * a newer one.
 */
export function getTaskInventoryView(
  db: Db = getDb(),
  options: TaskInventoryViewOptions = {},
): TaskInventoryResponse {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? TASK_INVENTORY_STALE_AFTER_MS;

  const rows = db
    .prepare(
      `SELECT g.*, u.slug AS posted_by_slug
         FROM task_inventory_generations AS g
         LEFT JOIN users AS u ON u.id = g.posted_by_user_id
        WHERE g.id = (
          SELECT inner.id
            FROM task_inventory_generations AS inner
           WHERE inner.executor_name = g.executor_name
           ORDER BY inner.observed_at DESC, inner.created_at DESC, inner.rowid DESC
           LIMIT 1
        )
        ORDER BY g.executor_name ASC`,
    )
    .all() as Array<GenerationRow & { posted_by_slug: string | null }>;

  const executors: TaskExecutorSummary[] = [];
  const tasks: TaskInventoryView[] = [];

  for (const row of rows) {
    const generation = parseStoredGeneration(row);
    if (!generation) continue;
    const observedAgeMs = Math.max(0, now - row.observed_at);
    const freshness = deriveExecutorFreshness(row.observed_at, now, staleAfterMs);
    executors.push({
      name: row.executor_name,
      version: generation.executor.version,
      capabilities: generation.executor.capabilities,
      observed_at: row.observed_at,
      observed_age_ms: observedAgeMs,
      freshness,
      generation_id: row.id,
      digest: row.digest,
      received_at: row.created_at,
      posted_by_user_id: row.posted_by_user_id,
      posted_by_slug: row.posted_by_slug,
      task_count: row.task_count,
    });
    for (const task of generation.tasks) {
      tasks.push({
        key: `${row.executor_name}/${task.task_id}`,
        executor: row.executor_name,
        freshness,
        observed_at: row.observed_at,
        observed_age_ms: observedAgeMs,
        task,
      });
    }
  }

  tasks.sort((a, b) => a.key.localeCompare(b.key));
  return { executors, tasks, stale_after_ms: staleAfterMs };
}
