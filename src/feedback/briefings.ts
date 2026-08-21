import { createHash, randomUUID } from "node:crypto";

import { readArtifactBytesFull } from "../artifact-content.js";
import type { FeedbackResponseType, FeedbackResponseValue } from "../contracts.js";
import type { Db } from "../db.js";
import { getCanonicalArtifactVersion, recordArtifactVersion, resolveArtifactRefReadonlyFull } from "../provider-artifacts.js";
import { getOperatorId } from "../users/store.js";
import {
  BRIEFING_PROFILE,
  BRIEFING_PROFILE_V3,
  BriefingDirectiveError,
  parseBriefingDirectives,
  type BriefingDirective,
  type BriefingProfile,
} from "./briefing-directives.js";

export const BRIEFING_RUN_SCHEMA = "mandible-briefing-run@1" as const;

export class BriefingStoreError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_briefing") {
    super(message);
    this.name = "BriefingStoreError";
  }
}

export type BriefingRunRequest = {
  schema: typeof BRIEFING_RUN_SCHEMA;
  briefing_key: string;
  title: string;
  task_identity: string;
  run_id: string;
  run_key: string;
  responder_user_ids: string[];
  evidence: { series_ref: string; version: number; digest: string };
  source_health: { source: string; status: "healthy" | "degraded" | "unavailable"; detail: string | null; observed_at: number };
  document: null | { markdown: string };
  quiet_reason: string | null;
  occurrences: Array<{ directive_key: string; evidence_digest: string; occurred_at: number; metadata: Record<string, unknown> }>;
};

export type BriefingRunReceipt = {
  receipt_id: string;
  briefing_id: string;
  run_id: string;
  round_id: string | null;
  artifact_version_id: string | null;
  quiet: boolean;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BriefingStoreError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new BriefingStoreError(`${label} contains unsupported field '${extra[0]}'`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BriefingStoreError(`${label} must be a nonblank string`);
  return value.trim();
}

function exactNonblankText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BriefingStoreError(`${label} must be a nonblank string`);
  return value;
}

