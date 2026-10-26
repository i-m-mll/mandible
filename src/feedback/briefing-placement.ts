import { requestOriginJson } from "../request-origin.js";
import { randomUUID } from "node:crypto";

import type { Db } from "../db.js";
import { BriefingStoreError } from "./briefings.js";

export type PlacementTarget = { kind: "group" | "bundle"; id: string };
export type PlacementOverride = {
  reason?: string;
  actorUserId: string;
  evidenceMethod: "api_token";
  credentialId: string | null;
};
export type PlacementCandidate = {
  subject_kind: "bundle" | "briefing";
  subject_id: string;
  owner_kind: "group" | "bundle";
  owner_id: string;
  owner_name: string;
};

function activeGroupForBundle(db: Db, bundleId: string): Array<{ id: string; name: string }> {
  return db.prepare(`SELECT DISTINCT g.id, g.name FROM briefing_groups g
    LEFT JOIN briefing_group_updates u ON u.group_id = g.id
    WHERE g.archived_at IS NULL AND (g.current_bundle_id = ? OR u.bundle_id = ?)
    ORDER BY g.id`).all(bundleId, bundleId) as Array<{ id: string; name: string }>;
}

export function placementTargetForBundle(db: Db, bundleId: string): PlacementTarget | null {
  const group = activeGroupForBundle(db, bundleId)[0];
  if (group) return { kind: "group", id: group.id };
  return groupAssociationExists(db, bundleId) ? null : { kind: "bundle", id: bundleId };
}

function groupAssociationExists(db: Db, bundleId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM briefing_groups g
    LEFT JOIN briefing_group_updates u ON u.group_id = g.id
    LEFT JOIN briefing_group_dispositions d ON d.group_id = g.id
    WHERE g.current_bundle_id = ? OR u.bundle_id = ? OR d.prior_base_bundle_id = ?
      OR d.proposal_bundle_id = ? OR d.resulting_base_bundle_id = ? LIMIT 1`)
    .get(bundleId, bundleId, bundleId, bundleId, bundleId)) || Boolean(db.prepare(`SELECT 1
      FROM briefing_destination_mutations WHERE operation_kind = 'place' AND (
        json_extract(before_json, '$.target_base_bundle_id') = ? OR
        json_extract(before_json, '$.source_base_bundle_id') = ? OR
        json_extract(after_json, '$.target_base_bundle_id') = ? OR
        json_extract(after_json, '$.source_base_bundle_id') = ?
      ) LIMIT 1`).get(bundleId, bundleId, bundleId, bundleId));
}

function activeOwnersForBriefing(db: Db, briefingId: string): Array<{ kind: "group" | "bundle"; id: string; name: string }> {
  const bundles = db.prepare(`SELECT b.id, b.name FROM briefing_bundles b
    JOIN briefing_bundle_members bm ON bm.bundle_id = b.id
    WHERE bm.briefing_id = ? ORDER BY b.id`).all(briefingId) as Array<{ id: string; name: string }>;
  const owners = new Map<string, { kind: "group" | "bundle"; id: string; name: string }>();
  for (const bundle of bundles) {
    const groups = activeGroupForBundle(db, bundle.id);
    for (const group of groups) owners.set(`group:${group.id}`, { kind: "group", ...group });
    if (groups.length === 0 && !groupAssociationExists(db, bundle.id)) {
      owners.set(`bundle:${bundle.id}`, { kind: "bundle", ...bundle });
    }
  }
  return [...owners.values()];
}

function sameCollection(target: PlacementTarget, owner: { kind: "group" | "bundle"; id: string }): boolean {
  return target.kind === owner.kind && target.id === owner.id;
}

export function placementCandidates(
  db: Db,
  target: PlacementTarget,
  bundleIds: readonly string[],
  briefingIds: readonly string[],
): PlacementCandidate[] {
  const candidates = new Map<string, PlacementCandidate>();
  for (const bundleId of bundleIds) {
    for (const owner of activeGroupForBundle(db, bundleId)) {
      if (sameCollection(target, { kind: "group", id: owner.id })) continue;
      const candidate: PlacementCandidate = { subject_kind: "bundle", subject_id: bundleId,
        owner_kind: "group", owner_id: owner.id, owner_name: owner.name };
      candidates.set(`${candidate.subject_kind}:${candidate.subject_id}:${candidate.owner_kind}:${candidate.owner_id}`, candidate);
    }
  }
  for (const briefingId of briefingIds) {
    for (const owner of activeOwnersForBriefing(db, briefingId)) {
      if (sameCollection(target, owner)) continue;
      if (owner.kind === "bundle" && bundleIds.includes(owner.id)) continue;
      const candidate: PlacementCandidate = { subject_kind: "briefing", subject_id: briefingId,
        owner_kind: owner.kind, owner_id: owner.id, owner_name: owner.name };
      candidates.set(`${candidate.subject_kind}:${candidate.subject_id}:${candidate.owner_kind}:${candidate.owner_id}`, candidate);
    }
  }
  return [...candidates.values()];
}

export function briefingIdsForBundles(db: Db, bundleIds: readonly string[]): string[] {
  if (bundleIds.length === 0) return [];
  const placeholders = bundleIds.map(() => "?").join(",");
  return (db.prepare(`SELECT DISTINCT briefing_id FROM briefing_bundle_members
    WHERE bundle_id IN (${placeholders}) ORDER BY briefing_id`).all(...bundleIds) as Array<{ briefing_id: string }>)
    .map((row) => row.briefing_id);
}

export function enforceActivePlacement(
  db: Db,
  input: { operation: string; target: PlacementTarget; bundleIds?: readonly string[];
    briefingIds: readonly string[]; override?: PlacementOverride; now: number },
): void {
  const bundleIds = input.bundleIds ?? [];
  const conflicts = placementCandidates(db, input.target, bundleIds, input.briefingIds);
  if (conflicts.length === 0) return;
  const reason = input.override?.reason?.trim() ?? "";
  if (!reason) {
    throw new BriefingStoreError("Active collection placement conflicts with existing ownership", 409,
      "briefing_collection_placement_conflict", { placement_candidates: conflicts });
  }
  const insert = db.prepare(`INSERT INTO briefing_collection_sharing_receipts
    (request_origin_json, id, operation, target_kind, target_id, subject_kind, subject_id, owner_kind, owner_id,
     reason, actor_user_id, evidence_method, credential_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const conflict of conflicts) insert.run(requestOriginJson(), randomUUID(), input.operation, input.target.kind, input.target.id,
    conflict.subject_kind, conflict.subject_id, conflict.owner_kind, conflict.owner_id, reason,
    input.override?.actorUserId, input.override?.evidenceMethod, input.override?.credentialId, input.now);
}
