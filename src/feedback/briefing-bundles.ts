import { randomUUID } from "node:crypto";

import type {
  BriefingBundle, BriefingBundleLayoutEntry, BriefingBundleLayoutInputEntry,
  BriefingBundleMember, BriefingListEntry,
} from "../contracts.js";
import type { Db } from "../db.js";
import { BRIEFING_HAS_ROUND_SQL, BriefingStoreError, resolveBriefingId } from "./briefings.js";
import { enforceActivePlacement, placementTargetForBundle, type PlacementOverride } from "./briefing-placement.js";
import { resolveId } from "../entity-refs.js";

export type BriefingBundleViewer = { userId: string; operator: boolean; humanReviewOperator?: boolean };

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

type LayoutRow = BriefingListEntry & {
  layout_position: number;
  entry_kind: "briefing" | "subgroup";
  subgroup_name: string | null;
  subgroup_position: number;
};

function layoutRows(db: Db, bundleId: string, viewer: BriefingBundleViewer): LayoutRow[] {
  return db.prepare(
    `SELECT bm.layout_position, bm.entry_kind, bm.subgroup_name, bm.subgroup_position,
            b.id, b.briefing_key, b.title, b.description, b.latest_round_id, b.round_count, b.archived_at,
            b.created_at, b.updated_at
       FROM briefing_bundle_members bm JOIN briefings b ON b.id = bm.briefing_id
      WHERE bm.bundle_id = ? AND b.archived_at IS NULL AND ${BRIEFING_HAS_ROUND_SQL} AND (? = 1 OR EXISTS (
        SELECT 1 FROM briefing_members m WHERE m.briefing_id = b.id AND m.user_id = ?
      )) ORDER BY bm.layout_position, bm.subgroup_position`,
  ).all(bundleId, viewer.operator ? 1 : 0, viewer.userId) as LayoutRow[];
}

function projectLayout(rows: readonly LayoutRow[]): { layout: BriefingBundleLayoutEntry[]; members: BriefingBundleMember[] } {
  const layout: BriefingBundleLayoutEntry[] = [];
  const members: BriefingBundleMember[] = [];
  for (const row of rows) {
    const { layout_position, entry_kind, subgroup_name, subgroup_position, ...briefing } = row;
    members.push({ position: members.length, briefing });
    if (entry_kind === "briefing") layout.push({ kind: "briefing", position: layout_position, briefing });
    else {
      const prior = layout.at(-1);
      if (prior?.kind === "subgroup" && prior.position === layout_position) {
        prior.briefings.push({ position: subgroup_position, briefing });
      } else {
        layout.push({ kind: "subgroup", position: layout_position, name: subgroup_name ?? "",
          briefings: [{ position: subgroup_position, briefing }] });
      }
    }
  }
  return { layout, members };
}

export function readBriefingBundle(db: Db, bundleRef: string, viewer: BriefingBundleViewer): BriefingBundle {
  const id = resolveBundleId(db, bundleRef);
  const bundle = db.prepare("SELECT id, name, created_at, updated_at FROM briefing_bundles WHERE id = ?")
    .get(id) as Omit<BriefingBundle, "layout" | "members">;
  return { ...bundle, ...projectLayout(layoutRows(db, id, viewer)) };
}

export function listBriefingBundles(db: Db, viewer: BriefingBundleViewer): BriefingBundle[] {
  const bundles = db.prepare("SELECT id, name, created_at, updated_at FROM briefing_bundles ORDER BY created_at, id")
    .all() as Array<Omit<BriefingBundle, "layout" | "members">>;
  return bundles.map((bundle) => ({ ...bundle, ...projectLayout(layoutRows(db, bundle.id, viewer)) }));
}

export type DeletedBriefingBundle = { bundle_id: string; name: string; deleted: true };

/**
 * Remove only a truly empty, standalone bundle. Historical and configured
 * references are deliberately retained by the schema and block deletion.
 */
