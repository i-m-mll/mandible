import { createHash, randomUUID } from "node:crypto";

import { readArtifactBytesFull } from "../artifact-content.js";
import type { FeedbackResponseType, FeedbackResponseValue } from "../contracts.js";
import type { Db } from "../db.js";
import {
  getCanonicalArtifactVersion,
  recordArtifactVersion,
  resolveArtifactIdentity,
} from "../provider-artifacts.js";
import { getOperatorId } from "../users/store.js";
import {
  BRIEFING_PROFILE,
  BRIEFING_PROFILE_V3,
  BriefingDirectiveError,
  parseBriefingDirectives,
  type BriefingDirective,
  type BriefingProfile,
} from "./briefing-directives.js";
import { resolveGroupDisplayComparisonBase } from "./briefing-groups.js";
import { canonicalJson } from "../canonical-json.js";
import { resolveId, shortRef } from "../entity-refs.js";
import { isEvidenceMethod, type EvidenceMethod } from "../users/types.js";

export const BRIEFING_RUN_SCHEMA = "mandible-briefing-run@1" as const;

export class BriefingStoreError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "invalid_briefing",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BriefingStoreError";
  }
}

export type BriefingRunRequest = {
  schema: typeof BRIEFING_RUN_SCHEMA;
  briefing_key: string;
  title: string;
  description?: string | null;
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

/** Briefing titles name durable material; transient review status belongs in metadata, not identity chrome. */
export function normalizeBriefingTitle(value: unknown, label = "title"): string {
  const normalized = text(value, label).replace(/\s+[—–-]\s*proposed update\s*$/iu, "").trim();
  if (!normalized) throw new BriefingStoreError(`${label} must contain a durable name`);
  return normalized;
}

export const BRIEFING_DESCRIPTION_MAX_LENGTH = 1_000;

export function normalizeBriefingDescription(value: unknown, label = "description"): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new BriefingStoreError(`${label} must be a nonblank string or null`);
  }
  const normalized = value.trim();
  if (normalized.length > BRIEFING_DESCRIPTION_MAX_LENGTH) {
    throw new BriefingStoreError(`${label} must be at most ${BRIEFING_DESCRIPTION_MAX_LENGTH} characters`);
  }
  return normalized;
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
  return createHash("sha256").update(canonicalJson(directives.map(directiveBinding))).digest("hex");
}

