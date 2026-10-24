import { createHash, randomUUID } from "node:crypto";

import {
  OPERATIONAL_INCIDENT_RECEIPT_SCHEMA,
  OPERATIONAL_INCIDENT_SCHEMA,
  OPERATIONAL_INCIDENT_SCHEMA_V1,
  type OperationalIncidentAttention,
  type OperationalIncidentAcknowledgementResponse,
  type OperationalIncidentCondition,
  type OperationalIncidentCounts,
  type OperationalIncidentIngestEnvelope,
  type OperationalIncidentIngestResponse,
  type OperationalIncidentListResponse,
  type OperationalIncidentProjection,
  type OperationalIncidentRemediation,
  type OperationalIncidentTelemetryEvent,
  OPERATIONAL_INCIDENT_EVENTS,
} from "./contracts.js";
import type { Db } from "./db.js";
import { broadcast } from "./sse.js";
import { ulid } from "./users/ids.js";
import { SYSTEM_USER_ID } from "./users/store.js";

const CONDITIONS: readonly OperationalIncidentCondition[] = [
  "failed_permanent",
  "timeout",
  "circuit_open",
  "publish_stale",
  "publish_quarantined",
  "containment_blocked",
];
// The executor's terminal run statuses, and only those. `facts` describes a
// run that has finished — `finished_at` is mandatory — so a non-terminal
// status here would be incoherent. The executor emits exactly this set
// (`statedb.TERMINAL_STATUSES`); accepting `running` or `blocked` besides
// would admit a shape it never sends and cannot mean.
const RUN_STATUSES = [
  "succeeded",
  "failed_transient",
  "failed_permanent",
  "killed",
  "timeout",
] as const;
const EXIT_CLASSES = [
  "ok",
  "budget",
  "collector",
  "config",
  "containment",
  "limit",
  "output-source",
  "permission",
  "runner",
  "schema",
  "stale",
  "supervisor",
  "timeout",
  "unavailable",
  "validation",
] as const;
const REMEDIATION_STATES: readonly OperationalIncidentRemediation[] = [
  "none",
  "triaging",
  "fix_prepared",
  "awaiting_auth",
  "auth_expired",
  "awaiting_deploy",
  "awaiting_verification",
  "complete",
];
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9]+$/;

export class OperationalIncidentError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "invalid_operational_incident",
  ) {
    super(message);
    this.name = "OperationalIncidentError";
  }
}

