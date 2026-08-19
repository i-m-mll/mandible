import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";

import { readArtifactBytesFull } from "../artifact-content.js";
import type { Db } from "../db.js";
import { tableExists } from "../db-introspection.js";
import { getCanonicalArtifactVersion, recordArtifactVersion } from "../provider-artifacts.js";
import {
  BRIEFING_SCHEMA_SQL,
  CANONICAL_AGENT_DISPATCH_SQL,
  CANONICAL_SPACE_ITEMS_SQL,
  LEGACY_FEEDBACK_DROP_SQL,
} from "./schema.js";

const RETIRED_BRIEFING_V1_PROFILE = "mandible-briefing.v1";
type RetiredV1Directive = {
  key: string; required: boolean; body: string; definition_digest: string;
  start_offset: number; end_offset: number; body_start_offset: number; body_end_offset: number;
};
type RetiredV1Node = {
  type?: string; name?: string; attributes?: Record<string, unknown>; children?: RetiredV1Node[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

function retiredV1Offsets(node: RetiredV1Node): { start: number; end: number } {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error("retired v1 directive source range is unavailable");
  }
  return { start, end };
}

/** Migration-only verifier for exact retired v1 bytes; it never produces active v2 semantics. */
function verifyRetiredV1Directives(source: string): RetiredV1Directive[] {
  const tree = unified().use(remarkParse).use(remarkDirective).parse(source) as unknown as RetiredV1Node;
  const directives: RetiredV1Directive[] = [];
  const seen = new Set<string>();
  const acceptedOpeners = new Set<number>();
  const walk = (node: RetiredV1Node, topLevel: boolean): void => {
    const isDirective = typeof node.type === "string" && node.type.endsWith("Directive");
    if (isDirective) {
      if (!topLevel || node.type !== "containerDirective" || node.name !== "spec-item") {
        throw new Error("retired v1 allows only top-level spec-item containers");
      }
      const attrs = node.attributes ?? {};
      if (Object.keys(attrs).some((key) => key !== "key" && key !== "required")
          || typeof attrs.key !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(attrs.key)
          || (attrs.required !== undefined && attrs.required !== "true" && attrs.required !== "false")) {
        throw new Error("retired v1 directive attributes are invalid");
      }
      const range = retiredV1Offsets(node);
      acceptedOpeners.add(range.start);
      const openEnd = source.indexOf("\n", range.start);
      if (openEnd < range.start || openEnd >= range.end
          || !/^:::spec-item\{key="[A-Za-z0-9._-]{1,128}"(?: required="(?:true|false)")?\}\r?$/.test(source.slice(range.start, openEnd))) {
        throw new Error("retired v1 directive opener is invalid");
      }
      const closeStart = source.lastIndexOf("\n:::", range.end - 1);
      if (closeStart < openEnd || !/^:::\r?$/.test(source.slice(closeStart + 1, range.end))) {
        throw new Error("retired v1 directive closing fence is invalid");
      }
      const bodyStart = openEnd + 1;
      const bodyEnd = source[closeStart - 1] === "\r" ? closeStart - 1 : closeStart;
      const body = source.slice(bodyStart, bodyEnd);
      if (!body.trim()) throw new Error("retired v1 directive body is empty");
      if (seen.has(attrs.key)) throw new Error("retired v1 directive keys are duplicated");
      seen.add(attrs.key);
      directives.push({ key: attrs.key, required: attrs.required === "true", body,
        start_offset: range.start, end_offset: range.end, body_start_offset: bodyStart, body_end_offset: bodyEnd,
        definition_digest: createHash("sha256").update(Buffer.from(source.slice(range.start, range.end), "utf8")).digest("hex") });
      for (const child of node.children ?? []) walk(child, false);
      return;
    }
    for (const child of node.children ?? []) walk(child, node === tree);
  };
  walk(tree, false);
  const directiveLikeLine = /^\s*:{2,}[A-Za-z][^\r\n]*$/gm;
  for (let match = directiveLikeLine.exec(source); match; match = directiveLikeLine.exec(source)) {
    const offset = match.index + (match[0].length - match[0].trimStart().length);
    if (!acceptedOpeners.has(offset)) {
      throw new Error("retired v1 document contains unparsed or misplaced directive-like bytes");
    }
  }
  if (directives.length === 0) throw new Error("retired v1 document has no directives");
  return directives;
}

type LegacyCollection = {
  id: string;
  kind: string;
  source: string | null;
  created_at: number;
};

function stableId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function rowsForIds(db: Db, table: string, column: string, ids: string[]): unknown[] {
  if (ids.length === 0 || !tableExists(db, table)) return [];
  const allowed = new Set([
    "briefing_rounds:briefing_id", "briefing_directive_instances:round_id",
    "briefing_directive_definitions:id", "briefing_runs:briefing_id",
    "briefing_run_occurrences:run_id", "briefing_response_events:round_id",
    "briefing_annotation_events:round_id", "briefing_submissions:round_id",
    "briefing_submission_answers:submission_id", "briefing_submission_annotations:submission_id",
  ]);
  if (!allowed.has(`${table}:${column}`)) throw new Error(`unsupported custody relation ${table}.${column}`);
  return db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${ids.map(() => "?").join(",")}) ORDER BY rowid`)
    .all(...ids) as unknown[];
}

function verifyRetiredV1Round(db: Db, round: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const versionId = String(round.artifact_version_id);
  const version = getCanonicalArtifactVersion(db, versionId);
  if (!version || version.id !== versionId) return ["canonical artifact version is unavailable"];
  const content = readArtifactBytesFull(db, version.id);
  if (!content.ok) return ["artifact bytes are unavailable"];
  if (createHash("sha256").update(content.bytes).digest("hex") !== version.content_hash) {
    return ["artifact bytes do not match the pinned content hash"];
  }
  let directives: RetiredV1Directive[];
  try {
    directives = verifyRetiredV1Directives(new TextDecoder("utf-8", { fatal: true }).decode(content.bytes));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const bindingDigest = createHash("sha256")
    .update(JSON.stringify(directives.map((directive) => [directive.key, directive.definition_digest])))
    .digest("hex");
  if (bindingDigest !== round.binding_digest) errors.push("round binding digest is invalid");
  if (round.previous_round_id) {
    const previous = db.prepare("SELECT briefing_id FROM briefing_rounds WHERE id = ?").get(round.previous_round_id) as
      { briefing_id: string } | undefined;
    if (!previous || previous.briefing_id !== round.briefing_id) errors.push("previous round binding is inconsistent");
  }
  const stored = db.prepare(
    `SELECT i.position, i.directive_key, d.artifact_version_id, d.definition_digest,
            d.response_type, d.required, d.prompt, d.options_json, d.start_offset, d.end_offset,
            d.body_start_offset, d.body_end_offset
       FROM briefing_directive_instances i JOIN briefing_directive_definitions d ON d.id = i.definition_id
      WHERE i.round_id = ? ORDER BY i.position`,
  ).all(round.id) as Array<Record<string, unknown>>;
  if (stored.length !== directives.length) errors.push("definition count does not match artifact");
  directives.forEach((directive, position) => {
    const row = stored[position];
    if (!row || row.position !== position || row.directive_key !== directive.key
        || row.artifact_version_id !== versionId || row.definition_digest !== directive.definition_digest
        || row.response_type !== "verdict" || row.required !== (directive.required ? 1 : 0)
        || row.prompt !== directive.body || row.options_json !== "[]"
        || row.start_offset !== directive.start_offset || row.end_offset !== directive.end_offset
        || row.body_start_offset !== directive.body_start_offset || row.body_end_offset !== directive.body_end_offset) {
      errors.push(`stored definition ${position} does not match retired v1 bytes`);
    }
  });
  const responseValues = db.prepare(
    `SELECT event.id, event.value_json, definition.response_type, definition.options_json
       FROM briefing_response_events event
       JOIN briefing_directive_instances instance ON instance.id = event.directive_instance_id
       JOIN briefing_directive_definitions definition ON definition.id = instance.definition_id
      WHERE event.round_id = ? AND event.operation = 'set' ORDER BY event.rowid`,
  ).all(round.id) as Array<{ id: string; value_json: string; response_type: string; options_json: string }>;
  for (const event of responseValues) {
    try {
      const value = JSON.parse(event.value_json) as Record<string, unknown>;
      const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
      const options = JSON.parse(event.options_json) as Array<{ key: string }>;
      const valid = event.response_type === "verdict"
        ? keys.join(",") === "verdict" && (value.verdict === "keep" || value.verdict === "dismiss")
        : event.response_type === "free_text"
          ? keys.join(",") === "text" && typeof value.text === "string"
          : event.response_type === "single_choice"
            ? keys.join(",") === "option_key" && options.some((option) => option.key === value.option_key)
            : event.response_type === "multi_choice"
              ? keys.join(",") === "option_keys" && Array.isArray(value.option_keys)
                && value.option_keys.length > 0 && new Set(value.option_keys).size === value.option_keys.length
                && value.option_keys.every((key) => options.some((option) => option.key === key))
              : false;
      if (!valid) errors.push(`stored response ${event.id} is invalid for retired v1`);
    } catch {
      errors.push(`stored response ${event.id} is invalid for retired v1`);
    }
  }
  const semanticChecks: Array<[string, string]> = [
    ["response event instance/round or membership is inconsistent", `
      SELECT 1 FROM briefing_response_events event
      LEFT JOIN briefing_directive_instances instance ON instance.id = event.directive_instance_id
      LEFT JOIN briefing_members member ON member.briefing_id = ? AND member.user_id = event.actor_user_id
      WHERE event.round_id = ? AND (instance.round_id != event.round_id OR member.user_id IS NULL) LIMIT 1`],
    ["response retraction identity is inconsistent", `
      SELECT 1 FROM briefing_response_events event
      LEFT JOIN briefing_response_events target ON target.id = event.retracts_event_id
      WHERE event.round_id = ? AND event.operation = 'retract'
        AND (target.id IS NULL OR target.operation != 'set' OR target.round_id != event.round_id
          OR target.directive_instance_id != event.directive_instance_id OR target.actor_user_id != event.actor_user_id)
      LIMIT 1`],
    ["annotation retraction identity is inconsistent", `
      SELECT 1 FROM briefing_annotation_events event
      LEFT JOIN briefing_annotation_events target ON target.id = event.retracts_event_id
      WHERE event.round_id = ? AND event.operation = 'retract'
        AND (target.id IS NULL OR target.operation != 'set' OR target.round_id != event.round_id
          OR target.actor_user_id != event.actor_user_id) LIMIT 1`],
    ["submission predecessor identity is inconsistent", `
      SELECT 1 FROM briefing_submissions submission
      LEFT JOIN briefing_submissions prior ON prior.id = submission.supersedes_submission_id
      WHERE submission.round_id = ? AND submission.supersedes_submission_id IS NOT NULL
        AND (prior.id IS NULL OR prior.round_id != submission.round_id OR prior.actor_user_id != submission.actor_user_id)
      LIMIT 1`],
    ["annotation actor membership is inconsistent", `
      SELECT 1 FROM briefing_annotation_events event
      LEFT JOIN briefing_members member ON member.briefing_id = ? AND member.user_id = event.actor_user_id
      WHERE event.round_id = ? AND member.user_id IS NULL LIMIT 1`],
    ["submission actor membership is inconsistent", `
      SELECT 1 FROM briefing_submissions submission
      LEFT JOIN briefing_members member ON member.briefing_id = ? AND member.user_id = submission.actor_user_id
      WHERE submission.round_id = ? AND member.user_id IS NULL LIMIT 1`],
    ["frozen answer identity is inconsistent", `
      SELECT 1 FROM briefing_submission_answers frozen
      JOIN briefing_submissions submission ON submission.id = frozen.submission_id
      LEFT JOIN briefing_response_events event ON event.id = frozen.response_event_id
      LEFT JOIN briefing_directive_instances instance ON instance.id = frozen.directive_instance_id
      WHERE submission.round_id = ? AND (event.id IS NULL OR event.operation != 'set'
        OR event.round_id != submission.round_id OR event.actor_user_id != submission.actor_user_id
        OR event.directive_instance_id != frozen.directive_instance_id OR instance.round_id != submission.round_id)
      LIMIT 1`],
    ["frozen annotation identity is inconsistent", `
      SELECT 1 FROM briefing_submission_annotations frozen
      JOIN briefing_submissions submission ON submission.id = frozen.submission_id
      LEFT JOIN briefing_annotation_events event ON event.id = frozen.annotation_event_id
      WHERE submission.round_id = ? AND (event.id IS NULL OR event.operation != 'set'
        OR event.round_id != submission.round_id OR event.actor_user_id != submission.actor_user_id)
      LIMIT 1`],
  ];
  for (const [message, sql] of semanticChecks) {
    const parameters = sql.includes("member.briefing_id = ?") ? [round.briefing_id, round.id] : [round.id];
    if (db.prepare(sql).get(...parameters)) errors.push(message);
  }
  return errors;
}

/** Seal exact active v1 state, then remove it from every active Briefing projection. */
export function retireBriefingV1ToCustody(db: Db, now = Date.now()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS briefing_legacy_custody (
    id TEXT PRIMARY KEY,
    briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE RESTRICT,
    source_profile TEXT NOT NULL CHECK(source_profile = 'mandible-briefing.v1'),
    disposition TEXT NOT NULL CHECK(disposition IN ('sealed_verified','sealed_ambiguous')),
    reason TEXT NOT NULL,
    packet_json TEXT NOT NULL CHECK(json_valid(packet_json) AND json_type(packet_json) = 'object'),
    packet_digest TEXT NOT NULL CHECK(length(packet_digest) = 64),
    created_at INTEGER NOT NULL,
    UNIQUE(briefing_id, source_profile)
  )`);
  const tableSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'briefing_rounds'",
  ).get() as { sql: string } | undefined)?.sql ?? "";
  const isV1Shape = tableSql.includes("mandible-briefing.v1");
  if (!isV1Shape) {
    for (const statement of BRIEFING_SCHEMA_SQL) db.exec(statement);
    return;
  }

  const briefings = db.prepare("SELECT * FROM briefings ORDER BY id").all() as Array<Record<string, unknown>>;
  for (const briefing of briefings) {
    const rounds = rowsForIds(db, "briefing_rounds", "briefing_id", [String(briefing.id)]) as Array<Record<string, unknown>>;
    if (rounds.length === 0) continue;
    const roundIds = rounds.map((row) => String(row.id));
    const instances = rowsForIds(db, "briefing_directive_instances", "round_id", roundIds) as Array<Record<string, unknown>>;
    const definitionIds = [...new Set(instances.map((row) => String(row.definition_id)))];
    const runs = rowsForIds(db, "briefing_runs", "briefing_id", [String(briefing.id)]) as Array<Record<string, unknown>>;
    const submissions = rowsForIds(db, "briefing_submissions", "round_id", roundIds) as Array<Record<string, unknown>>;
    const artifactVersions = rounds.map((round) => {
      const version = getCanonicalArtifactVersion(db, String(round.artifact_version_id));
      const bytes = version ? readArtifactBytesFull(db, version.id) : null;
      return {
        id: round.artifact_version_id,
        artifact_id: version?.artifact_id ?? null,
        blob_id: version?.blob_id ?? null,
        content_hash: version?.content_hash ?? null,
        byte_length: bytes?.ok ? bytes.bytes.byteLength : null,
        source_sha256: bytes?.ok ? createHash("sha256").update(bytes.bytes).digest("hex") : null,
      };
    });
    const components: Record<string, unknown> = {
      briefing,
      membership: db.prepare("SELECT * FROM briefing_members WHERE briefing_id = ? ORDER BY user_id").all(briefing.id),
      artifact_versions: artifactVersions,
      rounds,
      definitions: rowsForIds(db, "briefing_directive_definitions", "id", definitionIds),
      instances,
      runs,
      occurrences: rowsForIds(db, "briefing_run_occurrences", "run_id", runs.map((row) => String(row.id))),
      response_events: rowsForIds(db, "briefing_response_events", "round_id", roundIds),
      annotation_events: rowsForIds(db, "briefing_annotation_events", "round_id", roundIds),
      submissions,
      submission_answers: rowsForIds(db, "briefing_submission_answers", "submission_id", submissions.map((row) => String(row.id))),
      submission_annotations: rowsForIds(db, "briefing_submission_annotations", "submission_id", submissions.map((row) => String(row.id))),
      prior_audit: tableExists(db, "briefing_legacy_audit")
        ? db.prepare("SELECT * FROM briefing_legacy_audit WHERE legacy_collection_id = ? ORDER BY id")
          .all(String(briefing.briefing_key).replace(/^legacy:/, "")) : [],
    };
    const errors = rounds.flatMap((round) => verifyRetiredV1Round(db, round));
    const componentDigests = Object.fromEntries(Object.entries(components)
      .map(([key, value]) => [key, createHash("sha256").update(canonical(value)).digest("hex")]));
    const packet = {
      schema: "mandible-briefing-v1-custody.v1",
      source_profile: RETIRED_BRIEFING_V1_PROFILE,
      components,
      row_counts: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Array.isArray(value) ? value.length : 1])),
      component_digests: componentDigests,
      verification_errors: errors,
    };
    const packetJson = canonical(packet);
    const packetDigest = createHash("sha256").update(packetJson).digest("hex");
    const existing = db.prepare(
      "SELECT packet_digest FROM briefing_legacy_custody WHERE briefing_id = ? AND source_profile = ?",
    ).get(briefing.id, RETIRED_BRIEFING_V1_PROFILE) as { packet_digest: string } | undefined;
    if (existing && existing.packet_digest !== packetDigest) {
      throw new Error(`migration 143 custody packet conflicts for Briefing ${briefing.id}`);
    }
    if (!existing) db.prepare(
      `INSERT INTO briefing_legacy_custody
        (id, briefing_id, source_profile, disposition, reason, packet_json, packet_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(stableId("briefing-v1-custody", String(briefing.id)), briefing.id, RETIRED_BRIEFING_V1_PROFILE,
      errors.length === 0 ? "sealed_verified" : "sealed_ambiguous",
      errors.length === 0 ? "exact artifact and stored binding verified before retirement" : errors.join("; "),
      packetJson, packetDigest, now);
  }

  for (const table of [
    "briefing_submission_annotations", "briefing_submission_answers", "briefing_submissions",
    "briefing_annotation_events", "briefing_response_events", "briefing_run_occurrences",
    "briefing_runs", "briefing_directive_instances", "briefing_directive_definitions", "briefing_rounds",
  ]) db.exec(`DROP TABLE ${table}`);
  db.exec("UPDATE briefings SET latest_round_id = NULL, round_count = 0");
  for (const statement of BRIEFING_SCHEMA_SQL) db.exec(statement);
}

function safeDirectiveKey(value: string, itemId: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value)
    ? value
    : `legacy-${createHash("sha256").update(itemId).digest("hex").slice(0, 24)}`;
}

function quotedJsonRows(db: Db, table: string, collectionId: string): unknown[] {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
  if (columns.includes("collection_id")) {
    return db.prepare(`SELECT * FROM ${table} WHERE collection_id = ? ORDER BY rowid`).all(collectionId) as unknown[];
  }
  return [];
}

function legacyProvenance(db: Db, collection: LegacyCollection): Record<string, unknown> {
  const items = db.prepare("SELECT * FROM feedback_items WHERE collection_id = ? ORDER BY rowid")
    .all(collection.id) as Array<{ id: string }>;
  const itemIds = items.map((item) => item.id);
  const byItems = (table: string, column: string): unknown[] => itemIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM ${table} WHERE ${column} IN (${itemIds.map(() => "?").join(",")}) ORDER BY rowid`,
  ).all(...itemIds) as unknown[];
  const revisions = byItems("feedback_item_revisions", "item_id") as Array<{ id: string }>;
  const revisionIds = revisions.map((revision) => revision.id);
  const byRevisions = (table: string, column: string): unknown[] => revisionIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM ${table} WHERE ${column} IN (${revisionIds.map(() => "?").join(",")}) ORDER BY rowid`,
  ).all(...revisionIds) as unknown[];
  const submissions = quotedJsonRows(db, "feedback_submissions", collection.id) as Array<{ id: string }>;
  const submissionIds = submissions.map((submission) => submission.id);
  const bySubmissions = (table: string): unknown[] => submissionIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM ${table} WHERE submission_id IN (${submissionIds.map(() => "?").join(",")}) ORDER BY rowid`,
  ).all(...submissionIds) as unknown[];
  return {
    schema: "mandible.legacy-feedback-audit.v1",
    collection,
    recurring_profiles: quotedJsonRows(db, "feedback_recurring_profiles", collection.id),
    ask_sessions: quotedJsonRows(db, "feedback_ask_sessions", collection.id),
    documents: quotedJsonRows(db, "feedback_collection_documents", collection.id),
    publications: quotedJsonRows(db, "feedback_publications", collection.id),
    items,
    item_revisions: revisions,
    item_options: byRevisions("feedback_item_options", "revision_id"),
    item_directives: quotedJsonRows(db, "feedback_item_directives", collection.id),
    collection_events: quotedJsonRows(db, "feedback_collection_events", collection.id),
    item_events: byItems("feedback_item_events", "item_id"),
    response_events: quotedJsonRows(db, "feedback_response_events", collection.id),
    comments: quotedJsonRows(db, "feedback_comments", collection.id),
    annotation_events: quotedJsonRows(db, "feedback_annotation_events", collection.id),
    submissions,
    submission_answers: bySubmissions("feedback_submission_answers"),
    submission_annotations: bySubmissions("feedback_submission_annotations"),
  };
}

