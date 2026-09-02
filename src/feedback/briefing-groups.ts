import { randomUUID } from "node:crypto";

import type { BriefingGroup, BriefingGroupDisposition } from "../contracts.js";
import type { Db } from "../db.js";
import { tableExists } from "../db-introspection.js";
import { parseJsonObject } from "../row-coerce.js";
import { BriefingStoreError } from "./briefings.js";
import { readBriefingBundle, resolveBundleId, type BriefingBundleViewer } from "./briefing-bundles.js";
import { briefingIdsForBundles, enforceActivePlacement, type PlacementOverride } from "./briefing-placement.js";

export function resolveGroupId(db: Db, groupRef: string): string {
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
  const group = db.prepare("SELECT id, name, current_bundle_id, archived_at, created_at, updated_at FROM briefing_groups WHERE id = ?")
    .get(id) as Omit<BriefingGroup, "current" | "updates"> & { current_bundle_id: string | null };
  const { current_bundle_id: currentBundleId, ...projection } = group;
  return {
    ...projection,
    current: currentBundleId === null ? null : readBriefingBundle(db, currentBundleId, viewer),
    updates: updateIds(db, id).map((bundleId) => readBriefingBundle(db, bundleId, viewer)),
    history: readBriefingGroupHistory(db, id, viewer),
  };
}

function readBriefingGroupHistory(
  db: Db,
  groupId: string,
  viewer: BriefingBundleViewer,
): BriefingGroupDisposition[] {
  if (!tableExists(db, "briefing_group_dispositions")) return [];
  const rows = db.prepare(`SELECT id, kind, prior_base_bundle_id, proposal_bundle_id,
      resulting_base_bundle_id, auth_request_id, merge_head_sha, created_at
    FROM briefing_group_dispositions WHERE group_id = ? ORDER BY created_at DESC, id DESC`)
    .all(groupId) as Array<{
      id: string; kind: "promoted" | "dismissed"; prior_base_bundle_id: string | null;
      proposal_bundle_id: string; resulting_base_bundle_id: string | null;
      auth_request_id: string | null; merge_head_sha: string | null; created_at: number;
    }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    prior_base: row.prior_base_bundle_id === null ? null : readBriefingBundle(db, row.prior_base_bundle_id, viewer),
    proposal: readBriefingBundle(db, row.proposal_bundle_id, viewer),
    resulting_base: row.resulting_base_bundle_id === null
      ? null : readBriefingBundle(db, row.resulting_base_bundle_id, viewer),
    auth_request_id: row.auth_request_id,
    merge_head_sha: row.merge_head_sha,
    created_at: row.created_at,
  }));
}

export type BriefingGroupPromotionInput = {
  groupRef: string;
  expectedBaseBundleRef: string;
  proposalBundleRef: string;
  authRequestRef: string;
  mergeHeadSha: string;
};

export type BriefingGroupPromotionResult = {
  group: BriefingGroup;
  disposition: BriefingGroupDisposition;
  changed: boolean;
};

export function validateBriefingGroupPromotionCandidate(
  db: Db,
  input: Pick<BriefingGroupPromotionInput, "groupRef" | "expectedBaseBundleRef" | "proposalBundleRef">,
): { groupId: string; expectedBaseBundleId: string; proposalBundleId: string } {
  const groupId = resolveGroupId(db, input.groupRef);
  const expectedBaseBundleId = resolveBundleId(db, input.expectedBaseBundleRef);
  const proposalBundleId = resolveBundleId(db, input.proposalBundleRef);
  const group = db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?")
    .get(groupId) as { current_bundle_id: string | null };
  if (group.current_bundle_id !== expectedBaseBundleId) {
    throw new BriefingStoreError("Briefing group Base does not match expected_base_bundle_ref", 409,
      "promotion_base_drift");
  }
  if (!db.prepare("SELECT 1 FROM briefing_group_updates WHERE group_id = ? AND bundle_id = ?")
    .get(groupId, proposalBundleId)) {
    throw new BriefingStoreError("Proposal bundle is not an active proposal in this group", 409,
      "promotion_proposal_drift");
  }
  return { groupId, expectedBaseBundleId, proposalBundleId };
}

