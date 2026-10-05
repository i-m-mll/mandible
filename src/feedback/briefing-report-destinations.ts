import { createHash, randomUUID } from "node:crypto";

import { canonicalJson } from "../canonical-json.js";
import type { Db } from "../db.js";
import { resolveArtifactIdentity } from "../provider-artifacts.js";
import { BriefingStoreError, resolveBriefingId } from "./briefings.js";
import { resolveBundleId, type BriefingBundleViewer } from "./briefing-bundles.js";
import { resolveGroupId } from "./briefing-groups.js";
import { reconcileBriefingDestinationRoutes, type BriefingDestinationRouteManifest } from "./briefing-composer.js";
import { placementCandidates } from "./briefing-placement.js";

export type ReportPlacementInput = {
  operationKey: string;
  logicalArtifactRef: string;
  briefingRef: string;
  groupRef: string;
  expectedOwnerGroupRef: string | null;
  expectedTargetBaseRef: string | null;
  expectedSourceBaseRef: string | null;
  routeManifest?: BriefingDestinationRouteManifest;
};

export type DestinationActor = { userId: string; credentialId: string | null; projectId: string };

type LayoutMember = {
  briefing_id: string;
  layout_position: number;
  entry_kind: "briefing" | "subgroup";
  subgroup_name: string | null;
  subgroup_position: number;
};

function members(db: Db, bundleId: string | null): LayoutMember[] {
  return bundleId === null ? [] : db.prepare(`SELECT briefing_id, layout_position, entry_kind,
    subgroup_name, subgroup_position FROM briefing_bundle_members WHERE bundle_id = ?
    ORDER BY layout_position, subgroup_position`).all(bundleId) as LayoutMember[];
}

