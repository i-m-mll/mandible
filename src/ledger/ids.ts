import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "../canonical-json.js";

export const LEDGER_ID_PREFIXES = [
  "prj",
  "chk",
  "issue",
  "com",
  "evt",
  "out",
  "edge",
  "rel",
  "cnf",
  "xref",
  "job",
  "rec",
  "mis",
  "opb",
  "opm",
  "rev",
] as const;

export type LedgerIdPrefix = (typeof LEDGER_ID_PREFIXES)[number];

export interface LedgerIdOptions {
  now?: number;
  random?: Buffer;
}

export interface StableIssueIdInput {
  project_id: string;
  title: string;
  body?: string;
  source?: string;
  created_at: number;
  author_actor_id?: string | null;
  author_actor_type?: string;
  author_display?: string;
  nonce: string;
}

export interface StableCommentIdInput {
  issue_id: string;
  ordinal: number;
  body: string;
  source?: string;
  created_at: number;
  author_actor_id?: string | null;
  author_actor_type?: string;
  author_display?: string;
  nonce: string;
}

export interface StableEventIdInput {
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor_id?: string | null;
  actor_type: string;
  source: string;
  payload: Record<string, unknown>;
  occurred_at: number;
  observed_at: number;
  occurrence: string;
}

const TIME_WIDTH = 10;
const RANDOM_BYTES = 10;

/**
 * Generate a Mandible ledger ID. This is UUIDv7-like rather than a full RFC
 * UUIDv7 implementation: lexicographic order follows millisecond time, then a
 * cryptographic-random suffix prevents path/title/adapter-derived IDs.
 */
export function createLedgerId(prefix: LedgerIdPrefix, options: LedgerIdOptions = {}): string {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error(`Invalid ledger ID timestamp: ${now}`);
  }
  const time = Math.floor(now).toString(36).padStart(TIME_WIDTH, "0");
  const entropy = options.random ?? randomBytes(RANDOM_BYTES);
  if (entropy.length < RANDOM_BYTES) {
    throw new Error(`Ledger ID entropy must be at least ${RANDOM_BYTES} bytes`);
  }
  return `${prefix}_${time}_${entropy.subarray(0, RANDOM_BYTES).toString("hex")}`;
}

export function isLedgerIdWithPrefix(value: string, prefix: LedgerIdPrefix): boolean {
  return value.startsWith(`${prefix}_`);
}

export function createCreationNonce(): string {
  return randomBytes(16).toString("hex");
}

export function createStableIssueId(input: StableIssueIdInput): string {
  return sha256Hex({
    type: "mandible.issue.v1",
    project_id: input.project_id,
    title: input.title,
    body: input.body ?? "",
    source: input.source ?? "mandible",
    created_at: input.created_at,
    author_actor_id: input.author_actor_id ?? null,
    author_actor_type: input.author_actor_type ?? "external_adapter",
    author_display: input.author_display ?? "",
    nonce: input.nonce,
  });
}

export function createStableCommentId(input: StableCommentIdInput): string {
  return sha256Hex({
    type: "mandible.comment.v1",
    issue_id: input.issue_id,
    ordinal: input.ordinal,
    body: input.body,
    source: input.source ?? "mandible",
    created_at: input.created_at,
    author_actor_id: input.author_actor_id ?? null,
    author_actor_type: input.author_actor_type ?? "external_adapter",
    author_display: input.author_display ?? "",
    nonce: input.nonce,
  });
}

export function createStableEventId(input: StableEventIdInput): string {
  return sha256Hex({
    type: "mandible.event.v1",
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    event_type: input.event_type,
    actor_id: input.actor_id ?? null,
    actor_type: input.actor_type,
    source: input.source,
    payload: input.payload,
    occurred_at: input.occurred_at,
    observed_at: input.observed_at,
    occurrence: input.occurrence,
  });
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function sha256Hex(record: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