function sha(value: unknown, label: string): string {
  const parsed = text(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new BriefingStoreError(`${label} must be a SHA-256 digest`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new BriefingStoreError(`${label} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function directiveBinding(directive: BriefingDirective, position: number) {
  return {
    position,
    key: directive.key,
    type: directive.type,
    required: directive.required,
    prompt: directive.body,
    options: directive.options,
    variants: directive.variants,
    start_offset: directive.start_offset,
    end_offset: directive.end_offset,
    body_start_offset: directive.body_start_offset,
    body_end_offset: directive.body_end_offset,
    definition_digest: directive.definition_digest,
  };
}

function roundBindingDigest(directives: BriefingDirective[]): string {
  return createHash("sha256").update(canonical(directives.map(directiveBinding))).digest("hex");
}

export function parseBriefingRunRequest(value: unknown): BriefingRunRequest {
  const body = record(value, "request body");
  only(body, ["schema", "briefing_key", "title", "task_identity", "run_id", "run_key", "responder_user_ids",
    "evidence", "source_health", "document", "quiet_reason", "occurrences"], "request body");
  if (body.schema !== BRIEFING_RUN_SCHEMA) {
    throw new BriefingStoreError(`schema must be '${BRIEFING_RUN_SCHEMA}'`);
  }
  if (!Array.isArray(body.responder_user_ids) || body.responder_user_ids.length === 0
      || body.responder_user_ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new BriefingStoreError("responder_user_ids must be a non-empty array of user ids");
  }
  const evidence = record(body.evidence, "evidence");
  only(evidence, ["series_ref", "version", "digest"], "evidence");
  const health = record(body.source_health, "source_health");
  only(health, ["source", "status", "detail", "observed_at"], "source_health");
  if (!["healthy", "degraded", "unavailable"].includes(String(health.status))) {
    throw new BriefingStoreError("source_health.status must be healthy, degraded, or unavailable");
  }
  if (health.detail !== null && health.detail !== undefined && typeof health.detail !== "string") {
    throw new BriefingStoreError("source_health.detail must be a string or null");
  }
  const document = body.document === null || body.document === undefined ? null : record(body.document, "document");
  if (document) only(document, ["markdown"], "document");
  const markdown = document ? exactNonblankText(document.markdown, "document.markdown") : null;
  const quietReason = body.quiet_reason === null || body.quiet_reason === undefined
    ? null : text(body.quiet_reason, "quiet_reason");
  if ((markdown === null) === (quietReason === null)) {
    throw new BriefingStoreError("exactly one of document or quiet_reason is required");
  }
  const rawOccurrences: unknown[] = body.occurrences === undefined ? []
    : Array.isArray(body.occurrences) ? body.occurrences : (() => { throw new BriefingStoreError("occurrences must be an array"); })();
  const occurrences = rawOccurrences.map((entry, index) => {
    const occurrence = record(entry, `occurrences[${index}]`);
    only(occurrence, ["directive_key", "evidence_digest", "occurred_at", "metadata"], `occurrences[${index}]`);
    const metadata = occurrence.metadata === undefined ? {} : record(occurrence.metadata, `occurrences[${index}].metadata`);
    return {
      directive_key: text(occurrence.directive_key, `occurrences[${index}].directive_key`),
      evidence_digest: sha(occurrence.evidence_digest, `occurrences[${index}].evidence_digest`),
      occurred_at: integer(occurrence.occurred_at, `occurrences[${index}].occurred_at`),
      metadata,
    };
  });
  if (markdown === null && occurrences.length > 0) {
    throw new BriefingStoreError("quiet runs cannot carry directive occurrences");
  }
  if (markdown !== null) {
    try {
      const keys = new Set(parseBriefingDirectives(markdown).map((directive) => directive.key));
      for (const occurrence of occurrences) {
        if (!keys.has(occurrence.directive_key)) {
          throw new BriefingStoreError(`occurrence directive '${occurrence.directive_key}' is not in the document`);
        }
      }
    } catch (error) {
      if (error instanceof BriefingStoreError) throw error;
      if (error instanceof BriefingDirectiveError) {
        throw new BriefingStoreError(error.message, 400, "invalid_briefing_document");
      }
      throw error;
    }
  }
  return {
    schema: BRIEFING_RUN_SCHEMA,
    briefing_key: text(body.briefing_key, "briefing_key"),
    title: text(body.title, "title"),
    task_identity: text(body.task_identity, "task_identity"),
    run_id: text(body.run_id, "run_id"),
    run_key: text(body.run_key, "run_key"),
    responder_user_ids: [...new Set((body.responder_user_ids as string[]).map((id) => id.trim()))],
    evidence: {
      series_ref: text(evidence.series_ref, "evidence.series_ref"),
      version: integer(evidence.version, "evidence.version"),
      digest: sha(evidence.digest, "evidence.digest"),
    },
    source_health: {
      source: text(health.source, "source_health.source"),
      status: health.status as BriefingRunRequest["source_health"]["status"],
      detail: typeof health.detail === "string" ? health.detail : null,
      observed_at: integer(health.observed_at, "source_health.observed_at"),
    },
    document: markdown === null ? null : { markdown },
    quiet_reason: quietReason,
    occurrences,
  };
}

export function briefingRunRequestDigest(request: BriefingRunRequest): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

function receipt(row: {
  id: string; briefing_id: string; run_id: string; round_id: string | null;
  artifact_version_id: string | null; quiet: number;
}): BriefingRunReceipt {
  return {
    receipt_id: row.id,
    briefing_id: row.briefing_id,
    run_id: row.run_id,
    round_id: row.round_id,
    artifact_version_id: row.artifact_version_id,
    quiet: row.quiet === 1,
  };
}

export function publishBriefingRun(
  db: Db,
  request: BriefingRunRequest,
  publisherUserId: string,
  now = Date.now(),
): BriefingRunReceipt {
  const digest = briefingRunRequestDigest(request);
  const replay = db.prepare(
    `SELECT id, briefing_id, run_id, round_id, artifact_version_id, quiet, request_digest
       FROM briefing_runs WHERE publisher_user_id = ? AND task_identity = ? AND run_key = ?`,
  ).get(publisherUserId, request.task_identity, request.run_key) as
    | { id: string; briefing_id: string; run_id: string; round_id: string | null; artifact_version_id: string | null; quiet: number; request_digest: string }
    | undefined;
  if (replay) {
    if (replay.request_digest !== digest) {
      throw new BriefingStoreError("run replay conflicts with the stored request body", 409, "run_replay_conflict");
    }
    return receipt(replay);
  }
  for (const responder of request.responder_user_ids) {
    const user = db.prepare("SELECT kind, status FROM users WHERE id = ?").get(responder) as
      | { kind: string; status: string } | undefined;
    if (!user || user.status !== "active" || user.kind !== "human") {
      throw new BriefingStoreError(`responder '${responder}' is not an active human`, 400, "invalid_responder");
    }
  }

  return db.transaction(() => {
    let briefing = db.prepare("SELECT id, latest_round_id, round_count FROM briefings WHERE briefing_key = ?")
      .get(request.briefing_key) as { id: string; latest_round_id: string | null; round_count: number } | undefined;
    if (!briefing) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 0, ?, ?)`,
      ).run(id, request.briefing_key, request.title, now, now);
      briefing = { id, latest_round_id: null, round_count: 0 };
    } else {
      db.prepare("UPDATE briefings SET title = ?, updated_at = ? WHERE id = ?")
        .run(request.title, now, briefing.id);
    }
    for (const responder of request.responder_user_ids) {
      db.prepare("INSERT OR IGNORE INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)")
        .run(briefing.id, responder, now);
    }

    let roundId: string | null = null;
    let artifactVersionId: string | null = null;
    const instanceByKey = new Map<string, string>();
    if (request.document) {
      const artifact = recordArtifactVersion(db, {
        source_kind: "managed",
        content: request.document.markdown,
        series_key: `mandible:briefing:${briefing.id}`,
        logical_name: `${request.briefing_key}.md`,
        title: request.title,
        role: "briefing-document",
        media_type: "text/markdown",
        metadata: { profile: BRIEFING_PROFILE, briefing_id: briefing.id },
        parent_version_id: briefing.latest_round_id
          ? (db.prepare("SELECT artifact_version_id FROM briefing_rounds WHERE id = ?").get(briefing.latest_round_id) as { artifact_version_id: string }).artifact_version_id
          : null,
      }, now);
      artifactVersionId = artifact.version.id;
      const directives = parseBriefingDirectives(request.document.markdown);
      const bindingDigest = roundBindingDigest(directives);
      roundId = randomUUID();
      db.prepare(
        `INSERT INTO briefing_rounds
          (id, briefing_id, ordinal, artifact_version_id, previous_round_id, profile, binding_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(roundId, briefing.id, briefing.round_count + 1, artifactVersionId,
        briefing.latest_round_id, BRIEFING_PROFILE, bindingDigest, now);
      directives.forEach((directive, position) => {
        let definition = db.prepare(
          "SELECT id FROM briefing_directive_definitions WHERE artifact_version_id = ? AND directive_key = ?",
        ).get(artifactVersionId, directive.key) as { id: string } | undefined;
        if (!definition) {
          definition = { id: randomUUID() };
          db.prepare(
            `INSERT INTO briefing_directive_definitions
              (id, artifact_version_id, directive_key, definition_digest, response_type, required, prompt,
               options_json, start_offset, end_offset, body_start_offset, body_end_offset, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(definition.id, artifactVersionId, directive.key, directive.definition_digest,
            directive.type, directive.required ? 1 : 0, directive.body, canonical(directive.options),
            directive.start_offset, directive.end_offset,
            directive.body_start_offset, directive.body_end_offset, now);
        }
        const instanceId = randomUUID();
        db.prepare(
          `INSERT INTO briefing_directive_instances
            (id, round_id, briefing_id, artifact_version_id, definition_id, directive_key, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(instanceId, roundId, briefing.id, artifactVersionId, definition.id, directive.key, position, now);
        instanceByKey.set(directive.key, instanceId);
      });
      const verified = verifyBriefingRoundBinding(db, roundId);
      if (!verified.valid) {
        throw new BriefingStoreError(`published round binding is invalid: ${verified.reason}`, 409, "invalid_round_binding");
      }
      db.prepare(
        "UPDATE briefings SET latest_round_id = ?, round_count = round_count + 1, updated_at = ? WHERE id = ?",
      ).run(roundId, now, briefing.id);
    }
    const receiptId = randomUUID();
    db.prepare(
      `INSERT INTO briefing_runs
        (id, briefing_id, round_id, artifact_version_id, publisher_user_id, task_identity, run_id, run_key,
         request_digest, evidence_series_ref, evidence_version, evidence_digest, source_health_json,
         quiet, quiet_reason, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(receiptId, briefing.id, roundId, artifactVersionId, publisherUserId, request.task_identity,
      request.run_id, request.run_key, digest, request.evidence.series_ref, request.evidence.version,
      request.evidence.digest, JSON.stringify(request.source_health), request.document ? 0 : 1,
      request.quiet_reason, now);
    for (const occurrence of request.occurrences) {
      db.prepare(
        `INSERT INTO briefing_run_occurrences
          (id, run_id, round_id, briefing_id, directive_instance_id, directive_key, evidence_digest, occurred_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), receiptId, roundId, briefing.id, instanceByKey.get(occurrence.directive_key) ?? null,
        occurrence.directive_key, occurrence.evidence_digest, occurrence.occurred_at,
        JSON.stringify(occurrence.metadata));
    }
    return { receipt_id: receiptId, briefing_id: briefing.id, run_id: request.run_id,
      round_id: roundId, artifact_version_id: artifactVersionId, quiet: request.document === null };
  }).immediate();
}

export type ExistingArtifactBriefingRequest = {
  briefing_key: string; title: string; artifact_version_ref: string;
  profile: typeof BRIEFING_PROFILE_V3; responder_user_ids: string[];
};

/** Bind an existing exact artifact version; this path never records or copies artifact bytes. */
export function publishBriefingFromArtifactVersion(
  db: Db, request: ExistingArtifactBriefingRequest, now = Date.now(),
): BriefingRunReceipt {
  if (request.profile !== BRIEFING_PROFILE_V3) throw new BriefingStoreError("existing artifact publication requires mandible-briefing.v3");
  const resolved = resolveArtifactRefReadonlyFull(db, request.artifact_version_ref);
  if (resolved.status !== "resolved" || resolved.target_type !== "artifact_version" || !resolved.target_id) {
    throw new BriefingStoreError("artifact_version_ref must resolve to one exact artifact version", 404, "artifact_version_not_found");
  }
  const versionId = resolved.target_id;
  const document = pinnedRoundDocument(db, versionId);
  let directives: BriefingDirective[];
  try { directives = parseBriefingDirectives(document.source, request.profile); }
  catch (error) { throw new BriefingStoreError(error instanceof Error ? error.message : String(error), 400, "invalid_briefing_document"); }
  for (const responder of request.responder_user_ids) {
    const user = db.prepare("SELECT kind, status FROM users WHERE id = ?").get(responder) as { kind: string; status: string } | undefined;
    if (!user || user.kind !== "human" || user.status !== "active") throw new BriefingStoreError(`responder '${responder}' is not an active human`);
  }
  return db.transaction(() => {
    let briefing = db.prepare("SELECT id, latest_round_id, round_count FROM briefings WHERE briefing_key = ?")
      .get(request.briefing_key) as { id: string; latest_round_id: string | null; round_count: number } | undefined;
    if (!briefing) {
      const id = randomUUID();
      db.prepare(`INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 0, ?, ?)`).run(id, request.briefing_key, request.title, now, now);
      briefing = { id, latest_round_id: null, round_count: 0 };
    }
    for (const responder of request.responder_user_ids) db.prepare(
      "INSERT OR IGNORE INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)",
    ).run(briefing.id, responder, now);
    const existing = db.prepare("SELECT id FROM briefing_rounds WHERE briefing_id = ? AND artifact_version_id = ? AND profile = ?")
      .get(briefing.id, versionId, request.profile) as { id: string } | undefined;
    if (existing) {
      const replayVerification = verifyBriefingRoundBinding(db, existing.id);
      if (!replayVerification.valid) throw new BriefingStoreError(`stored round binding is invalid: ${replayVerification.reason}`, 409, "invalid_round_binding");
      return { receipt_id: existing.id, briefing_id: briefing.id, run_id: `artifact:${versionId}`,
        round_id: existing.id, artifact_version_id: versionId, quiet: false };
    }
    const roundId = randomUUID();
    db.prepare(`INSERT INTO briefing_rounds
      (id, briefing_id, ordinal, artifact_version_id, previous_round_id, profile, binding_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(roundId, briefing.id, briefing.round_count + 1, versionId,
      briefing.latest_round_id, request.profile, roundBindingDigest(directives), now);
    directives.forEach((directive, position) => {
      let definition = db.prepare("SELECT id FROM briefing_directive_definitions WHERE artifact_version_id = ? AND directive_key = ?")
        .get(versionId, directive.key) as { id: string } | undefined;
      if (!definition) {
        definition = { id: randomUUID() };
        db.prepare(`INSERT INTO briefing_directive_definitions
          (id, artifact_version_id, directive_key, definition_digest, response_type, required, prompt,
           options_json, variants_json, start_offset, end_offset, body_start_offset, body_end_offset, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(definition.id, versionId, directive.key,
          directive.definition_digest, directive.type, directive.required ? 1 : 0, directive.body,
          canonical(directive.options), canonical(directive.variants), directive.start_offset, directive.end_offset,
          directive.body_start_offset, directive.body_end_offset, now);
      }
      db.prepare(`INSERT INTO briefing_directive_instances
        (id, round_id, briefing_id, artifact_version_id, definition_id, directive_key, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), roundId, briefing.id, versionId, definition.id, directive.key, position, now);
    });
    const verified = verifyBriefingRoundBinding(db, roundId);
    if (!verified.valid) throw new BriefingStoreError(`published round binding is invalid: ${verified.reason}`, 409, "invalid_round_binding");
    db.prepare("UPDATE briefings SET title = ?, latest_round_id = ?, round_count = round_count + 1, updated_at = ? WHERE id = ?")
      .run(request.title, roundId, now, briefing.id);
    return { receipt_id: roundId, briefing_id: briefing.id, run_id: `artifact:${versionId}`,
      round_id: roundId, artifact_version_id: versionId, quiet: false };
  }).immediate();
}

export function briefingMemberAllows(db: Db, briefingId: string, actorUserId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM briefing_members WHERE briefing_id = ? AND user_id = ?")
    .get(briefingId, actorUserId));
}

export function listBriefings(db: Db, viewer: { userId: string; operator: boolean }) {
  return db.prepare(
    `SELECT b.id, b.briefing_key, b.title, b.latest_round_id, b.round_count, b.created_at, b.updated_at
       FROM briefings b
      WHERE ? = 1 OR EXISTS (SELECT 1 FROM briefing_members m WHERE m.briefing_id = b.id AND m.user_id = ?)
      ORDER BY b.updated_at DESC, b.id`,
  ).all(viewer.operator ? 1 : 0, viewer.userId);
}

function pinnedRoundDocument(db: Db, artifactVersionId: string): { source: string; content_hash: string } {
  const version = getCanonicalArtifactVersion(db, artifactVersionId);
  if (!version || version.id !== artifactVersionId) {
    throw new BriefingStoreError("round document is unavailable", 409, "document_unavailable");
  }
  const content = readArtifactBytesFull(db, version.id);
  if (!content.ok) throw new BriefingStoreError("round document is unavailable", 409, "document_unavailable");
  if (createHash("sha256").update(content.bytes).digest("hex") !== version.content_hash) {
    throw new BriefingStoreError("round document failed integrity verification", 409, "document_integrity_failed");
  }
  try {
    return { source: new TextDecoder("utf-8", { fatal: true }).decode(content.bytes), content_hash: version.content_hash };
  } catch {
    throw new BriefingStoreError("round document is not valid UTF-8", 409, "document_unavailable");
  }
}

export type BriefingBindingVerification =
  | { valid: true; source: string; content_hash: string; directives: BriefingDirective[] }
  | { valid: false; reason: string; source: string | null; content_hash: string | null };

/** One authoritative exact-byte verifier used by publication, reads, answers, annotations, and submission. */
export function verifyBriefingRoundBinding(db: Db, roundId: string): BriefingBindingVerification {
  const round = db.prepare(
    `SELECT id, briefing_id, artifact_version_id, profile, binding_digest
       FROM briefing_rounds WHERE id = ?`,
  ).get(roundId) as {
    id: string; briefing_id: string; artifact_version_id: string; profile: string; binding_digest: string;
  } | undefined;
  if (!round) return { valid: false, reason: "round is missing", source: null, content_hash: null };
  if (round.profile !== BRIEFING_PROFILE && round.profile !== BRIEFING_PROFILE_V3) {
    return { valid: false, reason: "round profile is unknown", source: null, content_hash: null };
  }
  let document: { source: string; content_hash: string };
  try {
    document = pinnedRoundDocument(db, round.artifact_version_id);
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error), source: null, content_hash: null };
  }
  let directives: BriefingDirective[];
  try {
    directives = parseBriefingDirectives(document.source, round.profile as BriefingProfile);
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error),
      source: document.source, content_hash: document.content_hash };
  }
  const rows = db.prepare(
    `SELECT i.position, i.directive_key, i.briefing_id, i.artifact_version_id,
            d.artifact_version_id AS definition_artifact_version_id,
            d.definition_digest, d.response_type, d.required, d.prompt, d.options_json, d.variants_json,
            d.start_offset, d.end_offset, d.body_start_offset, d.body_end_offset
       FROM briefing_directive_instances i
       JOIN briefing_directive_definitions d ON d.id = i.definition_id
      WHERE i.round_id = ? ORDER BY i.position`,
  ).all(roundId) as Array<{
    position: number; directive_key: string; briefing_id: string; artifact_version_id: string;
    definition_artifact_version_id: string; definition_digest: string; response_type: string;
    required: number; prompt: string; options_json: string; variants_json: string; start_offset: number; end_offset: number;
    body_start_offset: number; body_end_offset: number;
  }>;
  if (rows.length !== directives.length) {
    return { valid: false, reason: "stored definition count does not match artifact", ...document };
  }
  for (const [position, directive] of directives.entries()) {
    const row = rows[position];
    let options: unknown; let variants: unknown;
    try { options = JSON.parse(row.options_json); } catch { options = null; }
    try { variants = JSON.parse(row.variants_json); } catch { variants = null; }
    const expected = directiveBinding(directive, position);
    const stored = {
      position: row.position,
      key: row.directive_key,
      type: row.response_type,
      required: row.required === 1,
      prompt: row.prompt,
      options,
      variants,
      start_offset: row.start_offset,
      end_offset: row.end_offset,
      body_start_offset: row.body_start_offset,
      body_end_offset: row.body_end_offset,
      definition_digest: row.definition_digest,
    };
    if (row.briefing_id !== round.briefing_id || row.artifact_version_id !== round.artifact_version_id
        || row.definition_artifact_version_id !== round.artifact_version_id
        || canonical(stored) !== canonical(expected)) {
      return { valid: false, reason: `stored definition '${directive.key}' does not match artifact`, ...document };
    }
  }
  if (roundBindingDigest(directives) !== round.binding_digest) {
    return { valid: false, reason: "round binding digest does not match artifact", ...document };
  }
  return { valid: true, ...document, directives };
}

function requireValidBriefingRoundBinding(db: Db, roundId: string): Extract<BriefingBindingVerification, { valid: true }> {
  const verification = verifyBriefingRoundBinding(db, roundId);
  if (!verification.valid) {
    throw new BriefingStoreError(`briefing round binding is invalid: ${verification.reason}`, 409, "invalid_round_binding");
  }
  return verification;
}

function effectiveAnswers(db: Db, roundId: string, actorUserId: string) {
  return db.prepare(
    `SELECT e.id AS response_event_id, i.id AS directive_instance_id, i.directive_key,
            d.response_type, d.options_json, d.variants_json, e.value_json, e.created_at
       FROM briefing_response_events e
       JOIN briefing_directive_instances i ON i.id = e.directive_instance_id
       JOIN briefing_directive_definitions d ON d.id = i.definition_id
      WHERE e.round_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
        AND NOT EXISTS (SELECT 1 FROM briefing_response_events r WHERE r.retracts_event_id = e.id)
      ORDER BY i.position`,
  ).all(roundId, actorUserId) as Array<{
    response_event_id: string; directive_instance_id: string; directive_key: string;
    response_type: FeedbackResponseType; options_json: string; variants_json: string; value_json: string; created_at: number;
  }>;
}

function validatedEffectiveAnswers(db: Db, roundId: string, actorUserId: string) {
  return effectiveAnswers(db, roundId, actorUserId).map((answer) => {
    let parsed: unknown;
    try { parsed = JSON.parse(answer.value_json); } catch {
      throw new BriefingStoreError("stored answer is not valid JSON", 409, "invalid_stored_answer");
    }
    const value = validateValue(answer.response_type, parsed, answer.options_json, answer.variants_json);
    if (canonical(value) !== answer.value_json) {
      throw new BriefingStoreError("stored answer is not canonical for its directive", 409, "invalid_stored_answer");
    }
    return { ...answer, value };
  });
}

function effectiveAnnotations(db: Db, roundId: string, actorUserId: string) {
  return db.prepare(
    `SELECT id AS annotation_event_id, annotation_kind, start_offset, end_offset, quote, body,
            replacement_text, created_at
       FROM briefing_annotation_events e
      WHERE round_id = ? AND actor_user_id = ? AND operation = 'set'
        AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id)
      ORDER BY created_at, rowid`,
  ).all(roundId, actorUserId);
}

export function readBriefing(
  db: Db,
  briefingId: string,
  options: { roundId?: string; actorUserId: string; operator: boolean },
) {
  const briefing = db.prepare(
    `SELECT id, briefing_key, title, latest_round_id, round_count, created_at, updated_at
       FROM briefings WHERE id = ?`,
  ).get(briefingId) as Record<string, unknown> | undefined;
  if (!briefing || (!options.operator && !briefingMemberAllows(db, briefingId, options.actorUserId))) return null;
  const roundRows = db.prepare(
    `SELECT r.id, r.ordinal, r.artifact_version_id, r.previous_round_id, r.profile,
            r.binding_digest, r.created_at,
            (SELECT json_extract(run.source_health_json, '$.source')
               FROM briefing_runs run WHERE run.round_id = r.id LIMIT 1) AS origin_source,
            (SELECT run.run_id FROM briefing_runs run WHERE run.round_id = r.id LIMIT 1) AS origin_run_id,
            (SELECT run.task_identity FROM briefing_runs run WHERE run.round_id = r.id LIMIT 1) AS origin_task_identity
       FROM briefing_rounds r WHERE r.briefing_id = ? ORDER BY r.ordinal DESC`,
  ).all(briefingId) as Array<{
    id: string; ordinal: number; artifact_version_id: string; previous_round_id: string | null;
    profile: string; binding_digest: string; created_at: number; origin_source: string | null;
    origin_run_id: string | null; origin_task_identity: string | null;
  }>;
  const rounds = roundRows.map(({ origin_source, origin_run_id, origin_task_identity, ...round }) => ({
    ...round,
    origin: origin_run_id === null ? null : {
      source: origin_source,
      run_id: origin_run_id,
      task_identity: origin_task_identity,
    },
  }));
  let selected: (typeof rounds)[number] | undefined = rounds[0];
  const roundRef = options.roundId;
  if (roundRef) {
    selected = rounds.find((round) => round.id === roundRef);
    if (!selected) {
      const matches = rounds.filter((round) => round.id.startsWith(roundRef));
      if (matches.length > 1) {
        throw new BriefingStoreError("round reference is ambiguous within this Briefing", 409, "ambiguous_round");
      }
      selected = matches[0];
    }
  }
  if (roundRef && !selected) throw new BriefingStoreError("round not found", 404, "not_found");
  if (!selected) return { briefing, rounds, selected_round: null };
  const verification = verifyBriefingRoundBinding(db, selected.id);
  const items = db.prepare(
    `SELECT i.id, i.directive_key, i.position, d.definition_digest, d.response_type, d.required,
            d.prompt, d.options_json, d.variants_json, d.start_offset, d.end_offset, d.body_start_offset, d.body_end_offset
       FROM briefing_directive_instances i JOIN briefing_directive_definitions d ON d.id = i.definition_id
      WHERE i.round_id = ? ORDER BY i.position`,
  ).all(selected.id) as Array<{ id: string; directive_key: string; position: number; definition_digest: string;
    response_type: string; required: number; prompt: string; options_json: string; variants_json: string;
    start_offset: number; end_offset: number; body_start_offset: number; body_end_offset: number }>;
  const latestSubmission = db.prepare(
    `SELECT id, ordinal, supersedes_submission_id, actor_user_id, created_at
       FROM briefing_submissions WHERE round_id = ? AND actor_user_id = ? ORDER BY ordinal DESC LIMIT 1`,
  ).get(selected.id, options.actorUserId) as { id: string; ordinal: number } | undefined;
  const latestFrozenMembership = latestSubmission ? {
    answer_event_ids: (db.prepare(
      "SELECT response_event_id FROM briefing_submission_answers WHERE submission_id = ? ORDER BY position",
    ).all(latestSubmission.id) as Array<{ response_event_id: string }>).map((row) => row.response_event_id),
    annotation_event_ids: (db.prepare(
      "SELECT annotation_event_id FROM briefing_submission_annotations WHERE submission_id = ? ORDER BY position",
    ).all(latestSubmission.id) as Array<{ annotation_event_id: string }>).map((row) => row.annotation_event_id),
  } : null;
  let projectedAnswers: ReturnType<typeof validatedEffectiveAnswers> = [];
  let projectionError: string | null = null;
  if (verification.valid) {
    try { projectedAnswers = validatedEffectiveAnswers(db, selected.id, options.actorUserId); }
    catch (error) { projectionError = error instanceof Error ? error.message : String(error); }
  }
  const projectionValid = verification.valid && projectionError === null;
  const projectedItems = projectionValid
    ? items.map(({ options_json, variants_json, ...item }) => ({ ...item, options: JSON.parse(options_json),
      variants: JSON.parse(variants_json) }))
    : [];
  return {
    briefing,
    rounds,
    selected_round: {
      ...selected,
      document: { artifact_version_id: selected.artifact_version_id, content_hash: verification.content_hash,
        previous_round_id: selected.previous_round_id, profile: selected.profile, source: verification.source },
      binding: projectionValid ? { status: "valid" as const } : {
        status: "invalid" as const, reason: projectionError ?? (verification.valid ? "invalid projection" : verification.reason),
      },
      items: projectedItems,
      answers: projectionValid ? projectedAnswers.map(({ value_json: _valueJson, options_json: _optionsJson,
        variants_json: _variantsJson, ...answer }) => answer) : [],
      annotations: projectionValid ? effectiveAnnotations(db, selected.id, options.actorUserId) : [],
      latest_submission: projectionValid ? latestSubmission ?? null : null,
      latest_frozen_membership: projectionValid ? latestFrozenMembership : null,
    },
  };
}

function requireRoundResponder(db: Db, briefingId: string, roundId: string, actorUserId: string, now: number) {
  const row = db.prepare(
    `SELECT r.id FROM briefing_rounds r JOIN briefings b ON b.id = r.briefing_id
      WHERE b.id = ? AND r.id = ?`,
  ).get(briefingId, roundId);
  if (!row) {
    throw new BriefingStoreError("briefing round not found", 404, "not_found");
  }
  if (briefingMemberAllows(db, briefingId, actorUserId)) return;
  if (getOperatorId(db) !== actorUserId) {
    throw new BriefingStoreError("briefing round not found", 404, "not_found");
  }
  // Operator detail projection is authoritative for the same exact pair. Bind
  // the active operator as a responder in this response transaction so the
  // schema's actor-membership foreign keys remain the durable authority.
  db.prepare(
    "INSERT INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)",
  ).run(briefingId, actorUserId, now);
}

function validateValue(responseType: FeedbackResponseType, value: unknown, optionsJson: string, variantsJson = "[]"): FeedbackResponseValue {
  const payload = record(value, "answer.value");
  const options = JSON.parse(optionsJson) as Array<{ key: string }>;
  if (responseType === "verdict") {
    only(payload, ["verdict"], "answer.value");
    if (payload.verdict !== "keep" && payload.verdict !== "dismiss") {
      throw new BriefingStoreError("verdict must be keep or dismiss");
    }
    return { verdict: payload.verdict } as FeedbackResponseValue;
  } else if (responseType === "single_choice" || responseType === "text_variant") {
    const allowed = responseType === "text_variant" ? JSON.parse(variantsJson) as Array<{ key: string }> : options;
    only(payload, ["option_key"], "answer.value");
    if (typeof payload.option_key !== "string" || !allowed.some((option) => option.key === payload.option_key)) {
      throw new BriefingStoreError("option_key must name one defined option");
    }
    return { option_key: payload.option_key };
  } else if (responseType === "multi_choice") {
    only(payload, ["option_keys"], "answer.value");
    if (!Array.isArray(payload.option_keys) || payload.option_keys.length === 0
        || payload.option_keys.some((key) => typeof key !== "string")) {
      throw new BriefingStoreError("option_keys must be a nonempty string array");
    }
    const supplied = new Set(payload.option_keys as string[]);
    if (supplied.size !== payload.option_keys.length
        || [...supplied].some((key) => !options.some((option) => option.key === key))) {
      throw new BriefingStoreError("option_keys must be unique defined options");
    }
    return { option_keys: options.map((option) => option.key).filter((key) => supplied.has(key)) };
  } else if (responseType === "short_text" || responseType === "long_text") {
    only(payload, ["text"], "answer.value");
    const maximum = responseType === "short_text" ? 240 : 4000;
    if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > maximum) {
      throw new BriefingStoreError(`text must be nonblank and at most ${maximum} UTF-16 code units`);
    }
    return { text: payload.text };
  } else if (responseType === "rating") {
    only(payload, ["rating"], "answer.value");
    if (!Number.isSafeInteger(payload.rating) || (payload.rating as number) < 1 || (payload.rating as number) > 5) {
      throw new BriefingStoreError("rating must be a safe integer from 1 through 5");
    }
    return { rating: payload.rating as number };
  } else {
    throw new BriefingStoreError(`response type '${responseType}' is not supported by this Briefing profile`);
  }
}

