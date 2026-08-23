import { randomUUID } from "node:crypto";

import type { BriefingGroup } from "../contracts.js";
import type { Db } from "../db.js";
import { BriefingStoreError } from "./briefings.js";
import { readBriefingBundle, resolveBundleId, type BriefingBundleViewer } from "./briefing-bundles.js";

function resolveGroupId(db: Db, groupRef: string): string {
  const trimmed = groupRef.trim();
  const ref = trimmed.startsWith("briefing-group:") ? trimmed.slice("briefing-group:".length) : trimmed;
  if (!ref) throw new BriefingStoreError("group reference must be nonblank");
  const rows = db.prepare("SELECT id FROM briefing_groups ORDER BY id").all() as Array<{ id: string }>;
  const exact = rows.find((row) => row.id === ref);
  if (exact) return exact.id;
  const matches = rows.filter((row) => row.id.startsWith(ref));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new BriefingStoreError("Briefing group reference is ambiguous", 409, "ambiguous_ref");
  throw new BriefingStoreError("Briefing group not found", 404, "not_found");
}

function updateIds(db: Db, groupId: string): string[] {
  return (db.prepare("SELECT bundle_id FROM briefing_group_updates WHERE group_id = ? ORDER BY position")
    .all(groupId) as Array<{ bundle_id: string }>).map((row) => row.bundle_id);
}

export function readBriefingGroup(db: Db, groupRef: string, viewer: BriefingBundleViewer): BriefingGroup {
  const id = resolveGroupId(db, groupRef);
  const group = db.prepare("SELECT id, name, created_at, updated_at FROM briefing_groups WHERE id = ?")
    .get(id) as Omit<BriefingGroup, "updates">;
  return { ...group, updates: updateIds(db, id).map((bundleId) => readBriefingBundle(db, bundleId, viewer)) };
}

export function listBriefingGroups(db: Db, viewer: BriefingBundleViewer): BriefingGroup[] {
  const groups = db.prepare("SELECT id FROM briefing_groups ORDER BY created_at, id").all() as Array<{ id: string }>;
  return groups.map((group) => readBriefingGroup(db, group.id, viewer));
}

function resolveDistinctBundles(db: Db, bundleRefs: readonly string[]): string[] {
  if (!Array.isArray(bundleRefs) || !bundleRefs.every((ref) => typeof ref === "string" && ref.trim())) {
    throw new BriefingStoreError("bundle_refs must be an array of nonblank Briefing bundle refs");
  }
  const bundleIds = bundleRefs.map((ref) => resolveBundleId(db, ref));
  if (new Set(bundleIds).size !== bundleIds.length) throw new BriefingStoreError("bundle_refs must not contain duplicates");
  return bundleIds;
}

function assertUngrouped(db: Db, bundleIds: readonly string[]): void {
  for (const bundleId of bundleIds) {
    if (db.prepare("SELECT 1 FROM briefing_group_updates WHERE bundle_id = ?").get(bundleId)) {
      throw new BriefingStoreError("Briefing bundle already belongs to a group", 409, "briefing_bundle_already_grouped");
    }
  }
}

export function createBriefingGroup(
  db: Db,
  input: { name: string; bundleRefs: readonly string[]; viewer: BriefingBundleViewer },
  now = Date.now(),
): BriefingGroup {
  const name = input.name.trim();
  if (!name) throw new BriefingStoreError("name must be a nonblank string");
  const bundleIds = resolveDistinctBundles(db, input.bundleRefs);
  const groupId = randomUUID();
  db.transaction(() => {
    assertUngrouped(db, bundleIds);
    db.prepare("INSERT INTO briefing_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(groupId, name, now, now);
    const insert = db.prepare(
      "INSERT INTO briefing_group_updates (group_id, bundle_id, position, created_at) VALUES (?, ?, ?, ?)",
    );
    bundleIds.forEach((bundleId, position) => insert.run(groupId, bundleId, position, now));
  }).immediate();
  return readBriefingGroup(db, groupId, input.viewer);
}

export function addBriefingGroupUpdate(
  db: Db, groupRef: string, bundleRef: string, viewer: BriefingBundleViewer, now = Date.now(),
): { group: BriefingGroup; added: boolean } {
  const groupId = resolveGroupId(db, groupRef);
  const bundleId = resolveBundleId(db, bundleRef);
  const added = db.transaction(() => {
    const current = db.prepare("SELECT group_id FROM briefing_group_updates WHERE bundle_id = ?").get(bundleId) as
      { group_id: string } | undefined;
    if (current?.group_id === groupId) return false;
    if (current) throw new BriefingStoreError("Briefing bundle already belongs to a group", 409,
      "briefing_bundle_already_grouped");
    const row = db.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM briefing_group_updates WHERE group_id = ?",
    ).get(groupId) as { position: number };
    db.prepare("INSERT INTO briefing_group_updates (group_id, bundle_id, position, created_at) VALUES (?, ?, ?, ?)")
      .run(groupId, bundleId, row.position, now);
    db.prepare("UPDATE briefing_groups SET updated_at = ? WHERE id = ?").run(now, groupId);
    return true;
  }).immediate();
  return { group: readBriefingGroup(db, groupId, viewer), added };
}

export function updateBriefingGroupName(
  db: Db, groupRef: string, name: unknown, viewer: BriefingBundleViewer,
): { group: BriefingGroup; changed: boolean } {
  if (typeof name !== "string" || !name.trim()) throw new BriefingStoreError("name must be a nonblank string");
  const groupId = resolveGroupId(db, groupRef);
  const normalized = name.trim();
  const current = db.prepare("SELECT name FROM briefing_groups WHERE id = ?").get(groupId) as { name: string };
  const changed = current.name !== normalized;
  if (changed) db.prepare("UPDATE briefing_groups SET name = ? WHERE id = ?").run(normalized, groupId);
  return { group: readBriefingGroup(db, groupId, viewer), changed };
}