export function deleteEmptyBriefingBundle(db: Db, bundleRef: string): DeletedBriefingBundle {
  const bundleId = resolveBundleId(db, bundleRef);
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
}

type ResolvedLayoutEntry =
  | { kind: "briefing"; briefingId: string }
  | { kind: "subgroup"; name: string; briefingIds: string[] };

function resolveLayout(db: Db, layout: unknown, viewer: BriefingBundleViewer): ResolvedLayoutEntry[] {
  if (!Array.isArray(layout)) throw new BriefingStoreError("layout must be an array");
  const subgroupNames = new Set<string>();
  const allBriefingIds: string[] = [];
  const resolved = layout.map((raw, position): ResolvedLayoutEntry => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new BriefingStoreError(`layout entry ${position} must be an object`);
    }
    const entry = raw as Partial<BriefingBundleLayoutInputEntry> & Record<string, unknown>;
    if (entry.kind === "briefing") {
      const unexpected = Object.keys(entry).filter((key) => key !== "kind" && key !== "briefing_ref");
      if (unexpected.length) throw new BriefingStoreError(`layout entry ${position} contains unsupported field '${unexpected[0]}'`);
      if (typeof entry.briefing_ref !== "string" || !entry.briefing_ref.trim()) {
        throw new BriefingStoreError(`layout entry ${position} briefing_ref must be nonblank`);
      }
      const briefingId = resolveBriefingId(db, entry.briefing_ref, viewer);
      allBriefingIds.push(briefingId);
      return { kind: "briefing", briefingId };
    }
    if (entry.kind === "subgroup") {
      const unexpected = Object.keys(entry).filter((key) => key !== "kind" && key !== "name" && key !== "briefing_refs");
      if (unexpected.length) throw new BriefingStoreError(`layout entry ${position} contains unsupported field '${unexpected[0]}'`);
      if (typeof entry.name !== "string" || !entry.name.trim()) {
        throw new BriefingStoreError(`layout subgroup ${position} name must be nonblank`);
      }
      const name = entry.name.trim();
      if (subgroupNames.has(name)) throw new BriefingStoreError("layout must not contain duplicate subgroup blocks");
      subgroupNames.add(name);
      if (!Array.isArray(entry.briefing_refs) || entry.briefing_refs.length === 0
          || !entry.briefing_refs.every((ref) => typeof ref === "string" && ref.trim())) {
        throw new BriefingStoreError("layout subgroups require a nonempty briefing_refs array");
      }
      const briefingIds = entry.briefing_refs.map((ref) => resolveBriefingId(db, ref, viewer));
      allBriefingIds.push(...briefingIds);
      return { kind: "subgroup", name, briefingIds };
    }
    throw new BriefingStoreError(`layout entry ${position} kind must be 'briefing' or 'subgroup'`);
  });
  if (new Set(allBriefingIds).size !== allBriefingIds.length) {
    throw new BriefingStoreError("layout must not contain duplicate Briefings");
  }
  return resolved;
}

function flatLayout(db: Db, refs: readonly string[], viewer: BriefingBundleViewer): ResolvedLayoutEntry[] {
  if (!Array.isArray(refs) || !refs.every((ref) => typeof ref === "string" && ref.trim())) {
    throw new BriefingStoreError("briefing_refs must be an array of nonblank Briefing refs");
  }
  try {
    return resolveLayout(db, refs.map((briefing_ref) => ({ kind: "briefing", briefing_ref })), viewer);
  } catch (error) {
    if (error instanceof BriefingStoreError && error.message === "layout must not contain duplicate Briefings") {
      throw new BriefingStoreError("briefing_refs must not contain duplicates");
    }
    throw error;
  }
}