function synthesizeDocument(db: Db, collection: LegacyCollection): {
  source: string;
  itemByKey: Map<string, { item_id: string; revision_id: string }>;
} {
  const rows = db.prepare(
    `SELECT i.id AS item_id, i.external_key, i.client_item_key, r.id AS revision_id,
            r.title, r.prompt, r.required
       FROM feedback_items i
       JOIN feedback_item_revisions r ON r.id = i.current_revision_id
      WHERE i.collection_id = ? AND i.item_kind = 'item'
      ORDER BY r.position, i.created_at, i.id`,
  ).all(collection.id) as Array<{
    item_id: string;
    external_key: string | null;
    client_item_key: string | null;
    revision_id: string;
    title: string;
    prompt: string;
    required: number;
  }>;
  const itemByKey = new Map<string, { item_id: string; revision_id: string }>();
  const lines = [`# ${collection.source ?? "Legacy Briefing"}`, ""];
  for (const row of rows) {
    const key = safeDirectiveKey(row.client_item_key ?? row.external_key ?? row.item_id, row.item_id);
    itemByKey.set(key, { item_id: row.item_id, revision_id: row.revision_id });
    lines.push(`## ${row.title}`, "", `:::spec-item{key=\"${key}\" required=\"${row.required ? "true" : "false"}\"}`,
      row.prompt.trim() || row.title, ":::", "");
  }
  if (itemByKey.size === 0) {
    const key = `legacy-${createHash("sha256").update(collection.id).digest("hex").slice(0, 24)}`;
    lines.push(`:::spec-item{key=\"${key}\" required=\"false\"}`, "No response requested.", ":::", "");
  }
  return { source: `${lines.join("\n")}\n`, itemByKey };
}

