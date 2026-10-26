import { mutateBriefing } from "./mutation-history.js";
import { requestOriginJson } from "../request-origin.js";
import { createHash, randomUUID } from "node:crypto";

import { readArtifactBytesFull } from "../artifact-content.js";
import { canonicalJson } from "../canonical-json.js";
import type { Db } from "../db.js";
import {
  recordArtifactVersion,
  resolveArtifactIdentity,
} from "../provider-artifacts.js";
import { enforceActivePlacement } from "./briefing-placement.js";
import { parseBriefingDirectives } from "./briefing-directives.js";
import { BriefingStoreError, publishBriefingFromArtifactVersion, publishBriefingReportRound } from "./briefings.js";

export const BRIEFING_COMPOSITION_SCHEMA = "mandible-briefing-composition@2" as const;
export const BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA = "mandible-briefing-destination-routes@3" as const;
export type BriefingDestinationPublicationMode = "reviewed-document" | "published-report";

type SlotType = "string" | "string_array" | "number" | "boolean";
export type DestinationSlot = { type: SlotType; required?: boolean; max_length?: number; max_items?: number };

export type BriefingDestinationRouteInput = {
  route_key: string;
  logical_artifact_id: string;
  publication_mode: BriefingDestinationPublicationMode;
  heading: string;
  composer_kind: "deterministic" | "agentic";
  template_version: number;
  contribution_template: string;
  slots: Record<string, DestinationSlot>;
  limits: { max_contributions: number; max_document_bytes: number; max_directives: number };
};

export type BriefingDestinationRouteDeclaration = Omit<
  BriefingDestinationRouteInput,
  "logical_artifact_id" | "template_version" | "contribution_template" | "slots"
> & {
  logical_artifact_ref: string;
  expected_revision?: string;
  template: {
    version: number;
    contribution_template: string;
    slots: Record<string, DestinationSlot>;
  };
};

export type BriefingDestinationRouteManifest = {
  schema: typeof BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA;
  routes: BriefingDestinationRouteDeclaration[];
};

export type BriefingDestinationRoutePlan = {
  schema: typeof BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA;
  changed: boolean;
  routes: Array<{
    route_key: string;
    current_revision: string | null;
    action: "create" | "update" | "unchanged";
    publication_mode: BriefingDestinationPublicationMode;
    group_id: string;
    logical_artifact_id: string;
    heading: string;
    composer_kind: "deterministic" | "agentic";
    active_template_version: number;
    template_action: "create" | "reuse";
    limits: { max_contributions: number; max_document_bytes: number; max_directives: number };
  }>;
};

export type BriefingDestinationRouteInspection = {
  schema: typeof BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA;
  routes: Array<{
    route_key: string;
    publication_mode: BriefingDestinationPublicationMode;
    group_id: string;
    logical_artifact_id: string;
    heading: string;
    composer_kind: "deterministic" | "agentic";
    active_template_version: number;
    limits: { max_contributions: number; max_document_bytes: number; max_directives: number };
    templates: Array<{
      version: number;
      contribution_template: string;
      slots: Record<string, DestinationSlot>;
    }>;
  }>;
};

export type BriefingCompositionRequest = {
  schema: typeof BRIEFING_COMPOSITION_SCHEMA;
  task_identity: string;
  run_id: string;
  run_key: string;
  source: { key: string; cursor: string };
  source_health: { source: string; status: "healthy" | "degraded" | "unavailable"; detail: string | null; observed_at: number };
  responder_user_ids: string[];
  quiet_reason: string | null;
  inputs: Array<{ route_key: string; expected_artifact_version_ref: string;
    expected_current_round_id: string | null; agentic_markdown: string | null }>;
  contributions: Array<{
    route_key: string; change_id: string; evidence_ref: string; evidence_digest: string;
    occurred_at: number; slots: Record<string, unknown>;
  }>;
};

export type BriefingCompositionReceipt = {
  receipt_id: string;
  run_id: string;
  quiet: boolean;
  targets: Array<
    { publication_mode: "reviewed-document"; group_id: string; outcome: "queued" | "unchanged" | "proposed";
      base_bundle_id: string; proposal_bundle_id: string | null }
    | { publication_mode: "published-report"; group_id: string; logical_artifact_id: string;
      briefing_id: string; outcome: "unchanged" | "published"; previous_round_id: string; current_round_id: string;
      previous_artifact_version_id: string; current_artifact_version_id: string }
  >;
};

type RouteRow = {
  route_key: string; group_id: string; logical_artifact_id: string; heading: string;
  publication_mode: BriefingDestinationPublicationMode;
  composer_kind: "deterministic" | "agentic"; active_template_version: number;
  max_contributions: number; max_document_bytes: number; max_directives: number;
  contribution_template: string; slots_json: string;
};

type BaseDocument = {
  groupId: string; groupName: string; baseBundleId: string; briefingId: string; title: string;
  briefingKey: string; latestRoundId: string; logicalArtifactId: string; artifactVersionId: string;
  source: string; logicalName: string;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BriefingStoreError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw new BriefingStoreError(`${label} contains unsupported field '${extra[0]}'`);
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BriefingStoreError(`${label} must be a nonblank string`);
  return value.trim();
}

function exactNonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BriefingStoreError(`${label} must be a nonblank string`);
  return value;
}