function resolveAuthRequestId(db: Db, authRequestRef: string): string {
  const ref = authRequestRef.trim();
  if (!ref) throw new BriefingStoreError("auth_request_ref must be nonblank");
  if (!tableExists(db, "auth_requests")) {
    throw new BriefingStoreError("Auth request schema is unavailable", 409,
      "promotion_authorization_unavailable");
  }
  const rows = db.prepare("SELECT id FROM auth_requests ORDER BY id").all() as Array<{ id: string }>;
  const exact = rows.find((row) => row.id === ref);
  if (exact) return exact.id;
  const matches = rows.filter((row) => row.id.startsWith(ref));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new BriefingStoreError("Auth request reference is ambiguous", 409, "ambiguous_ref");
  throw new BriefingStoreError("Auth request not found", 404, "not_found");
}

function requirePromotionAuthorization(
  db: Db,
  authRequestId: string,
  input: { groupId: string; expectedBaseBundleId: string; proposalBundleId: string },
): void {
  if (!tableExists(db, "auth_request_actions")) {
    throw new BriefingStoreError("Auth request action schema is unavailable", 409,
      "promotion_authorization_unavailable");
  }
  const rows = db.prepare(
    `SELECT state, payload FROM auth_request_actions
     WHERE auth_request_id = ? AND kind = 'briefing_group_promote'`,
  ).all(authRequestId) as Array<{ state: string; payload: string }>;
  const exact = rows.some((row) => {
    if (row.state !== "staged" && row.state !== "applied" && row.state !== "failed") return false;
    const payload = parseJsonObject(row.payload);
    return Object.keys(payload).length === 3
      && payload.group_ref === input.groupId
      && payload.expected_base_bundle_ref === input.expectedBaseBundleId
      && payload.proposal_bundle_ref === input.proposalBundleId;
  });
  if (!exact) {
    throw new BriefingStoreError(
      "Auth request does not authorize this exact Briefing group promotion",
      409,
      "promotion_authorization_mismatch",
    );
  }
}

function requireSuccessfulMergeConvergence(db: Db, authRequestId: string, mergeHeadSha: string): void {
  if (!/^[0-9a-f]{40}$/i.test(mergeHeadSha)) {
    throw new BriefingStoreError("merge_head_sha must be one exact 40-character Git commit id");
  }
  const request = db.prepare(
    "SELECT status, type, exit_code, merge_head_sha FROM auth_requests WHERE id = ?",
  ).get(authRequestId) as {
    status: string; type: string; exit_code: number | null; merge_head_sha: string | null;
  } | undefined;
  if (!request || request.status !== "completed" || request.type !== "merge" || request.exit_code !== 0) {
    throw new BriefingStoreError("Auth request is not a completed successful merge", 409, "promotion_auth_not_successful");
  }
  if (request.merge_head_sha?.toLowerCase() !== mergeHeadSha.toLowerCase()) {
    throw new BriefingStoreError("Auth request merge head does not match the guarded transition", 409,
      "promotion_merge_head_drift");
  }
  if (!tableExists(db, "auth_hook_executions")) {
    throw new BriefingStoreError("Auth request convergence schema is unavailable", 409,
      "promotion_convergence_unavailable");
  }
  const runs = db.prepare(
    "SELECT state, required FROM auth_hook_executions WHERE auth_request_id = ?",
  ).all(authRequestId) as Array<{ state: string; required: number }>;
  if (runs.some((run) => run.state === "pending" || run.state === "running")
      || runs.some((run) => run.required === 1 && run.state !== "complete")) {
    throw new BriefingStoreError("Auth request convergence is not complete", 409,
      "promotion_convergence_incomplete");
  }
}