function pinnedLegacyDocument(db: Db, collectionId: string): { versionId: string; source: string } | null {
  const row = db.prepare(
    "SELECT artifact_version_id, profile FROM feedback_collection_documents WHERE collection_id = ?",
  ).get(collectionId) as { artifact_version_id: string; profile: string | null } | undefined;
  if (!row || row.profile !== RETIRED_BRIEFING_V1_PROFILE) return null;
  const version = getCanonicalArtifactVersion(db, row.artifact_version_id);
  if (!version) return null;
  const bytes = readArtifactBytesFull(db, version.id);
  if (!bytes.ok || createHash("sha256").update(bytes.bytes).digest("hex") !== version.content_hash) return null;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes);
    verifyRetiredV1Directives(source);
    return { versionId: version.id, source };
  } catch {
    return null;
  }
}

/**
 * Lean v142 conversion. Exact frozen legacy submissions are copied; all other
 * bytes remain in the immutable audit packet instead of being interpreted.
 */
export function migrateLegacyFeedbackToBriefings(db: Db, now = Date.now()): void {
  const legacyPresent = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feedback_collections'",
  ).get());
  const collections = legacyPresent
    ? db.prepare("SELECT id, kind, source, created_at FROM feedback_collections ORDER BY created_at, id").all() as LegacyCollection[]
    : [];
  for (const collection of collections) {
    const provenance = legacyProvenance(db, collection);
    const ask = db.prepare(
      "SELECT request_key, responder_user_ids_json FROM feedback_ask_sessions WHERE collection_id = ?",
    ).get(collection.id) as { request_key: string; responder_user_ids_json: string } | undefined;
    const briefingId = stableId("briefing", "legacy", collection.id);
    const title = collection.source ?? ask?.request_key ?? `Legacy Briefing ${collection.id.slice(0, 8)}`;
    db.prepare(
      `INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 0, ?, ?)`,
    ).run(briefingId, `legacy:${collection.id}`, title, collection.created_at, collection.created_at);

    const actors = new Set<string>();
    if (ask) {
      try { for (const id of JSON.parse(ask.responder_user_ids_json) as string[]) actors.add(id); } catch { /* sealed below */ }
    }
    for (const row of db.prepare("SELECT DISTINCT actor_user_id FROM feedback_response_events WHERE collection_id = ?")
      .all(collection.id) as Array<{ actor_user_id: string }>) actors.add(row.actor_user_id);
    for (const actor of actors) {
      if (db.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").get(actor)) {
        db.prepare("INSERT OR IGNORE INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)")
          .run(briefingId, actor, now);
      }
    }

    const pinned = pinnedLegacyDocument(db, collection.id);
    const synthesized = synthesizeDocument(db, collection);
    const source = pinned?.source ?? synthesized.source;
    const artifactVersionId = pinned?.versionId ?? recordArtifactVersion(db, {
      source_kind: "managed",
      content: source,
      series_key: `mandible:briefing:${briefingId}`,
      logical_name: `${collection.id}.md`,
      title,
      role: "briefing-document",
      media_type: "text/markdown",
      metadata: { migrated_from_feedback_collection: collection.id, profile: RETIRED_BRIEFING_V1_PROFILE },
    }, now).version.id;
    const directives = verifyRetiredV1Directives(source);
    const bindingDigest = createHash("sha256")
      .update(JSON.stringify(directives.map((directive) => [directive.key, directive.definition_digest])))
      .digest("hex");
    const roundId = stableId("briefing-round", collection.id);
    db.prepare(
      `INSERT INTO briefing_rounds
        (id, briefing_id, ordinal, artifact_version_id, previous_round_id, profile, binding_digest, created_at)
       VALUES (?, ?, 1, ?, NULL, ?, ?, ?)`,
    ).run(roundId, briefingId, artifactVersionId, RETIRED_BRIEFING_V1_PROFILE, bindingDigest, collection.created_at);
    db.prepare("UPDATE briefings SET latest_round_id = ?, round_count = 1 WHERE id = ?")
      .run(roundId, briefingId);

    const legacyBindings = db.prepare(
      `SELECT d.directive_key, i.id AS item_id, d.item_revision_id
         FROM feedback_item_directives d JOIN feedback_item_revisions r ON r.id = d.item_revision_id
         JOIN feedback_items i ON i.id = r.item_id WHERE d.collection_id = ?`,
    ).all(collection.id) as Array<{ directive_key: string; item_id: string; item_revision_id: string }>;
    const legacyByKey = new Map(legacyBindings.map((row) => [row.directive_key, {
      item_id: row.item_id, revision_id: row.item_revision_id,
    }]));
    const instanceByLegacyItem = new Map<string, string>();
    directives.forEach((directive, position) => {
      const definitionId = stableId("briefing-directive", artifactVersionId, directive.key);
      const instanceId = stableId("briefing-instance", roundId, directive.key);
      db.prepare(
        `INSERT OR IGNORE INTO briefing_directive_definitions
          (id, artifact_version_id, directive_key, definition_digest, response_type, required, prompt,
           options_json, start_offset, end_offset, body_start_offset, body_end_offset, created_at)
         VALUES (?, ?, ?, ?, 'verdict', ?, ?, '[]', ?, ?, ?, ?, ?)`,
      ).run(definitionId, artifactVersionId, directive.key, directive.definition_digest,
        directive.required ? 1 : 0, directive.body, directive.start_offset, directive.end_offset,
        directive.body_start_offset, directive.body_end_offset, now);
      db.prepare(
        `INSERT INTO briefing_directive_instances
          (id, round_id, briefing_id, artifact_version_id, definition_id, directive_key, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(instanceId, roundId, briefingId, artifactVersionId, definitionId, directive.key, position, now);
      const legacy = legacyByKey.get(directive.key) ?? synthesized.itemByKey.get(directive.key);
      if (legacy) instanceByLegacyItem.set(legacy.item_id, instanceId);
    });

    let exact = 0;
    const representedResponseIds = new Set<string>();
    const submissions = db.prepare(
      "SELECT id, ordinal, supersedes_submission_id, actor_user_id, created_at FROM feedback_submissions WHERE collection_id = ? ORDER BY ordinal",
    ).all(collection.id) as Array<{ id: string; ordinal: number; supersedes_submission_id: string | null; actor_user_id: string; created_at: number }>;
    const migratedSubmissionIds = new Map<string, string>();
    for (const submission of submissions) {
      const answers = db.prepare(
        `SELECT a.item_id, a.response_event_id, a.position, e.value_json
           FROM feedback_submission_answers a JOIN feedback_response_events e ON e.id = a.response_event_id
          WHERE a.submission_id = ? ORDER BY a.position`,
      ).all(submission.id) as Array<{ item_id: string; response_event_id: string; position: number; value_json: string }>;
      if (answers.some((answer) => !instanceByLegacyItem.has(answer.item_id))) continue;
      const newSubmissionId = stableId("briefing-submission", submission.id);
      db.prepare(
        `INSERT INTO briefing_submissions
          (id, round_id, briefing_id, ordinal, supersedes_submission_id, actor_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(newSubmissionId, roundId, briefingId, submission.ordinal,
        submission.supersedes_submission_id ? migratedSubmissionIds.get(submission.supersedes_submission_id) ?? null : null,
        submission.actor_user_id, submission.created_at);
      for (const answer of answers) {
        representedResponseIds.add(answer.response_event_id);
        const eventId = stableId("briefing-response", answer.response_event_id);
        const instanceId = instanceByLegacyItem.get(answer.item_id) as string;
        db.prepare(
          `INSERT INTO briefing_response_events
            (id, round_id, briefing_id, directive_instance_id, operation, value_json, retracts_event_id, actor_user_id, created_at)
           VALUES (?, ?, ?, ?, 'set', ?, NULL, ?, ?)`,
        ).run(eventId, roundId, briefingId, instanceId, answer.value_json, submission.actor_user_id, submission.created_at);
        db.prepare(
          `INSERT INTO briefing_submission_answers
            (submission_id, round_id, actor_user_id, directive_instance_id, response_event_id, position)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(newSubmissionId, roundId, submission.actor_user_id, instanceId, eventId, answer.position);
      }
      migratedSubmissionIds.set(submission.id, newSubmissionId);
      exact += 1;
    }
    const legacyResponseIds = (provenance.response_events as Array<{ id: string }>).map((event) => event.id);
    const hasSealedOnlyHistory = legacyResponseIds.some((id) => !representedResponseIds.has(id))
      || (provenance.comments as unknown[]).length > 0
      || (provenance.annotation_events as unknown[]).length > 0;
    const disposition = exact === submissions.length && !hasSealedOnlyHistory
      ? "reconstructed" : "sealed_ambiguous";
    const reason = disposition === "reconstructed"
      ? `reconstructed ${exact} exact frozen submission(s)`
      : `reconstructed ${exact} exact frozen submission(s); sealed non-round or unmappable legacy history`;
    db.prepare(
      `INSERT INTO briefing_legacy_audit
        (id, legacy_collection_id, disposition, reason, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(stableId("briefing-audit", collection.id), collection.id, disposition, reason, JSON.stringify(provenance), now);
  }
  // Finding dispatch was a product-kind alias. Preserve its exact legacy rows
  // in audit provenance, then rebuild the live dispatch surface for the two
  // canonical subject kinds before dropping its referenced tables.
  if (tableExists(db, "agent_dispatch_events")) {
    const findingDispatches = db.prepare(
      "SELECT * FROM agent_dispatch_events WHERE subject_kind = 'finding' ORDER BY created_at, id",
    ).all();
    if (findingDispatches.length > 0) {
      db.prepare(
        `INSERT INTO briefing_legacy_audit
          (id, legacy_collection_id, disposition, reason, provenance_json, created_at)
         VALUES (?, ?, 'sealed_ambiguous', ?, ?, ?)`,
      ).run(stableId("briefing-audit", "finding-dispatches"), "finding-dispatches",
        "sealed retired finding dispatch events as immutable audit provenance",
        JSON.stringify({ agent_dispatch_events: findingDispatches }), now);
    }
    db.exec("CREATE TEMP TABLE agent_dispatch_events_v142 AS SELECT * FROM agent_dispatch_events WHERE subject_kind IN ('issue','incident')");
    db.exec("DROP TABLE agent_dispatch_events");
    db.exec(CANONICAL_AGENT_DISPATCH_SQL);
    db.exec(`INSERT INTO agent_dispatch_events
      SELECT id, subject_kind, issue_id, incident_id, incident_telemetry_sha256,
             actor_user_id, provider, instruction, cwd, prompt_path, prompt_sha256,
             status, session_handle, session_id, attach_command, error, created_at, settled_at
        FROM agent_dispatch_events_v142`);
    db.exec("DROP TABLE agent_dispatch_events_v142");
    db.exec("CREATE INDEX idx_agent_dispatch_events_issue ON agent_dispatch_events(issue_id, created_at DESC)");
    db.exec("CREATE INDEX idx_agent_dispatch_events_incident ON agent_dispatch_events(incident_id, created_at DESC)");
  }
  if (tableExists(db, "space_items")) {
    const findingItems = db.prepare(
      "SELECT * FROM space_items WHERE ref_type = 'finding' ORDER BY created_at, id",
    ).all() as Array<{ id: string }>;
    if (findingItems.length > 0) {
      const findingIds = findingItems.map((row) => row.id);
      const placeholders = findingIds.map(() => "?").join(",");
      const provenance = {
        space_items: findingItems,
        occurrences: db.prepare(`SELECT * FROM space_occurrences WHERE item_id IN (${placeholders})`).all(...findingIds),
        blocks: db.prepare(`SELECT * FROM space_blocks WHERE item_id IN (${placeholders})`).all(...findingIds),
      };
      db.prepare(
        `INSERT INTO briefing_legacy_audit
          (id, legacy_collection_id, disposition, reason, provenance_json, created_at)
         VALUES (?, ?, 'sealed_ambiguous', ?, ?, ?)`,
      ).run(stableId("briefing-audit", "space-findings"), "space-findings",
        "sealed retired Space finding references as immutable audit provenance",
        JSON.stringify(provenance), now);
      db.exec("CREATE TEMP TABLE retired_space_occurrences(id TEXT PRIMARY KEY)");
      db.prepare(`INSERT INTO retired_space_occurrences
        WITH RECURSIVE retired(id) AS (
          SELECT id FROM space_occurrences WHERE item_id IN (${placeholders})
          UNION SELECT o.id FROM space_occurrences o JOIN retired r ON o.parent_id = r.id
        ) SELECT id FROM retired`).run(...findingIds);
      db.exec("DELETE FROM space_edges WHERE source IN (SELECT id FROM retired_space_occurrences) OR target IN (SELECT id FROM retired_space_occurrences)");
      db.exec("DELETE FROM space_occurrences WHERE id IN (SELECT id FROM retired_space_occurrences)");
      db.exec("DROP TABLE retired_space_occurrences");
      db.prepare(`UPDATE space_blocks SET item_id = NULL WHERE item_id IN (${placeholders})`).run(...findingIds);
    }
    db.exec("CREATE TEMP TABLE space_items_v142 AS SELECT * FROM space_items WHERE ref_type != 'finding'");
    db.exec("DROP TABLE space_items");
    db.exec(CANONICAL_SPACE_ITEMS_SQL);
    db.exec("INSERT INTO space_items SELECT * FROM space_items_v142");
    db.exec("DROP TABLE space_items_v142");
    db.exec("CREATE INDEX idx_space_items_lookup ON space_items(space_id, ref_type, ref_id)");
    db.exec("CREATE INDEX idx_space_items_by_ref ON space_items(ref_type, ref_id, space_id)");
  }
  for (const statement of LEGACY_FEEDBACK_DROP_SQL) {
    try { db.exec(statement); } catch (error) {
      throw new Error(`migration 142 could not retire legacy feedback schema at '${statement}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