function positiveInteger(value: unknown, label: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new BriefingStoreError(`${label} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function digest(value: unknown, label: string): string {
  const normalized = nonblank(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new BriefingStoreError(`${label} must be a SHA-256 digest`);
  return normalized;
}

function validateHealth(raw: unknown): BriefingCompositionRequest["source_health"] {
  const health = object(raw, "source_health");
  only(health, ["source", "status", "detail", "observed_at"], "source_health");
  if (!new Set(["healthy", "degraded", "unavailable"]).has(String(health.status))) {
    throw new BriefingStoreError("source_health.status must be healthy, degraded, or unavailable");
  }
  if (health.detail !== null && health.detail !== undefined && typeof health.detail !== "string") {
    throw new BriefingStoreError("source_health.detail must be a string or null");
  }
  return {
    source: nonblank(health.source, "source_health.source"),
    status: health.status as BriefingCompositionRequest["source_health"]["status"],
    detail: typeof health.detail === "string" ? health.detail : null,
    observed_at: positiveInteger(health.observed_at, "source_health.observed_at", true),
  };
}

export function parseBriefingCompositionRequest(value: unknown): BriefingCompositionRequest {
  const body = object(value, "request body");
  only(body, ["schema", "task_identity", "run_id", "run_key", "source", "source_health",
    "responder_user_ids", "quiet_reason", "inputs", "contributions"], "request body");
  if (body.schema !== BRIEFING_COMPOSITION_SCHEMA) {
    throw new BriefingStoreError(`schema must be '${BRIEFING_COMPOSITION_SCHEMA}'`);
  }
  const source = object(body.source, "source");
  only(source, ["key", "cursor"], "source");
  if (!Array.isArray(body.responder_user_ids) || body.responder_user_ids.length === 0
      || body.responder_user_ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new BriefingStoreError("responder_user_ids must be a non-empty array of user ids");
  }
  const quietReason = body.quiet_reason === null || body.quiet_reason === undefined
    ? null : nonblank(body.quiet_reason, "quiet_reason");
  if (!Array.isArray(body.inputs)) throw new BriefingStoreError("inputs must be an array");
  const inputs = body.inputs.map((raw, index) => {
    const input = object(raw, `inputs[${index}]`);
    only(input, ["route_key", "expected_artifact_version_ref", "expected_current_round_id", "agentic_markdown"],
      `inputs[${index}]`);
    return {
      route_key: nonblank(input.route_key, `inputs[${index}].route_key`),
      expected_artifact_version_ref: nonblank(input.expected_artifact_version_ref,
        `inputs[${index}].expected_artifact_version_ref`),
      expected_current_round_id: input.expected_current_round_id === undefined || input.expected_current_round_id === null
        ? null : nonblank(input.expected_current_round_id, `inputs[${index}].expected_current_round_id`),
      agentic_markdown: input.agentic_markdown === null || input.agentic_markdown === undefined
        ? null : exactNonblank(input.agentic_markdown, `inputs[${index}].agentic_markdown`),
    };
  });
  if (new Set(inputs.map((input) => input.route_key)).size !== inputs.length) {
    throw new BriefingStoreError("inputs must contain each route_key at most once");
  }
  if (!Array.isArray(body.contributions)) throw new BriefingStoreError("contributions must be an array");
  const contributions = body.contributions.map((raw, index) => {
    const contribution = object(raw, `contributions[${index}]`);
    only(contribution, ["route_key", "change_id", "evidence_ref", "evidence_digest", "occurred_at", "slots"],
      `contributions[${index}]`);
    return {
      route_key: nonblank(contribution.route_key, `contributions[${index}].route_key`),
      change_id: nonblank(contribution.change_id, `contributions[${index}].change_id`),
      evidence_ref: nonblank(contribution.evidence_ref, `contributions[${index}].evidence_ref`),
      evidence_digest: digest(contribution.evidence_digest, `contributions[${index}].evidence_digest`),
      occurred_at: positiveInteger(contribution.occurred_at, `contributions[${index}].occurred_at`, true),
      slots: object(contribution.slots, `contributions[${index}].slots`),
    };
  });
  const routeKeys = new Set((quietReason === null ? contributions : inputs).map((entry) => entry.route_key));
  if (quietReason !== null ? contributions.length !== 0 || inputs.length === 0 : contributions.length === 0) {
    throw new BriefingStoreError("quiet runs require destination inputs and no contributions; non-quiet runs require contributions");
  }
  if (quietReason === null && (inputs.length !== routeKeys.size || inputs.some((input) => !routeKeys.has(input.route_key)))) {
    throw new BriefingStoreError("inputs must match the contribution route keys exactly");
  }
  return {
    schema: BRIEFING_COMPOSITION_SCHEMA,
    task_identity: nonblank(body.task_identity, "task_identity"),
    run_id: nonblank(body.run_id, "run_id"),
    run_key: nonblank(body.run_key, "run_key"),
    source: { key: nonblank(source.key, "source.key"), cursor: nonblank(source.cursor, "source.cursor") },
    source_health: validateHealth(body.source_health),
    responder_user_ids: [...new Set((body.responder_user_ids as string[]).map((id) => id.trim()))],
    quiet_reason: quietReason,
    inputs,
    contributions,
  };
}

function validateSlotDefinitions(raw: Record<string, DestinationSlot>): Record<string, DestinationSlot> {
  const result: Record<string, DestinationSlot> = {};
  for (const [key, definition] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new BriefingStoreError("slot definitions require stable lowercase keys and object values");
    }
    only(definition as unknown as Record<string, unknown>, ["type", "required", "max_length", "max_items"], `slot '${key}'`);
    if (!new Set(["string", "string_array", "number", "boolean"]).has(definition.type)) {
      throw new BriefingStoreError(`slot '${key}' has an unsupported type`);
    }
    if (definition.required !== undefined && typeof definition.required !== "boolean") {
      throw new BriefingStoreError(`slot '${key}'.required must be boolean`);
    }
    if (definition.max_length !== undefined) positiveInteger(definition.max_length, `slot '${key}'.max_length`);
    if (definition.max_items !== undefined) positiveInteger(definition.max_items, `slot '${key}'.max_items`);
    result[key] = { ...definition };
  }
  return result;
}

export function parseBriefingDestinationRouteManifest(value: unknown): BriefingDestinationRouteManifest {
  const manifest = object(value, "route manifest");
  only(manifest, ["schema", "routes"], "route manifest");
  if (manifest.schema !== BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA) {
    throw new BriefingStoreError(`schema must be '${BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA}'`);
  }
  if (!Array.isArray(manifest.routes) || manifest.routes.length === 0) {
    throw new BriefingStoreError("route manifest routes must be a non-empty array");
  }
  const routes = manifest.routes.map((raw, index) => {
    const route = object(raw, `routes[${index}]`);
    only(route, ["route_key", "logical_artifact_ref", "publication_mode", "heading", "composer_kind", "template", "limits", "expected_revision"],
      `routes[${index}]`);
    if (route.publication_mode !== "reviewed-document" && route.publication_mode !== "published-report") {
      throw new BriefingStoreError(`routes[${index}].publication_mode must be reviewed-document or published-report`);
    }
    if (route.composer_kind !== "deterministic" && route.composer_kind !== "agentic") {
      throw new BriefingStoreError(`routes[${index}].composer_kind must be deterministic or agentic`);
    }
    const template = object(route.template, `routes[${index}].template`);
    only(template, ["version", "contribution_template", "slots"], `routes[${index}].template`);
    if (typeof template.contribution_template !== "string") {
      throw new BriefingStoreError(`routes[${index}].template.contribution_template must be a string`);
    }
    const limits = object(route.limits, `routes[${index}].limits`);
    only(limits, ["max_contributions", "max_document_bytes", "max_directives"], `routes[${index}].limits`);
    return {
      route_key: nonblank(route.route_key, `routes[${index}].route_key`),
      logical_artifact_ref: nonblank(route.logical_artifact_ref, `routes[${index}].logical_artifact_ref`),
      ...(route.expected_revision === undefined ? {} : {
        expected_revision: nonblank(route.expected_revision, `routes[${index}].expected_revision`),
      }),
      publication_mode: route.publication_mode,
      heading: nonblank(route.heading, `routes[${index}].heading`),
      composer_kind: route.composer_kind,
      template: {
        version: positiveInteger(template.version, `routes[${index}].template.version`),
        contribution_template: template.contribution_template,
        slots: validateSlotDefinitions(object(template.slots, `routes[${index}].template.slots`) as Record<string, DestinationSlot>),
      },
      limits: {
        max_contributions: positiveInteger(limits.max_contributions, `routes[${index}].limits.max_contributions`),
        max_document_bytes: positiveInteger(limits.max_document_bytes, `routes[${index}].limits.max_document_bytes`),
        max_directives: positiveInteger(limits.max_directives, `routes[${index}].limits.max_directives`, true),
      },
    } satisfies BriefingDestinationRouteDeclaration;
  });
  const duplicate = routes.map((route) => route.route_key)
    .find((routeKey, index, all) => all.indexOf(routeKey) !== index);
  if (duplicate) throw new BriefingStoreError(`route manifest declares route_key '${duplicate}' more than once`);
  return { schema: BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA, routes };
}

function currentBaseDocument(db: Db, route: Pick<RouteRow, "group_id" | "logical_artifact_id">): BaseDocument {
  const group = db.prepare(`SELECT id, name, current_bundle_id, archived_at FROM briefing_groups WHERE id = ?`)
    .get(route.group_id) as { id: string; name: string; current_bundle_id: string | null; archived_at: number | null } | undefined;
  if (!group || group.archived_at !== null || !group.current_bundle_id) {
    throw new BriefingStoreError("destination route requires an active Briefing group with a Base bundle", 409,
      "briefing_destination_base_unavailable");
  }
  const rows = db.prepare(`SELECT b.id AS briefing_id, b.briefing_key, b.title, b.latest_round_id,
      r.artifact_version_id, a.logical_name
    FROM briefing_bundle_members bm
    JOIN briefings b ON b.id = bm.briefing_id
    JOIN briefing_rounds r ON r.id = b.latest_round_id
    JOIN artifact a ON a.id = b.logical_artifact_id
    WHERE bm.bundle_id = ? AND b.logical_artifact_id = ? AND b.archived_at IS NULL`)
    .all(group.current_bundle_id, route.logical_artifact_id) as Array<{
      briefing_id: string; briefing_key: string; title: string; latest_round_id: string;
      artifact_version_id: string; logical_name: string | null;
    }>;
  if (rows.length !== 1) {
    throw new BriefingStoreError("destination route must resolve to exactly one Base document", 409,
      "briefing_destination_document_drift");
  }
  const bytes = readArtifactBytesFull(db, rows[0].artifact_version_id);
  if (!bytes.ok) throw new BriefingStoreError(`Base document bytes are unavailable: ${bytes.reason}`, 409,
    "briefing_destination_base_unavailable");
  return { groupId: group.id, groupName: group.name, baseBundleId: group.current_bundle_id,
    briefingId: rows[0].briefing_id, briefingKey: rows[0].briefing_key, latestRoundId: rows[0].latest_round_id,
    title: rows[0].title, logicalArtifactId: route.logical_artifact_id,
    artifactVersionId: rows[0].artifact_version_id, source: bytes.bytes.toString("utf8"),
    logicalName: rows[0].logical_name ?? `${rows[0].title}.md` };
}

function routeRow(db: Db, routeKey: string): RouteRow {
  const row = db.prepare(`SELECT r.*, policy.publication_mode, owner.group_id, t.contribution_template, t.slots_json
    FROM briefing_destination_routes r JOIN briefing_destination_templates t
      ON t.route_key = r.route_key AND t.version = r.active_template_version
    JOIN briefing_destination_policies policy ON policy.route_key = r.route_key
    JOIN briefing_destination_owners owner ON owner.logical_artifact_id = r.logical_artifact_id
    WHERE r.route_key = ?`).get(routeKey) as RouteRow | undefined;
  if (!row) throw new BriefingStoreError(`unknown destination route '${routeKey}'`, 409, "briefing_destination_unknown");
  return row;
}

type ResolvedRouteDeclaration = {
  route_key: string;
  expected_revision?: string;
  publication_mode: BriefingDestinationPublicationMode;
  group_id: string;
  logical_artifact_id: string;
  heading: string;
  composer_kind: "deterministic" | "agentic";
  template_version: number;
  contribution_template: string;
  slots: Record<string, DestinationSlot>;
  limits: { max_contributions: number; max_document_bytes: number; max_directives: number };
};

function resolveRouteDeclaration(db: Db, input: BriefingDestinationRouteDeclaration): ResolvedRouteDeclaration {
  const logical = resolveArtifactIdentity(db, input.logical_artifact_ref, "strict-read");
  if (logical.status !== "resolved" || logical.target_type !== "artifact" || !logical.target_id) {
    throw new BriefingStoreError("logical_artifact_ref must resolve to one logical Artifact", 404,
      "artifact_not_found");
  }
  const owner = db.prepare(`SELECT owner.group_id
    FROM briefing_destination_owners owner
    JOIN briefing_groups g ON g.id = owner.group_id
    WHERE owner.logical_artifact_id = ? AND g.archived_at IS NULL`).get(logical.target_id) as
    { group_id: string } | undefined;
  if (!owner) {
    throw new BriefingStoreError("logical Artifact has no active destination owner", 409,
      "briefing_destination_owner_unavailable");
  }
  if (input.composer_kind === "deterministic" && !input.template.contribution_template.includes("{{evidence_ref}}")) {
    throw new BriefingStoreError("deterministic contribution templates must render {{evidence_ref}}");
  }
  const placeholders = [...input.template.contribution_template.matchAll(/{{([a-z][a-z0-9_]*)}}/g)]
    .map((match) => match[1]);
  const allowed = new Set(["route_key", "change_id", "evidence_ref", "evidence_digest", "occurred_at",
    ...Object.keys(input.template.slots)]);
  const unknown = placeholders.find((placeholder) => !allowed.has(placeholder));
  if (unknown) throw new BriefingStoreError(`contribution template references unknown slot '${unknown}'`);
  return {
    route_key: input.route_key,
    expected_revision: input.expected_revision,
    publication_mode: input.publication_mode,
    group_id: owner.group_id,
    logical_artifact_id: logical.target_id,
    heading: input.heading,
    composer_kind: input.composer_kind,
    template_version: input.template.version,
    contribution_template: input.template.contribution_template,
    slots: input.template.slots,
    limits: input.limits,
  };
}

function planResolvedRoute(
  db: Db,
  route: ResolvedRouteDeclaration,
): BriefingDestinationRoutePlan["routes"][number] {
  const existing = db.prepare(`SELECT r.logical_artifact_id, r.heading, r.composer_kind, policy.publication_mode,
      active_template_version, max_contributions, max_document_bytes, max_directives
    FROM briefing_destination_routes r JOIN briefing_destination_policies policy ON policy.route_key = r.route_key
    WHERE r.route_key = ?`).get(route.route_key) as {
      logical_artifact_id: string; heading: string; composer_kind: string;
      publication_mode: BriefingDestinationPublicationMode;
      active_template_version: number; max_contributions: number; max_document_bytes: number; max_directives: number;
    } | undefined;
  const currentRevision = existing ? routeConfigurationRevision(db, route.route_key) : null;
  if (existing && (existing.logical_artifact_id !== route.logical_artifact_id
      || existing.heading !== route.heading || existing.composer_kind !== route.composer_kind)) {
    throw new BriefingStoreError("stable destination route ownership cannot be reassigned", 409,
      "briefing_destination_route_conflict");
  }
  if (existing && existing.publication_mode !== route.publication_mode) {
    throw new BriefingStoreError("An existing route cannot change between reviewed-document and published-report",
      409, "briefing_destination_policy_conflict");
  }
  const tupleOwner = db.prepare(`SELECT route_key, composer_kind FROM briefing_destination_routes
    WHERE logical_artifact_id = ? AND heading = ? LIMIT 1`)
    .get(route.logical_artifact_id, route.heading) as
    { route_key: string; composer_kind: string } | undefined;
  if (tupleOwner && tupleOwner.route_key !== route.route_key) {
    throw new BriefingStoreError("destination document heading is already owned by another stable route", 409,
      "briefing_destination_route_conflict");
  }
  const existingKind = db.prepare(`SELECT r.composer_kind, policy.publication_mode
    FROM briefing_destination_routes r JOIN briefing_destination_policies policy ON policy.route_key = r.route_key
    WHERE r.logical_artifact_id = ? AND r.route_key != ? LIMIT 1`).get(route.logical_artifact_id, route.route_key) as
    { composer_kind: string; publication_mode: BriefingDestinationPublicationMode } | undefined;
  if (existingKind && (existingKind.composer_kind !== route.composer_kind
      || existingKind.publication_mode !== route.publication_mode)) {
    throw new BriefingStoreError("all routes for one destination document must use one composer kind and publication mode", 409,
      "briefing_destination_policy_conflict");
  }
  if (existing && route.template_version < existing.active_template_version) {
    throw new BriefingStoreError("active template version cannot move backwards", 409,
      "briefing_destination_template_regression");
  }
  const existingTemplate = db.prepare(`SELECT contribution_template, slots_json
    FROM briefing_destination_templates WHERE route_key = ? AND version = ?`)
    .get(route.route_key, route.template_version) as { contribution_template: string; slots_json: string } | undefined;
  const slotsJson = canonicalJson(route.slots);
  if (existingTemplate && (existingTemplate.contribution_template !== route.contribution_template
      || existingTemplate.slots_json !== slotsJson)) {
    throw new BriefingStoreError("template versions are immutable", 409, "briefing_destination_template_conflict");
  }
  currentBaseDocument(db, { group_id: route.group_id, logical_artifact_id: route.logical_artifact_id });
  const changed = !existing || existing.publication_mode !== route.publication_mode
    || existing.active_template_version !== route.template_version
    || existing.max_contributions !== route.limits.max_contributions
    || existing.max_document_bytes !== route.limits.max_document_bytes
    || existing.max_directives !== route.limits.max_directives;
  return {
    route_key: route.route_key,
    current_revision: currentRevision,
    publication_mode: route.publication_mode,
    action: !existing ? "create" : changed ? "update" : "unchanged",
    group_id: route.group_id,
    logical_artifact_id: route.logical_artifact_id,
    heading: route.heading,
    composer_kind: route.composer_kind,
    active_template_version: route.template_version,
    template_action: existingTemplate ? "reuse" : "create",
    limits: route.limits,
  };
}

function routeConfigurationRevision(db: Db, routeKey: string): string {
  const row = db.prepare(`SELECT r.logical_artifact_id, r.heading, r.composer_kind,
      r.active_template_version, r.max_contributions, r.max_document_bytes, r.max_directives,
      policy.publication_mode, template.contribution_template, template.slots_json
    FROM briefing_destination_routes r
    JOIN briefing_destination_policies policy ON policy.route_key = r.route_key
    JOIN briefing_destination_templates template ON template.route_key = r.route_key
      AND template.version = r.active_template_version WHERE r.route_key = ?`).get(routeKey);
  return createHash("sha256").update(canonicalJson(row)).digest("hex");
}

function resolveAndPlanBriefingDestinationRoutes(
  db: Db,
  manifest: BriefingDestinationRouteManifest,
): { plan: BriefingDestinationRoutePlan; resolved: ResolvedRouteDeclaration[] } {
  const resolved = manifest.routes.map((route) => resolveRouteDeclaration(db, route))
    .sort((left, right) => left.route_key.localeCompare(right.route_key));
  const ownership = new Map<string, { composerKind: string; publicationMode: BriefingDestinationPublicationMode;
    headings: Map<string, string> }>();
  for (const route of resolved) {
    const key = `${route.group_id}\0${route.logical_artifact_id}`;
    const prior = ownership.get(key);
    if (prior && (prior.composerKind !== route.composer_kind || prior.publicationMode !== route.publication_mode)) {
      throw new BriefingStoreError("all routes for one destination document must use one composer kind and publication mode", 409,
        "briefing_destination_composer_conflict");
    }
    const priorRouteKey = prior?.headings.get(route.heading);
    if (priorRouteKey && priorRouteKey !== route.route_key) {
      throw new BriefingStoreError("destination document heading is declared by more than one stable route", 409,
        "briefing_destination_route_conflict");
    }
    if (prior) prior.headings.set(route.heading, route.route_key);
    else ownership.set(key, { composerKind: route.composer_kind, publicationMode: route.publication_mode,
      headings: new Map([[route.heading, route.route_key]]) });
  }
  const routes = resolved.map((route) => planResolvedRoute(db, route));
  return { resolved, plan: { schema: BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA,
    changed: routes.some((route) => route.action !== "unchanged"), routes } };
}

export function planBriefingDestinationRoutes(
  db: Db,
  manifest: BriefingDestinationRouteManifest,
): BriefingDestinationRoutePlan {
  return db.transaction(() => resolveAndPlanBriefingDestinationRoutes(db, manifest).plan).deferred();
}

export function reconcileBriefingDestinationRoutes(
  db: Db,
  manifest: BriefingDestinationRouteManifest,
  now = Date.now(),
): BriefingDestinationRoutePlan {
  return db.transaction(() => {
    const { plan, resolved } = resolveAndPlanBriefingDestinationRoutes(db, manifest);
    const byKey = new Map(resolved.map((route) => [route.route_key, route]));
    for (const planned of plan.routes) {
      if (planned.action === "unchanged") continue;
      const route = byKey.get(planned.route_key)!;
      if (planned.action === "update" && route.expected_revision !== planned.current_revision) {
        throw new BriefingStoreError(`route '${planned.route_key}' changed; provide its current_revision from route plan`,
          409, "briefing_destination_route_revision_drift",
          { route_key: planned.route_key, current_revision: planned.current_revision });
      }
      mutateBriefing(db, "briefing_route", route.route_key, () => {
      db.prepare(`INSERT INTO briefing_destination_routes
        (route_key, logical_artifact_id, heading, composer_kind, active_template_version,
         max_contributions, max_document_bytes, max_directives, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(route_key) DO UPDATE SET active_template_version = excluded.active_template_version,
          max_contributions = excluded.max_contributions, max_document_bytes = excluded.max_document_bytes,
          max_directives = excluded.max_directives, updated_at = excluded.updated_at`)
        .run(route.route_key, route.logical_artifact_id, route.heading, route.composer_kind,
          route.template_version, route.limits.max_contributions, route.limits.max_document_bytes,
          route.limits.max_directives, now, now);
      db.prepare(`INSERT OR IGNORE INTO briefing_destination_templates
        (route_key, version, contribution_template, slots_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(route.route_key, route.template_version, route.contribution_template, canonicalJson(route.slots), now);
      db.prepare(`INSERT INTO briefing_destination_policies (route_key, publication_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(route_key) DO UPDATE SET
          publication_mode = excluded.publication_mode, updated_at = excluded.updated_at`)
        .run(route.route_key, route.publication_mode, now, now);
      });
    }
    return plan;
  }).immediate();
}