export function parseBriefingRunRequest(value: unknown): BriefingRunRequest {
  const body = record(value, "request body");
  only(body, ["schema", "briefing_key", "title", "description", "task_identity", "run_id", "run_key", "responder_user_ids",
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
    title: normalizeBriefingTitle(body.title),
    ...(Object.hasOwn(body, "description")
      ? { description: normalizeBriefingDescription(body.description) }
      : {}),
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
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
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
    let briefing = db.prepare(
      "SELECT id, latest_round_id, round_count, logical_artifact_id FROM briefings WHERE briefing_key = ?",
    ).get(request.briefing_key) as {
      id: string; latest_round_id: string | null; round_count: number; logical_artifact_id: string | null;
    } | undefined;
    if (!briefing) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO briefings (id, briefing_key, title, description, latest_round_id, round_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`,
      ).run(id, request.briefing_key, request.title, request.description ?? null, now, now);
      briefing = { id, latest_round_id: null, round_count: 0, logical_artifact_id: null };
    } else {
      if (request.description === undefined) {
        db.prepare("UPDATE briefings SET title = ?, updated_at = ? WHERE id = ?")
          .run(request.title, now, briefing.id);
      } else {
        db.prepare("UPDATE briefings SET title = ?, description = ?, updated_at = ? WHERE id = ?")
          .run(request.title, request.description, now, briefing.id);
      }
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
        ...(briefing.logical_artifact_id
          ? { artifact_id: briefing.logical_artifact_id }
          : { series_key: `mandible:briefing:${briefing.id}` }),
        logical_name: `${request.briefing_key}.md`,
        title: request.title,
        role: "briefing-document",
        media_type: "text/markdown",
        metadata: { profile: BRIEFING_PROFILE, briefing_id: briefing.id },
      }, now);
      artifactVersionId = artifact.artifact_version.id;
      const logicalArtifactId = logicalArtifactForVersion(db, artifactVersionId);
      if (briefing.logical_artifact_id === null) {
        db.prepare("UPDATE briefings SET logical_artifact_id = ? WHERE id = ?")
          .run(logicalArtifactId, briefing.id);
        briefing.logical_artifact_id = logicalArtifactId;
      } else if (briefing.logical_artifact_id !== logicalArtifactId) {
        throw new BriefingStoreError(
          "recurring run artifact does not belong to the Briefing logical Artifact",
          409,
          "briefing_artifact_lineage_mismatch",
        );
      }
      const directives = parseBriefingDirectives(request.document.markdown);
      const bindingDigest = roundBindingDigest(directives);
      const existingRound = db.prepare(
        `SELECT id FROM briefing_rounds
          WHERE briefing_id = ? AND artifact_version_id = ? AND profile = ?
            AND comparison_base_artifact_version_id IS NULL`,
      ).get(briefing.id, artifactVersionId, BRIEFING_PROFILE) as { id: string } | undefined;
      roundId = existingRound?.id ?? randomUUID();
      if (!existingRound) {
        db.prepare(
          `INSERT INTO briefing_rounds
            (id, briefing_id, ordinal, artifact_version_id, previous_round_id, profile, binding_digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(roundId, briefing.id, briefing.round_count + 1, artifactVersionId,
          briefing.latest_round_id, BRIEFING_PROFILE, bindingDigest, now);
      }
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
            directive.type, directive.required ? 1 : 0, directive.body, canonicalJson(directive.options),
            directive.start_offset, directive.end_offset,
            directive.body_start_offset, directive.body_end_offset, now);
        }
        const storedInstance = db.prepare(
          "SELECT id FROM briefing_directive_instances WHERE round_id = ? AND directive_key = ?",
        ).get(roundId, directive.key) as { id: string } | undefined;
        const instanceId = storedInstance?.id ?? randomUUID();
        if (!storedInstance) {
          db.prepare(
            `INSERT INTO briefing_directive_instances
              (id, round_id, briefing_id, artifact_version_id, definition_id, directive_key, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(instanceId, roundId, briefing.id, artifactVersionId, definition.id, directive.key, position, now);
        }
        instanceByKey.set(directive.key, instanceId);
      });
      const verified = verifyBriefingRoundBinding(db, roundId);
      if (!verified.valid) {
        throw new BriefingStoreError(`published round binding is invalid: ${verified.reason}`, 409, "invalid_round_binding");
      }
      if (!existingRound) {
        db.prepare(
          "UPDATE briefings SET latest_round_id = ?, round_count = round_count + 1, updated_at = ? WHERE id = ?",
        ).run(roundId, now, briefing.id);
      }
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
  briefing_key?: string; target_briefing_ref?: string; title: string; description?: unknown; artifact_version_ref: string;
  comparison_base_artifact_version_ref?: string | null;
  profile: typeof BRIEFING_PROFILE_V3; responder_user_ids: string[];
  viewer?: BriefingViewer;
  distinct_reason?: unknown;
  creation_provenance?: {
    actor_user_id: string;
    evidence_method: EvidenceMethod;
    credential_id: string | null;
  };
};

export type ArtifactBriefingCandidate = {
  briefing_id: string;
  title: string;
  archived_at: number | null;
  latest_round_id: string | null;
  matching_round_id: string | null;
  guidance: "reuse_round" | "add_round";
};

export type ExistingArtifactBriefingResult =
  | {
      outcome: "active_candidates";
      logical_artifact_id: string;
      active_candidates: ArtifactBriefingCandidate[];
      archived_candidates: ArtifactBriefingCandidate[];
    }
  | (BriefingRunReceipt & {
      outcome: "created" | "created_distinct" | "round_added" | "round_reused";
      logical_artifact_id: string;
      active_candidates: ArtifactBriefingCandidate[];
      archived_candidates: ArtifactBriefingCandidate[];
      override_receipt_id: string | null;
    });

function resolveExactArtifactVersion(db: Db, ref: string, field: string): string {
  const resolved = resolveArtifactIdentity(db, ref, "strict-read");
  if (resolved.status !== "resolved" || resolved.target_type !== "artifact_version" || !resolved.target_id) {
    throw new BriefingStoreError(`${field} must resolve to one exact artifact version`, 404, "artifact_version_not_found");
  }
  return resolved.target_id;
}

function logicalArtifactForVersion(db: Db, versionId: string): string {
  const row = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?")
    .get(versionId) as { artifact_id: string } | undefined;
  if (!row) throw new BriefingStoreError("artifact version has no logical Artifact", 409, "artifact_lineage_unavailable");
  return row.artifact_id;
}

function artifactBriefingCandidates(
  db: Db,
  logicalArtifactId: string,
  versionId: string,
  profile: string,
  comparisonBaseVersionId: string | null,
): { active: ArtifactBriefingCandidate[]; archived: ArtifactBriefingCandidate[] } {
  const rows = db.prepare(
    `SELECT b.id AS briefing_id, b.title, b.archived_at, b.latest_round_id,
            (SELECT r.id FROM briefing_rounds r
              WHERE r.briefing_id = b.id AND r.artifact_version_id = ? AND r.profile = ?
                AND r.comparison_base_artifact_version_id IS ?
              ORDER BY r.ordinal LIMIT 1) AS matching_round_id
       FROM briefings b
      WHERE b.logical_artifact_id = ?
      ORDER BY b.created_at, b.id`,
  ).all(versionId, profile, comparisonBaseVersionId, logicalArtifactId) as Array<{
    briefing_id: string; title: string; archived_at: number | null;
    latest_round_id: string | null; matching_round_id: string | null;
  }>;
  const candidates = rows.map((row): ArtifactBriefingCandidate => ({
    ...row,
    guidance: row.matching_round_id ? "reuse_round" : "add_round",
  }));
  return {
    active: candidates.filter((candidate) => candidate.archived_at === null),
    archived: candidates.filter((candidate) => candidate.archived_at !== null),
  };
}

function validateCreationProvenance(
  db: Db,
  provenance: ExistingArtifactBriefingRequest["creation_provenance"],
): NonNullable<ExistingArtifactBriefingRequest["creation_provenance"]> {
  if (!provenance || !isEvidenceMethod(provenance.evidence_method)) {
    throw new BriefingStoreError(
      "distinct creation requires authenticated provenance",
      400,
      "briefing_distinct_provenance_required",
    );
  }
  const actor = db.prepare("SELECT status FROM users WHERE id = ?").get(provenance.actor_user_id) as
    | { status: string }
    | undefined;
  if (!actor || actor.status !== "active") {
    throw new BriefingStoreError(
      "distinct creation actor must be active",
      400,
      "briefing_distinct_actor_invalid",
    );
  }
  if (provenance.credential_id) {
    const credential = db.prepare(
      "SELECT user_id, status FROM user_credentials WHERE id = ?",
    ).get(provenance.credential_id) as { user_id: string; status: string } | undefined;
    if (!credential || credential.user_id !== provenance.actor_user_id || credential.status !== "active") {
      throw new BriefingStoreError(
        "distinct creation credential must be active and owned by the actor",
        400,
        "briefing_distinct_credential_invalid",
      );
    }
  }
  return provenance;
}

/** Bind an existing exact artifact version; this path never records or copies artifact bytes. */
export function publishBriefingFromArtifactVersion(
  db: Db, request: ExistingArtifactBriefingRequest, now = Date.now(),
): ExistingArtifactBriefingResult {
  if (request.profile !== BRIEFING_PROFILE_V3) throw new BriefingStoreError("existing artifact publication requires mandible-briefing.v3");
  const title = normalizeBriefingTitle(request.title);
  const descriptionProvided = Object.hasOwn(request, "description");
  const description = normalizeBriefingDescription(request.description);
  const versionId = resolveExactArtifactVersion(db, request.artifact_version_ref, "artifact_version_ref");
  const comparisonBaseVersionId = request.comparison_base_artifact_version_ref
    ? resolveExactArtifactVersion(db, request.comparison_base_artifact_version_ref, "comparison_base_artifact_version_ref")
    : null;
  const logicalArtifactId = logicalArtifactForVersion(db, versionId);
  if (comparisonBaseVersionId && logicalArtifactForVersion(db, comparisonBaseVersionId) !== logicalArtifactId) {
    throw new BriefingStoreError(
      "comparison base must belong to the Briefing logical Artifact",
      409,
      "briefing_comparison_lineage_mismatch",
    );
  }
  const document = pinnedRoundDocument(db, versionId);
  if (comparisonBaseVersionId) pinnedRoundDocument(db, comparisonBaseVersionId);
  let directives: BriefingDirective[];
  try { directives = parseBriefingDirectives(document.source, request.profile, { allowEmpty: true }); }
  catch (error) { throw new BriefingStoreError(error instanceof Error ? error.message : String(error), 400, "invalid_briefing_document"); }
  for (const responder of request.responder_user_ids) {
    const user = db.prepare("SELECT kind, status FROM users WHERE id = ?").get(responder) as { kind: string; status: string } | undefined;
    if (!user || user.kind !== "human" || user.status !== "active") throw new BriefingStoreError(`responder '${responder}' is not an active human`);
  }
  return db.transaction((): ExistingArtifactBriefingResult => {
    const candidates = artifactBriefingCandidates(
      db,
      logicalArtifactId,
      versionId,
      request.profile,
      comparisonBaseVersionId,
    );
    const requestedKey = request.briefing_key === undefined ? null : text(request.briefing_key, "briefing_key");
    if (requestedKey && request.target_briefing_ref) {
      throw new BriefingStoreError("briefing_key and target_briefing_ref are mutually exclusive");
    }
    type BriefingIdentityRow = {
      id: string; latest_round_id: string | null; round_count: number; logical_artifact_id: string | null;
    };
    let briefing: BriefingIdentityRow | undefined;
    if (requestedKey) {
      briefing = db.prepare(
        "SELECT id, latest_round_id, round_count, logical_artifact_id FROM briefings WHERE briefing_key = ?",
      ).get(requestedKey) as BriefingIdentityRow | undefined;
    } else if (request.target_briefing_ref) {
      if (!request.viewer) throw new BriefingStoreError("target_briefing_ref requires a viewer");
      const targetId = resolveBriefingId(db, request.target_briefing_ref, request.viewer);
      briefing = db.prepare(
        "SELECT id, latest_round_id, round_count, logical_artifact_id FROM briefings WHERE id = ?",
      ).get(targetId) as BriefingIdentityRow | undefined;
    }
    if (briefing && db.prepare(`SELECT 1
        FROM briefing_destination_routes route
        JOIN briefing_destination_policies policy ON policy.route_key = route.route_key
       WHERE route.logical_artifact_id = ? AND policy.publication_mode = 'published-report'
       LIMIT 1`).get(briefing.logical_artifact_id)) {
      throw new BriefingStoreError(
        "governed published-report Briefings can only advance through composition publication",
        409,
        "briefing_report_publication_required",
      );
    }
    let outcome: "created" | "created_distinct" | "round_added" | "round_reused";
    let overrideReceiptId: string | null = null;
    if (!briefing) {
      const distinctReason = request.distinct_reason === undefined
        ? null
        : text(request.distinct_reason, "distinct_reason");
      if (candidates.active.length > 0 && !distinctReason) {
        return {
          outcome: "active_candidates",
          logical_artifact_id: logicalArtifactId,
          active_candidates: candidates.active,
          archived_candidates: candidates.archived,
        };
      }
      if (candidates.active.length === 0 && distinctReason) {
        throw new BriefingStoreError(
          "distinct_reason is only valid when active candidates block default creation",
          400,
          "briefing_distinct_reason_unnecessary",
        );
      }
      const id = randomUUID();
      db.prepare(`INSERT INTO briefings
        (id, briefing_key, logical_artifact_id, title, description, latest_round_id, round_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`).run(
        id,
        requestedKey ?? `manual:${id}`,
        logicalArtifactId,
        title,
        description,
        now,
        now,
      );
      briefing = { id, latest_round_id: null, round_count: 0, logical_artifact_id: logicalArtifactId };
      if (distinctReason) {
        const provenance = validateCreationProvenance(db, request.creation_provenance);
        overrideReceiptId = randomUUID();
        db.prepare(`INSERT INTO briefing_creation_overrides
          (id, briefing_id, logical_artifact_id, reason, actor_user_id, evidence_method, credential_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          overrideReceiptId,
          id,
          logicalArtifactId,
          distinctReason,
          provenance.actor_user_id,
          provenance.evidence_method,
          provenance.credential_id,
          now,
        );
        outcome = "created_distinct";
      } else {
        outcome = "created";
      }
    } else {
      if (briefing.logical_artifact_id === null && briefing.round_count === 0) {
        db.prepare("UPDATE briefings SET logical_artifact_id = ? WHERE id = ?")
          .run(logicalArtifactId, briefing.id);
        briefing.logical_artifact_id = logicalArtifactId;
      }
      if (briefing.logical_artifact_id !== logicalArtifactId) {
        throw new BriefingStoreError(
          "artifact version does not belong to the Briefing logical Artifact",
          409,
          "briefing_artifact_lineage_mismatch",
        );
      }
      if (request.distinct_reason !== undefined) {
        throw new BriefingStoreError(
          "distinct_reason cannot be used when adding a round to an existing Briefing",
          400,
          "briefing_distinct_reason_with_target",
        );
      }
      outcome = "round_added";
    }
    for (const responder of request.responder_user_ids) db.prepare(
      "INSERT OR IGNORE INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)",
    ).run(briefing.id, responder, now);
    const existing = db.prepare(`SELECT id FROM briefing_rounds
      WHERE briefing_id = ? AND artifact_version_id = ? AND profile = ?
        AND comparison_base_artifact_version_id IS ?`)
      .get(briefing.id, versionId, request.profile, comparisonBaseVersionId) as { id: string } | undefined;
    if (existing) {
      const replayVerification = verifyBriefingRoundBinding(db, existing.id);
      if (!replayVerification.valid) throw new BriefingStoreError(`stored round binding is invalid: ${replayVerification.reason}`, 409, "invalid_round_binding");
      return { receipt_id: existing.id, briefing_id: briefing.id, run_id: `artifact:${versionId}`,
        round_id: existing.id, artifact_version_id: versionId, quiet: false,
        outcome: "round_reused", logical_artifact_id: logicalArtifactId,
        active_candidates: candidates.active, archived_candidates: candidates.archived,
        override_receipt_id: overrideReceiptId };
    }
    const roundId = randomUUID();
    db.prepare(`INSERT INTO briefing_rounds
      (id, briefing_id, ordinal, artifact_version_id, comparison_base_artifact_version_id,
       previous_round_id, profile, binding_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(roundId, briefing.id, briefing.round_count + 1, versionId,
      comparisonBaseVersionId, briefing.latest_round_id, request.profile, roundBindingDigest(directives), now);
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
          canonicalJson(directive.options), canonicalJson(directive.variants), directive.start_offset, directive.end_offset,
          directive.body_start_offset, directive.body_end_offset, now);
      }
      db.prepare(`INSERT INTO briefing_directive_instances
        (id, round_id, briefing_id, artifact_version_id, definition_id, directive_key, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), roundId, briefing.id, versionId, definition.id, directive.key, position, now);
    });
    const verified = verifyBriefingRoundBinding(db, roundId);
    if (!verified.valid) throw new BriefingStoreError(`published round binding is invalid: ${verified.reason}`, 409, "invalid_round_binding");
    if (descriptionProvided) {
      db.prepare("UPDATE briefings SET title = ?, description = ?, latest_round_id = ?, round_count = round_count + 1, updated_at = ? WHERE id = ?")
        .run(title, description, roundId, now, briefing.id);
    } else {
      db.prepare("UPDATE briefings SET title = ?, latest_round_id = ?, round_count = round_count + 1, updated_at = ? WHERE id = ?")
        .run(title, roundId, now, briefing.id);
    }
    return { receipt_id: roundId, briefing_id: briefing.id, run_id: `artifact:${versionId}`,
      round_id: roundId, artifact_version_id: versionId, quiet: false,
      outcome, logical_artifact_id: logicalArtifactId,
      active_candidates: candidates.active, archived_candidates: candidates.archived,
      override_receipt_id: overrideReceiptId };
  }).immediate();
}