export function applyBriefingAnswers(
  db: Db,
  briefingId: string,
  roundId: string,
  actorUserId: string,
  answers: unknown,
  now = Date.now(),
) {
  if (!Array.isArray(answers)) throw new BriefingStoreError("answers must be an array");
  return db.transaction(() => {
    requireRoundResponder(db, briefingId, roundId, actorUserId, now);
    requireValidBriefingRoundBinding(db, roundId);
    const answerEventIds: string[] = [];
    for (const [index, raw] of answers.entries()) {
      const answer = record(raw, `answers[${index}]`);
      only(answer, ["directive_key", "operation", "expected_response_event_id", "value"], `answers[${index}]`);
      const key = text(answer.directive_key, `answers[${index}].directive_key`);
      if (answer.operation !== "set" && answer.operation !== "retract") {
        throw new BriefingStoreError(`answers[${index}].operation must be set or retract`);
      }
      const directive = db.prepare(
        `SELECT i.id, d.response_type, d.options_json, d.variants_json FROM briefing_directive_instances i
          JOIN briefing_directive_definitions d ON d.id = i.definition_id
         WHERE i.round_id = ? AND i.directive_key = ?`,
      ).get(roundId, key) as { id: string; response_type: FeedbackResponseType; options_json: string; variants_json: string } | undefined;
      if (!directive) throw new BriefingStoreError(`directive '${key}' not found`, 404, "directive_not_found");
      const current = db.prepare(
        `SELECT e.id, e.value_json FROM briefing_response_events e
          WHERE e.round_id = ? AND e.directive_instance_id = ? AND e.actor_user_id = ? AND e.operation = 'set'
            AND NOT EXISTS (SELECT 1 FROM briefing_response_events r WHERE r.retracts_event_id = e.id)
          ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
      ).get(roundId, directive.id, actorUserId) as { id: string; value_json: string } | undefined;
      if (current) {
        let parsed: unknown;
        try { parsed = JSON.parse(current.value_json); } catch {
          throw new BriefingStoreError("stored answer is not valid JSON", 409, "invalid_stored_answer");
        }
        if (canonical(validateValue(directive.response_type, parsed, directive.options_json, directive.variants_json)) !== current.value_json) {
          throw new BriefingStoreError("stored answer is not canonical for its directive", 409, "invalid_stored_answer");
        }
      }
      const expected = answer.expected_response_event_id === null
        ? null : text(answer.expected_response_event_id, `answers[${index}].expected_response_event_id`);
      if ((current?.id ?? null) !== expected) {
        throw new BriefingStoreError("answer changed since it was read", 409, "stale_answer");
      }
      if (answer.operation === "retract") {
        if (Object.hasOwn(answer, "value") || !current) {
          throw new BriefingStoreError("retract requires one current answer and no value");
        }
        const retractionId = randomUUID();
        db.prepare(
          `INSERT INTO briefing_response_events
            (id, round_id, briefing_id, directive_instance_id, operation, value_json, retracts_event_id, actor_user_id, created_at)
           VALUES (?, ?, ?, ?, 'retract', NULL, ?, ?, ?)`,
        ).run(retractionId, roundId, briefingId, directive.id, current.id, actorUserId, now);
        answerEventIds.push(retractionId);
        continue;
      }
      if (!Object.hasOwn(answer, "value")) throw new BriefingStoreError("set requires value");
      const value = validateValue(directive.response_type, answer.value, directive.options_json, directive.variants_json);
      const serialized = canonical(value);
      if (current && canonical(JSON.parse(current.value_json)) === serialized) {
        throw new BriefingStoreError("answer is unchanged", 409, "answer_noop");
      }
      if (current) db.prepare(
        `INSERT INTO briefing_response_events
          (id, round_id, briefing_id, directive_instance_id, operation, value_json, retracts_event_id, actor_user_id, created_at)
         VALUES (?, ?, ?, ?, 'retract', NULL, ?, ?, ?)`,
      ).run(randomUUID(), roundId, briefingId, directive.id, current.id, actorUserId, now);
      const eventId = randomUUID();
      db.prepare(
        `INSERT INTO briefing_response_events
          (id, round_id, briefing_id, directive_instance_id, operation, value_json, retracts_event_id, actor_user_id, created_at)
         VALUES (?, ?, ?, ?, 'set', ?, NULL, ?, ?)`,
      ).run(eventId, roundId, briefingId, directive.id, serialized, actorUserId, now);
      answerEventIds.push(eventId);
    }
    return { answer_event_ids: answerEventIds,
      answers: validatedEffectiveAnswers(db, roundId, actorUserId)
        .map(({ value_json: _valueJson, options_json: _optionsJson, ...answer }) => answer) };
  }).immediate();
}

export function applyBriefingAnnotations(
  db: Db,
  briefingId: string,
  roundId: string,
  actorUserId: string,
  annotations: unknown,
  now = Date.now(),
) {
  if (!Array.isArray(annotations)) throw new BriefingStoreError("annotations must be an array");
  return db.transaction(() => {
    requireRoundResponder(db, briefingId, roundId, actorUserId, now);
    const source = requireValidBriefingRoundBinding(db, roundId).source;
    const ids: string[] = [];
    for (const [index, raw] of annotations.entries()) {
      const annotation = record(raw, `annotations[${index}]`);
      if (annotation.operation === "retract") {
        only(annotation, ["operation", "annotation_event_id"], `annotations[${index}]`);
        const targetId = text(annotation.annotation_event_id, "annotation.annotation_event_id");
        const target = db.prepare(
          `SELECT id FROM briefing_annotation_events e
            WHERE id = ? AND round_id = ? AND actor_user_id = ? AND operation = 'set'
              AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id)`,
        ).get(targetId, roundId, actorUserId);
        if (!target) throw new BriefingStoreError("annotation changed since it was read", 409, "stale_annotation");
        const retractionId = randomUUID();
        db.prepare(
          `INSERT INTO briefing_annotation_events
            (id, round_id, briefing_id, operation, annotation_kind, start_offset, end_offset, quote, body,
             replacement_text, retracts_event_id, actor_user_id, created_at)
           VALUES (?, ?, ?, 'retract', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        ).run(retractionId, roundId, briefingId, targetId, actorUserId, now);
        ids.push(retractionId);
        continue;
      }
      only(annotation, ["operation", "kind", "start_offset", "end_offset", "quote", "body", "replacement_text"], `annotations[${index}]`);
      if (annotation.operation !== "set") throw new BriefingStoreError("annotation.operation must be set or retract");
      const kind = annotation.kind;
      if (kind !== "comment" && kind !== "suggest_replacement") {
        throw new BriefingStoreError("annotation kind must be comment or suggest_replacement");
      }
      const start = integer(annotation.start_offset, "annotation.start_offset");
      const end = integer(annotation.end_offset, "annotation.end_offset", start + 1);
      const quote = text(annotation.quote, "annotation.quote");
      if (source.slice(start, end) !== quote) throw new BriefingStoreError("annotation quote does not match document", 400, "quote_mismatch");
      const body = annotation.body === null || annotation.body === undefined ? null : text(annotation.body, "annotation.body");
      const replacement = annotation.replacement_text === null || annotation.replacement_text === undefined
        ? null : String(annotation.replacement_text);
      if ((kind === "comment" && (!body || replacement !== null))
          || (kind === "suggest_replacement" && replacement === null)) {
        throw new BriefingStoreError("annotation payload does not match its kind");
      }
      const duplicate = db.prepare(
        `SELECT id FROM briefing_annotation_events e
          WHERE round_id = ? AND actor_user_id = ? AND operation = 'set' AND annotation_kind = ?
            AND start_offset = ? AND end_offset = ? AND quote = ? AND body IS ? AND replacement_text IS ?
            AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id)
          LIMIT 1`,
      ).get(roundId, actorUserId, kind, start, end, quote, body, replacement) as { id: string } | undefined;
      if (duplicate) throw new BriefingStoreError("annotation is unchanged", 409, "annotation_noop");
      const id = randomUUID();
      db.prepare(
        `INSERT INTO briefing_annotation_events
          (id, round_id, briefing_id, operation, annotation_kind, start_offset, end_offset, quote, body,
           replacement_text, retracts_event_id, actor_user_id, created_at)
         VALUES (?, ?, ?, 'set', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(id, roundId, briefingId, kind, start, end, quote, body, replacement, actorUserId, now);
      ids.push(id);
    }
    return { annotation_event_ids: ids, annotations: effectiveAnnotations(db, roundId, actorUserId) };
  }).immediate();
}

export function submitBriefingRound(
  db: Db,
  briefingId: string,
  roundId: string,
  actorUserId: string,
  payload: unknown,
  now = Date.now(),
) {
  const body = record(payload, "request body");
  only(body, ["answers", "annotation_event_ids", "supersedes_submission_id"], "request body");
  if (!Array.isArray(body.answers) || !Array.isArray(body.annotation_event_ids)) {
    throw new BriefingStoreError("answers and annotation_event_ids must be arrays");
  }
  const supplied = body.answers.map((raw, index) => {
    const answer = record(raw, `answers[${index}]`);
    only(answer, ["directive_key", "response_event_id"], `answers[${index}]`);
    return { directive_key: text(answer.directive_key, "answer.directive_key"),
      response_event_id: text(answer.response_event_id, "answer.response_event_id") };
  });
  if (body.annotation_event_ids.some((id) => typeof id !== "string" || !id)) {
    throw new BriefingStoreError("annotation_event_ids must contain nonblank strings");
  }
  return db.transaction(() => {
    requireRoundResponder(db, briefingId, roundId, actorUserId, now);
    requireValidBriefingRoundBinding(db, roundId);
    const current = validatedEffectiveAnswers(db, roundId, actorUserId);
    const currentKeys = current.map((answer) => `${answer.directive_key}\0${answer.response_event_id}`).sort();
    const suppliedKeys = supplied.map((answer) => `${answer.directive_key}\0${answer.response_event_id}`).sort();
    if (canonical(currentKeys) !== canonical(suppliedKeys)) {
      throw new BriefingStoreError("submitted answers must exactly match current effective answers", 409, "stale_submission_answers");
    }
    const required = db.prepare(
      `SELECT i.directive_key FROM briefing_directive_instances i JOIN briefing_directive_definitions d ON d.id = i.definition_id
        WHERE i.round_id = ? AND d.required = 1`,
    ).all(roundId) as Array<{ directive_key: string }>;
    const answered = new Set(current.map((answer) => answer.directive_key));
    const missing = required.filter((row) => !answered.has(row.directive_key)).map((row) => row.directive_key);
    if (missing.length > 0) throw new BriefingStoreError(`required directives are unanswered: ${missing.join(", ")}`, 409, "required_answers_missing");
    const currentAnnotations = effectiveAnnotations(db, roundId, actorUserId) as Array<{ annotation_event_id: string }>;
    const currentAnnotationIds = currentAnnotations.map((entry) => entry.annotation_event_id).sort();
    const suppliedAnnotationIds = [...new Set(body.annotation_event_ids as string[])].sort();
    if (canonical(currentAnnotationIds) !== canonical(suppliedAnnotationIds)) {
      throw new BriefingStoreError("submitted annotations must exactly match current effective annotations", 409, "stale_submission_annotations");
    }
    const latest = db.prepare(
      `SELECT id FROM briefing_submissions WHERE round_id = ? AND actor_user_id = ? ORDER BY ordinal DESC LIMIT 1`,
    ).get(roundId, actorUserId) as { id: string } | undefined;
    const supersedes = body.supersedes_submission_id === null || body.supersedes_submission_id === undefined
      ? null : text(body.supersedes_submission_id, "supersedes_submission_id");
    if ((latest?.id ?? null) !== supersedes) {
      throw new BriefingStoreError("supersedes_submission_id must name the actor's latest submission", 409, "stale_submission");
    }
    if (latest) {
      const priorAnswers = db.prepare(
        `SELECT a.response_event_id FROM briefing_submission_answers a WHERE a.submission_id = ? ORDER BY a.position`,
      ).all(latest.id) as Array<{ response_event_id: string }>;
      const priorAnnotations = db.prepare(
        `SELECT a.annotation_event_id FROM briefing_submission_annotations a WHERE a.submission_id = ? ORDER BY a.position`,
      ).all(latest.id) as Array<{ annotation_event_id: string }>;
      if (canonical(priorAnswers.map((entry) => entry.response_event_id).sort()) === canonical(current.map((entry) => entry.response_event_id).sort())
          && canonical(priorAnnotations.map((entry) => entry.annotation_event_id).sort()) === canonical(currentAnnotationIds)) {
        throw new BriefingStoreError("submission is unchanged", 409, "submission_noop");
      }
    }
    const ordinal = (db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM briefing_submissions WHERE round_id = ?")
      .get(roundId) as { n: number }).n;
    const submissionId = randomUUID();
    db.prepare(
      `INSERT INTO briefing_submissions
        (id, round_id, briefing_id, ordinal, supersedes_submission_id, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(submissionId, roundId, briefingId, ordinal, supersedes, actorUserId, now);
    current.forEach((answer, position) => db.prepare(
      `INSERT INTO briefing_submission_answers
        (submission_id, round_id, actor_user_id, directive_instance_id, response_event_id, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(submissionId, roundId, actorUserId, answer.directive_instance_id, answer.response_event_id, position));
    currentAnnotationIds.forEach((id, position) => db.prepare(
      `INSERT INTO briefing_submission_annotations
        (submission_id, round_id, actor_user_id, annotation_event_id, position) VALUES (?, ?, ?, ?, ?)`,
    ).run(submissionId, roundId, actorUserId, id, position));
    return { submission_id: submissionId, ordinal, supersedes_submission_id: supersedes,
      actor_user_id: actorUserId, created_at: now };
  }).immediate();
}

/** Read-only export of one actor-owned frozen v3 submission. */
export function exportBriefingSubmissionMarkdown(
  db: Db, briefingId: string, roundId: string, submissionId: string, actorUserId: string,
) {
  return db.transaction(() => {
    const round = db.prepare("SELECT profile FROM briefing_rounds WHERE id = ? AND briefing_id = ?")
      .get(roundId, briefingId) as { profile: string } | undefined;
    if (!round || round.profile !== BRIEFING_PROFILE_V3) {
      throw new BriefingStoreError("only mandible-briefing.v3 rounds can be exported", 409, "unsupported_export_profile");
    }
    const submission = db.prepare(`SELECT id FROM briefing_submissions
      WHERE id = ? AND round_id = ? AND briefing_id = ? AND actor_user_id = ?`)
      .get(submissionId, roundId, briefingId, actorUserId);
    if (!submission) throw new BriefingStoreError("submission not found for actor and round", 404, "submission_not_found");
    const verification = requireValidBriefingRoundBinding(db, roundId);
    const frozen = db.prepare(`SELECT i.directive_key, e.id AS response_event_id, e.value_json
      FROM briefing_submission_answers a
      JOIN briefing_directive_instances i ON i.id = a.directive_instance_id
      JOIN briefing_response_events e ON e.id = a.response_event_id
      WHERE a.submission_id = ? AND a.round_id = ? AND a.actor_user_id = ?`).all(submissionId, roundId, actorUserId) as
      Array<{ directive_key: string; response_event_id: string; value_json: string }>;
    const current = new Map(validatedEffectiveAnswers(db, roundId, actorUserId)
      .map((answer) => [answer.directive_key, answer.response_event_id]));
    const frozenByKey = new Map(frozen.map((answer) => [answer.directive_key, answer]));
    const replacements = verification.directives.map((directive) => {
      if (directive.type !== "text_variant") {
        return { start: directive.start_offset, end: directive.end_offset, body: directive.body };
      }
      const answer = frozenByKey.get(directive.key);
      if (!answer || current.get(directive.key) !== answer.response_event_id) {
        throw new BriefingStoreError(`text variant '${directive.key}' is unresolved or non-current`, 409, "unresolved_text_variant");
      }
      let value: { option_key?: string };
      try { value = JSON.parse(answer.value_json) as { option_key?: string }; }
      catch { throw new BriefingStoreError("stored text variant is invalid", 409, "invalid_stored_answer"); }
      const selected = directive.variants.find((variant) => variant.key === value.option_key);
      if (!selected) throw new BriefingStoreError(`text variant '${directive.key}' is unresolved`, 409, "unresolved_text_variant");
      return { start: directive.start_offset, end: directive.end_offset, body: selected.body };
    }).sort((a, b) => b.start - a.start);
    let content = verification.source;
    for (const replacement of replacements) {
      content = content.slice(0, replacement.start) + replacement.body + content.slice(replacement.end);
    }
    return { content, sha256: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex") };
  })();
}