export function inspectBriefingDestinationRoutes(db: Db, routeKey?: string): BriefingDestinationRouteInspection {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT r.route_key, policy.publication_mode, owner.group_id,
        r.logical_artifact_id, r.heading, r.composer_kind,
        active_template_version, max_contributions, max_document_bytes, max_directives
      FROM briefing_destination_routes r
      JOIN briefing_destination_policies policy ON policy.route_key = r.route_key
      JOIN briefing_destination_owners owner ON owner.logical_artifact_id = r.logical_artifact_id
      ${routeKey === undefined ? "" : "WHERE r.route_key = ?"}
      ORDER BY r.route_key`).all(...(routeKey === undefined ? [] : [nonblank(routeKey, "route_key")])) as Array<{
        route_key: string; publication_mode: BriefingDestinationPublicationMode;
        group_id: string; logical_artifact_id: string; heading: string;
        composer_kind: "deterministic" | "agentic"; active_template_version: number;
        max_contributions: number; max_document_bytes: number; max_directives: number;
      }>;
    if (routeKey !== undefined && rows.length === 0) {
      throw new BriefingStoreError(`unknown destination route '${routeKey}'`, 404, "briefing_destination_unknown");
    }
    const templates = db.prepare(`SELECT version, contribution_template, slots_json
      FROM briefing_destination_templates WHERE route_key = ? ORDER BY version`);
    return { schema: BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA, routes: rows.map((route) => ({
      route_key: route.route_key,
      publication_mode: route.publication_mode,
      group_id: route.group_id,
      logical_artifact_id: route.logical_artifact_id,
      heading: route.heading,
      composer_kind: route.composer_kind,
      active_template_version: route.active_template_version,
      limits: { max_contributions: route.max_contributions, max_document_bytes: route.max_document_bytes,
        max_directives: route.max_directives },
      templates: (templates.all(route.route_key) as Array<{
        version: number; contribution_template: string; slots_json: string;
      }>).map((template) => ({ version: template.version, contribution_template: template.contribution_template,
        slots: JSON.parse(template.slots_json) as Record<string, DestinationSlot> })),
    })) };
  }).deferred();
}

export function registerBriefingDestinationRoute(db: Db, input: BriefingDestinationRouteInput, now = Date.now()): void {
  reconcileBriefingDestinationRoutes(db, parseBriefingDestinationRouteManifest({
    schema: BRIEFING_DESTINATION_ROUTE_MANIFEST_SCHEMA,
    routes: [{
      route_key: input.route_key,
      logical_artifact_ref: input.logical_artifact_id,
      publication_mode: input.publication_mode,
      heading: input.heading,
      composer_kind: input.composer_kind,
      template: { version: input.template_version, contribution_template: input.contribution_template,
        slots: input.slots },
      limits: input.limits,
    }],
  }), now);
}

function exactVersionId(db: Db, ref: string): string {
  const resolved = resolveArtifactIdentity(db, ref, "strict-read");
  if (resolved.status !== "resolved" || resolved.target_type !== "artifact_version" || !resolved.target_id) {
    throw new BriefingStoreError("expected_artifact_version_ref must resolve to one exact artifact version", 404,
      "artifact_version_not_found");
  }
  return resolved.target_id;
}

function validateSlots(route: RouteRow, slots: Record<string, unknown>): Record<string, unknown> {
  const definitions = JSON.parse(route.slots_json) as Record<string, DestinationSlot>;
  const extra = Object.keys(slots).find((key) => !Object.hasOwn(definitions, key));
  if (extra) throw new BriefingStoreError(`route '${route.route_key}' does not declare slot '${extra}'`);
  const result: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(definitions)) {
    const value = slots[key];
    if (value === undefined) {
      if (definition.required) throw new BriefingStoreError(`route '${route.route_key}' requires slot '${key}'`);
      continue;
    }
    const valid = definition.type === "string" ? typeof value === "string" && Boolean(value.trim())
      : definition.type === "string_array" ? Array.isArray(value) && value.length > 0
        && value.every((entry) => typeof entry === "string" && entry.trim())
      : definition.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : typeof value === "boolean";
    if (!valid) throw new BriefingStoreError(`route '${route.route_key}' slot '${key}' must be ${definition.type}`);
    if (definition.max_length !== undefined && typeof value === "string" && value.length > definition.max_length) {
      throw new BriefingStoreError(`route '${route.route_key}' slot '${key}' exceeds its size limit`, 413,
        "briefing_contribution_too_large");
    }
    if (definition.max_items !== undefined && Array.isArray(value) && value.length > definition.max_items) {
      throw new BriefingStoreError(`route '${route.route_key}' slot '${key}' exceeds its item limit`, 413,
        "briefing_contribution_too_large");
    }
    result[key] = value;
  }
  return result;
}

function renderContribution(route: RouteRow, contribution: Record<string, unknown>): string {
  const values: Record<string, unknown> = { ...JSON.parse(String(contribution.slots_json)),
    route_key: route.route_key, change_id: contribution.change_id, evidence_ref: contribution.evidence_ref,
    evidence_digest: contribution.evidence_digest, occurred_at: contribution.occurred_at };
  return route.contribution_template.replace(/{{([a-z][a-z0-9_]*)}}/g, (_match, key: string) => {
    const value = values[key];
    return Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
  }).trim();
}

function insertUnderHeading(source: string, heading: string, blocks: readonly string[]): string {
  const lines = source.split(/(?<=\n)/);
  const matches: Array<{ index: number; level: number }> = [];
  let offset = 0;
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*(?:\r?\n)?$/.exec(line);
    if (match && match[2] === heading) matches.push({ index: offset + line.length, level: match[1].length });
    offset += line.length;
  }
  if (matches.length !== 1) throw new BriefingStoreError(`Base document must contain exactly one '${heading}' heading`,
    409, "briefing_destination_heading_drift");
  const start = matches[0].index;
  const tail = source.slice(start);
  const next = new RegExp(`^#{1,${matches[0].level}}\\s+`, "m").exec(tail);
  const end = next ? start + (next.index ?? 0) : source.length;
  const prefix = source.slice(0, end).replace(/[ \t\r\n]+$/, "");
  const suffix = source.slice(end).replace(/^[ \t\r\n]+/, "");
  return `${prefix}\n\n${blocks.join("\n\n")}\n${suffix ? `\n${suffix}` : ""}`;
}

