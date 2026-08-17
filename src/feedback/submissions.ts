import { createHash } from "node:crypto";

import type { FeedbackResponseType, FeedbackResponseValue } from "../contracts.js";
import type { Db } from "../db.js";
import { readArtifactBytesFull } from "../artifact-content.js";
import { evaluateGlobalCapability } from "../permissions/store.js";
import { getCanonicalArtifactVersion } from "../provider-artifacts.js";
import { AskStoreError } from "./asks.js";

export interface SubmissionViewer {
  userId: string;
  isOperator: boolean;
}

export interface FeedbackSubmissionRow {
  id: string;
  collection_id: string;
  ordinal: number;
  supersedes_submission_id: string | null;
  lifecycle_event_id: string;
  actor_user_id: string;
  created_at: number;
}

export type SubmissionResolution =
  | { ok: true; submission: FeedbackSubmissionRow; ask_id: string }
  | { ok: false; error: "not_found" | "ambiguous" };

const ASK_ORDINAL_REF = /^submission:([0-9a-f][0-9a-f-]{6,})#([1-9][0-9]*)$/i;
const DIRECT_REF = /^submission:([0-9a-f][0-9a-f-]{6,})$/i;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function escapedLikePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function authorizedWhere(db: Db, viewer: SubmissionViewer): { sql: string; params: string[] } {
  if (viewer.isOperator) return { sql: "1 = 1", params: [] };
  const user = db.prepare("SELECT id, slug, kind, status FROM users WHERE id = ?").get(viewer.userId) as
    | { id: string; slug: string; kind: string; status: string }
    | undefined;
  if (!user || user.status !== "active") return { sql: "0 = 1", params: [] };
  if (user.kind === "human") {
    return {
      sql: "EXISTS (SELECT 1 FROM json_each(a.responder_user_ids_json) audience WHERE audience.value = ?)",
      params: [viewer.userId],
    };
  }
  if (user.kind === "agent") {
    const decision = evaluateGlobalCapability(db, {
      identity: {
        user_id: user.id,
        slug: user.slug,
        method: "api_token",
        credential_id: null,
        source: "in_process",
      },
      capability: "ask.create",
    });
    if (decision.allowed && decision.reason !== "operator_implicit_admin") {
      return { sql: "a.requester_user_id = ?", params: [viewer.userId] };
    }
  }
  return { sql: "0 = 1", params: [] };
}

export function resolveSubmissionRef(
  db: Db,
  ref: string,
  viewer: SubmissionViewer,
): SubmissionResolution {
  const canonical = ASK_ORDINAL_REF.exec(ref.trim());
  const direct = canonical ? null : DIRECT_REF.exec(ref.trim());
  if (!canonical && !direct) return { ok: false, error: "not_found" };
  const authorized = authorizedWhere(db, viewer);
  const rows = canonical
    ? db.prepare(
      `SELECT s.id, s.collection_id, s.ordinal, s.supersedes_submission_id,
              s.lifecycle_event_id, s.actor_user_id, s.created_at
         FROM feedback_submissions s
         JOIN feedback_ask_sessions a ON a.collection_id = s.collection_id
         JOIN feedback_collections c ON c.id = a.collection_id AND c.kind = 'bounded_ask'
        WHERE s.collection_id LIKE ? ESCAPE '\\'
          AND s.ordinal = ? AND ${authorized.sql}
        ORDER BY s.collection_id, s.id
        LIMIT 2`,
    ).all(escapedLikePrefix(canonical[1]), Number(canonical[2]), ...authorized.params)
    : db.prepare(
      `SELECT s.id, s.collection_id, s.ordinal, s.supersedes_submission_id,
              s.lifecycle_event_id, s.actor_user_id, s.created_at
         FROM feedback_submissions s
         JOIN feedback_ask_sessions a ON a.collection_id = s.collection_id
         JOIN feedback_collections c ON c.id = a.collection_id AND c.kind = 'bounded_ask'
        WHERE s.id LIKE ? ESCAPE '\\' AND ${authorized.sql}
        ORDER BY s.id
        LIMIT 2`,
    ).all(escapedLikePrefix(direct![1]), ...authorized.params);
  const submissions = rows as FeedbackSubmissionRow[];
  if (submissions.length === 0) return { ok: false, error: "not_found" };
  if (submissions.length > 1) return { ok: false, error: "ambiguous" };
  return { ok: true, submission: submissions[0], ask_id: submissions[0].collection_id };
}