export type BriefingReportRoundResult = {
  briefing_id: string;
  round_id: string;
  artifact_version_id: string;
  previous_round_id: string;
  previous_artifact_version_id: string;
};

/** Append one published-report round and advance Current only from the exact producer-observed round and version. */
export function publishBriefingReportRound(db: Db, input: {
  briefing_id: string;
  artifact_version_ref: string;
  expected_current_round_id: string;
  expected_current_artifact_version_ref: string;
  responder_user_ids: readonly string[];
}, now = Date.now()): BriefingReportRoundResult {
  const versionId = resolveExactArtifactVersion(db, input.artifact_version_ref, "artifact_version_ref");
  const expectedVersionId = resolveExactArtifactVersion(
    db, input.expected_current_artifact_version_ref, "expected_current_artifact_version_ref",
  );
  const logicalArtifactId = logicalArtifactForVersion(db, versionId);
  if (logicalArtifactForVersion(db, expectedVersionId) !== logicalArtifactId) {
    throw new BriefingStoreError("published report version is outside the destination lineage", 409,
      "briefing_report_lineage_mismatch");
  }
  const document = pinnedRoundDocument(db, versionId);
  let directives: BriefingDirective[];
  try { directives = parseBriefingDirectives(document.source, BRIEFING_PROFILE_V3, { allowEmpty: true }); }
  catch (error) { throw new BriefingStoreError(error instanceof Error ? error.message : String(error), 400,
    "invalid_briefing_document"); }
  for (const responder of input.responder_user_ids) {
    const user = db.prepare("SELECT kind, status FROM users WHERE id = ?").get(responder) as
      { kind: string; status: string } | undefined;
    if (!user || user.kind !== "human" || user.status !== "active") {
      throw new BriefingStoreError(`responder '${responder}' is not an active human`);
    }
  }
  return db.transaction(() => {
    const briefing = db.prepare(`SELECT id, logical_artifact_id, latest_round_id, round_count
      FROM briefings WHERE id = ? AND archived_at IS NULL`).get(input.briefing_id) as {
        id: string; logical_artifact_id: string | null; latest_round_id: string | null; round_count: number;
      } | undefined;
    if (!briefing || briefing.logical_artifact_id !== logicalArtifactId || !briefing.latest_round_id) {
      throw new BriefingStoreError("published report destination Briefing is unavailable", 409,
        "briefing_report_destination_unavailable");
    }
    const current = db.prepare("SELECT artifact_version_id FROM briefing_rounds WHERE id = ? AND briefing_id = ?")
      .get(briefing.latest_round_id, briefing.id) as { artifact_version_id: string } | undefined;
    if (briefing.latest_round_id !== input.expected_current_round_id
        || !current || current.artifact_version_id !== expectedVersionId) {
      throw new BriefingStoreError("published report Current changed after the producer observed it", 409,
        "briefing_destination_current_drift", {
          expected_current_round_id: input.expected_current_round_id,
          current_round_id: briefing.latest_round_id,
          expected_current_artifact_version_id: expectedVersionId,
          current_artifact_version_id: current?.artifact_version_id ?? null,
        });
    }
    for (const responder of input.responder_user_ids) db.prepare(
      "INSERT OR IGNORE INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)",
    ).run(briefing.id, responder, now);
    const roundId = randomUUID();
    db.prepare(`INSERT INTO briefing_rounds
      (id, briefing_id, ordinal, artifact_version_id, comparison_base_artifact_version_id,
       previous_round_id, profile, binding_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(roundId, briefing.id, briefing.round_count + 1, versionId,
      expectedVersionId, briefing.latest_round_id, BRIEFING_PROFILE_V3, roundBindingDigest(directives), now);
    directives.forEach((directive, position) => {
      let definition = db.prepare(`SELECT id FROM briefing_directive_definitions
        WHERE artifact_version_id = ? AND directive_key = ? AND definition_digest = ?`)
        .get(versionId, directive.key, directive.definition_digest) as { id: string } | undefined;
      if (!definition) {
        definition = { id: randomUUID() };
        db.prepare(`INSERT INTO briefing_directive_definitions
          (id, artifact_version_id, directive_key, definition_digest, response_type, required, prompt,
           options_json, variants_json, start_offset, end_offset, body_start_offset, body_end_offset, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(definition.id, versionId, directive.key,
          directive.definition_digest, directive.type, directive.required ? 1 : 0, directive.body,
          canonicalJson(directive.options), canonicalJson(directive.variants), directive.start_offset,
          directive.end_offset, directive.body_start_offset, directive.body_end_offset, now);
      }
      db.prepare(`INSERT INTO briefing_directive_instances
        (id, round_id, briefing_id, artifact_version_id, definition_id, directive_key, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), roundId, briefing.id, versionId,
        definition.id, directive.key, position, now);
    });
    const updated = db.prepare(`UPDATE briefings SET latest_round_id = ?, round_count = round_count + 1,
      updated_at = ? WHERE id = ? AND latest_round_id = ? AND round_count = ?`)
      .run(roundId, now, briefing.id, briefing.latest_round_id, briefing.round_count);
    if (updated.changes !== 1) throw new BriefingStoreError(
      "published report Current changed during publication", 409, "briefing_destination_current_drift");
    const verified = verifyBriefingRoundBinding(db, roundId);
    if (!verified.valid) throw new BriefingStoreError(`published round binding is invalid: ${verified.reason}`,
      409, "invalid_round_binding");
    return { briefing_id: briefing.id, round_id: roundId, artifact_version_id: versionId,
      previous_round_id: briefing.latest_round_id, previous_artifact_version_id: expectedVersionId };
  }).immediate();
}

export function briefingMemberAllows(db: Db, briefingId: string, actorUserId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM briefing_members WHERE briefing_id = ? AND user_id = ?")
    .get(briefingId, actorUserId));
}

/**
 * A Briefing is listable only while its latest round exists. A recurring feed
 * whose runs have all been quiet, or a row whose v1 rounds were retired to
 * legacy custody (migration 143), has no round to show, so every listing
 * projection excludes it. Queries alias the Briefing row as `b`.
 */
export const BRIEFING_HAS_ROUND_SQL = `EXISTS (
  SELECT 1 FROM briefing_rounds listed_round
   WHERE listed_round.id = b.latest_round_id AND listed_round.briefing_id = b.id
)`;

export function listBriefings(db: Db, viewer: { userId: string; operator: boolean }) {
  return db.prepare(
    `SELECT b.id, b.briefing_key, b.logical_artifact_id, b.title, b.description,
            b.latest_round_id, b.round_count, b.archived_at,
            (SELECT MIN(policy.publication_mode)
               FROM briefing_destination_routes route
               JOIN briefing_destination_policies policy ON policy.route_key = route.route_key
              WHERE route.logical_artifact_id = b.logical_artifact_id) AS publication_mode,
            b.created_at, b.updated_at,
            CASE WHEN EXISTS (
              SELECT 1 FROM users actor
               WHERE actor.id = ? AND actor.kind = 'human' AND actor.status = 'active'
            ) THEN (SELECT COUNT(*)
               FROM briefing_directive_instances i
              WHERE i.round_id = b.latest_round_id
                AND NOT EXISTS (
                  SELECT 1
                    FROM briefing_response_events e
                   WHERE e.directive_instance_id = i.id
                     AND e.round_id = i.round_id
                     AND e.actor_user_id = ?
                     AND e.operation = 'set'
                     AND NOT EXISTS (
                       SELECT 1 FROM briefing_response_events r WHERE r.retracts_event_id = e.id
                     )
                )) ELSE 0 END AS unanswered_directive_count
       FROM briefings b
      WHERE b.archived_at IS NULL AND ${BRIEFING_HAS_ROUND_SQL} AND (? = 1 OR EXISTS (
        SELECT 1 FROM briefing_members m WHERE m.briefing_id = b.id AND m.user_id = ?
      ))
      ORDER BY b.updated_at DESC, b.id`,
  ).all(viewer.userId, viewer.userId, viewer.operator ? 1 : 0, viewer.userId);
}

export type BriefingViewer = { userId: string; operator: boolean };

/**
 * Resolve a Briefing reference to any stored row the viewer may see, listed or
 * not, so organization routes (archive, restore, rename) reach every row a list
 * can return. A leading `briefing:` is the typed-ref prefix; legacy rows also
 * store it in their id, and the shared resolver matches both spellings.
 */
export function resolveBriefingId(db: Db, briefingRef: string, viewer: BriefingViewer): string {
  const key = bareBriefingId(briefingRef.trim());
  if (!key) throw new BriefingStoreError("Briefing reference must be nonblank");
  const resolved = resolveId(db, "briefing", key);
  if (!resolved.ok) {
    throw resolved.error === "ambiguous"
      ? new BriefingStoreError("Briefing reference is ambiguous", 409, "ambiguous_ref")
      : new BriefingStoreError("briefing not found", 404, "not_found");
  }
  const visible = viewer.operator || db.prepare(
    "SELECT 1 FROM briefing_members WHERE briefing_id = ? AND user_id = ?",
  ).get(resolved.id, viewer.userId) !== undefined;
  if (!visible) throw new BriefingStoreError("briefing not found", 404, "not_found");
  return resolved.id;
}

function bareBriefingId(id: string): string {
  return id.startsWith("briefing:") ? id.slice("briefing:".length) : id;
}

/** The shortest `briefing:<target>` reference that resolves to this Briefing. */
export function shortBriefingRef(db: Db, briefingId: string): string {
  return `briefing:${shortRef(db, "briefing", briefingId, { key: bareBriefingId(briefingId) })}`;
}

export function updateBriefingTitle(
  db: Db,
  briefingRef: string,
  title: unknown,
  viewer: BriefingViewer,
) {
  const normalized = normalizeBriefingTitle(title);
  const briefingId = resolveBriefingId(db, briefingRef, viewer);
  const briefing = db.prepare("SELECT id, title FROM briefings WHERE id = ?")
    .get(briefingId) as { id: string; title: string } | undefined;
  if (!briefing) throw new BriefingStoreError("briefing not found", 404, "not_found");
  if (briefing.title !== normalized) {
    db.prepare("UPDATE briefings SET title = ? WHERE id = ?").run(normalized, briefing.id);
  }
  return { briefing_id: briefing.id, title: normalized, changed: briefing.title !== normalized };
}

export function updateBriefingDescription(
  db: Db,
  briefingRef: string,
  description: unknown,
  viewer: BriefingViewer,
  now = Date.now(),
) {
  const normalized = normalizeBriefingDescription(description);
  const briefingId = resolveBriefingId(db, briefingRef, viewer);
  const briefing = db.prepare("SELECT id, description FROM briefings WHERE id = ?")
    .get(briefingId) as { id: string; description: string | null } | undefined;
  if (!briefing) throw new BriefingStoreError("briefing not found", 404, "not_found");
  const changed = briefing.description !== normalized;
  if (changed) {
    db.prepare("UPDATE briefings SET description = ?, updated_at = ? WHERE id = ?")
      .run(normalized, now, briefing.id);
  }
  return { briefing_id: briefing.id, description: normalized, changed };
}

export function setBriefingArchived(
  db: Db,
  briefingRef: string,
  archived: boolean,
  viewer: BriefingViewer,
  now = Date.now(),
) {
  const briefingId = resolveBriefingId(db, briefingRef, viewer);
  const briefing = db.prepare("SELECT archived_at FROM briefings WHERE id = ?")
    .get(briefingId) as { archived_at: number | null } | undefined;
  if (!briefing) throw new BriefingStoreError("briefing not found", 404, "not_found");
  const changed = archived ? briefing.archived_at === null : briefing.archived_at !== null;
  if (changed) db.prepare("UPDATE briefings SET archived_at = ? WHERE id = ?")
    .run(archived ? now : null, briefingId);
  return { briefing_id: briefingId, archived_at: archived ? (briefing.archived_at ?? now) : null, changed };
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
    directives = parseBriefingDirectives(document.source, round.profile as BriefingProfile, { allowEmpty: true });
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
        || canonicalJson(stored) !== canonicalJson(expected)) {
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
    if (canonicalJson(value) !== answer.value_json) {
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
  options: {
    roundId?: string;
    submissionId?: string;
    actorUserId: string;
    operator: boolean;
    displayGroup?: { groupRef: string; proposalBundleRef: string | null };
  },
) {
  const briefing = db.prepare(
    `SELECT b.id, b.briefing_key, b.logical_artifact_id, b.title, b.description, b.latest_round_id,
            b.round_count, b.archived_at, b.created_at, b.updated_at,
            (SELECT MIN(policy.publication_mode)
               FROM briefing_destination_routes route
               JOIN briefing_destination_policies policy ON policy.route_key = route.route_key
              WHERE route.logical_artifact_id = b.logical_artifact_id) AS publication_mode
       FROM briefings b WHERE b.id = ?`,
  ).get(briefingId) as Record<string, unknown> | undefined;
  if (!briefing || (!options.operator && !briefingMemberAllows(db, briefingId, options.actorUserId))) return null;
  const roundRows = db.prepare(
    `SELECT r.id, r.ordinal, r.artifact_version_id, r.comparison_base_artifact_version_id,
            r.previous_round_id, r.profile,
            r.binding_digest, r.created_at,
            COALESCE((SELECT json_extract(run.source_health_json, '$.source')
               FROM briefing_runs run WHERE run.round_id = r.id LIMIT 1),
              (SELECT composition.source_key FROM briefing_composition_report_publications publication
               JOIN briefing_composition_runs composition ON composition.id = publication.run_id
               WHERE publication.current_round_id = r.id LIMIT 1)) AS origin_source,
            COALESCE((SELECT run.run_id FROM briefing_runs run WHERE run.round_id = r.id LIMIT 1),
              (SELECT composition.run_id FROM briefing_composition_report_publications publication
               JOIN briefing_composition_runs composition ON composition.id = publication.run_id
               WHERE publication.current_round_id = r.id LIMIT 1)) AS origin_run_id,
            COALESCE((SELECT run.task_identity FROM briefing_runs run WHERE run.round_id = r.id LIMIT 1),
              (SELECT composition.task_identity FROM briefing_composition_report_publications publication
               JOIN briefing_composition_runs composition ON composition.id = publication.run_id
               WHERE publication.current_round_id = r.id LIMIT 1)) AS origin_task_identity
       FROM briefing_rounds r WHERE r.briefing_id = ? ORDER BY r.ordinal DESC`,
  ).all(briefingId) as Array<{
    id: string; ordinal: number; artifact_version_id: string; comparison_base_artifact_version_id: string | null;
    previous_round_id: string | null;
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
  let originalComparisonBase: { artifact_version_id: string; content_hash: string; source: string } | null = null;
  if (selected.comparison_base_artifact_version_id) {
    const base = pinnedRoundDocument(db, selected.comparison_base_artifact_version_id);
    originalComparisonBase = { artifact_version_id: selected.comparison_base_artifact_version_id, ...base };
  }
  let comparisonBase = originalComparisonBase;
  if (options.displayGroup) {
    const displayBaseId = resolveGroupDisplayComparisonBase(db, {
      groupRef: options.displayGroup.groupRef,
      proposalBundleRef: options.displayGroup.proposalBundleRef,
      briefingId,
      artifactVersionId: selected.artifact_version_id,
    });
    comparisonBase = displayBaseId === null ? null : {
      artifact_version_id: displayBaseId,
      ...pinnedRoundDocument(db, displayBaseId),
    };
  }
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
  const submissionOverlays = db.prepare(
    `SELECT s.id, s.ordinal, s.supersedes_submission_id, s.actor_user_id, s.created_at,
            u.slug AS actor_slug, u.display_name AS actor_display_name,
            (SELECT COUNT(*) FROM briefing_submission_answers a WHERE a.submission_id = s.id) AS answer_count,
            (SELECT COUNT(*) FROM briefing_submission_annotations a WHERE a.submission_id = s.id) AS annotation_count
       FROM briefing_submissions s
       JOIN users u ON u.id = s.actor_user_id
      WHERE s.round_id = ? AND s.briefing_id = ?
      ORDER BY s.created_at DESC, s.ordinal DESC, s.id`,
  ).all(selected.id, briefingId) as Array<{
    id: string; ordinal: number; supersedes_submission_id: string | null; actor_user_id: string; created_at: number;
    actor_slug: string; actor_display_name: string | null; answer_count: number; annotation_count: number;
  }>;
  let selectedSubmissionOverlay: null | Record<string, unknown> = null;
  if (options.submissionId) {
    const summary = submissionOverlays.find((submission) => submission.id === options.submissionId);
    if (!summary) {
      throw new BriefingStoreError(
        "submission overlay not found for selected round",
        404,
        "submission_overlay_not_found",
      );
    }
    const frozenAnswers = db.prepare(
      `SELECT a.directive_instance_id, a.response_event_id, i.directive_key,
              e.value_json, e.created_at, d.response_type, d.options_json, d.variants_json
         FROM briefing_submission_answers a
         JOIN briefing_directive_instances i ON i.id = a.directive_instance_id
         JOIN briefing_directive_definitions d ON d.id = i.definition_id
         JOIN briefing_response_events e ON e.id = a.response_event_id
        WHERE a.submission_id = ? AND a.round_id = ? AND a.actor_user_id = ?
        ORDER BY a.position`,
    ).all(summary.id, selected.id, summary.actor_user_id) as Array<{
      directive_instance_id: string; response_event_id: string; directive_key: string; value_json: string;
      created_at: number; response_type: FeedbackResponseType; options_json: string; variants_json: string;
    }>;
    const answers = frozenAnswers.map(({ value_json, response_type, options_json, variants_json, ...answer }) => ({
      ...answer,
      value: validateValue(response_type, JSON.parse(value_json), options_json, variants_json),
    }));
    const annotations = db.prepare(
      `SELECT e.id AS annotation_event_id, e.annotation_kind, e.start_offset, e.end_offset,
              e.quote, e.body, e.replacement_text, e.created_at
         FROM briefing_submission_annotations a
         JOIN briefing_annotation_events e ON e.id = a.annotation_event_id
        WHERE a.submission_id = ? AND a.round_id = ? AND a.actor_user_id = ?
        ORDER BY a.position`,
    ).all(summary.id, selected.id, summary.actor_user_id);
    selectedSubmissionOverlay = {
      id: summary.id,
      ordinal: summary.ordinal,
      supersedes_submission_id: summary.supersedes_submission_id,
      actor_user_id: summary.actor_user_id,
      actor: { slug: summary.actor_slug, display_name: summary.actor_display_name },
      created_at: summary.created_at,
      answer_count: summary.answer_count,
      annotation_count: summary.annotation_count,
      answers,
      annotations,
    };
  }
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
        previous_round_id: selected.previous_round_id, profile: selected.profile, source: verification.source,
        comparison_base: comparisonBase,
        original_comparison_base: originalComparisonBase },
      binding: projectionValid ? { status: "valid" as const } : {
        status: "invalid" as const, reason: projectionError ?? (verification.valid ? "invalid projection" : verification.reason),
      },
      items: projectedItems,
      answers: projectionValid ? projectedAnswers.map(({ value_json: _valueJson, options_json: _optionsJson,
        variants_json: _variantsJson, ...answer }) => answer) : [],
      annotations: projectionValid ? effectiveAnnotations(db, selected.id, options.actorUserId) : [],
      latest_submission: projectionValid ? latestSubmission ?? null : null,
      latest_frozen_membership: projectionValid ? latestFrozenMembership : null,
      submission_overlays: projectionValid ? submissionOverlays.map((submission) => ({
        id: submission.id,
        ordinal: submission.ordinal,
        supersedes_submission_id: submission.supersedes_submission_id,
        actor_user_id: submission.actor_user_id,
        actor: { slug: submission.actor_slug, display_name: submission.actor_display_name },
        created_at: submission.created_at,
        answer_count: submission.answer_count,
        annotation_count: submission.annotation_count,
      })) : [],
      selected_submission_overlay: projectionValid ? selectedSubmissionOverlay : null,
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
        if (canonicalJson(validateValue(directive.response_type, parsed, directive.options_json, directive.variants_json)) !== current.value_json) {
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
      const serialized = canonicalJson(value);
      if (current && canonicalJson(JSON.parse(current.value_json)) === serialized) {
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
    if (canonicalJson(currentKeys) !== canonicalJson(suppliedKeys)) {
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
    if (canonicalJson(currentAnnotationIds) !== canonicalJson(suppliedAnnotationIds)) {
      throw new BriefingStoreError("submitted annotations must exactly match current effective annotations", 409, "stale_submission_annotations");
    }
    if (current.length === 0 && currentAnnotationIds.length === 0) {
      throw new BriefingStoreError("submission must contain at least one answer or annotation", 409, "submission_empty");
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
      if (canonicalJson(priorAnswers.map((entry) => entry.response_event_id).sort()) === canonicalJson(current.map((entry) => entry.response_event_id).sort())
          && canonicalJson(priorAnnotations.map((entry) => entry.annotation_event_id).sort()) === canonicalJson(currentAnnotationIds)) {
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
  }).deferred();
}