export function promoteBriefingGroupProposal(
  db: Db,
  input: BriefingGroupPromotionInput,
  viewer: BriefingBundleViewer,
  now = Date.now(),
): BriefingGroupPromotionResult {
  const groupId = resolveGroupId(db, input.groupRef);
  const expectedBaseBundleId = resolveBundleId(db, input.expectedBaseBundleRef);
  const proposalBundleId = resolveBundleId(db, input.proposalBundleRef);
  const authRequestId = resolveAuthRequestId(db, input.authRequestRef);
  const mergeHeadSha = input.mergeHeadSha.trim().toLowerCase();
  requirePromotionAuthorization(db, authRequestId, { groupId, expectedBaseBundleId, proposalBundleId });
  requireSuccessfulMergeConvergence(db, authRequestId, mergeHeadSha);

  const result = db.transaction(() => {
    const replay = db.prepare(`SELECT id, prior_base_bundle_id, merge_head_sha FROM briefing_group_dispositions
      WHERE auth_request_id = ? AND group_id = ? AND proposal_bundle_id = ?`)
      .get(authRequestId, groupId, proposalBundleId) as {
        id: string; prior_base_bundle_id: string | null; merge_head_sha: string | null;
      } | undefined;
    const group = db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?")
      .get(groupId) as { current_bundle_id: string | null };
    const activeProposal = Boolean(db.prepare(
      "SELECT 1 FROM briefing_group_updates WHERE group_id = ? AND bundle_id = ?",
    ).get(groupId, proposalBundleId));
    if (replay) {
      if (replay.prior_base_bundle_id !== expectedBaseBundleId || replay.merge_head_sha !== mergeHeadSha
          || group.current_bundle_id !== proposalBundleId || activeProposal) {
        throw new BriefingStoreError("Applied promotion no longer matches group state", 409,
          "promotion_replay_drift");
      }
      return { dispositionId: replay.id, changed: false };
    }
    if (group.current_bundle_id !== expectedBaseBundleId) {
      throw new BriefingStoreError("Briefing group Base does not match expected_base_bundle_ref", 409,
        "promotion_base_drift");
    }
    if (!activeProposal) {
      throw new BriefingStoreError("Proposal bundle is not an active proposal in this group", 409,
        "promotion_proposal_drift");
    }
    const dispositionId = randomUUID();
    db.prepare("DELETE FROM briefing_group_updates WHERE group_id = ? AND bundle_id = ?")
      .run(groupId, proposalBundleId);
    const survivors = updateIds(db, groupId);
    const reposition = db.prepare(
      "UPDATE briefing_group_updates SET position = ? WHERE group_id = ? AND bundle_id = ?",
    );
    survivors.forEach((bundleId, position) => reposition.run(position, groupId, bundleId));
    db.prepare("UPDATE briefing_groups SET current_bundle_id = ?, updated_at = ? WHERE id = ?")
      .run(proposalBundleId, now, groupId);
    db.prepare(`INSERT INTO briefing_group_dispositions (
      id, group_id, kind, prior_base_bundle_id, proposal_bundle_id, resulting_base_bundle_id,
      auth_request_id, merge_head_sha, created_at
    ) VALUES (?, ?, 'promoted', ?, ?, ?, ?, ?, ?)`)
      .run(dispositionId, groupId, expectedBaseBundleId, proposalBundleId, proposalBundleId,
        authRequestId, mergeHeadSha, now);
    return { dispositionId, changed: true };
  }).immediate();
  const group = readBriefingGroup(db, groupId, viewer);
  const disposition = group.history.find((entry) => entry.id === result.dispositionId);
  if (!disposition) throw new BriefingStoreError("Promotion history could not be read", 500,
    "promotion_history_missing");
  return { group, disposition, changed: result.changed };
}