function assertExactHeading(source: string, heading: string): void {
  const matches = source.split(/\r?\n/).filter((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    return match?.[2] === heading;
  });
  if (matches.length !== 1) throw new BriefingStoreError(`document must contain exactly one '${heading}' heading`,
    409, "briefing_destination_heading_drift");
}

function validateDocument(route: RouteRow, markdown: string, evidenceRefs: readonly string[]): void {
  if (Buffer.byteLength(markdown, "utf8") > route.max_document_bytes) {
    throw new BriefingStoreError(`route '${route.route_key}' exceeds its document byte limit`, 413,
      "briefing_document_too_large");
  }
  let directives;
  try { directives = parseBriefingDirectives(markdown, "mandible-briefing.v3", { allowEmpty: true }); }
  catch (error) { throw new BriefingStoreError(error instanceof Error ? error.message : String(error), 400,
    "invalid_briefing_document"); }
  if (directives.length > route.max_directives) {
    throw new BriefingStoreError(`route '${route.route_key}' exceeds its directive limit`, 413,
      "briefing_directive_limit");
  }
  for (const evidenceRef of evidenceRefs) {
    if (!markdown.includes(evidenceRef)) throw new BriefingStoreError(
      `route '${route.route_key}' output omits evidence '${evidenceRef}'`, 409, "briefing_evidence_omitted");
  }
}

