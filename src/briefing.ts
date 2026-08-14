// Stable Briefing compatibility facade over the shared feedback kernel.
// Authorization and wire contracts remain owned by the existing Briefing
// routes; recurring persistence and derived state live in feedback/store.ts.

import { createHash } from "node:crypto";
import {
  BRIEFING_INGEST_SCHEMA_V1,
  BRIEFING_INGEST_SCHEMA_V2,
  type BriefingCandidateHistoryResponse,
  type BriefingCandidateState,
  type BriefingComment,
  type BriefingIngestItem,
  type BriefingIngestRequest,
  type BriefingIngestResult,
  type BriefingPublisherAdvisory,
  type BriefingQueueResponse,
  type BriefingReviewAction,
  type BriefingSourceHealth,
} from "./contracts.js";
import { getDb, type Db } from "./db.js";
import { getSetting } from "./client-auth/settings-kv.js";
import {
  FeedbackStoreError,
  addRecurringComment,
  countPendingRecurringItems,
  getRecurringCandidate,
  getRecurringCandidateHistory,
  ingestRecurringBatch,
  lastRecurringActionForRevision,
  listRecurringQueue,
  listRecurringSourceHealth,
  recordRecurringDecision,
  recurringCandidateStateFromAction,
  summarizeRecurringBatch,
  sweepExpiredRecurringItems,
} from "./feedback/store.js";

export const BRIEFING_EXPIRY_MS_KEY = "briefing.expiry_ms";
export const DEFAULT_BRIEFING_EXPIRY_MS = 14 * 24 * 60 * 60 * 1_000;
export const BRIEFING_PUBLISHERS_KEY = "briefing.ingest.publishers";
export interface BriefingPublisherBinding {
  task_identity: string;
  sources: readonly string[];
}

export const DEFAULT_BRIEFING_PUBLISHERS: Readonly<
  Record<string, readonly Readonly<BriefingPublisherBinding>[]>
> = Object.freeze({
  "agent-schedule": Object.freeze([
    Object.freeze({ task_identity: "agent-schedule/daily-digest", sources: Object.freeze(["arxiv-scan"]) }),
    Object.freeze({ task_identity: "agent-schedule/task-health", sources: Object.freeze(["task-health"]) }),
  ]),
});

/** Independent code-owned route gate; deployed task bundles cannot widen it. */
export const BRIEFING_PUBLISHER_TASK_GATE: readonly string[] = Object.freeze([
  "agent-schedule/daily-digest",
  "agent-schedule/task-health",
]);

export class BriefingValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "BriefingValidationError";
  }
}

function translateStoreError(error: unknown): never {
  if (error instanceof FeedbackStoreError) {
    throw new BriefingValidationError(error.message, error.status);
  }
  throw error;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BriefingValidationError(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BriefingValidationError(`${field} must be a string`);
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BriefingValidationError(`${field} must be an integer`);
  }
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new BriefingValidationError(`${field} has unknown field(s): ${extras.sort().join(", ")}`);
  }
}

const REQUEST_KEYS = ["schema", "task_identity", "run_id", "digest", "batch_key", "items"];
const DIGEST_KEYS = ["series_ref", "version"];
const ITEM_V1_KEYS = [
  "candidate_key", "source", "ref", "title", "why_notable", "refs",
  "evidence_hash", "evidence_kind", "captured_at", "rank",
];
const ITEM_V2_KEYS = [
  ...ITEM_V1_KEYS, "item_kind", "parent", "publisher_advisory",
];
const ADVISORY_KEYS = ["code", "reason"];

export function parseBriefingIngestRequest(body: unknown): BriefingIngestRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BriefingValidationError("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  rejectUnknownKeys(record, REQUEST_KEYS, "request body");
  const schema = requireString(record.schema, "schema");
  if (schema !== BRIEFING_INGEST_SCHEMA_V1 && schema !== BRIEFING_INGEST_SCHEMA_V2) {
    throw new BriefingValidationError(
      `unsupported schema '${schema}'; expected '${BRIEFING_INGEST_SCHEMA_V1}' or '${BRIEFING_INGEST_SCHEMA_V2}'`,
    );
  }
  const digest = record.digest;
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) {
    throw new BriefingValidationError("digest must be an object");
  }
  const digestRecord = digest as Record<string, unknown>;
  rejectUnknownKeys(digestRecord, DIGEST_KEYS, "digest");
  const items = record.items;
  if (!Array.isArray(items)) throw new BriefingValidationError("items must be an array");
  return {
    schema,
    task_identity: requireString(record.task_identity, "task_identity"),
    run_id: requireString(record.run_id, "run_id"),
    digest: {
      series_ref: requireString(digestRecord.series_ref, "digest.series_ref"),
      version: requireInteger(digestRecord.version, "digest.version"),
    },
    batch_key: requireString(record.batch_key, "batch_key"),
    items: items.map((item, index) => parseIngestItem(item, index, schema)),
  };
}