export function resolveGroupDisplayComparisonBase(
  db: Db,
  input: { groupRef: string; proposalBundleRef: string | null; briefingId: string; artifactVersionId: string },
): string | null {
  const groupId = resolveGroupId(db, input.groupRef);
  const group = db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?")
    .get(groupId) as { current_bundle_id: string | null };
  const displayBundleId = input.proposalBundleRef === null
    ? group.current_bundle_id : resolveBundleId(db, input.proposalBundleRef);
  if (displayBundleId === null) return null;
  if (input.proposalBundleRef !== null && !db.prepare(
    "SELECT 1 FROM briefing_group_updates WHERE group_id = ? AND bundle_id = ?",
  ).get(groupId, displayBundleId)) {
    throw new BriefingStoreError("Display proposal is not active in this Briefing group", 409,
      "briefing_display_context_drift");
  }
  if (!db.prepare("SELECT 1 FROM briefing_bundle_members WHERE bundle_id = ? AND briefing_id = ?")
    .get(displayBundleId, input.briefingId)) {
    throw new BriefingStoreError("Briefing does not belong to the selected group layout", 409,
      "briefing_display_context_drift");
  }
  if (input.proposalBundleRef === null || group.current_bundle_id === null) return null;
  const artifact = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?")
    .get(input.artifactVersionId) as { artifact_id: string } | undefined;
  if (!artifact) throw new BriefingStoreError("Selected Briefing artifact version is missing", 409,
    "briefing_display_artifact_missing");
  const base = db.prepare(`SELECT r.artifact_version_id
    FROM briefing_bundle_members bm
    JOIN briefings b ON b.id = bm.briefing_id
    JOIN briefing_rounds r ON r.id = b.latest_round_id
    JOIN artifact_version av ON av.id = r.artifact_version_id
    WHERE bm.bundle_id = ? AND av.artifact_id = ?
    ORDER BY bm.layout_position, bm.subgroup_position LIMIT 1`)
    .get(group.current_bundle_id, artifact.artifact_id) as { artifact_version_id: string } | undefined;
  return base?.artifact_version_id ?? null;
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

export function createBriefingGroup(
  db: Db,
  input: { name: string; currentBundleRef?: string | null; bundleRefs: readonly string[];
    viewer: BriefingBundleViewer; placementOverride?: PlacementOverride },
  now = Date.now(),
): BriefingGroup {
  const name = input.name.trim();
  if (!name) throw new BriefingStoreError("name must be a nonblank string");
  const bundleIds = resolveDistinctBundles(db, input.bundleRefs);
  const currentBundleId = input.currentBundleRef == null ? null : resolveBundleId(db, input.currentBundleRef);
  if (currentBundleId !== null && bundleIds.includes(currentBundleId)) {
    throw new BriefingStoreError("current_bundle_ref must not also appear in bundle_refs");
  }
  const groupId = randomUUID();
  db.transaction(() => {
    const allBundleIds = currentBundleId === null ? bundleIds : [currentBundleId, ...bundleIds];
    enforceActivePlacement(db, { operation: "group_create", target: { kind: "group", id: groupId },
      bundleIds: allBundleIds, briefingIds: briefingIdsForBundles(db, allBundleIds),
      override: input.placementOverride, now });
    db.prepare(`INSERT INTO briefing_groups
      (id, name, current_bundle_id, archived_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`)
      .run(groupId, name, currentBundleId, now, now);
    const insert = db.prepare(
      "INSERT INTO briefing_group_updates (group_id, bundle_id, position, created_at) VALUES (?, ?, ?, ?)",
    );
    bundleIds.forEach((bundleId, position) => insert.run(groupId, bundleId, position, now));
  }).immediate();
  return readBriefingGroup(db, groupId, input.viewer);
}

export function configureBriefingGroup(
  db: Db, groupRef: string,
  input: { currentBundleRef: string | null; bundleRefs: readonly string[]; placementOverride?: PlacementOverride },
  viewer: BriefingBundleViewer, now = Date.now(),
): { group: BriefingGroup; changed: boolean } {
  const groupId = resolveGroupId(db, groupRef);
  const bundleIds = resolveDistinctBundles(db, input.bundleRefs);
  const currentBundleId = input.currentBundleRef === null ? null : resolveBundleId(db, input.currentBundleRef);
  if (currentBundleId !== null && bundleIds.includes(currentBundleId)) {
    throw new BriefingStoreError("current_bundle_ref must not also appear in bundle_refs");
  }
  const changed = db.transaction(() => {
    const allBundleIds = currentBundleId === null ? bundleIds : [currentBundleId, ...bundleIds];
    const current = db.prepare("SELECT current_bundle_id, archived_at FROM briefing_groups WHERE id = ?")
      .get(groupId) as { current_bundle_id: string | null; archived_at: number | null };
    const previousUpdates = updateIds(db, groupId);
    if (current.current_bundle_id === currentBundleId
        && JSON.stringify(previousUpdates) === JSON.stringify(bundleIds)) return false;
    if (current.archived_at === null) enforceActivePlacement(db, { operation: "group_configure",
      target: { kind: "group", id: groupId }, bundleIds: allBundleIds,
      briefingIds: briefingIdsForBundles(db, allBundleIds), override: input.placementOverride, now });
    const dismissed = previousUpdates.filter((bundleId) => !bundleIds.includes(bundleId)
      && bundleId !== currentBundleId);
    const recordDismissal = db.prepare(`INSERT INTO briefing_group_dispositions (
      id, group_id, kind, prior_base_bundle_id, proposal_bundle_id, resulting_base_bundle_id,
      auth_request_id, merge_head_sha, created_at
    ) VALUES (?, ?, 'dismissed', ?, ?, NULL, NULL, NULL, ?)`);
    dismissed.forEach((bundleId) => recordDismissal.run(randomUUID(), groupId,
      current.current_bundle_id, bundleId, now));
    db.prepare("DELETE FROM briefing_group_updates WHERE group_id = ?").run(groupId);
    db.prepare("UPDATE briefing_groups SET current_bundle_id = ?, updated_at = ? WHERE id = ?")
      .run(currentBundleId, now, groupId);
    const insert = db.prepare(
      "INSERT INTO briefing_group_updates (group_id, bundle_id, position, created_at) VALUES (?, ?, ?, ?)",
    );
    bundleIds.forEach((bundleId, position) => insert.run(groupId, bundleId, position, now));
    return true;
  }).immediate();
  return { group: readBriefingGroup(db, groupId, viewer), changed };
}

export function addBriefingGroupUpdate(
  db: Db, groupRef: string, bundleRef: string, viewer: BriefingBundleViewer, now = Date.now(),
  placementOverride?: PlacementOverride,
): { group: BriefingGroup; added: boolean } {
  const groupId = resolveGroupId(db, groupRef);
  const bundleId = resolveBundleId(db, bundleRef);
  const added = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM briefing_group_updates WHERE bundle_id = ? AND group_id = ?")
      .get(bundleId, groupId)) return false;
    const group = db.prepare("SELECT archived_at FROM briefing_groups WHERE id = ?")
      .get(groupId) as { archived_at: number | null };
    if (group.archived_at === null) enforceActivePlacement(db, { operation: "group_add",
      target: { kind: "group", id: groupId }, bundleIds: [bundleId],
      briefingIds: briefingIdsForBundles(db, [bundleId]), override: placementOverride, now });
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

export function setBriefingGroupArchived(
  db: Db, groupRef: string, archived: boolean, viewer: BriefingBundleViewer, now = Date.now(),
): { group: BriefingGroup; changed: boolean } {
  const groupId = resolveGroupId(db, groupRef);
  const changed = db.transaction(() => {
    const row = db.prepare("SELECT current_bundle_id, archived_at FROM briefing_groups WHERE id = ?")
      .get(groupId) as { current_bundle_id: string | null; archived_at: number | null };
    if (archived ? row.archived_at !== null : row.archived_at === null) return false;
    if (!archived) {
      const bundleIds = [...(row.current_bundle_id ? [row.current_bundle_id] : []), ...updateIds(db, groupId)];
      enforceActivePlacement(db, { operation: "group_restore", target: { kind: "group", id: groupId },
        bundleIds, briefingIds: briefingIdsForBundles(db, bundleIds), now });
    }
    db.prepare("UPDATE briefing_groups SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archived ? now : null, now, groupId);
    return true;
  }).immediate();
  return { group: readBriefingGroup(db, groupId, viewer), changed };
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
