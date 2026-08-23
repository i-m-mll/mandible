import { randomUUID } from "node:crypto";

import type { BriefingBundle, BriefingListEntry } from "../contracts.js";
import type { Db } from "../db.js";
import { BriefingStoreError, resolveBriefingId } from "./briefings.js";

export type BriefingBundleViewer = { userId: string; operator: boolean };

function untypedRef(value: string, prefix: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function resolveUniqueId(
  rows: readonly { id: string }[],
  ref: string,
  kind: "Briefing" | "Briefing bundle",
): string {
  const exact = rows.find((row) => row.id === ref);
  if (exact) return exact.id;
  const matches = rows.filter((row) => row.id.startsWith(ref));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new BriefingStoreError(`${kind} reference is ambiguous`, 409, "ambiguous_ref");
  }
  throw new BriefingStoreError(`${kind} not found`, 404, "not_found");
}

function resolveBundleId(db: Db, bundleRef: string): string {
  const ref = untypedRef(bundleRef, "briefing-bundle:");
  if (!ref) throw new BriefingStoreError("bundle reference must be nonblank");
  return resolveUniqueId(
    db.prepare("SELECT id FROM briefing_bundles ORDER BY id").all() as Array<{ id: string }>,
    ref,
    "Briefing bundle",
  );
}

function memberRows(db: Db, bundleId: string, viewer: BriefingBundleViewer) {
  return db.prepare(
    `SELECT bm.position,
            b.id, b.briefing_key, b.title, b.latest_round_id, b.round_count, b.created_at, b.updated_at
       FROM briefing_bundle_members bm
       JOIN briefings b ON b.id = bm.briefing_id
      WHERE bm.bundle_id = ?
        AND (? = 1 OR EXISTS (
          SELECT 1 FROM briefing_members m WHERE m.briefing_id = b.id AND m.user_id = ?
        ))
      ORDER BY bm.position`,
  ).all(bundleId, viewer.operator ? 1 : 0, viewer.userId) as Array<BriefingListEntry & { position: number }>;
}

export function readBriefingBundle(
  db: Db,
  bundleRef: string,
  viewer: BriefingBundleViewer,
): BriefingBundle {
  const id = resolveBundleId(db, bundleRef);
  const bundle = db.prepare(
    "SELECT id, name, created_at, updated_at FROM briefing_bundles WHERE id = ?",
  ).get(id) as Omit<BriefingBundle, "members">;
  return {
    ...bundle,
    members: memberRows(db, id, viewer).map(({ position, ...briefing }) => ({ position, briefing })),
  };
}

export function listBriefingBundles(db: Db, viewer: BriefingBundleViewer): BriefingBundle[] {
  const bundles = db.prepare(
    "SELECT id, name, created_at, updated_at FROM briefing_bundles ORDER BY created_at, id",
  ).all() as Array<Omit<BriefingBundle, "members">>;
  return bundles.map((bundle) => ({
    ...bundle,
    members: memberRows(db, bundle.id, viewer).map(({ position, ...briefing }) => ({ position, briefing })),
  }));
}

export function createBriefingBundle(
  db: Db,
  input: { name: string; briefingRefs: readonly string[]; viewer: BriefingBundleViewer },
  now = Date.now(),
): BriefingBundle {
  const name = input.name.trim();
  if (!name) throw new BriefingStoreError("name must be a nonblank string");
  const briefingIds = input.briefingRefs.map((ref) => resolveBriefingId(db, ref, input.viewer));
  if (new Set(briefingIds).size !== briefingIds.length) {
    throw new BriefingStoreError("briefing_refs must not contain duplicates");
  }
  const bundleId = randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO briefing_bundles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(bundleId, name, now, now);
    const insert = db.prepare(
      "INSERT INTO briefing_bundle_members (bundle_id, briefing_id, position, created_at) VALUES (?, ?, ?, ?)",
    );
    briefingIds.forEach((briefingId, position) => insert.run(bundleId, briefingId, position, now));
  }).immediate();
  return readBriefingBundle(db, bundleId, input.viewer);
}