function currentResolvedLayout(db: Db, bundleId: string): ResolvedLayoutEntry[] {
  const rows = db.prepare(`SELECT briefing_id, layout_position, entry_kind, subgroup_name
    FROM briefing_bundle_members WHERE bundle_id = ? ORDER BY layout_position, subgroup_position`).all(bundleId) as
    Array<{ briefing_id: string; layout_position: number; entry_kind: "briefing" | "subgroup"; subgroup_name: string | null }>;
  const result: ResolvedLayoutEntry[] = [];
  let priorPosition = -1;
  for (const row of rows) {
    if (row.entry_kind === "briefing") result.push({ kind: "briefing", briefingId: row.briefing_id });
    else {
      const prior = result.at(-1);
      if (prior?.kind === "subgroup" && priorPosition === row.layout_position) prior.briefingIds.push(row.briefing_id);
      else result.push({ kind: "subgroup", name: row.subgroup_name ?? "", briefingIds: [row.briefing_id] });
    }
    priorPosition = row.layout_position;
  }
  return result;
}

function writeLayout(db: Db, bundleId: string, layout: readonly ResolvedLayoutEntry[], now: number): void {
  const insert = db.prepare(`INSERT INTO briefing_bundle_members
    (bundle_id, briefing_id, layout_position, entry_kind, subgroup_name, subgroup_position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  layout.forEach((entry, layoutPosition) => {
    if (entry.kind === "briefing") insert.run(bundleId, entry.briefingId, layoutPosition, entry.kind, null, 0, now);
    else entry.briefingIds.forEach((briefingId, subgroupPosition) =>
      insert.run(bundleId, briefingId, layoutPosition, entry.kind, entry.name, subgroupPosition, now));
  });
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
      briefingIds: layout.flatMap((entry) => entry.kind === "briefing" ? [entry.briefingId] : entry.briefingIds),
      override: input.placementOverride, now });
    db.prepare("INSERT INTO briefing_bundles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(bundleId, name, now, now);
    writeLayout(db, bundleId, layout, now);
  }).immediate();
  return readBriefingBundle(db, bundleId, input.viewer);
}

export function updateBriefingBundleName(
  db: Db, bundleRef: string, name: unknown, viewer: BriefingBundleViewer,
): { bundle: BriefingBundle; changed: boolean } {
  if (typeof name !== "string" || !name.trim()) throw new BriefingStoreError("name must be a nonblank string");
  const normalized = name.trim();
  const bundleId = resolveBundleId(db, bundleRef);
  const current = db.prepare("SELECT name FROM briefing_bundles WHERE id = ?").get(bundleId) as { name: string };
  const changed = current.name !== normalized;
  if (changed) db.prepare("UPDATE briefing_bundles SET name = ? WHERE id = ?").run(normalized, bundleId);
  return { bundle: readBriefingBundle(db, bundleId, viewer), changed };
}

export function replaceBriefingBundleLayout(
  db: Db, bundleRef: string, input: { briefingRefs?: readonly string[]; layout?: unknown },
  viewer: BriefingBundleViewer, now = Date.now(), placementOverride?: PlacementOverride,
): { bundle: BriefingBundle; changed: boolean } {
  if ((input.briefingRefs === undefined) === (input.layout === undefined)) {
    throw new BriefingStoreError("provide exactly one of briefing_refs or layout");
  }
  const bundleId = resolveBundleId(db, bundleRef);
  const layout = input.layout === undefined ? flatLayout(db, input.briefingRefs ?? [], viewer) : resolveLayout(db, input.layout, viewer);
  const changed = db.transaction(() => {
    if (JSON.stringify(currentResolvedLayout(db, bundleId)) === JSON.stringify(layout)) return false;
    const target = placementTargetForBundle(db, bundleId);
    if (target) enforceActivePlacement(db, { operation: "bundle_replace", target,
      briefingIds: layout.flatMap((entry) => entry.kind === "briefing" ? [entry.briefingId] : entry.briefingIds),
      override: placementOverride, now });
    db.prepare("DELETE FROM briefing_bundle_members WHERE bundle_id = ?").run(bundleId);
    writeLayout(db, bundleId, layout, now);
    db.prepare("UPDATE briefing_bundles SET updated_at = ? WHERE id = ?").run(now, bundleId);
    return true;
  }).immediate();
  return { bundle: readBriefingBundle(db, bundleId, viewer), changed };
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
}