function parseIngestItem(
  value: unknown,
  index: number,
  schema: typeof BRIEFING_INGEST_SCHEMA_V1 | typeof BRIEFING_INGEST_SCHEMA_V2,
): BriefingIngestItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BriefingValidationError(`items[${index}] must be an object`);
  }
  const item = value as Record<string, unknown>;
  rejectUnknownKeys(
    item,
    schema === BRIEFING_INGEST_SCHEMA_V1 ? ITEM_V1_KEYS : ITEM_V2_KEYS,
    `items[${index}]`,
  );
  const evidenceKind = requireString(item.evidence_kind, `items[${index}].evidence_kind`);
  if (evidenceKind !== "snapshot-item" && evidenceKind !== "finding-only") {
    throw new BriefingValidationError(
      `items[${index}].evidence_kind must be 'snapshot-item' or 'finding-only'`,
    );
  }
  let refs: string[] = [];
  if (item.refs !== undefined && item.refs !== null) {
    if (!Array.isArray(item.refs) || item.refs.some((ref) => typeof ref !== "string")) {
      throw new BriefingValidationError(`items[${index}].refs must be an array of strings`);
    }
    refs = item.refs as string[];
  }
  let rank: number | null = null;
  if (item.rank !== undefined && item.rank !== null) {
    rank = requireInteger(item.rank, `items[${index}].rank`);
  }
  const parsed: BriefingIngestItem = {
    candidate_key: requireString(item.candidate_key, `items[${index}].candidate_key`),
    source: requireString(item.source, `items[${index}].source`),
    ref: requireString(item.ref, `items[${index}].ref`),
    title: requireString(item.title, `items[${index}].title`),
    why_notable: optionalString(item.why_notable, `items[${index}].why_notable`),
    refs,
    evidence_hash: requireString(item.evidence_hash, `items[${index}].evidence_hash`),
    evidence_kind: evidenceKind,
    captured_at: optionalString(item.captured_at, `items[${index}].captured_at`),
    rank,
  };
  if (schema === BRIEFING_INGEST_SCHEMA_V2) {
    const itemKind = item.item_kind === undefined
      ? "item"
      : requireString(item.item_kind, `items[${index}].item_kind`);
    if (itemKind !== "item" && itemKind !== "group") {
      throw new BriefingValidationError(`items[${index}].item_kind must be 'item' or 'group'`);
    }
    const parent = optionalString(item.parent, `items[${index}].parent`);
    if (itemKind === "group" && parent !== null) {
      throw new BriefingValidationError(`items[${index}] group cannot have a parent`);
    }
    if (parent !== null && parent.trim() === "") {
      throw new BriefingValidationError(`items[${index}].parent must be a non-empty string`);
    }
    let publisherAdvisory: BriefingPublisherAdvisory | null = null;
    if (item.publisher_advisory !== undefined && item.publisher_advisory !== null) {
      if (typeof item.publisher_advisory !== "object" || Array.isArray(item.publisher_advisory)) {
        throw new BriefingValidationError(`items[${index}].publisher_advisory must be an object`);
      }
      const advisory = item.publisher_advisory as Record<string, unknown>;
      rejectUnknownKeys(advisory, ADVISORY_KEYS, `items[${index}].publisher_advisory`);
      const code = requireString(advisory.code, `items[${index}].publisher_advisory.code`);
      if (code !== "admission_gate_rejected") {
        throw new BriefingValidationError(
          `items[${index}].publisher_advisory.code must be 'admission_gate_rejected'`,
        );
      }
      publisherAdvisory = {
        code,
        reason: requireString(advisory.reason, `items[${index}].publisher_advisory.reason`),
      };
    }
    parsed.item_kind = itemKind;
    parsed.parent = parent?.trim() ?? null;
    parsed.publisher_advisory = publisherAdvisory;
  }
  return parsed;
}

export function readBriefingPublisherBindings(
  db: Db = getDb(),
): Record<string, BriefingPublisherBinding[]> {
  const raw = getSetting(db, BRIEFING_PUBLISHERS_KEY);
  if (raw === null) {
    return Object.fromEntries(
      Object.entries(DEFAULT_BRIEFING_PUBLISHERS).map(([slug, bindings]) => [
        slug,
        bindings.map((binding) => ({
          task_identity: binding.task_identity,
          sources: [...binding.sources],
        })),
      ]),
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const mapping: Record<string, BriefingPublisherBinding[]> = Object.create(null) as
      Record<string, BriefingPublisherBinding[]>;
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!slug.trim() || slug !== slug.trim() || !Array.isArray(value)) return {};
      const bindings: BriefingPublisherBinding[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
        const binding = entry as Record<string, unknown>;
        if (
          Object.keys(binding).length !== 2
          || !Object.hasOwn(binding, "task_identity")
          || !Object.hasOwn(binding, "sources")
          || typeof binding.task_identity !== "string"
          || !binding.task_identity.trim()
          || binding.task_identity !== binding.task_identity.trim()
          || !Array.isArray(binding.sources)
          || binding.sources.length === 0
          || binding.sources.some((source) =>
            typeof source !== "string" || !source.trim() || source !== source.trim())
        ) return {};
        bindings.push({
          task_identity: binding.task_identity,
          sources: [...new Set(binding.sources as string[])],
        });
      }
      mapping[slug] = bindings;
    }
    return mapping;
  } catch {
    return {};
  }
}