type FrozenAnswer = {
  item_id: string;
  client_item_key: string | null;
  item_revision_id: string;
  response_event_id: string;
  response_type: FeedbackResponseType;
  value: FeedbackResponseValue;
  actor_user_id: string;
};

type FrozenAnnotation = {
  annotation_event_id: string;
  annotation_kind: "comment" | "suggest_replacement";
  start_offset: number;
  end_offset: number;
  quote: string;
  body: string | null;
  replacement_text: string | null;
  actor_user_id: string;
  created_at: number;
  position: number;
};

export interface SubmissionFactPacket {
  submission_id: string;
  ask_id: string;
  ordinal: number;
  actor_user_id: string;
  created_at: number;
  supersedes_submission_id: string | null;
  superseded_by_submission_id: string | null;
  canonical_ref: string;
  document: null | { artifact_version_id: string; previous_round_id: string | null };
  answers: FrozenAnswer[];
  annotations: FrozenAnnotation[];
}

export function readSubmissionFactPacket(
  db: Db,
  resolved: Extract<SubmissionResolution, { ok: true }>,
): SubmissionFactPacket {
  const submission = resolved.submission;
  const supersededBy = db.prepare(
    `SELECT id FROM feedback_submissions
      WHERE collection_id = ? AND actor_user_id = ? AND supersedes_submission_id = ?
      ORDER BY ordinal LIMIT 1`,
  ).get(submission.collection_id, submission.actor_user_id, submission.id) as { id: string } | undefined;
  const document = db.prepare(
    "SELECT artifact_version_id, previous_round_id FROM feedback_collection_documents WHERE collection_id = ?",
  ).get(submission.collection_id) as { artifact_version_id: string; previous_round_id: string | null } | undefined;
  const answerRows = db.prepare(
    `SELECT sa.item_id, i.client_item_key, sa.item_revision_id, sa.response_event_id,
            r.response_type, e.value_json, e.actor_user_id
       FROM feedback_submission_answers sa
       JOIN feedback_items i ON i.id = sa.item_id
       JOIN feedback_item_revisions r ON r.id = sa.item_revision_id
       JOIN feedback_response_events e ON e.id = sa.response_event_id
      WHERE sa.submission_id = ? ORDER BY sa.position, sa.rowid`,
  ).all(submission.id) as Array<Omit<FrozenAnswer, "value"> & { value_json: string }>;
  const annotations = db.prepare(
    `SELECT sa.annotation_event_id, e.annotation_kind, e.start_offset, e.end_offset,
            e.quote, e.body, e.replacement_text, e.actor_user_id, e.created_at, sa.position
       FROM feedback_submission_annotations sa
       JOIN feedback_annotation_events e ON e.id = sa.annotation_event_id
      WHERE sa.submission_id = ? ORDER BY sa.position, e.id`,
  ).all(submission.id) as FrozenAnnotation[];
  return {
    submission_id: submission.id,
    ask_id: submission.collection_id,
    ordinal: submission.ordinal,
    actor_user_id: submission.actor_user_id,
    created_at: submission.created_at,
    supersedes_submission_id: submission.supersedes_submission_id,
    superseded_by_submission_id: supersededBy?.id ?? null,
    canonical_ref: `submission:${submission.collection_id}#${submission.ordinal}`,
    document: document ?? null,
    answers: answerRows.map(({ value_json, ...answer }) => ({
      ...answer,
      value: JSON.parse(value_json) as FeedbackResponseValue,
    })),
    annotations,
  };
}

