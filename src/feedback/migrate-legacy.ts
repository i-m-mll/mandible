import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";

import { readArtifactBytesFull } from "../artifact-content.js";
import type { Db } from "../db.js";
import { tableExists } from "../db-introspection.js";
import { getCanonicalArtifactVersion } from "../provider-artifacts.js";
import { BRIEFING_SCHEMA_SQL } from "./schema.js";

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