export function updateBriefingBundleName(
  db: Db,
  bundleRef: string,
  name: unknown,
  viewer: BriefingBundleViewer,
): { bundle: BriefingBundle; changed: boolean } {
  if (typeof name !== "string" || !name.trim()) {
    throw new BriefingStoreError("name must be a nonblank string");
  }
  const normalized = name.trim();
  const bundleId = resolveBundleId(db, bundleRef);
  const current = db.prepare("SELECT name FROM briefing_bundles WHERE id = ?")
    .get(bundleId) as { name: string };
  const changed = current.name !== normalized;
  if (changed) db.prepare("UPDATE briefing_bundles SET name = ? WHERE id = ?").run(normalized, bundleId);
  return { bundle: readBriefingBundle(db, bundleId, viewer), changed };
}

export function replaceBriefingBundleMembers(
  db: Db,
  bundleRef: string,
  briefingRefs: readonly string[],
  viewer: BriefingBundleViewer,
  now = Date.now(),
): { bundle: BriefingBundle; changed: boolean } {
  const bundleId = resolveBundleId(db, bundleRef);
  if (!Array.isArray(briefingRefs)
      || !briefingRefs.every((ref) => typeof ref === "string" && ref.trim())) {
    throw new BriefingStoreError("briefing_refs must be an array of nonblank Briefing refs");
  }
  const briefingIds = briefingRefs.map((ref) => resolveBriefingId(db, ref, viewer));
  if (new Set(briefingIds).size !== briefingIds.length) {
    throw new BriefingStoreError("briefing_refs must not contain duplicates");
  }
  const changed = db.transaction(() => {
    const currentIds = db.prepare(
      "SELECT briefing_id FROM briefing_bundle_members WHERE bundle_id = ? ORDER BY position",
    ).all(bundleId) as Array<{ briefing_id: string }>;
    const membershipChanged = currentIds.length !== briefingIds.length
      || currentIds.some((row, position) => row.briefing_id !== briefingIds[position]);
    if (membershipChanged) {
      db.prepare("DELETE FROM briefing_bundle_members WHERE bundle_id = ?").run(bundleId);
      const insert = db.prepare(
        "INSERT INTO briefing_bundle_members (bundle_id, briefing_id, position, created_at) VALUES (?, ?, ?, ?)",
      );
      briefingIds.forEach((briefingId, position) => insert.run(bundleId, briefingId, position, now));
      db.prepare("UPDATE briefing_bundles SET updated_at = ? WHERE id = ?").run(now, bundleId);
    }
    return membershipChanged;
  }).immediate();
  return { bundle: readBriefingBundle(db, bundleId, viewer), changed };
}

export function addBriefingBundleMember(
  db: Db,
  bundleRef: string,
  briefingRef: string,
  viewer: BriefingBundleViewer,
  now = Date.now(),
): { bundle: BriefingBundle; added: boolean } {
  const bundleId = resolveBundleId(db, bundleRef);
  const briefingId = resolveBriefingId(db, briefingRef, viewer);
  const added = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM briefing_bundle_members WHERE bundle_id = ? AND briefing_id = ?")
      .get(bundleId, briefingId)) return false;
    const row = db.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM briefing_bundle_members WHERE bundle_id = ?",
    ).get(bundleId) as { position: number };
    db.prepare(
      "INSERT INTO briefing_bundle_members (bundle_id, briefing_id, position, created_at) VALUES (?, ?, ?, ?)",
    ).run(bundleId, briefingId, row.position, now);
    db.prepare("UPDATE briefing_bundles SET updated_at = ? WHERE id = ?").run(now, bundleId);
    return true;
  }).immediate();
  return { bundle: readBriefingBundle(db, bundleId, viewer), added };
}