export function markdownBlockquote(value: string): string {
  return value.split(/\r\n|\r|\n/).map((line) => `> ${line}`).join("\n");
}

export function markdownHeading(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ").replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, "\\$1");
}

export function exportSubmissionMarkdown(
  db: Db,
  resolved: Extract<SubmissionResolution, { ok: true }>,
): string {
  const packet = readSubmissionFactPacket(db, resolved);
  const document = packet.document;
  let documentSource: string | null = null;
  let documentHash: string | null = null;
  if (document) {
    const version = getCanonicalArtifactVersion(db, document.artifact_version_id);
    if (!version || version.id !== document.artifact_version_id) {
      throw new AskStoreError("document bytes are unavailable", 409, "document_unavailable");
    }
    const content = readArtifactBytesFull(db, version.id);
    if (!content.ok) throw new AskStoreError("document bytes are unavailable", 409, "document_unavailable");
    const expected = version.content_hash.replace(/^sha256:/, "").toLowerCase();
    const actual = createHash("sha256").update(content.bytes).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      throw new AskStoreError("document bytes failed integrity verification", 409, "document_unavailable");
    }
    try {
      documentSource = new TextDecoder("utf-8", { fatal: true }).decode(content.bytes);
    } catch {
      throw new AskStoreError("document bytes are not valid UTF-8", 409, "document_unavailable");
    }
    documentHash = version.content_hash;
  }

  const answerRows = db.prepare(
    `SELECT r.title, r.response_type, e.value_json
       FROM feedback_submission_answers sa
       JOIN feedback_item_revisions r ON r.id = sa.item_revision_id
       JOIN feedback_response_events e ON e.id = sa.response_event_id
      WHERE sa.submission_id = ? ORDER BY sa.position, sa.rowid`,
  ).all(packet.submission_id) as Array<{ title: string; response_type: string; value_json: string }>;
  const lines = [
    "---",
    "export_schema: mandible-submission-export@1",
    `submission_ref: ${packet.canonical_ref}`,
    `submission_id: ${packet.submission_id}`,
    `ask_id: ${packet.ask_id}`,
    `responder_user_id: ${packet.actor_user_id}`,
    `submitted_at: ${new Date(packet.created_at).toISOString()}`,
    `document_artifact_version: ${document?.artifact_version_id ?? "none"}`,
    `document_content_hash: ${documentHash ?? "none"}`,
    `previous_round: ${document?.previous_round_id ?? "none"}`,
    "---",
    "",
    `# Submission ${packet.ordinal}`,
    "",
    "## Annotations",
  ];
  if (packet.annotations.length === 0) {
    lines.push("None.");
  } else {
    packet.annotations.forEach((annotation, index) => {
      lines.push(
        `### ${index + 1}. ${annotation.annotation_kind} [${annotation.start_offset}–${annotation.end_offset}]`,
        markdownBlockquote(annotation.quote),
      );
      if (annotation.body !== null) lines.push("", annotation.body);
      if (annotation.annotation_kind === "suggest_replacement") {
        lines.push(
          "",
          "**Suggested replacement:**",
          markdownBlockquote(annotation.replacement_text === "" ? "(delete)" : annotation.replacement_text ?? ""),
        );
      }
      if (index < packet.annotations.length - 1) lines.push("");
    });
  }
  lines.push("", "## Answers");
  if (answerRows.length === 0) {
    lines.push("None.");
  } else {
    answerRows.forEach((answer, index) => {
      lines.push(
        `### ${markdownHeading(answer.title)}`,
        `- response_type: ${answer.response_type}`,
        `- value: ${canonicalJson(JSON.parse(answer.value_json))}`,
      );
      if (index < answerRows.length - 1) lines.push("");
    });
  }
  lines.push("", "## Document");
  if (!document || documentSource === null) {
    lines.push("None.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Source: ${document.artifact_version_id}`, "");
  return `${lines.join("\n")}\n${documentSource}`;
}