function fail(message: string, status = 400, code = "invalid_operational_incident"): never {
  throw new OperationalIncidentError(message, status, code);
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter((key) => !Object.hasOwn(record, key));
  const extra = actual.filter((key) => !wanted.includes(key));
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `missing: ${missing.join(", ")}` : "",
      extra.length ? `unknown: ${extra.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    fail(`${field} has an invalid field set (${details})`);
  }
}

function stringAt(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${field} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function literalAt<T extends string>(value: unknown, literal: T, field: string): T {
  if (value !== literal) fail(`${field} must be '${literal}'`);
  return literal;
}

function enumAt<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(`${field} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function timestampAt(value: unknown, field: string): number {
  if (typeof value !== "string") fail(`${field} must be an ISO-8601 timestamp string`);
  const millis = Date.parse(value as string);
  if (!Number.isSafeInteger(millis)) fail(`${field} must be a valid ISO-8601 timestamp`);
  return millis;
}

function digestAt(value: unknown, field: string): string {
  const digest = stringAt(value, field);
  if (!SHA256.test(digest)) fail(`${field} must be a lowercase SHA-256 digest`);
  return digest;
}

function runIdAt(value: unknown, field: string): string {
  const runId = stringAt(value, field);
  if (!RUN_ID.test(runId)) fail(`${field} must be an integer serialized as a string`);
  return runId;
}

function parseFacts(value: unknown, field: string) {
  const record = objectAt(value, field);
  exactKeys(record, ["run_id", "run_status", "exit_class", "finished_at"], field);
  return {
    run_id: runIdAt(record.run_id, `${field}.run_id`),
    run_status: enumAt(record.run_status, RUN_STATUSES, `${field}.run_status`),
    exit_class: enumAt(record.exit_class, EXIT_CLASSES, `${field}.exit_class`),
    finished_at: timestampAt(record.finished_at, `${field}.finished_at`),
  };
}

function parseEvent(value: unknown, index: number): OperationalIncidentTelemetryEvent {
  const field = `events[${index}]`;
  const record = objectAt(value, field);
  exactKeys(
    record,
    ["event_id", "event_seq", "episode", "observation", "observed_at", "facts", "recovery"],
    field,
  );
  const eventId = stringAt(record.event_id, `${field}.event_id`);
  if (!ULID.test(eventId)) fail(`${field}.event_id must be an uppercase ULID`);
  if (record.event_seq !== 1 && record.event_seq !== 2) {
    fail(`${field}.event_seq must be 1 or 2`);
  }
  const eventSeq = record.event_seq;
  const episode = objectAt(record.episode, `${field}.episode`);
  exactKeys(episode, ["task", "condition", "first_seen"], `${field}.episode`);
  const firstSeen = timestampAt(episode.first_seen, `${field}.episode.first_seen`);
  const observedAt = timestampAt(record.observed_at, `${field}.observed_at`);
  const facts = parseFacts(record.facts, `${field}.facts`);
  if (facts.finished_at > observedAt) {
    fail(`${field}.facts.finished_at must not be later than observed_at`, 409, "incident_order_conflict");
  }

  if (eventSeq === 1) {
    literalAt(record.observation, "active", `${field}.observation`);
    if (record.recovery !== null) fail(`${field}.recovery must be null for an active event`);
    if (observedAt < firstSeen) {
      fail(`${field}.observed_at must not precede first_seen`, 409, "incident_order_conflict");
    }
    return {
      event_id: eventId,
      event_seq: 1,
      episode: {
        task: stringAt(episode.task, `${field}.episode.task`),
        condition: enumAt(episode.condition, CONDITIONS, `${field}.episode.condition`),
        first_seen: firstSeen,
      },
      observation: "active",
      observed_at: observedAt,
      facts,
      recovery: null,
    };
  }

  literalAt(record.observation, "recovered", `${field}.observation`);
  const recovery = objectAt(record.recovery, `${field}.recovery`);
  exactKeys(recovery, ["basis", "run_id", "run_status", "finished_at"], `${field}.recovery`);
  const recoveryRunId = runIdAt(recovery.run_id, `${field}.recovery.run_id`);
  const recoveryFinishedAt = timestampAt(recovery.finished_at, `${field}.recovery.finished_at`);
  literalAt(recovery.basis, "newer_successful_run", `${field}.recovery.basis`);
  literalAt(recovery.run_status, "succeeded", `${field}.recovery.run_status`);
  if (recoveryRunId === facts.run_id) {
    fail(`${field}.recovery.run_id must differ from the raising run`, 409, "incident_order_conflict");
  }
  if (recoveryFinishedAt <= firstSeen || recoveryFinishedAt > observedAt) {
    fail(
      `${field}.recovery.finished_at must be after first_seen and not later than observed_at`,
      409,
      "incident_order_conflict",
    );
  }
  return {
    event_id: eventId,
    event_seq: 2,
    episode: {
      task: stringAt(episode.task, `${field}.episode.task`),
      condition: enumAt(episode.condition, CONDITIONS, `${field}.episode.condition`),
      first_seen: firstSeen,
    },
    observation: "recovered",
    observed_at: observedAt,
    facts,
    recovery: {
      basis: "newer_successful_run",
      run_id: recoveryRunId,
      run_status: "succeeded",
      finished_at: recoveryFinishedAt,
    },
  };
}

export function parseOperationalIncidentEnvelope(value: unknown): OperationalIncidentIngestEnvelope {
  const record = objectAt(value, "payload");
  exactKeys(record, ["schema", "executor", "generation", "provenance", "events"], "payload");
  if (record.schema !== OPERATIONAL_INCIDENT_SCHEMA
    && record.schema !== OPERATIONAL_INCIDENT_SCHEMA_V1) {
    fail(
      `schema must be '${OPERATIONAL_INCIDENT_SCHEMA}' or '${OPERATIONAL_INCIDENT_SCHEMA_V1}'`,
    );
  }
  const schema = record.schema;

  const executor = objectAt(record.executor, "executor");
  exactKeys(executor, ["name", "version"], "executor");
  const generation = objectAt(record.generation, "generation");
  exactKeys(generation, ["inventory_schema", "inventory_digest", "observed_at"], "generation");
  const provenance = objectAt(record.provenance, "provenance");
  exactKeys(provenance, ["basis", "verification"], "provenance");
  if (!Array.isArray(record.events) || record.events.length === 0) {
    fail("events must be a non-empty array");
  }
  const events = record.events.map(parseEvent);
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    fail("events contains a duplicate event_id");
  }

  return {
    schema,
    executor: {
      name: stringAt(executor.name, "executor.name"),
      version: stringAt(executor.version, "executor.version"),
    },
    generation: {
      inventory_schema: literalAt(
        generation.inventory_schema,
        schema === OPERATIONAL_INCIDENT_SCHEMA
          ? "executor-inventory@3"
          : "executor-inventory@2",
        "generation.inventory_schema",
      ),
      inventory_digest: digestAt(generation.inventory_digest, "generation.inventory_digest"),
      observed_at: timestampAt(generation.observed_at, "generation.observed_at"),
    },
    provenance: {
      basis: literalAt(provenance.basis, "scheduler_computed", "provenance.basis"),
      verification: literalAt(
        provenance.verification,
        "unverified_by_mandible",
        "provenance.verification",
      ),
    },
    events,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  fail("canonical JSON values must not contain undefined or non-finite numbers");
}

function canonicalTelemetry(
  schema: OperationalIncidentIngestEnvelope["schema"],
  event: OperationalIncidentTelemetryEvent,
): string {
  return canonicalJson({ schema, event });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface IncidentRow {
  id: string;
  executor: string;
  task: string;
  condition: OperationalIncidentCondition;
  first_seen: number;
  observation_state: "active" | "recovered";
  attention_state: OperationalIncidentAttention;
  remediation_state: OperationalIncidentRemediation;
  latest_event_seq: 1 | 2;
  latest_observed_at: number;
  latest_event_id: string;
  latest_telemetry_json: string;
  latest_telemetry_sha256: string;
  provenance: "executor_asserted_unverified";
  posted_by_user_id: string;
  recovered_at: number | null;
  recovery_run_id: string | null;
  acknowledged_at: number | null;
  acknowledged_by_user_id: string | null;
  resolved_at: number | null;
  resolution_kind: "successful_run" | "operator_closure" | null;
  operator_closed_at: number | null;
  operator_closed_by_user_id: string | null;
  created_at: number;
  updated_at: number;
}

function incidentByEpisode(
  db: Db,
  executor: string,
  event: OperationalIncidentTelemetryEvent,
): IncidentRow | undefined {
  return db.prepare(
    `SELECT * FROM operational_incidents
      WHERE executor = ? AND task = ? AND condition = ? AND first_seen = ?`,
  ).get(executor, event.episode.task, event.episode.condition, event.episode.first_seen) as
    | IncidentRow
    | undefined;
}

function sourceEvent(
  db: Db,
  sourceEventId: string,
): { incident_id: string; telemetry_sha256: string } | undefined {
  return db.prepare(
    `SELECT incident_id, telemetry_sha256
       FROM operational_incident_observation_events WHERE source_event_id = ?`,
  ).get(sourceEventId) as { incident_id: string; telemetry_sha256: string } | undefined;
}

export function ingestOperationalIncidentEnvelope(
  db: Db,
  envelope: OperationalIncidentIngestEnvelope,
  postedByUserId: string,
  receivedAt = Date.now(),
): OperationalIncidentIngestResponse {
  const apply = db.transaction(() => {
    const accepted: OperationalIncidentIngestResponse["accepted"] = [];
    for (const event of envelope.events) {
      const telemetryJson = canonicalTelemetry(envelope.schema, event);
      const telemetrySha256 = sha256(telemetryJson);
      const bySource = sourceEvent(db, event.event_id);
      if (bySource) {
        if (bySource.telemetry_sha256 !== telemetrySha256) {
          fail(
            `event_id '${event.event_id}' was already used for different telemetry`,
            409,
            "incident_event_conflict",
          );
        }
        accepted.push({ event_id: event.event_id, incident_id: bySource.incident_id, result: "duplicate" });
        continue;
      }

      let incident = incidentByEpisode(db, envelope.executor.name, event);
      const createdNew = !incident;
      if (!incident) {
        const incidentId = randomUUID();
        const recovered = event.event_seq === 2;
        db.prepare(
          `INSERT INTO operational_incidents (
             id, executor, task, condition, first_seen, observation_state,
             attention_state, remediation_state, latest_event_seq,
             latest_observed_at, latest_event_id, latest_telemetry_json,
             latest_telemetry_sha256, provenance, posted_by_user_id,
             recovered_at, recovery_run_id, resolved_at, resolution_kind,
             created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, 'unacknowledged', ?, ?, ?, ?, ?, ?,
             'executor_asserted_unverified', ?, ?, ?, ?, ?, ?, ?
           )`,
        ).run(
          incidentId,
          envelope.executor.name,
          event.episode.task,
          event.episode.condition,
          event.episode.first_seen,
          event.observation,
          recovered ? "complete" : "none",
          event.event_seq,
          event.observed_at,
          event.event_id,
          telemetryJson,
          telemetrySha256,
          postedByUserId,
          event.recovery?.finished_at ?? null,
          event.recovery?.run_id ?? null,
          event.recovery?.finished_at ?? null,
          recovered ? "successful_run" : null,
          receivedAt,
          receivedAt,
        );
        incident = incidentByEpisode(db, envelope.executor.name, event);
        if (!incident) throw new Error("operational incident insert did not materialize");
      }

      const sameSequence = db.prepare(
        `SELECT telemetry_sha256 FROM operational_incident_observation_events
          WHERE incident_id = ? AND event_seq = ?`,
      ).get(incident.id, event.event_seq) as { telemetry_sha256: string } | undefined;
      if (sameSequence) {
        if (sameSequence.telemetry_sha256 !== telemetrySha256) {
          fail(
            `episode sequence ${event.event_seq} was already used for different telemetry`,
            409,
            "incident_sequence_conflict",
          );
        }
        accepted.push({ event_id: event.event_id, incident_id: incident.id, result: "duplicate" });
        continue;
      }

      const applied = createdNew || (
        event.event_seq > incident.latest_event_seq
        && incident.resolution_kind !== "operator_closure"
      );
      db.prepare(
        `INSERT INTO operational_incident_observation_events (
           id, incident_id, source_event_id, event_seq, observation_state,
           observed_at, inventory_digest, telemetry_json, telemetry_sha256,
           posted_by_user_id, received_at, applied, ignored_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        incident.id,
        event.event_id,
        event.event_seq,
        event.observation,
        event.observed_at,
        envelope.generation.inventory_digest,
        telemetryJson,
        telemetrySha256,
        postedByUserId,
        receivedAt,
        applied ? 1 : 0,
        applied ? null : "stale_sequence",
      );

      if (applied && !createdNew) {
        if (event.event_seq !== 2 || !event.recovery) {
          fail("an active event cannot advance an existing episode", 409, "incident_sequence_conflict");
        }
        db.prepare(
          `UPDATE operational_incidents
              SET observation_state = 'recovered', remediation_state = 'complete',
                  latest_event_seq = 2, latest_observed_at = ?, latest_event_id = ?,
                  latest_telemetry_json = ?, latest_telemetry_sha256 = ?,
                  posted_by_user_id = ?, recovered_at = ?, recovery_run_id = ?,
                  resolved_at = ?, resolution_kind = 'successful_run', updated_at = ?
            WHERE id = ?`,
        ).run(
          event.observed_at,
          event.event_id,
          telemetryJson,
          telemetrySha256,
          postedByUserId,
          event.recovery.finished_at,
          event.recovery.run_id,
          event.recovery.finished_at,
          receivedAt,
          incident.id,
        );
      }
      accepted.push({ event_id: event.event_id, incident_id: incident.id, result: "stored" });
    }
    return { schema: OPERATIONAL_INCIDENT_RECEIPT_SCHEMA, accepted } as const;
  });
  return apply();
}

export const DAEMON_INCIDENT_EXECUTOR = "mandible-daemon";

/**
 * Raise a fault the daemon detected in itself. One unresolved incident stands
 * for each task, so a repeating failure raises it once until it is resolved.
 */
export function raiseDaemonIncident(
  db: Db,
  input: { task: string; exitClass: (typeof EXIT_CLASSES)[number]; observedAt?: number },
): { incident_id: string; raised: boolean } {
  const open = db.prepare(
    `SELECT id FROM operational_incidents
      WHERE executor = ? AND task = ? AND resolved_at IS NULL
      ORDER BY first_seen DESC LIMIT 1`,
  ).get(DAEMON_INCIDENT_EXECUTOR, input.task) as { id: string } | undefined;
  if (open) return { incident_id: open.id, raised: false };
  const observedAt = input.observedAt ?? Date.now();
  const receipt = ingestOperationalIncidentEnvelope(db, {
    schema: OPERATIONAL_INCIDENT_SCHEMA,
    executor: { name: DAEMON_INCIDENT_EXECUTOR, version: "1" },
    generation: { inventory_schema: "executor-inventory@3", inventory_digest: sha256(input.task), observed_at: observedAt },
    provenance: { basis: "scheduler_computed", verification: "unverified_by_mandible" },
    events: [{
      event_id: ulid(observedAt),
      event_seq: 1,
      episode: { task: input.task, condition: "failed_permanent", first_seen: observedAt },
      observation: "active",
      observed_at: observedAt,
      facts: { run_id: String(observedAt), run_status: "failed_permanent", exit_class: input.exitClass, finished_at: observedAt },
      recovery: null,
    }],
  }, SYSTEM_USER_ID, observedAt);
  const incidentId = receipt.accepted[0]!.incident_id;
  broadcast(OPERATIONAL_INCIDENT_EVENTS.ingested, { incident_ids: [incidentId] });
  return { incident_id: incidentId, raised: true };
}

function project(row: IncidentRow): OperationalIncidentProjection {
  return {
    id: row.id,
    executor: row.executor,
    task: row.task,
    condition: row.condition,
    first_seen: row.first_seen,
    observation: row.observation_state,
    attention: row.attention_state,
    remediation: row.remediation_state,
    resolved: row.resolved_at !== null,
    resolution_kind: row.resolution_kind,
    provenance: {
      label: "Executor-reported; not verified by Mandible",
      value: "executor_asserted_unverified",
    },
    latest_telemetry: JSON.parse(row.latest_telemetry_json) as OperationalIncidentProjection["latest_telemetry"],
    latest_telemetry_sha256: row.latest_telemetry_sha256,
    latest_observed_at: row.latest_observed_at,
    recovered_at: row.recovered_at,
    recovery_run_id: row.recovery_run_id,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by_user_id: row.acknowledged_by_user_id,
    resolved_at: row.resolved_at,
    operator_closed_at: row.operator_closed_at,
    operator_closed_by_user_id: row.operator_closed_by_user_id,
    updated_at: row.updated_at,
  };
}

export function getOperationalIncident(db: Db, id: string): OperationalIncidentProjection {
  const row = db.prepare("SELECT * FROM operational_incidents WHERE id = ?").get(id) as
    | IncidentRow
    | undefined;
  if (!row) fail(`Operational incident '${id}' was not found`, 404, "incident_not_found");
  return project(row);
}

export function countOperationalIncidents(
  db: Db,
  filters: { executor?: string; task?: string } = {},
): OperationalIncidentCounts {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.executor) { clauses.push("executor = ?"); params.push(filters.executor); }
  if (filters.task) { clauses.push("task = ?"); params.push(filters.task); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN resolved_at IS NULL AND observation_state = 'active'
                     AND attention_state = 'unacknowledged' THEN 1 ELSE 0 END)
         AS active_unacknowledged,
       SUM(CASE WHEN resolved_at IS NULL AND observation_state = 'active'
                     AND attention_state = 'acknowledged' THEN 1 ELSE 0 END)
         AS active_acknowledged,
       SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
       FROM operational_incidents ${where}`,
  ).get(...params) as Record<keyof OperationalIncidentCounts, number | null>;
  return {
    active_unacknowledged: Number(row.active_unacknowledged ?? 0),
    active_acknowledged: Number(row.active_acknowledged ?? 0),
    resolved: Number(row.resolved ?? 0),
  };
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    const keys = Object.keys(decoded as Record<string, unknown>);
    const offset = (decoded as { offset?: unknown }).offset;
    if (keys.length !== 1 || !Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error();
    return Number(offset);
  } catch {
    fail("cursor is invalid", 400, "invalid_cursor");
  }
}

export function listOperationalIncidents(
  db: Db,
  options: {
    status?: "active" | "resolved" | "all";
    attention?: OperationalIncidentAttention | "all";
    executor?: string;
    task?: string;
    limit?: number;
    cursor?: string;
  } = {},
): OperationalIncidentListResponse {
  const status = options.status ?? "active";
  const attention = options.attention ?? "all";
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    fail("limit must be an integer from 1 through 200", 400, "invalid_limit");
  }
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (status === "active") clauses.push("resolved_at IS NULL");
  else if (status === "resolved") clauses.push("resolved_at IS NOT NULL");
  if (attention !== "all") { clauses.push("attention_state = ?"); params.push(attention); }
  if (options.executor) { clauses.push("executor = ?"); params.push(options.executor); }
  if (options.task) { clauses.push("task = ?"); params.push(options.task); }
  const offset = cursorOffset(options.cursor);
  const rows = db.prepare(
    `SELECT * FROM operational_incidents
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY
        CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END,
        CASE WHEN attention_state = 'unacknowledged' THEN 0 ELSE 1 END,
        CASE WHEN resolved_at IS NULL THEN first_seen ELSE resolved_at END DESC,
        id
      LIMIT ? OFFSET ?`,
  ).all(...params, limit + 1, offset) as IncidentRow[];
  const hasMore = rows.length > limit;
  return {
    incidents: rows.slice(0, limit).map(project),
    counts: countOperationalIncidents(db, { executor: options.executor, task: options.task }),
    next_cursor: hasMore
      ? Buffer.from(JSON.stringify({ offset: offset + limit }), "utf8").toString("base64url")
      : null,
  };
}

function workflowEvent(
  db: Db,
  values: {
    incidentId: string;
    kind: "attention_acknowledged" | "operator_closed" | "prepare_fix_confirmed" |
      "dispatch_failed" | "remediation_transition";
    authority: "user" | "server";
    actorUserId?: string | null;
    fromAttention?: OperationalIncidentAttention | null;
    toAttention?: OperationalIncidentAttention | null;
    fromRemediation?: OperationalIncidentRemediation | null;
    toRemediation?: OperationalIncidentRemediation | null;
    agentDispatchEventId?: string | null;
    authRequestId?: string | null;
    deployRef?: string | null;
    verificationRunId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt: number;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO operational_incident_workflow_events (
       id, incident_id, kind, authority, actor_user_id,
       from_attention_state, to_attention_state,
       from_remediation_state, to_remediation_state,
       agent_dispatch_event_id, auth_request_id, deploy_ref,
       verification_run_id, reason, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    values.incidentId,
    values.kind,
    values.authority,
    values.actorUserId ?? null,
    values.fromAttention ?? null,
    values.toAttention ?? null,
    values.fromRemediation ?? null,
    values.toRemediation ?? null,
    values.agentDispatchEventId ?? null,
    values.authRequestId ?? null,
    values.deployRef ?? null,
    values.verificationRunId ?? null,
    values.reason ?? null,
    values.metadata ? canonicalJson(values.metadata) : null,
    values.createdAt,
  );
  return id;
}

export function acknowledgeOperationalIncident(
  db: Db,
  incidentId: string,
  actorUserId: string,
  now = Date.now(),
): OperationalIncidentAcknowledgementResponse {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM operational_incidents WHERE id = ?").get(incidentId) as
      | IncidentRow
      | undefined;
    if (!row) fail(`Operational incident '${incidentId}' was not found`, 404, "incident_not_found");
    if (row.attention_state === "acknowledged") {
      const event = db.prepare(
        `SELECT id FROM operational_incident_workflow_events
          WHERE incident_id = ? AND kind = 'attention_acknowledged'
          ORDER BY created_at, id LIMIT 1`,
      ).get(incidentId) as { id: string } | undefined;
      if (!event || row.acknowledged_at === null || row.acknowledged_by_user_id === null) {
        throw new Error("acknowledged incident is missing its workflow event");
      }
      return {
        incident_id: incidentId,
        attention: "acknowledged" as const,
        event_id: event.id,
        acknowledged_at: row.acknowledged_at,
        acknowledged_by_user_id: row.acknowledged_by_user_id,
      };
    }
    const eventId = workflowEvent(db, {
      incidentId,
      kind: "attention_acknowledged",
      authority: "user",
      actorUserId,
      fromAttention: "unacknowledged",
      toAttention: "acknowledged",
      createdAt: now,
    });
    db.prepare(
      `UPDATE operational_incidents
          SET attention_state = 'acknowledged', acknowledged_at = ?,
              acknowledged_by_user_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, actorUserId, now, incidentId);
    return {
      incident_id: incidentId,
      attention: "acknowledged" as const,
      event_id: eventId,
      acknowledged_at: now,
      acknowledged_by_user_id: actorUserId,
    };
  })();
}

export function closeOperationalIncident(
  db: Db,
  incidentId: string,
  actorUserId: string,
  reason: string,
  expectedUpdatedAt: number,
  now = Date.now(),
): OperationalIncidentProjection {
  if (!reason.trim()) fail("reason must be a non-empty string");
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM operational_incidents WHERE id = ?").get(incidentId) as
      | IncidentRow
      | undefined;
    if (!row) fail(`Operational incident '${incidentId}' was not found`, 404, "incident_not_found");
    if (row.updated_at !== expectedUpdatedAt) {
      fail("incident changed after it was read", 409, "incident_projection_changed");
    }
    if (row.resolved_at !== null) {
      fail("incident is already resolved", 409, "incident_already_resolved");
    }
    if (row.attention_state === "unacknowledged") {
      workflowEvent(db, {
        incidentId,
        kind: "attention_acknowledged",
        authority: "user",
        actorUserId,
        fromAttention: "unacknowledged",
        toAttention: "acknowledged",
        createdAt: now,
      });
    }
    workflowEvent(db, {
      incidentId,
      kind: "operator_closed",
      authority: "user",
      actorUserId,
      fromAttention: row.attention_state,
      toAttention: "acknowledged",
      fromRemediation: row.remediation_state,
      toRemediation: "complete",
      reason: reason.trim(),
      createdAt: now,
    });
    db.prepare(
      `UPDATE operational_incidents
          SET attention_state = 'acknowledged',
              acknowledged_at = COALESCE(acknowledged_at, ?),
              acknowledged_by_user_id = COALESCE(acknowledged_by_user_id, ?),
              remediation_state = 'complete', resolved_at = ?,
              resolution_kind = 'operator_closure', operator_closed_at = ?,
              operator_closed_by_user_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, actorUserId, now, now, actorUserId, now, incidentId);
    return getOperationalIncident(db, incidentId);
  })();
}

/**
 * Undo the `triaging` a dispatch set, after its spawn failed, only while the
 * incident is still exactly as that dispatch left it. If anything moved it
 * on meanwhile (closure, resolution, another transition) the incident is
 * left alone and its current projection returned.
 */
export function rollBackFailedAgentDispatch(
  db: Db,
  incidentId: string,
  agentDispatchEventId: string,
  reason: string | null,
): OperationalIncidentProjection {
  return db.transaction(() => {
    const row = db.prepare(
      "SELECT remediation_state, resolved_at, observation_state FROM operational_incidents WHERE id = ?",
    ).get(incidentId) as Pick<IncidentRow, "remediation_state" | "resolved_at" | "observation_state"> | undefined;
    const latest = db.prepare(
      `SELECT agent_dispatch_event_id FROM operational_incident_workflow_events
        WHERE incident_id = ? AND to_remediation_state IS NOT NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(incidentId) as { agent_dispatch_event_id: string | null } | undefined;
    const untouched = row?.resolved_at === null && row.observation_state === "active"
      && row.remediation_state === "triaging" && latest?.agent_dispatch_event_id === agentDispatchEventId;
    if (!untouched) return getOperationalIncident(db, incidentId);
    return transitionOperationalIncidentRemediation(db, incidentId, "none", {
      kind: "dispatch_failed",
      authority: "server",
      agentDispatchEventId,
      reason,
    });
  })();
}

const SERVER_REMEDIATION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  triaging: ["fix_prepared"],
  fix_prepared: ["awaiting_auth"],
  awaiting_auth: ["auth_expired", "awaiting_deploy"],
  auth_expired: ["awaiting_auth"],
  awaiting_deploy: ["awaiting_verification"],
};

export function transitionOperationalIncidentRemediation(
  db: Db,
  incidentId: string,
  to: OperationalIncidentRemediation,
  options: {
    kind?: "prepare_fix_confirmed" | "dispatch_failed" | "remediation_transition";
    authority: "user" | "server";
    actorUserId?: string | null;
    agentDispatchEventId?: string | null;
    authRequestId?: string | null;
    deployRef?: string | null;
    verificationRunId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
    now?: number;
  },
): OperationalIncidentProjection {
  if (!REMEDIATION_STATES.includes(to)) fail(`unknown remediation state '${to}'`);
  const now = options.now ?? Date.now();
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM operational_incidents WHERE id = ?").get(incidentId) as
      | IncidentRow
      | undefined;
    if (!row) fail(`Operational incident '${incidentId}' was not found`, 404, "incident_not_found");
    if (row.resolved_at !== null || row.observation_state !== "active") {
      fail("remediation may change only for an unresolved active incident", 409, "incident_not_active");
    }
    const kind = options.kind ?? "remediation_transition";
    let legal = false;
    if (kind === "prepare_fix_confirmed") {
      legal = options.authority === "user"
        && (row.remediation_state === "none" || row.remediation_state === "auth_expired")
        && to === "triaging";
    } else if (kind === "dispatch_failed") {
      legal = options.authority === "server"
        && row.remediation_state === "triaging" && to === "none";
    } else {
      legal = options.authority === "server"
        && (SERVER_REMEDIATION_TRANSITIONS[row.remediation_state]?.includes(to) ?? false);
    }
    if (!legal) {
      fail(
        `illegal remediation transition ${row.remediation_state} -> ${to}`,
        409,
        "incident_remediation_conflict",
      );
    }
    if (options.authority === "user" && !options.actorUserId) {
      fail("user remediation transitions require an actor", 403, "human_actor_required");
    }
    workflowEvent(db, {
      incidentId,
      kind,
      authority: options.authority,
      actorUserId: options.actorUserId,
      fromRemediation: row.remediation_state,
      toRemediation: to,
      agentDispatchEventId: options.agentDispatchEventId,
      authRequestId: options.authRequestId,
      deployRef: options.deployRef,
      verificationRunId: options.verificationRunId,
      reason: options.reason,
      metadata: options.metadata,
      createdAt: now,
    });
    db.prepare(
      "UPDATE operational_incidents SET remediation_state = ?, updated_at = ? WHERE id = ?",
    ).run(to, now, incidentId);
    return getOperationalIncident(db, incidentId);
  })();
}