function successorBundle(db: Db, oldId: string | null, next: LayoutMember[], now: number): string {
  const name = oldId === null ? "Published reports" : (db.prepare("SELECT name FROM briefing_bundles WHERE id = ?")
    .get(oldId) as { name: string }).name;
  const id = randomUUID();
  db.prepare("INSERT INTO briefing_bundles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, name, now, now);
  const insert = db.prepare(`INSERT INTO briefing_bundle_members
    (bundle_id, briefing_id, layout_position, entry_kind, subgroup_name, subgroup_position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const positions = [...new Set(next.map((row) => row.layout_position))];
  for (const [position, prior] of positions.entries()) {
    const group = next.filter((row) => row.layout_position === prior);
    group.forEach((row, subgroupPosition) => insert.run(id, row.briefing_id, position,
      row.entry_kind, row.subgroup_name, row.entry_kind === "subgroup" ? subgroupPosition : 0, now));
  }
  return id;
}

function exactArtifactId(db: Db, ref: string): string {
  const resolved = resolveArtifactIdentity(db, ref, "strict-read");
  if (resolved.status !== "resolved" || resolved.target_type !== "artifact" || !resolved.target_id) {
    throw new BriefingStoreError("Placement requires one exact logical Artifact ref", 404, "artifact_not_found");
  }
  return resolved.target_id;
}

/** One ordinary, atomic report placement and owner write. Historical bundles are never edited. */
export function placeBriefingReport(
  db: Db, input: ReportPlacementInput, actor: DestinationActor, viewer: BriefingBundleViewer,
  now = Date.now(),
): { changed: boolean; logical_artifact_id: string; group_id: string; target_base_bundle_id: string;
  source_group_id: string | null; source_base_bundle_id: string | null;
  route_changed: boolean; receipt_id: string } {
  if (!input.operationKey.trim()) throw new BriefingStoreError("operation_key must be nonblank");
  const logicalArtifactId = exactArtifactId(db, input.logicalArtifactRef);
  const briefingId = resolveBriefingId(db, input.briefingRef, viewer);
  const targetId = resolveGroupId(db, input.groupRef);
  const expectedOwnerId = input.expectedOwnerGroupRef === null ? null : resolveGroupId(db, input.expectedOwnerGroupRef);
  const expectedTargetBaseId = input.expectedTargetBaseRef === null ? null : resolveBundleId(db, input.expectedTargetBaseRef);
  const expectedSourceBaseId = input.expectedSourceBaseRef === null ? null : resolveBundleId(db, input.expectedSourceBaseRef);
  if (input.routeManifest && (input.routeManifest.routes.length !== 1
      || exactArtifactId(db, input.routeManifest.routes[0].logical_artifact_ref) !== logicalArtifactId
      || input.routeManifest.routes[0].publication_mode !== "published-report")) {
    throw new BriefingStoreError("Placement route must declare only this published-report Artifact", 400,
      "briefing_report_route_invalid");
  }
  const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
  return db.transaction(() => {
    const replay = db.prepare(`SELECT id, request_digest, after_json FROM briefing_destination_mutations
      WHERE operation_kind = 'place' AND actor_user_id = ? AND operation_key = ?`)
      .get(actor.userId, input.operationKey) as { id: string; request_digest: string; after_json: string } | undefined;
    if (replay) {
      if (replay.request_digest !== digest) throw new BriefingStoreError(
        "operation_key was already used with different placement input", 409, "briefing_destination_replay_conflict");
      return { ...JSON.parse(replay.after_json) as ReturnType<typeof placeBriefingReport>, changed: false };
    }
    const briefing = db.prepare("SELECT logical_artifact_id, archived_at FROM briefings WHERE id = ?")
      .get(briefingId) as { logical_artifact_id: string | null; archived_at: number | null };
    if (briefing.logical_artifact_id !== logicalArtifactId || briefing.archived_at !== null) throw new BriefingStoreError(
      "Briefing is not the active identity for this logical Artifact", 409, "briefing_report_identity_drift");
    const owner = db.prepare("SELECT group_id FROM briefing_destination_owners WHERE logical_artifact_id = ?")
      .get(logicalArtifactId) as { group_id: string } | undefined;
    if ((owner?.group_id ?? null) !== expectedOwnerId) throw new BriefingStoreError(
      "Destination owner changed", 409, "briefing_destination_owner_drift",
      { expected_group_id: expectedOwnerId, current_group_id: owner?.group_id ?? null });
    const target = db.prepare("SELECT current_bundle_id, archived_at FROM briefing_groups WHERE id = ?")
      .get(targetId) as { current_bundle_id: string | null; archived_at: number | null };
    if (target.archived_at !== null) throw new BriefingStoreError("Target group is archived", 409,
      "briefing_destination_group_inactive");
    if (target.current_bundle_id !== expectedTargetBaseId) throw new BriefingStoreError(
      "Target Base changed", 409, "briefing_destination_layout_drift");
    const source = expectedOwnerId === null || expectedOwnerId === targetId ? null
      : db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?")
        .get(expectedOwnerId) as { current_bundle_id: string | null };
    if ((source?.current_bundle_id ?? null) !== expectedSourceBaseId) throw new BriefingStoreError(
      "Source Base changed", 409, "briefing_destination_layout_drift");
    const active = db.prepare(`SELECT DISTINCT g.id FROM briefing_groups g
      JOIN briefing_bundle_members bm ON bm.bundle_id = g.current_bundle_id
      WHERE g.archived_at IS NULL AND bm.briefing_id = ?`).all(briefingId) as Array<{ id: string }>;
    if (active.some((row) => row.id !== targetId && row.id !== expectedOwnerId)) throw new BriefingStoreError(
      "Report is already placed in another active group", 409, "briefing_collection_placement_conflict");
    const conflicts = placementCandidates(db, { kind: "group", id: targetId }, [], [briefingId])
      .filter((owner) => owner.owner_kind !== "group" || owner.owner_id !== expectedOwnerId);
    if (conflicts.length) throw new BriefingStoreError("Report has another active collection placement", 409,
      "briefing_collection_placement_conflict", { placement_candidates: conflicts });
    if (source && db.prepare(`SELECT 1 FROM briefing_group_updates u
      JOIN briefing_bundle_members bm ON bm.bundle_id = u.bundle_id
      WHERE u.group_id = ? AND bm.briefing_id = ? LIMIT 1`).get(expectedOwnerId, briefingId)) {
      throw new BriefingStoreError("Retire the source group's pending report proposal before moving it", 409,
        "briefing_destination_proposal_conflict");
    }
    const targetRows = members(db, target.current_bundle_id);
    const targetMatches = targetRows.filter((row) => row.briefing_id === briefingId);
    const otherIdentity = db.prepare(`SELECT 1 FROM briefing_bundle_members bm
      JOIN briefings b ON b.id = bm.briefing_id
      WHERE bm.bundle_id = ? AND b.logical_artifact_id = ? AND b.id != ? LIMIT 1`)
      .get(target.current_bundle_id, logicalArtifactId, briefingId);
    if (otherIdentity) throw new BriefingStoreError("Target already contains another Briefing for this Artifact",
      409, "briefing_destination_document_drift");
    if (targetMatches.length > 1 || (expectedOwnerId !== null && expectedOwnerId !== targetId
        && targetMatches.length !== 0)) {
      throw new BriefingStoreError("Target contains a conflicting report placement", 409,
        "briefing_destination_document_drift");
    }
    const sourceRows = members(db, source?.current_bundle_id ?? null);
    if (source && sourceRows.filter((row) => row.briefing_id === briefingId).length !== 1) {
      throw new BriefingStoreError("Source no longer contains exactly one report", 409,
        "briefing_destination_document_drift");
    }
    const before = { owner_group_id: owner?.group_id ?? null, target_base_bundle_id: target.current_bundle_id,
      source_base_bundle_id: source?.current_bundle_id ?? null };
    let targetBaseId = target.current_bundle_id;
    if (targetMatches.length === 0) {
      targetBaseId = successorBundle(db, target.current_bundle_id, [...targetRows, {
        briefing_id: briefingId, layout_position: targetRows.length
          ? Math.max(...targetRows.map((row) => row.layout_position)) + 1 : 0,
        entry_kind: "briefing", subgroup_name: null, subgroup_position: 0,
      }], now);
      db.prepare("UPDATE briefing_groups SET current_bundle_id = ?, updated_at = ? WHERE id = ?")
        .run(targetBaseId, now, targetId);
    }
    if (!owner) db.prepare(`INSERT INTO briefing_destination_owners
      (logical_artifact_id, group_id, bound_by_user_id, evidence_method, credential_id, created_at, updated_at)
      VALUES (?, ?, ?, 'api_token', ?, ?, ?)`).run(logicalArtifactId, targetId, actor.userId,
        actor.credentialId, now, now);
    else if (owner.group_id !== targetId) db.prepare(`UPDATE briefing_destination_owners SET group_id = ?,
      bound_by_user_id = ?, evidence_method = 'api_token', credential_id = ?, updated_at = ?
      WHERE logical_artifact_id = ? AND group_id = ?`).run(targetId, actor.userId, actor.credentialId,
        now, logicalArtifactId, expectedOwnerId);
    let sourceBaseId: string | null = null;
    if (source) {
      sourceBaseId = successorBundle(db, source.current_bundle_id, sourceRows.filter((row) => row.briefing_id !== briefingId), now);
      db.prepare("UPDATE briefing_groups SET current_bundle_id = ?, updated_at = ? WHERE id = ?")
        .run(sourceBaseId, now, expectedOwnerId);
    }
    const route = input.routeManifest ? reconcileBriefingDestinationRoutes(db, input.routeManifest, now) : null;
    const result = { changed: targetMatches.length === 0 || owner?.group_id !== targetId || Boolean(route?.changed),
      logical_artifact_id: logicalArtifactId, group_id: targetId, target_base_bundle_id: targetBaseId!,
      source_group_id: source ? expectedOwnerId : null, source_base_bundle_id: sourceBaseId,
      route_changed: route?.changed ?? false, receipt_id: randomUUID() };
    db.prepare(`INSERT INTO briefing_destination_mutations
      (id, operation_key, operation_kind, request_digest, logical_artifact_id, project_id,
       actor_user_id, credential_id, before_json, after_json, created_at)
      VALUES (?, ?, 'place', ?, ?, ?, ?, ?, ?, ?, ?)`).run(result.receipt_id, input.operationKey,
      digest, logicalArtifactId, actor.projectId, actor.userId, actor.credentialId,
      canonicalJson(before), canonicalJson(result), now);
    return result;
  }).immediate();
}