export function publisherMayIngest(
  db: Db,
  slug: string,
  taskIdentity: string,
  sources: readonly string[],
): boolean {
  if (!BRIEFING_PUBLISHER_TASK_GATE.includes(taskIdentity)) return false;
  const bindings = readBriefingPublisherBindings(db)[slug];
  const binding = bindings?.find((candidate) => candidate.task_identity === taskIdentity);
  return Boolean(binding && sources.every((source) => binding.sources.includes(source)));
}

/** SHA-256 over the parser-reconstructed, fixed-order request. */
export function briefingRequestDigest(batch: BriefingIngestRequest): string {
  return createHash("sha256").update(JSON.stringify(batch)).digest("hex");
}

export function briefingExpiryMs(db: Db): number {
  const raw = getSetting(db, BRIEFING_EXPIRY_MS_KEY);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRIEFING_EXPIRY_MS;
}

export function ingestBriefingBatch(
  db: Db,
  batch: BriefingIngestRequest,
  now: number = Date.now(),
  publisherUserId?: string,
): BriefingIngestResult {
  try {
    return ingestRecurringBatch(db, batch, {
      now,
      expiryMs: briefingExpiryMs(db),
      publisherUserId: publisherUserId ?? null,
      requestDigest: briefingRequestDigest(batch),
    });
  } catch (error) {
    return translateStoreError(error);
  }
}

export function summarizeBatch(db: Db, batchKey: string): BriefingIngestResult {
  return summarizeRecurringBatch(db, batchKey);
}

export function lastActionForRevision(db: Db, revisionId: string): string | null {
  return lastRecurringActionForRevision(db, revisionId);
}

export function candidateStateFromAction(action: string | null): BriefingCandidateState {
  return recurringCandidateStateFromAction(action);
}

export function countPendingBriefingCandidates(db: Db = getDb()): number {
  return countPendingRecurringItems(db);
}

export interface BriefingQueueOptions {
  source?: string;
  limit?: number;
  now?: number;
}

export function listBriefingQueue(
  db: Db = getDb(),
  options: BriefingQueueOptions = {},
): BriefingQueueResponse {
  return listRecurringQueue(db, { ...options, now: options.now ?? Date.now() });
}

export function listBriefingSourceHealth(
  db: Db = getDb(),
  now: number = Date.now(),
): BriefingSourceHealth[] {
  return listRecurringSourceHealth(db, now);
}

export function getBriefingCandidate(db: Db, candidateId: string) {
  return getRecurringCandidate(db, candidateId);
}

export function getBriefingCandidateHistory(
  db: Db,
  candidateId: string,
): BriefingCandidateHistoryResponse | null {
  return getRecurringCandidateHistory(db, candidateId);
}

export interface BriefingDecisionInput {
  candidateId: string;
  action: BriefingReviewAction;
  actorUserId: string;
  revisionId?: string;
  expectedEventId?: string;
  now?: number;
}

export interface BriefingDecisionOutcome {
  candidate_id: string;
  revision_id: string;
  action: BriefingReviewAction;
  event_id: string;
  state: BriefingCandidateState;
}

export function recordBriefingDecision(
  db: Db,
  input: BriefingDecisionInput,
): BriefingDecisionOutcome {
  try {
    return recordRecurringDecision(db, { ...input, now: input.now ?? Date.now() });
  } catch (error) {
    return translateStoreError(error);
  }
}

export interface BriefingCommentInput {
  candidateId: string;
  body: string;
  actorUserId: string;
  revisionId?: string;
  now?: number;
}

export function addBriefingComment(db: Db, input: BriefingCommentInput): BriefingComment {
  try {
    return addRecurringComment(db, { ...input, now: input.now ?? Date.now() });
  } catch (error) {
    return translateStoreError(error);
  }
}

export interface BriefingSweepResult {
  expired: number;
  candidate_ids: string[];
}

export function sweepExpiredBriefingCandidates(
  db: Db = getDb(),
  options: { now?: number; expiryMs?: number } = {},
): BriefingSweepResult {
  return sweepExpiredRecurringItems(db, {
    now: options.now ?? Date.now(),
    expiryMs: options.expiryMs ?? briefingExpiryMs(db),
  });
}
