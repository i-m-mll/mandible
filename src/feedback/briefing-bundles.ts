import { canonicalJson } from "../canonical-json.js";
import { requestOriginFromRow } from "../ledger/origin-read.js";
import { mutateBriefing } from "./mutation-history.js";
import { requestOriginJson } from "../request-origin.js";
import { randomUUID } from "node:crypto";

import type {
  BriefingBundle, BriefingBundleLayoutEntry, BriefingBundleLeaf,
  BriefingBundleMember, BriefingListEntry, TrackedBriefingPath,
} from "../contracts.js";
import type { Db } from "../db.js";
import { BRIEFING_HAS_ROUND_SQL, BriefingStoreError, resolveBriefingId } from "./briefings.js";
import { enforceActivePlacement, placementTargetForBundle, type PlacementOverride } from "./briefing-placement.js";
import { resolveId } from "../entity-refs.js";

import { resolveProjectRef } from "../ledger/project-registry.js";
import { isTrackedBriefingPath, trackedBriefingReader, type TrackedBriefingReader } from "./tracked-briefing-files.js";

export type BriefingBundleViewer = { userId: string; operator: boolean; humanReviewOperator?: boolean; hideTracked?: boolean };

function untypedRef(value: string, prefix: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

export function resolveBundleId(db: Db, bundleRef: string): string {
  const ref = untypedRef(bundleRef, "briefing-bundle:");
  if (!ref) throw new BriefingStoreError("bundle reference must be nonblank");
  const resolved = resolveId(db, "briefing_bundle", ref);
  if (resolved.ok) return resolved.id;
  if (resolved.error === "ambiguous") throw new BriefingStoreError("Briefing bundle reference is ambiguous", 409, "ambiguous_ref");
  throw new BriefingStoreError("Briefing bundle not found", 404, "not_found");
}

export type BundleMemberRow = {
  layout_position: number;
  entry_kind: "briefing" | "subgroup";
  subgroup_name: string | null;
  subgroup_position: number;
} & (
  | { briefing_id: string; tracked_project_id: null; tracked_path: null }
  | { briefing_id: null; tracked_project_id: string; tracked_path: string }
);

const MEMBER_COLUMNS = "briefing_id, tracked_project_id, tracked_path, layout_position, entry_kind, subgroup_name, subgroup_position";

export function bundleMemberRows(db: Db, bundleId: string): BundleMemberRow[] {
  return db.prepare(`SELECT ${MEMBER_COLUMNS} FROM briefing_bundle_members
    WHERE bundle_id = ? ORDER BY layout_position, subgroup_position`).all(bundleId) as BundleMemberRow[];
}

export function writeBundleMemberRows(db: Db, bundleId: string, rows: readonly BundleMemberRow[], now: number): void {
  const insert = db.prepare(`INSERT INTO briefing_bundle_members (bundle_id, ${MEMBER_COLUMNS}, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(bundleId, row.briefing_id, row.tracked_project_id, row.tracked_path,
      row.layout_position, row.entry_kind, row.subgroup_name, row.subgroup_position, now);
  }
}

type LayoutRow = BundleMemberRow & { briefing: BriefingListEntry | null };

function visibleLayoutRows(db: Db, bundleId: string, viewer: BriefingBundleViewer): LayoutRow[] {
  const rows = db.prepare(
    `SELECT bm.briefing_id, bm.tracked_project_id, bm.tracked_path,
            bm.layout_position, bm.entry_kind, bm.subgroup_name, bm.subgroup_position,
            b.id, b.briefing_key, b.title, b.description, b.latest_round_id, b.round_count, b.archived_at,
            b.created_at, b.updated_at
       FROM briefing_bundle_members bm LEFT JOIN briefings b ON b.id = bm.briefing_id
      WHERE bm.bundle_id = ? AND ((bm.tracked_project_id IS NOT NULL AND ? = 1) OR
        (b.id IS NOT NULL AND b.archived_at IS NULL AND ${BRIEFING_HAS_ROUND_SQL} AND (? = 1 OR EXISTS (
          SELECT 1 FROM briefing_members m WHERE m.briefing_id = b.id AND m.user_id = ?
        )))) ORDER BY bm.layout_position, bm.subgroup_position`,
  ).all(bundleId, viewer.operator && !viewer.hideTracked ? 1 : 0, viewer.operator ? 1 : 0, viewer.userId) as Array<BundleMemberRow & BriefingListEntry>;
  return rows.map(({ briefing_id, tracked_project_id, tracked_path,
    layout_position, entry_kind, subgroup_name, subgroup_position, ...briefing }) => ({
    layout_position, entry_kind, subgroup_name, subgroup_position,
    ...(briefing_id === null
      ? { briefing_id, tracked_project_id: tracked_project_id!, tracked_path: tracked_path!, briefing: null }
      : { briefing_id, tracked_project_id: null, tracked_path: null, briefing }),
  }));
}

function projectLayout(rows: readonly LayoutRow[], reader: TrackedBriefingReader): Pick<BriefingBundle, "layout" | "members"> {
  const layout: BriefingBundleLayoutEntry[] = [];
  const members: BriefingBundleMember[] = [];
  for (const row of rows) {
    const position = row.entry_kind === "subgroup" ? row.subgroup_position : row.layout_position;
    const leaf: BriefingBundleLeaf = row.briefing === null
      ? { kind: "tracked", position, tracked: reader.read({ project_id: row.tracked_project_id!, path: row.tracked_path! }) }
      : { kind: "briefing", position, briefing: row.briefing };
    if (leaf.kind === "briefing") members.push({ position: members.length, briefing: leaf.briefing });
    if (row.entry_kind === "briefing") {
      layout.push(leaf);
      continue;
    }
    const prior = layout.at(-1);
    const subgroup = prior?.kind === "subgroup" && prior.position === row.layout_position ? prior
      : { kind: "subgroup" as const, position: row.layout_position, name: row.subgroup_name!, members: [], briefings: [] };
    if (subgroup !== prior) layout.push(subgroup);
    subgroup.members.push(leaf);
    if (leaf.kind === "briefing") subgroup.briefings.push({ position, briefing: leaf.briefing });
  }
  return { layout, members };
}

export function readBriefingBundle(db: Db, bundleRef: string, viewer: BriefingBundleViewer,
  reader = trackedBriefingReader(db)): BriefingBundle {
  const id = resolveBundleId(db, bundleRef);
  const bundle = db.prepare("SELECT id, name, created_at, updated_at, request_origin_json FROM briefing_bundles WHERE id = ?")
    .get(id) as Omit<BriefingBundle, "layout" | "members">;
  return { ...bundle, request_origin: requestOriginFromRow(bundle), ...projectLayout(visibleLayoutRows(db, id, viewer), reader) };
}

export function listBriefingBundles(db: Db, viewer: BriefingBundleViewer): BriefingBundle[] {
  const bundles = db.prepare("SELECT id, name, created_at, updated_at, request_origin_json FROM briefing_bundles ORDER BY created_at, id")
    .all() as Array<Omit<BriefingBundle, "layout" | "members">>;
  const reader = trackedBriefingReader(db);
  return bundles.map((bundle) => ({
    ...bundle, request_origin: requestOriginFromRow(bundle), ...projectLayout(visibleLayoutRows(db, bundle.id, viewer), reader),
  }));
}

export type DeletedBriefingBundle = { bundle_id: string; name: string; deleted: true };

/**
 * Remove only a truly empty, standalone bundle. Historical and configured
 * references are deliberately retained by the schema and block deletion.
 */
export function deleteEmptyBriefingBundle(db: Db, bundleRef: string): DeletedBriefingBundle {
  const bundleId = resolveBundleId(db, bundleRef);
  return mutateBriefing(db, "briefing_bundle", bundleId, () => {
  return db.transaction(() => {
    const bundle = db.prepare("SELECT name FROM briefing_bundles WHERE id = ?").get(bundleId) as { name: string };
    if (db.prepare("SELECT 1 FROM briefing_bundle_members WHERE bundle_id = ? LIMIT 1").get(bundleId)) {
      throw new BriefingStoreError("Briefing bundle must be empty before deletion", 409, "briefing_bundle_not_empty");
    }

    const references = [
      ["group configuration", `SELECT 1 FROM briefing_groups
        WHERE current_bundle_id = ? LIMIT 1`, [bundleId]],
      ["group proposal", `SELECT 1 FROM briefing_group_updates
        WHERE bundle_id = ? LIMIT 1`, [bundleId]],
      ["group disposition history", `SELECT 1 FROM briefing_group_dispositions
        WHERE prior_base_bundle_id = ? OR proposal_bundle_id = ? OR resulting_base_bundle_id = ? LIMIT 1`,
        [bundleId, bundleId, bundleId]],
      ["group review history", `SELECT 1 FROM briefing_group_review_dispositions
        WHERE expected_base_bundle_id = ? OR proposal_bundle_id = ? OR resulting_base_bundle_id = ? LIMIT 1`,
        [bundleId, bundleId, bundleId]],
      ["composition contribution history", `SELECT 1 FROM briefing_composition_contributions
        WHERE proposal_bundle_id = ? LIMIT 1`, [bundleId]],
      ["composition target history", `SELECT 1 FROM briefing_composition_targets
        WHERE base_bundle_id = ? OR proposal_bundle_id = ? LIMIT 1`, [bundleId, bundleId]],
    ] as const;
    for (const [label, sql, params] of references) {
      if (db.prepare(sql).get(...params)) {
        throw new BriefingStoreError(
          `Briefing bundle is retained by ${label} and cannot be deleted`,
          409,
          "briefing_bundle_referenced",
          { reference_kind: label },
        );
      }
    }

    const result = db.prepare("DELETE FROM briefing_bundles WHERE id = ?").run(bundleId);
    if (result.changes !== 1) throw new BriefingStoreError("Briefing bundle not found", 404, "not_found");
    return { bundle_id: bundleId, name: bundle.name, deleted: true as const };
  }).immediate();
  });
}

type ResolvedLeaf = Pick<BundleMemberRow, "briefing_id" | "tracked_project_id" | "tracked_path">;

function layoutInputObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BriefingStoreError("Each layout entry must be an object");
  }
  return raw as Record<string, unknown>;
}

function requireLayoutFields(entry: Record<string, unknown>, keys: string[]): void {
  const unexpected = Object.keys(entry).find(key => !keys.includes(key));
  if (unexpected) throw new BriefingStoreError(`Layout entry contains unsupported field '${unexpected}'`);
}

function resolveLeaf(db: Db, input: unknown, viewer: BriefingBundleViewer): ResolvedLeaf {
  const leaf = layoutInputObject(input);
  if (leaf.kind === "briefing") {
    requireLayoutFields(leaf, ["kind", "briefing_ref"]);
    if (typeof leaf.briefing_ref !== "string" || !leaf.briefing_ref.trim()) {
      throw new BriefingStoreError("briefing_ref must be nonblank");
    }
    return { briefing_id: resolveBriefingId(db, leaf.briefing_ref, viewer), tracked_project_id: null, tracked_path: null };
  }
  if (leaf.kind === "tracked") {
    requireLayoutFields(leaf, ["kind", "project_ref", "path"]);
    if (!viewer.operator) throw new BriefingStoreError("Tracked layout changes require an operator", 403, "forbidden");
    if (typeof leaf.project_ref !== "string" || !isTrackedBriefingPath(leaf.path)) {
      throw new BriefingStoreError("Tracked layout entries require a project_ref and a Git-relative file path");
    }
    const project = resolveProjectRef(db, leaf.project_ref);
    if (!project.ok) throw new BriefingStoreError("Tracked layout project must resolve uniquely");
    return { briefing_id: null, tracked_project_id: project.project.id, tracked_path: leaf.path };
  }
  throw new BriefingStoreError("A bundle leaf must be a Briefing or a tracked path");
}

function resolveLayout(db: Db, layout: unknown, viewer: BriefingBundleViewer): BundleMemberRow[] {
  if (!Array.isArray(layout)) throw new BriefingStoreError("layout must be an array");
  const subgroupNames = new Set<string>();
  const seen = new Set<string>();
  return layout.flatMap((raw, layout_position) => {
    const entry = layoutInputObject(raw);
    const subgroup = entry.kind === "subgroup";
    let subgroup_name: string | null = null;
    let leaves: unknown[] = [entry];
    if (subgroup) {
      requireLayoutFields(entry, ["kind", "name", "briefing_refs", "members"]);
      if (typeof entry.name !== "string" || !entry.name.trim()) {
        throw new BriefingStoreError("Layout subgroup name must be nonblank");
      }
      subgroup_name = entry.name.trim();
      if (subgroupNames.has(subgroup_name)) throw new BriefingStoreError("layout must not contain duplicate subgroup blocks");
      subgroupNames.add(subgroup_name);
      if ((entry.briefing_refs === undefined) === (entry.members === undefined)) {
        throw new BriefingStoreError("Layout subgroup requires either members or briefing_refs");
      }
      const inputs = entry.members ?? entry.briefing_refs;
      if (!Array.isArray(inputs) || inputs.length === 0) throw new BriefingStoreError("Layout subgroup must contain leaves");
      leaves = entry.members === undefined
        ? inputs.map(briefing_ref => ({ kind: "briefing", briefing_ref }))
        : inputs;
    }
    return leaves.map((input, subgroup_position) => {
      const leaf = resolveLeaf(db, input, viewer);
      const key = leaf.briefing_id ?? JSON.stringify([leaf.tracked_project_id, leaf.tracked_path]);
      if (seen.has(key)) throw new BriefingStoreError("layout must not contain duplicate members");
      seen.add(key);
      return { ...leaf, layout_position, entry_kind: subgroup ? "subgroup" : "briefing",
        subgroup_name, subgroup_position } as BundleMemberRow;
    });
  });
}

function flatLayout(db: Db, refs: readonly string[], viewer: BriefingBundleViewer): BundleMemberRow[] {
  if (!Array.isArray(refs) || !refs.every((ref) => typeof ref === "string" && ref.trim())) {
    throw new BriefingStoreError("briefing_refs must be an array of nonblank Briefing refs");
  }
  try {
    return resolveLayout(db, refs.map((briefing_ref) => ({ kind: "briefing", briefing_ref })), viewer);
  } catch (error) {
    if (error instanceof BriefingStoreError && error.message === "layout must not contain duplicate members") {
      throw new BriefingStoreError("briefing_refs must not contain duplicates");
    }
    throw error;
  }
}

export function trackedBundleMembers(db: Db, bundleId: string): TrackedBriefingPath[] {
  return bundleMemberRows(db, bundleId).flatMap(row => row.briefing_id === null
    ? [{ project_id: row.tracked_project_id, path: row.tracked_path }] : []);
}

export function sameTrackedBundleLayout(db: Db, baseId: string, proposalId: string): boolean {
  const tracked = (id: string) => bundleMemberRows(db, id).filter(row => row.briefing_id === null);
  return JSON.stringify(tracked(baseId)) === JSON.stringify(tracked(proposalId));
}

export function createBriefingBundle(
  db: Db, input: { name: string; briefingRefs: readonly string[]; viewer: BriefingBundleViewer;
    placementOverride?: PlacementOverride }, now = Date.now(),
): BriefingBundle {
  const name = input.name.trim();
  if (!name) throw new BriefingStoreError("name must be a nonblank string");
  const layout = flatLayout(db, input.briefingRefs, input.viewer);
  const bundleId = randomUUID();
  db.transaction(() => {
    enforceActivePlacement(db, { operation: "bundle_create", target: { kind: "bundle", id: bundleId },
      briefingIds: layout.flatMap(row => row.briefing_id === null ? [] : [row.briefing_id]),
      override: input.placementOverride, now });
    db.prepare("INSERT INTO briefing_bundles (request_origin_json, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(requestOriginJson(), bundleId, name, now, now);
    writeBundleMemberRows(db, bundleId, layout, now);
  }).immediate();
  return readBriefingBundle(db, bundleId, input.viewer);
}

export function updateBriefingBundleName(
  db: Db, bundleRef: string, name: unknown, viewer: BriefingBundleViewer,
): { bundle: BriefingBundle; changed: boolean } {
  if (typeof name !== "string" || !name.trim()) throw new BriefingStoreError("name must be a nonblank string");
  const normalized = name.trim();
  const bundleId = resolveBundleId(db, bundleRef);
  return mutateBriefing(db, "briefing_bundle", bundleId, () => {
  const current = db.prepare("SELECT name FROM briefing_bundles WHERE id = ?").get(bundleId) as { name: string };
  const changed = current.name !== normalized;
  if (changed) db.prepare("UPDATE briefing_bundles SET name = ? WHERE id = ?").run(normalized, bundleId);
  return { bundle: readBriefingBundle(db, bundleId, viewer), changed };
  });
}

export function replaceBriefingBundleLayout(
  db: Db, bundleRef: string, input: { briefingRefs?: readonly string[]; layout?: unknown },
  viewer: BriefingBundleViewer, now = Date.now(), placementOverride?: PlacementOverride,
): { bundle: BriefingBundle; changed: boolean } {
  if ((input.briefingRefs === undefined) === (input.layout === undefined)) {
    throw new BriefingStoreError("provide exactly one of briefing_refs or layout");
  }
  const bundleId = resolveBundleId(db, bundleRef);
  return mutateBriefing(db, "briefing_bundle", bundleId, () => {
  const layout = input.layout === undefined ? flatLayout(db, input.briefingRefs ?? [], viewer) : resolveLayout(db, input.layout, viewer);
  const changed = db.transaction(() => {
    const previous = bundleMemberRows(db, bundleId);
    if (canonicalJson(previous) === canonicalJson(layout)) return false;
    if (!viewer.operator && previous.some(row => row.briefing_id === null)) {
      throw new BriefingStoreError("Tracked layout changes require an operator", 403, "forbidden");
    }
    const target = placementTargetForBundle(db, bundleId);
    if (target) enforceActivePlacement(db, { operation: "bundle_replace", target,
      briefingIds: layout.flatMap(row => row.briefing_id === null ? [] : [row.briefing_id]),
      override: placementOverride, now });
    db.prepare("DELETE FROM briefing_bundle_members WHERE bundle_id = ?").run(bundleId);
    writeBundleMemberRows(db, bundleId, layout, now);
    db.prepare("UPDATE briefing_bundles SET updated_at = ? WHERE id = ?").run(now, bundleId);
    return true;
  }).immediate();
  return { bundle: readBriefingBundle(db, bundleId, viewer), changed };
  });
}

export function replaceBriefingBundleMembers(
  db: Db, bundleRef: string, briefingRefs: readonly string[], viewer: BriefingBundleViewer, now = Date.now(),
): { bundle: BriefingBundle; changed: boolean } {
  return replaceBriefingBundleLayout(db, bundleRef, { briefingRefs }, viewer, now);
}

export function addBriefingBundleMember(
  db: Db, bundleRef: string, briefingRef: string, viewer: BriefingBundleViewer, now = Date.now(),
  placementOverride?: PlacementOverride,
): { bundle: BriefingBundle; added: boolean } {
  const bundleId = resolveBundleId(db, bundleRef);
  return mutateBriefing(db, "briefing_bundle", bundleId, () => {
  const briefingId = resolveBriefingId(db, briefingRef, viewer);
  const added = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM briefing_bundle_members WHERE bundle_id = ? AND briefing_id = ?").get(bundleId, briefingId)) return false;
    const target = placementTargetForBundle(db, bundleId);
    if (target) enforceActivePlacement(db, { operation: "bundle_add", target,
      briefingIds: [briefingId], override: placementOverride, now });
    const row = db.prepare("SELECT COALESCE(MAX(layout_position), -1) + 1 AS position FROM briefing_bundle_members WHERE bundle_id = ?")
      .get(bundleId) as { position: number };
    db.prepare(`INSERT INTO briefing_bundle_members
      (bundle_id, briefing_id, layout_position, entry_kind, subgroup_name, subgroup_position, created_at)
      VALUES (?, ?, ?, 'briefing', NULL, 0, ?)`).run(bundleId, briefingId, row.position, now);
    db.prepare("UPDATE briefing_bundles SET updated_at = ? WHERE id = ?").run(now, bundleId);
    return true;
  }).immediate();
  return { bundle: readBriefingBundle(db, bundleId, viewer), added };
  });
}