function receiptForRun(db: Db, row: { id: string; run_id: string; quiet: number }): BriefingCompositionReceipt {
  const reviewed = db.prepare(`SELECT 'reviewed-document' AS publication_mode,
      group_id, outcome, base_bundle_id, proposal_bundle_id
    FROM briefing_composition_targets WHERE run_id = ? ORDER BY group_id`).all(row.id) as
    Extract<BriefingCompositionReceipt["targets"][number], { publication_mode: "reviewed-document" }>[];
  const reports = db.prepare(`SELECT 'published-report' AS publication_mode, group_id, logical_artifact_id,
      briefing_id, outcome, previous_round_id, current_round_id,
      previous_artifact_version_id, current_artifact_version_id
    FROM briefing_composition_report_publications WHERE run_id = ? ORDER BY logical_artifact_id`).all(row.id) as
    Extract<BriefingCompositionReceipt["targets"][number], { publication_mode: "published-report" }>[];
  return { receipt_id: row.id, run_id: row.run_id, quiet: row.quiet === 1, targets: [...reviewed, ...reports] };
}

function cloneBaseBundle(db: Db, base: BaseDocument, replacements: ReadonlyMap<string, string>, now: number): string {
  const members = db.prepare(`SELECT briefing_id, layout_position, entry_kind, subgroup_name, subgroup_position
    FROM briefing_bundle_members WHERE bundle_id = ? ORDER BY layout_position, subgroup_position`)
    .all(base.baseBundleId) as Array<{ briefing_id: string; layout_position: number; entry_kind: string;
      subgroup_name: string | null; subgroup_position: number }>;
  const briefingIds = members.map((member) => replacements.get(member.briefing_id) ?? member.briefing_id);
  enforceActivePlacement(db, { operation: "composition_proposal", target: { kind: "group", id: base.groupId },
    briefingIds, now });
  const bundleId = randomUUID();
  db.prepare("INSERT INTO briefing_bundles (request_origin_json, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(requestOriginJson(), bundleId, `${base.groupName} proposed update`, now, now);
  const insert = db.prepare(`INSERT INTO briefing_bundle_members
    (bundle_id, briefing_id, layout_position, entry_kind, subgroup_name, subgroup_position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  members.forEach((member) => insert.run(bundleId, replacements.get(member.briefing_id) ?? member.briefing_id,
    member.layout_position, member.entry_kind, member.subgroup_name, member.subgroup_position, now));
  db.prepare(`INSERT INTO briefing_group_updates (request_origin_json, group_id, bundle_id, position, created_at)
    VALUES (?, ?, ?, 0, ?)`).run(requestOriginJson(), base.groupId, bundleId, now);
  db.prepare("UPDATE briefing_groups SET updated_at = ? WHERE id = ?").run(now, base.groupId);
  return bundleId;
}

export function publishBriefingCompositionRun(db: Db, request: BriefingCompositionRequest,
  publisherUserId: string, now = Date.now()): BriefingCompositionReceipt {
  const requestDigest = createHash("sha256").update(canonicalJson(request)).digest("hex");
  const replay = db.prepare(`SELECT id, run_id, quiet, request_digest FROM briefing_composition_runs
    WHERE publisher_user_id = ? AND task_identity = ? AND run_key = ?`)
    .get(publisherUserId, request.task_identity, request.run_key) as
    { id: string; run_id: string; quiet: number; request_digest: string } | undefined;
  if (replay) {
    if (replay.request_digest !== requestDigest) throw new BriefingStoreError(
      "run replay conflicts with the stored request body", 409, "run_replay_conflict");
    return receiptForRun(db, replay);
  }
  for (const responder of request.responder_user_ids) {
    const user = db.prepare("SELECT kind, status FROM users WHERE id = ?").get(responder) as
      { kind: string; status: string } | undefined;
    if (!user || user.kind !== "human" || user.status !== "active") {
      throw new BriefingStoreError(`responder '${responder}' is not an active human`, 400, "invalid_responder");
    }
  }
  return db.transaction(() => {
    const receiptId = randomUUID();
    const routes = new Map(request.inputs.map((input) => {
      const route = routeRow(db, input.route_key);
      return [route.route_key, route] as const;
    }));
    const publisher = db.prepare("SELECT slug FROM users WHERE id = ? AND kind = 'agent' AND status = 'active'")
      .get(publisherUserId) as { slug: string } | undefined;
    if (!publisher) throw new BriefingStoreError("composition publisher is not an active agent", 403,
      "briefing_publisher_agent_required");
    if (routes.has("digest.repository-maintenance") && (publisher.slug !== "agent-schedule"
        || request.task_identity !== "agent-schedule/repo-janitor"
        || request.source.key !== "repo-janitor" || request.source_health.source !== "repo-janitor")) {
      throw new BriefingStoreError("digest.repository-maintenance requires the exact agent-schedule repo-janitor publisher binding",
        403, "briefing_destination_publisher_forbidden");
    }
    const inputs = new Map(request.inputs.map((input) => [input.route_key, input]));
    const bases = new Map<string, BaseDocument>();
    for (const route of routes.values()) {
      const base = currentBaseDocument(db, route);
      const expected = exactVersionId(db, inputs.get(route.route_key)!.expected_artifact_version_ref);
      if (expected !== base.artifactVersionId) throw new BriefingStoreError(
        `${route.publication_mode === "published-report" ? "Current" : "Base"} drifted for destination route '${route.route_key}'`,
        409, route.publication_mode === "published-report" ? "briefing_destination_current_drift"
          : "briefing_destination_base_drift",
        { route_key: route.route_key, expected_artifact_version_id: expected,
          current_artifact_version_id: base.artifactVersionId });
      const expectedRoundId = inputs.get(route.route_key)!.expected_current_round_id;
      if (route.publication_mode === "published-report") {
        if (expectedRoundId === null) throw new BriefingStoreError(
          `published-report route '${route.route_key}' requires expected_current_round_id`, 400,
          "briefing_destination_current_round_required");
        if (expectedRoundId !== base.latestRoundId) throw new BriefingStoreError(
          `Current round drifted for destination route '${route.route_key}'`, 409,
          "briefing_destination_current_drift", { route_key: route.route_key,
            expected_current_round_id: expectedRoundId, current_round_id: base.latestRoundId,
            expected_artifact_version_id: expected, current_artifact_version_id: base.artifactVersionId });
      } else if (expectedRoundId !== null) {
        throw new BriefingStoreError(
          `reviewed-document route '${route.route_key}' must not carry expected_current_round_id`, 400,
          "briefing_destination_current_round_forbidden");
      }
      if ((request.quiet_reason !== null || route.composer_kind === "deterministic")
          && inputs.get(route.route_key)!.agentic_markdown !== null) {
        throw new BriefingStoreError(`route '${route.route_key}' must not carry agentic_markdown for this run`);
      }
      if (request.quiet_reason === null && route.composer_kind === "agentic"
          && inputs.get(route.route_key)!.agentic_markdown === null) {
        throw new BriefingStoreError(`agentic route '${route.route_key}' requires agentic_markdown`);
      }
      bases.set(`${base.groupId}:${base.logicalArtifactId}`, base);
    }
    db.prepare(`INSERT INTO briefing_composition_runs
      (request_origin_json, id, publisher_user_id, task_identity, run_id, run_key, request_digest, source_key, source_cursor,
       source_health_json, quiet, quiet_reason, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestOriginJson(), receiptId, publisherUserId, request.task_identity, request.run_id, request.run_key, requestDigest,
        request.source.key, request.source.cursor, canonicalJson(request.source_health), request.quiet_reason === null ? 0 : 1,
        request.quiet_reason, now);
    const insertInput = db.prepare(`INSERT INTO briefing_composition_inputs
      (run_id, route_key, expected_base_artifact_version_id, expected_current_round_id, agentic_markdown)
      VALUES (?, ?, ?, ?, ?)`);
    for (const input of request.inputs) {
      const route = routes.get(input.route_key)!;
      const base = bases.get(`${route.group_id}:${route.logical_artifact_id}`)!;
      insertInput.run(receiptId, input.route_key, base.artifactVersionId,
        input.expected_current_round_id, input.agentic_markdown);
    }
    const insertContribution = db.prepare(`INSERT OR IGNORE INTO briefing_composition_contributions
      (request_origin_json, id, run_id, publisher_user_id, source_key, route_key, change_id, evidence_ref, evidence_digest,
       occurred_at, slots_json, observed_base_artifact_version_id, state, proposal_bundle_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`);
    for (const contribution of request.contributions) {
      const route = routes.get(contribution.route_key)!;
      const base = bases.get(`${route.group_id}:${route.logical_artifact_id}`)!;
      insertContribution.run(requestOriginJson(), randomUUID(), receiptId, publisherUserId, request.source.key, route.route_key,
        contribution.change_id, contribution.evidence_ref, contribution.evidence_digest, contribution.occurred_at,
        canonicalJson(validateSlots(route, contribution.slots)), base.artifactVersionId, now);
    }
    const targets: BriefingCompositionReceipt["targets"] = [];
    if (request.quiet_reason !== null) {
      const reportDocuments = new Map([...routes.values()].filter((route) => route.publication_mode === "published-report")
        .map((route) => [route.logical_artifact_id, route]));
      for (const route of reportDocuments.values()) {
        const current = bases.get(`${route.group_id}:${route.logical_artifact_id}`)!;
        db.prepare(`INSERT INTO briefing_composition_report_publications
          (request_origin_json, run_id, logical_artifact_id, group_id, briefing_id, outcome, previous_round_id, current_round_id,
           previous_artifact_version_id, current_artifact_version_id, created_at)
          VALUES (?, ?, ?, ?, ?, 'unchanged', ?, ?, ?, ?, ?)`).run(requestOriginJson(), receiptId, current.logicalArtifactId,
          current.groupId, current.briefingId, current.latestRoundId, current.latestRoundId,
          current.artifactVersionId, current.artifactVersionId, now);
        targets.push({ publication_mode: "published-report", group_id: current.groupId,
          logical_artifact_id: current.logicalArtifactId, briefing_id: current.briefingId, outcome: "unchanged",
          previous_round_id: current.latestRoundId, current_round_id: current.latestRoundId,
          previous_artifact_version_id: current.artifactVersionId,
          current_artifact_version_id: current.artifactVersionId });
      }
      for (const groupId of [...new Set([...routes.values()].filter((route) => route.publication_mode === "reviewed-document")
        .map((route) => route.group_id))].sort()) {
        const route = [...routes.values()].find((candidate) => candidate.group_id === groupId)!;
        const base = bases.get(`${route.group_id}:${route.logical_artifact_id}`)!;
        db.prepare(`INSERT INTO briefing_composition_targets
          (request_origin_json, run_id, group_id, outcome, base_bundle_id, proposal_bundle_id) VALUES (?, ?, ?, 'unchanged', ?, NULL)`)
          .run(requestOriginJson(), receiptId, groupId, base.baseBundleId);
        targets.push({ publication_mode: "reviewed-document", group_id: groupId, outcome: "unchanged",
          base_bundle_id: base.baseBundleId, proposal_bundle_id: null });
      }
      return { receipt_id: receiptId, run_id: request.run_id, quiet: true, targets };
    }

    const reportRoutes = [...routes.values()].filter((route) => route.publication_mode === "published-report");
    const reportDocumentIds = [...new Set(reportRoutes.map((route) => route.logical_artifact_id))].sort();
    for (const logicalArtifactId of reportDocumentIds) {
      const documentRoutes = reportRoutes.filter((route) => route.logical_artifact_id === logicalArtifactId)
        .sort((left, right) => left.route_key.localeCompare(right.route_key));
      const current = bases.get(`${documentRoutes[0].group_id}:${logicalArtifactId}`)!;
      const contributions = db.prepare(`SELECT c.* FROM briefing_composition_contributions c
        WHERE c.run_id = ? AND c.route_key IN (${documentRoutes.map(() => "?").join(",")})
        ORDER BY c.created_at, c.id`).all(receiptId, ...documentRoutes.map((route) => route.route_key)) as
        Array<Record<string, unknown>>;
      let markdown = current.source;
      if (documentRoutes[0].composer_kind === "agentic") {
        const candidates = [...new Set(documentRoutes.map((route) => inputs.get(route.route_key)?.agentic_markdown)
          .filter((value): value is string => typeof value === "string"))];
        if (candidates.length !== 1) throw new BriefingStoreError(
          "agentic routes for one report must provide one identical complete document", 409,
          "briefing_destination_agentic_conflict");
        markdown = candidates[0];
        for (const route of documentRoutes) {
          const routed = contributions.filter((entry) => entry.route_key === route.route_key);
          if (routed.length > route.max_contributions) throw new BriefingStoreError(
            `route '${route.route_key}' exceeds its contribution limit`, 413, "briefing_contribution_limit");
          assertExactHeading(markdown, route.heading);
          validateDocument(route, markdown, routed.map((entry) => String(entry.evidence_ref)));
        }
      } else {
        for (const route of documentRoutes) {
          const routed = contributions.filter((entry) => entry.route_key === route.route_key);
          if (routed.length > route.max_contributions) throw new BriefingStoreError(
            `route '${route.route_key}' exceeds its contribution limit`, 413, "briefing_contribution_limit");
          markdown = insertUnderHeading(markdown, route.heading, routed.map((entry) => renderContribution(route, entry)));
          validateDocument(route, markdown, routed.map((entry) => String(entry.evidence_ref)));
        }
      }
      const contributionIds = contributions.map((entry) => String(entry.id));
      // Report rounds deliberately reuse prior document bytes; run provenance belongs to the publication receipt.
      const priorDocument = db.prepare(`SELECT id FROM artifact_version WHERE artifact_id=? AND content_hash=?
        AND source_kind='managed' AND custody_mode='managed' ORDER BY version_no DESC LIMIT 1`)
        .get(current.logicalArtifactId, createHash('sha256').update(markdown).digest('hex')) as { id: string } | undefined;
      const artifactVersionId = priorDocument?.id ?? recordArtifactVersion(db, { source_kind: "managed", content: markdown,
        artifact_id: current.logicalArtifactId, logical_name: current.logicalName, title: current.title,
        role: "briefing-document", media_type: "text/markdown",
        metadata: { composer: BRIEFING_COMPOSITION_SCHEMA,
          previous_current_artifact_version_id: current.artifactVersionId } }, now).artifact_version.id;
      const published = publishBriefingReportRound(db, { briefing_id: current.briefingId,
        artifact_version_ref: artifactVersionId,
        expected_current_round_id: inputs.get(documentRoutes[0].route_key)!.expected_current_round_id!,
        expected_current_artifact_version_ref: current.artifactVersionId,
        responder_user_ids: request.responder_user_ids }, now);
      const currentRoundId = published.round_id;
      const currentVersionId = published.artifact_version_id;
      const outcome = "published" as const;
      if (contributionIds.length) {
        db.prepare(`UPDATE briefing_composition_contributions SET state = 'composed'
          WHERE id IN (${contributionIds.map(() => "?").join(",")})`).run(...contributionIds);
      }
      db.prepare(`INSERT INTO briefing_composition_report_publications
        (request_origin_json, run_id, logical_artifact_id, group_id, briefing_id, outcome, previous_round_id, current_round_id,
         previous_artifact_version_id, current_artifact_version_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(requestOriginJson(), receiptId, current.logicalArtifactId, current.groupId,
        current.briefingId, outcome, current.latestRoundId, currentRoundId, current.artifactVersionId,
        currentVersionId, now);
      targets.push({ publication_mode: "published-report", group_id: current.groupId,
        logical_artifact_id: current.logicalArtifactId, briefing_id: current.briefingId, outcome,
        previous_round_id: current.latestRoundId, current_round_id: currentRoundId,
        previous_artifact_version_id: current.artifactVersionId,
        current_artifact_version_id: currentVersionId });
    }

    const groupIds = [...new Set([...routes.values()].filter((route) => route.publication_mode === "reviewed-document")
      .map((route) => route.group_id))].sort();
    for (const groupId of groupIds) {
      const anyRoute = [...routes.values()].find((route) => route.group_id === groupId)!;
      const anyBase = currentBaseDocument(db, anyRoute);
      const active = db.prepare("SELECT bundle_id FROM briefing_group_updates WHERE group_id = ? ORDER BY position")
        .all(groupId) as Array<{ bundle_id: string }>;
      if (active.length > 1) throw new BriefingStoreError("destination group has more than one active proposal", 409,
        "briefing_destination_proposal_drift");
      if (active.length === 1) {
        db.prepare(`INSERT INTO briefing_composition_targets
          (request_origin_json, run_id, group_id, outcome, base_bundle_id, proposal_bundle_id) VALUES (?, ?, ?, 'queued', ?, NULL)`)
          .run(requestOriginJson(), receiptId, groupId, anyBase.baseBundleId);
      targets.push({ publication_mode: "reviewed-document", group_id: groupId, outcome: "queued", base_bundle_id: anyBase.baseBundleId,
          proposal_bundle_id: null });
        continue;
      }
      const pending = db.prepare(`SELECT c.* FROM briefing_composition_contributions c
        JOIN briefing_destination_routes r ON r.route_key = c.route_key
        JOIN briefing_destination_policies policy ON policy.route_key = r.route_key
        JOIN briefing_destination_owners owner ON owner.logical_artifact_id = r.logical_artifact_id
        WHERE owner.group_id = ? AND policy.publication_mode = 'reviewed-document'
          AND c.state = 'pending' ORDER BY c.created_at, c.id`).all(groupId) as Array<Record<string, unknown>>;
      if (pending.length === 0) {
        db.prepare(`INSERT INTO briefing_composition_targets
          (request_origin_json, run_id, group_id, outcome, base_bundle_id, proposal_bundle_id) VALUES (?, ?, ?, 'unchanged', ?, NULL)`)
          .run(requestOriginJson(), receiptId, groupId, anyBase.baseBundleId);
        targets.push({ publication_mode: "reviewed-document", group_id: groupId, outcome: "unchanged", base_bundle_id: anyBase.baseBundleId,
          proposal_bundle_id: null });
        continue;
      }
      const pendingRoutes = new Map<string, RouteRow>();
      pending.forEach((contribution) => pendingRoutes.set(String(contribution.route_key), routeRow(db, String(contribution.route_key))));
      const byDocument = new Map<string, { base: BaseDocument; routes: RouteRow[]; contributions: Array<Record<string, unknown>> }>();
      for (const route of pendingRoutes.values()) {
        const base = currentBaseDocument(db, route);
        const key = base.logicalArtifactId;
        const group = byDocument.get(key) ?? { base, routes: [], contributions: [] };
        group.routes.push(route);
        group.contributions.push(...pending.filter((contribution) => contribution.route_key === route.route_key));
        byDocument.set(key, group);
      }
      const missingAgenticInput = [...byDocument.values()].some((document) =>
        document.routes[0].composer_kind === "agentic"
        && !document.routes.some((route) => typeof inputs.get(route.route_key)?.agentic_markdown === "string"));
      if (missingAgenticInput) {
        db.prepare(`INSERT INTO briefing_composition_targets
          (request_origin_json, run_id, group_id, outcome, base_bundle_id, proposal_bundle_id) VALUES (?, ?, ?, 'queued', ?, NULL)`)
          .run(requestOriginJson(), receiptId, groupId, anyBase.baseBundleId);
        targets.push({ publication_mode: "reviewed-document", group_id: groupId, outcome: "queued", base_bundle_id: anyBase.baseBundleId,
          proposal_bundle_id: null });
        continue;
      }
      const replacements = new Map<string, string>();
      const composedContributionIds: string[] = [];
      for (const document of byDocument.values()) {
        let markdown = document.base.source;
        const kind = document.routes[0].composer_kind;
        const routeGroups = document.routes.sort((a, b) => a.route_key.localeCompare(b.route_key));
        if (kind === "agentic") {
          const candidates = [...new Set(routeGroups.map((route) => inputs.get(route.route_key)?.agentic_markdown)
            .filter((value): value is string => typeof value === "string"))];
          if (candidates.length !== 1) throw new BriefingStoreError(
            "agentic routes for one document must provide one identical complete document", 409,
            "briefing_destination_agentic_conflict");
          const candidate = candidates[0];
          markdown = candidate;
          for (const route of routeGroups) {
            const contributions = document.contributions.filter((entry) => entry.route_key === route.route_key);
            if (contributions.length > route.max_contributions) throw new BriefingStoreError(
              `route '${route.route_key}' exceeds its contribution limit`, 413, "briefing_contribution_limit");
            assertExactHeading(markdown, route.heading);
            validateDocument(route, markdown, contributions.map((entry) => String(entry.evidence_ref)));
          }
        } else {
          for (const route of routeGroups) {
            const contributions = document.contributions.filter((entry) => entry.route_key === route.route_key);
            if (contributions.length > route.max_contributions) throw new BriefingStoreError(
              `route '${route.route_key}' exceeds its contribution limit`, 413, "briefing_contribution_limit");
            markdown = insertUnderHeading(markdown, route.heading,
              contributions.map((contribution) => renderContribution(route, contribution)));
            validateDocument(route, markdown, contributions.map((entry) => String(entry.evidence_ref)));
          }
        }
        if (markdown === document.base.source) {
          composedContributionIds.push(...document.contributions.map((entry) => String(entry.id)));
          continue;
        }
        const artifact = recordArtifactVersion(db, { source_kind: "managed", content: markdown,
          artifact_id: document.base.logicalArtifactId, logical_name: document.base.logicalName, title: document.base.title,
          role: "briefing-document", media_type: "text/markdown",
          metadata: { composer: BRIEFING_COMPOSITION_SCHEMA, base_artifact_version_id: document.base.artifactVersionId } }, now);
        const published = publishBriefingFromArtifactVersion(db, { briefing_key: `composition:${artifact.artifact_version.id}`,
          title: document.base.title, artifact_version_ref: artifact.artifact_version.id,
          comparison_base_artifact_version_ref: document.base.artifactVersionId,
          profile: "mandible-briefing.v3", responder_user_ids: request.responder_user_ids,
          distinct_reason: "Base-relative destination proposal",
          creation_provenance: { actor_user_id: publisherUserId, evidence_method: "api_token", credential_id: null } }, now);
        if (published.outcome === "active_candidates") throw new BriefingStoreError(
          "proposal Briefing identity could not be created", 409, "briefing_destination_identity_conflict");
        replacements.set(document.base.briefingId, published.briefing_id);
        composedContributionIds.push(...document.contributions.map((entry) => String(entry.id)));
      }
      if (replacements.size === 0) {
        if (composedContributionIds.length) {
          const placeholders = composedContributionIds.map(() => "?").join(",");
          db.prepare(`UPDATE briefing_composition_contributions SET state = 'composed' WHERE id IN (${placeholders})`)
            .run(...composedContributionIds);
        }
        db.prepare(`INSERT INTO briefing_composition_targets
          (request_origin_json, run_id, group_id, outcome, base_bundle_id, proposal_bundle_id) VALUES (?, ?, ?, 'unchanged', ?, NULL)`)
          .run(requestOriginJson(), receiptId, groupId, anyBase.baseBundleId);
        targets.push({ publication_mode: "reviewed-document", group_id: groupId, outcome: "unchanged", base_bundle_id: anyBase.baseBundleId,
          proposal_bundle_id: null });
        continue;
      }
      const proposalBundleId = cloneBaseBundle(db, anyBase, replacements, now);
      const placeholders = composedContributionIds.map(() => "?").join(",");
      db.prepare(`UPDATE briefing_composition_contributions SET state = 'composed', proposal_bundle_id = ?
        WHERE id IN (${placeholders})`).run(proposalBundleId, ...composedContributionIds);
      db.prepare(`INSERT INTO briefing_composition_targets
        (request_origin_json, run_id, group_id, outcome, base_bundle_id, proposal_bundle_id) VALUES (?, ?, ?, 'proposed', ?, ?)`)
        .run(requestOriginJson(), receiptId, groupId, anyBase.baseBundleId, proposalBundleId);
      targets.push({ publication_mode: "reviewed-document", group_id: groupId, outcome: "proposed", base_bundle_id: anyBase.baseBundleId,
        proposal_bundle_id: proposalBundleId });
    }
    const quiet = targets.every((target) => target.outcome === "unchanged");
    if (quiet) db.prepare("UPDATE briefing_composition_runs SET quiet = 1, quiet_reason = 'identical output' WHERE id = ?")
      .run(receiptId);
    return { receipt_id: receiptId, run_id: request.run_id, quiet, targets };
  }).immediate();
}
