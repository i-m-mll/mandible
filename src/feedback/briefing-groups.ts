import { createHash, randomUUID } from "node:crypto";

import { canonicalJson } from "../canonical-json.js";
import type {
  BriefingGroup,
  BriefingGroupDestinationChange,
  BriefingGroupDisposition,
  BriefingGroupReviewLayoutEntry,
  BriefingGroupReviewCandidate,
  BriefingGroupReviewItem,
} from "../contracts.js";
import { readArtifactBytesFull } from "../artifact-content.js";
import type { Db } from "../db.js";
import { tableExists } from "../db-introspection.js";
import { resolveArtifactIdentity } from "../provider-artifacts.js";
import { parseJsonObject } from "../row-coerce.js";
import { BriefingStoreError } from "./briefings.js";
import { readBriefingBundle, resolveBundleId, type BriefingBundleViewer } from "./briefing-bundles.js";
import { briefingIdsForBundles, enforceActivePlacement, type PlacementOverride } from "./briefing-placement.js";
import { resolveId } from "../entity-refs.js";

export function resolveGroupId(db: Db, groupRef: string): string {
  const trimmed = groupRef.trim();
  const ref = trimmed.startsWith("briefing-group:") ? trimmed.slice("briefing-group:".length) : trimmed;
  if (!ref) throw new BriefingStoreError("group reference must be nonblank");
  const resolved = resolveId(db, "briefing_group", ref);
  if (resolved.ok) return resolved.id;
  if (resolved.error === "ambiguous") throw new BriefingStoreError("Briefing group reference is ambiguous", 409, "ambiguous_ref");
  const activeKey = db.prepare("SELECT id FROM briefing_groups WHERE key = ? AND archived_at IS NULL")
    .get(ref) as { id: string } | undefined;
  if (activeKey) return activeKey.id;
  throw new BriefingStoreError("Briefing group not found", 404, "not_found");
}

const GROUP_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function groupKey(value: unknown): string {
  if (typeof value !== "string" || !GROUP_KEY.test(value) || value.length > 80) {
    throw new BriefingStoreError(
      "key must be an immutable lower-kebab identifier of at most 80 characters",
      400,
      "invalid_briefing_group_key",
    );
  }
  return value;
}

function assertActiveGroupKeyAvailable(db: Db, key: string, exceptId?: string): void {
  const owner = db.prepare("SELECT id FROM briefing_groups WHERE key = ? AND archived_at IS NULL")
    .get(key) as { id: string } | undefined;
  if (owner && owner.id !== exceptId) {
    throw new BriefingStoreError("An active Briefing group already owns this key", 409,
      "briefing_group_key_conflict");
  }
}

function updateIds(db: Db, groupId: string): string[] {
  return (db.prepare("SELECT bundle_id FROM briefing_group_updates WHERE group_id = ? ORDER BY position")
    .all(groupId) as Array<{ bundle_id: string }>).map((row) => row.bundle_id);
}

type ReviewSnapshotRow = {
  layout_position: number;
  entry_kind: "briefing" | "subgroup";
  subgroup_name: string | null;
  subgroup_position: number;
  briefing_id: string;
  archived_at: number | null;
  round_id: string | null;
  artifact_version_id: string | null;
  artifact_id: string | null;
  content_hash: string | null;
  version_source_kind: string | null;
  version_custody_mode: string | null;
  commit_sha: string | null;
  artifact_source_kind: string | null;
  blob_storage_uri: string | null;
};

function reviewBundleSnapshot(db: Db, bundleId: string): ReviewSnapshotRow[] {
  return db.prepare(`SELECT bm.layout_position, bm.entry_kind, bm.subgroup_name, bm.subgroup_position,
      b.id AS briefing_id, b.archived_at, r.id AS round_id,
      r.artifact_version_id, av.artifact_id, av.content_hash, av.source_kind AS version_source_kind,
      av.custody_mode AS version_custody_mode, av.commit_sha,
      a.source_kind AS artifact_source_kind, blob.storage_uri AS blob_storage_uri
    FROM briefing_bundle_members bm
    JOIN briefings b ON b.id = bm.briefing_id
    LEFT JOIN briefing_rounds r ON r.id = b.latest_round_id
    LEFT JOIN artifact_version av ON av.id = r.artifact_version_id
    LEFT JOIN artifact a ON a.id = av.artifact_id
    LEFT JOIN artifact_blob blob ON blob.id = av.blob_id
    WHERE bm.bundle_id = ?
    ORDER BY bm.layout_position, bm.subgroup_position, bm.briefing_id`).all(bundleId) as ReviewSnapshotRow[];
}

function reviewLayout(rows: readonly ReviewSnapshotRow[]): BriefingGroupReviewLayoutEntry[] {
  return rows.map((row, position) => ({
    position,
    entry_kind: row.entry_kind,
    subgroup_name: row.subgroup_name,
    subgroup_position: row.subgroup_position,
    briefing_id: row.briefing_id,
    logical_artifact_id: row.artifact_id ?? "",
    artifact_version_id: row.artifact_version_id ?? "",
  }));
}

export type BriefingGroupDestinationChangeInput = {
  logicalArtifactRef: string;
  expectedGroupRef: string | null;
};

function destinationChangeIdentity(db: Db, change: BriefingGroupDestinationChangeInput) {
  const artifact = resolveArtifactIdentity(db, change.logicalArtifactRef, "strict-read");
  if (artifact.status !== "resolved" || artifact.target_type !== "artifact" || !artifact.target_id) {
    throw new BriefingStoreError("Destination changes require exact logical Artifact refs", 404,
      "artifact_not_found");
  }
  const expectedGroupId = change.expectedGroupRef === null ? null : resolveGroupId(db, change.expectedGroupRef);
  return { logical_artifact_id: artifact.target_id, expected_group_id: expectedGroupId };
}

function resolveDestinationChanges(
  db: Db,
  groupId: string,
  proposalRows: readonly ReviewSnapshotRow[],
  input: readonly BriefingGroupDestinationChangeInput[],
): BriefingGroupDestinationChange[] {
  const group = db.prepare("SELECT archived_at FROM briefing_groups WHERE id = ?")
    .get(groupId) as { archived_at: number | null } | undefined;
  if (!group || group.archived_at !== null) {
    throw new BriefingStoreError("Destination ownership requires an active Briefing group", 409,
      "briefing_destination_group_inactive");
  }
  const resolved = input.map((change) => {
    const identity = destinationChangeIdentity(db, change);
    const artifactId = identity.logical_artifact_id;
    const expectedGroupId = identity.expected_group_id;
    const owner = db.prepare("SELECT group_id FROM briefing_destination_owners WHERE logical_artifact_id = ?")
      .get(artifactId) as { group_id: string } | undefined;
    if ((owner?.group_id ?? null) !== expectedGroupId) {
      throw new BriefingStoreError("Destination ownership changed since the proposal was reviewed", 409,
        "briefing_destination_owner_drift");
    }
    const placements = proposalRows.filter((row) => row.artifact_id === artifactId);
    if (placements.length !== 1) {
      throw new BriefingStoreError(
        "A destination move requires exactly one matching document in the proposed layout",
        409,
        "briefing_destination_document_drift",
      );
    }
    return { logical_artifact_id: artifactId, expected_group_id: expectedGroupId };
  }).sort((left, right) => left.logical_artifact_id.localeCompare(right.logical_artifact_id));
  if (new Set(resolved.map((change) => change.logical_artifact_id)).size !== resolved.length) {
    throw new BriefingStoreError("Destination changes must name each logical Artifact at most once");
  }
  return resolved.map((change, position) => ({ ...change, position, resulting_group_id: groupId }));
}

function blockedReviewCandidate(
  proposalBundleId: string,
  expectedBaseBundleId: string | null,
  compositionRunId: string | null,
  code: string,
  message: string,
  items: BriefingGroupReviewItem[] = [],
): BriefingGroupReviewCandidate {
  return {
    proposal_bundle_id: proposalBundleId,
    expected_base_bundle_id: expectedBaseBundleId,
    composition_run_id: compositionRunId,
    binding_digest: null,
    ready: false,
    blocker_code: code,
    blocker_message: message,
    base_layout_digest: null,
    proposal_layout_digest: null,
    layout_changed: false,
    base_layout: [],
    proposal_layout: [],
    destination_changes: [],
    items,
  };
}

function reviewBindingManifestJson(
  groupId: string,
  candidate: Pick<BriefingGroupReviewCandidate,
    "expected_base_bundle_id" | "proposal_bundle_id" | "composition_run_id" | "base_layout"
    | "proposal_layout" | "base_layout_digest" | "proposal_layout_digest" | "destination_changes" | "items">,
): string {
  return canonicalJson({
    schema: "mandible-briefing-group-human-review@2",
    group_id: groupId,
    expected_base_bundle_id: candidate.expected_base_bundle_id,
    proposal_bundle_id: candidate.proposal_bundle_id,
    composition_run_id: candidate.composition_run_id,
    base_layout: candidate.base_layout,
    proposal_layout: candidate.proposal_layout,
    base_layout_digest: candidate.base_layout_digest,
    proposal_layout_digest: candidate.proposal_layout_digest,
    destination_changes: candidate.destination_changes,
    items: candidate.items,
  });
}

function humanReviewCandidate(
  db: Db,
  input: { groupId: string; expectedBaseBundleId: string | null; proposalBundleId: string;
    operatorUserId: string; destinationChanges?: readonly BriefingGroupDestinationChangeInput[] },
): BriefingGroupReviewCandidate {
  if (input.expectedBaseBundleId === null) return blockedReviewCandidate(
    input.proposalBundleId, null, null, "briefing_review_base_required",
    "Human-reviewed disposition requires an existing Base bundle.",
  );
  // Composer provenance is optional for manually staged proposals, but an existing
  // composer record must still match the exact reviewed group and Base.
  const provenance = db.prepare(`SELECT run_id, group_id, base_bundle_id, outcome
    FROM briefing_composition_targets WHERE proposal_bundle_id = ?`)
    .all(input.proposalBundleId) as Array<{
      run_id: string; group_id: string; base_bundle_id: string; outcome: string;
    }>;
  if (provenance.length > 1 || provenance.some((row) => row.group_id !== input.groupId
      || row.base_bundle_id !== input.expectedBaseBundleId || row.outcome !== "proposed")) {
    return blockedReviewCandidate(
      input.proposalBundleId, input.expectedBaseBundleId, null, "briefing_review_provenance_drift",
      "Composer provenance does not match this exact group, Base, and proposal.",
    );
  }
  const compositionRunId = provenance[0]?.run_id ?? null;
  const baseRows = reviewBundleSnapshot(db, input.expectedBaseBundleId);
  const proposalRows = reviewBundleSnapshot(db, input.proposalBundleId);
  if (proposalRows.length === 0 || proposalRows.some((row) => row.archived_at !== null || !row.round_id
      || !row.artifact_version_id || !row.artifact_id || !row.content_hash)) return blockedReviewCandidate(
    input.proposalBundleId, input.expectedBaseBundleId, compositionRunId,
    "briefing_review_proposal_incomplete", "Every proposal member must have one active frozen Briefing round.",
  );
  if (baseRows.some((row) => row.archived_at !== null || !row.round_id
      || !row.artifact_version_id || !row.artifact_id || !row.content_hash)) return blockedReviewCandidate(
    input.proposalBundleId, input.expectedBaseBundleId, compositionRunId,
    "briefing_review_base_incomplete", "Every Base member must have one active frozen Briefing round.",
  );
  const baseLayout = reviewLayout(baseRows);
  const proposalLayout = reviewLayout(proposalRows);
  const baseLayoutDigest = createHash("sha256").update(canonicalJson(baseLayout)).digest("hex");
  const proposalLayoutDigest = createHash("sha256").update(canonicalJson(proposalLayout)).digest("hex");
  const structural = (layout: readonly BriefingGroupReviewLayoutEntry[]) => layout.map((entry) => ({
    position: entry.position,
    entry_kind: entry.entry_kind,
    subgroup_name: entry.subgroup_name,
    subgroup_position: entry.subgroup_position,
    logical_artifact_id: entry.logical_artifact_id,
  }));
  const layoutChanged = canonicalJson(structural(baseLayout)) !== canonicalJson(structural(proposalLayout));
  const destinationChanges = resolveDestinationChanges(
    db,
    input.groupId,
    proposalRows,
    input.destinationChanges ?? [],
  );
  const baseByArtifact = new Map<string, ReviewSnapshotRow>();
  for (const row of baseRows) {
    if (baseByArtifact.has(row.artifact_id!)) return blockedReviewCandidate(
      input.proposalBundleId, input.expectedBaseBundleId, compositionRunId,
      "briefing_review_base_ambiguous", "The Base contains the same logical Artifact more than once.",
    );
    baseByArtifact.set(row.artifact_id!, row);
  }
  const proposalArtifacts = new Set<string>();
  const items: BriefingGroupReviewItem[] = [];
  for (const [position, row] of proposalRows.entries()) {
    if (proposalArtifacts.has(row.artifact_id!)) return blockedReviewCandidate(
      input.proposalBundleId, input.expectedBaseBundleId, compositionRunId,
      "briefing_review_proposal_ambiguous", "The proposal contains the same logical Artifact more than once.", items,
    );
    proposalArtifacts.add(row.artifact_id!);
    const base = baseByArtifact.get(row.artifact_id!) ?? null;
    const changed = base?.artifact_version_id !== row.artifact_version_id;
    const authoritative = (row.artifact_source_kind === "managed" || row.artifact_source_kind === "local_only")
      && (row.version_source_kind === "managed" || row.version_source_kind === "local_only")
      && row.version_custody_mode === "managed"
      && Boolean(row.blob_storage_uri)
      && row.commit_sha === null;
    if (!authoritative) return blockedReviewCandidate(
      input.proposalBundleId, input.expectedBaseBundleId, compositionRunId,
      "briefing_review_repository_authority_required",
      "Repository-backed, mixed-lineage, external, or unavailable proposal bytes require protected merge promotion.", items,
    );
    const bytes = readArtifactBytesFull(db, row.artifact_version_id!);
    if (!bytes.ok) return blockedReviewCandidate(
      input.proposalBundleId, input.expectedBaseBundleId, compositionRunId,
      "briefing_review_custody_unavailable", `Proposal artifact custody is unavailable: ${bytes.reason}.`, items,
    );
    let submissionId: string | null = null;
    if (changed) {
      const submission = db.prepare(`SELECT id FROM briefing_submissions
        WHERE round_id = ? AND actor_user_id = ? ORDER BY ordinal DESC, created_at DESC, id DESC LIMIT 1`)
        .get(row.round_id, input.operatorUserId) as { id: string } | undefined;
      if (!submission) return blockedReviewCandidate(
        input.proposalBundleId, input.expectedBaseBundleId, compositionRunId,
        "briefing_review_submission_required",
        "Submit a frozen operator review for every changed proposal document before accepting or rejecting it.", items,
      );
      submissionId = submission.id;
    }
    items.push({
      position,
      layout_position: row.layout_position,
      subgroup_position: row.subgroup_position,
      proposal_briefing_id: row.briefing_id,
      proposal_round_id: row.round_id!,
      proposal_artifact_version_id: row.artifact_version_id!,
      proposal_content_hash: row.content_hash!,
      base_briefing_id: base?.briefing_id ?? null,
      base_round_id: base?.round_id ?? null,
      base_artifact_version_id: base?.artifact_version_id ?? null,
      base_content_hash: base?.content_hash ?? null,
      changed,
      submission_id: submissionId,
    });
  }
  if (!items.some((item) => item.changed) && !layoutChanged && destinationChanges.length === 0) return blockedReviewCandidate(
    input.proposalBundleId, input.expectedBaseBundleId, compositionRunId,
    "briefing_review_change_required",
    "Human-reviewed disposition requires a document, layout, or destination ownership change.", items,
  );
  const candidate = {
    expected_base_bundle_id: input.expectedBaseBundleId,
    proposal_bundle_id: input.proposalBundleId,
    composition_run_id: compositionRunId,
    base_layout: baseLayout,
    proposal_layout: proposalLayout,
    base_layout_digest: baseLayoutDigest,
    proposal_layout_digest: proposalLayoutDigest,
    destination_changes: destinationChanges,
    items,
  };
  return {
    ...candidate,
    binding_digest: createHash("sha256").update(reviewBindingManifestJson(input.groupId, candidate)).digest("hex"),
    ready: true,
    blocker_code: null,
    blocker_message: null,
    layout_changed: layoutChanged,
    items,
  };
}

export function previewBriefingGroupReviewCandidate(
  db: Db,
  input: {
    groupRef: string;
    expectedBaseBundleRef: string;
    proposalBundleRef: string;
    destinationChanges?: readonly BriefingGroupDestinationChangeInput[];
  },
  operatorUserId: string,
): BriefingGroupReviewCandidate {
  const groupId = resolveGroupId(db, input.groupRef);
  const expectedBaseBundleId = resolveBundleId(db, input.expectedBaseBundleRef);
  const proposalBundleId = resolveBundleId(db, input.proposalBundleRef);
  const group = db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?")
    .get(groupId) as { current_bundle_id: string | null };
  if (group.current_bundle_id !== expectedBaseBundleId) {
    throw new BriefingStoreError("Briefing group Base does not match expected_base_bundle_ref", 409,
      "briefing_review_base_drift");
  }
  if (!db.prepare("SELECT 1 FROM briefing_group_updates WHERE group_id = ? AND bundle_id = ?")
    .get(groupId, proposalBundleId)) {
    throw new BriefingStoreError("Proposal bundle is not an active proposal in this group", 409,
      "briefing_review_proposal_drift");
  }
  return humanReviewCandidate(db, {
    groupId,
    expectedBaseBundleId,
    proposalBundleId,
    operatorUserId,
    destinationChanges: input.destinationChanges,
  });
}

export function readBriefingGroup(db: Db, groupRef: string, viewer: BriefingBundleViewer): BriefingGroup {
  const id = resolveGroupId(db, groupRef);
  const group = db.prepare("SELECT id, key, name, current_bundle_id, archived_at, created_at, updated_at FROM briefing_groups WHERE id = ?")
    .get(id) as Omit<BriefingGroup, "current" | "updates"> & { current_bundle_id: string | null };
  const { current_bundle_id: currentBundleId, ...projection } = group;
  return {
    ...projection,
    current: currentBundleId === null ? null : readBriefingBundle(db, currentBundleId, viewer),
    updates: updateIds(db, id).map((bundleId) => readBriefingBundle(db, bundleId, viewer)),
    destinations: (db.prepare(`SELECT owner.logical_artifact_id, owner.group_id,
        MIN(policy.publication_mode) AS publication_mode, owner.created_at, owner.updated_at,
        (SELECT json_group_array(route_key) FROM (SELECT route_key FROM briefing_destination_routes
          WHERE logical_artifact_id = owner.logical_artifact_id ORDER BY route_key)) AS route_keys_json
      FROM briefing_destination_owners owner
      LEFT JOIN briefing_destination_routes route ON route.logical_artifact_id = owner.logical_artifact_id
      LEFT JOIN briefing_destination_policies policy ON policy.route_key = route.route_key
      WHERE owner.group_id = ? GROUP BY owner.logical_artifact_id, owner.group_id
      ORDER BY owner.logical_artifact_id`).all(id) as Array<Omit<BriefingGroup["destinations"][number], "route_keys"> &
        { route_keys_json: string }>).map(({ route_keys_json, ...destination }) => ({
          ...destination, route_keys: JSON.parse(route_keys_json) as string[],
        })),
    destination_history: db.prepare(`SELECT id, logical_artifact_id,
        json_extract(before_json, '$.owner_group_id') AS prior_group_id,
        json_extract(after_json, '$.group_id') AS resulting_group_id,
        actor_user_id, created_at FROM briefing_destination_mutations
      WHERE operation_kind = 'place' AND (
        json_extract(before_json, '$.owner_group_id') = ? OR
        json_extract(after_json, '$.group_id') = ?)
      ORDER BY created_at DESC, id DESC`).all(id, id) as BriefingGroup["destination_history"],
    review_candidates: viewer.humanReviewOperator === true
      ? updateIds(db, id).map((proposalBundleId) => humanReviewCandidate(db, {
      groupId: id, expectedBaseBundleId: currentBundleId, proposalBundleId, operatorUserId: viewer.userId,
      })) : [],
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
  const mergeBound = rows.map((row): BriefingGroupDisposition => ({
    id: row.id,
    kind: row.kind,
    prior_base: row.prior_base_bundle_id === null ? null : readBriefingBundle(db, row.prior_base_bundle_id, viewer),
    proposal: readBriefingBundle(db, row.proposal_bundle_id, viewer),
    resulting_base: row.resulting_base_bundle_id === null
      ? null : readBriefingBundle(db, row.resulting_base_bundle_id, viewer),
    auth_request_id: row.auth_request_id,
    merge_head_sha: row.merge_head_sha,
    review_binding_digest: null,
    composition_run_id: null,
    review_items: [],
    base_layout_digest: null,
    proposal_layout_digest: null,
    base_layout: [],
    proposal_layout: [],
    destination_changes: [],
    actor_user_id: null,
    evidence_method: null,
    credential_id: null,
    created_at: row.created_at,
  }));
  if (!tableExists(db, "briefing_group_review_dispositions")) return mergeBound;
  const reviewed = db.prepare(`SELECT id, decision, expected_base_bundle_id, proposal_bundle_id,
      composition_run_id, resulting_base_bundle_id, binding_digest, manifest_json, actor_user_id,
      evidence_method, credential_id, item_count, destination_change_count,
      base_layout_digest, proposal_layout_digest, created_at
    FROM briefing_group_review_dispositions WHERE group_id = ?`).all(groupId) as Array<{
      id: string; decision: "accepted" | "rejected"; expected_base_bundle_id: string;
      proposal_bundle_id: string; composition_run_id: string | null; resulting_base_bundle_id: string;
      binding_digest: string; manifest_json: string; actor_user_id: string; evidence_method: string;
      credential_id: string | null; item_count: number; destination_change_count: number;
      base_layout_digest: string | null; proposal_layout_digest: string | null; created_at: number;
    }>;
  const humanReviewed = reviewed.map((row): BriefingGroupDisposition => {
    if (createHash("sha256").update(row.manifest_json).digest("hex") !== row.binding_digest) {
      throw new BriefingStoreError("Stored human-review manifest digest does not match its receipt", 500,
        "briefing_review_receipt_corrupt");
    }
    const manifest = parseJsonObject(row.manifest_json);
    if (manifest.schema !== "mandible-briefing-group-human-review@1"
        && manifest.schema !== "mandible-briefing-group-human-review@2") {
      throw new BriefingStoreError("Stored human-review manifest has an unsupported schema", 500,
        "briefing_review_receipt_corrupt");
    }
    if (manifest.group_id !== groupId
        || manifest.expected_base_bundle_id !== row.expected_base_bundle_id
        || manifest.proposal_bundle_id !== row.proposal_bundle_id
        || manifest.composition_run_id !== row.composition_run_id
        || !Array.isArray(manifest.items)) {
      throw new BriefingStoreError("Stored human-review manifest does not match its receipt", 500,
        "briefing_review_receipt_corrupt");
    }
    const anchored = db.prepare(`SELECT COUNT(*) AS count FROM briefing_group_review_disposition_items
      WHERE disposition_id = ?`).get(row.id) as { count: number };
    if (anchored.count !== row.item_count || row.item_count !== manifest.items.length) {
      throw new BriefingStoreError("Stored human-review receipt has incomplete custody anchors", 500,
        "briefing_review_receipt_corrupt");
    }
    const baseLayout = manifest.schema === "mandible-briefing-group-human-review@2"
      && Array.isArray(manifest.base_layout) ? manifest.base_layout as BriefingGroupReviewLayoutEntry[] : [];
    const proposalLayout = manifest.schema === "mandible-briefing-group-human-review@2"
      && Array.isArray(manifest.proposal_layout) ? manifest.proposal_layout as BriefingGroupReviewLayoutEntry[] : [];
    const destinationChanges = manifest.schema === "mandible-briefing-group-human-review@2"
      && Array.isArray(manifest.destination_changes)
      ? manifest.destination_changes as BriefingGroupDestinationChange[] : [];
    const destinationAnchors = db.prepare(`SELECT COUNT(*) AS count
      FROM briefing_group_review_destination_items WHERE disposition_id = ?`).get(row.id) as { count: number };
    if (destinationAnchors.count !== row.destination_change_count
        || row.destination_change_count !== destinationChanges.length
        || (manifest.schema === "mandible-briefing-group-human-review@2"
          && (row.base_layout_digest !== manifest.base_layout_digest
            || row.proposal_layout_digest !== manifest.proposal_layout_digest))) {
      throw new BriefingStoreError("Stored human-review receipt has incomplete structural anchors", 500,
        "briefing_review_receipt_corrupt");
    }
    return {
      id: row.id,
      kind: row.decision,
      prior_base: readBriefingBundle(db, row.expected_base_bundle_id, viewer),
      proposal: readBriefingBundle(db, row.proposal_bundle_id, viewer),
      resulting_base: readBriefingBundle(db, row.resulting_base_bundle_id, viewer),
      auth_request_id: null,
      merge_head_sha: null,
      review_binding_digest: row.binding_digest,
      composition_run_id: row.composition_run_id,
      review_items: manifest.items as BriefingGroupReviewItem[],
      base_layout_digest: row.base_layout_digest,
      proposal_layout_digest: row.proposal_layout_digest,
      base_layout: baseLayout,
      proposal_layout: proposalLayout,
      destination_changes: destinationChanges,
      actor_user_id: row.actor_user_id,
      evidence_method: row.evidence_method,
      credential_id: row.credential_id,
      created_at: row.created_at,
    };
  });
  return [...mergeBound, ...humanReviewed].sort((left, right) =>
    right.created_at - left.created_at || right.id.localeCompare(left.id));
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

export type BriefingGroupHumanReviewInput = {
  groupRef: string;
  expectedBaseBundleRef: string;
  proposalBundleRef: string;
  decision: "accepted" | "rejected";
  bindingDigest: string;
  destinationChanges?: readonly BriefingGroupDestinationChangeInput[];
};

export type BriefingGroupHumanReviewActor = {
  userId: string;
  evidenceMethod: "api_token";
  credentialId: string | null;
};

export type BriefingGroupHumanReviewResult = {
  group: BriefingGroup;
  disposition: BriefingGroupDisposition;
  changed: boolean;
};

export type BriefingDestinationOwnerActor = {
  userId: string;
  evidenceMethod: "api_token";
  credentialId: string | null;
};

export function bindBriefingDestinationOwner(
  db: Db,
  input: { logicalArtifactRef: string; groupRef: string },
  actor: BriefingDestinationOwnerActor,
  viewer: BriefingBundleViewer,
  now = Date.now(),
): { group: BriefingGroup; changed: boolean } {
  const groupId = resolveGroupId(db, input.groupRef);
  const artifact = resolveArtifactIdentity(db, input.logicalArtifactRef, "strict-read");
  if (artifact.status !== "resolved" || artifact.target_type !== "artifact" || !artifact.target_id) {
    throw new BriefingStoreError("Destination ownership requires one exact logical Artifact ref", 404,
      "artifact_not_found");
  }
  const logicalArtifactId = artifact.target_id;
  const changed = db.transaction(() => {
    const group = db.prepare("SELECT current_bundle_id, archived_at FROM briefing_groups WHERE id = ?")
      .get(groupId) as { current_bundle_id: string | null; archived_at: number | null };
    if (group.archived_at !== null || group.current_bundle_id === null) {
      throw new BriefingStoreError("Destination ownership requires an active group with a Base bundle", 409,
        "briefing_destination_base_unavailable");
    }
    const placements = db.prepare(`SELECT COUNT(*) AS count
      FROM briefing_bundle_members bm
      JOIN briefings b ON b.id = bm.briefing_id
      JOIN briefing_rounds r ON r.id = b.latest_round_id
      JOIN artifact_version av ON av.id = r.artifact_version_id
      WHERE bm.bundle_id = ? AND av.artifact_id = ?`).get(group.current_bundle_id, logicalArtifactId) as { count: number };
    if (placements.count !== 1) {
      throw new BriefingStoreError("A destination owner Base must contain exactly one matching document", 409,
        "briefing_destination_document_drift");
    }
    const owner = db.prepare("SELECT group_id FROM briefing_destination_owners WHERE logical_artifact_id = ?")
      .get(logicalArtifactId) as { group_id: string } | undefined;
    if (owner) {
      if (owner.group_id === groupId) return false;
      throw new BriefingStoreError(
        "Destination ownership already exists and can move only through an accepted guarded review",
        409,
        "briefing_destination_owner_conflict",
      );
    }
    db.prepare(`INSERT INTO briefing_destination_owners (
      logical_artifact_id, group_id, bound_by_user_id, evidence_method, credential_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      logicalArtifactId, groupId, actor.userId, actor.evidenceMethod, actor.credentialId, now, now,
    );
    return true;
  }).immediate();
  return { group: readBriefingGroup(db, groupId, viewer), changed };
}

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
  const resolved = resolveId(db, "auth_request", ref);
  if (resolved.ok) return resolved.id;
  if (resolved.error === "ambiguous") throw new BriefingStoreError("Auth request reference is ambiguous", 409, "ambiguous_ref");
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

function removeActiveProposal(db: Db, groupId: string, proposalBundleId: string): void {
  const removed = db.prepare("DELETE FROM briefing_group_updates WHERE group_id = ? AND bundle_id = ?")
    .run(groupId, proposalBundleId);
  if (removed.changes !== 1) throw new BriefingStoreError(
    "Proposal bundle is not an active proposal in this group", 409, "briefing_review_proposal_drift",
  );
  const reposition = db.prepare(
    "UPDATE briefing_group_updates SET position = ? WHERE group_id = ? AND bundle_id = ?",
  );
  updateIds(db, groupId).forEach((bundleId, position) => reposition.run(position, groupId, bundleId));
}

export function dispositionBriefingGroupProposalByHumanReview(
  db: Db,
  input: BriefingGroupHumanReviewInput,
  actor: BriefingGroupHumanReviewActor,
  viewer: BriefingBundleViewer,
  now = Date.now(),
): BriefingGroupHumanReviewResult {
  const groupId = resolveGroupId(db, input.groupRef);
  const expectedBaseBundleId = resolveBundleId(db, input.expectedBaseBundleRef);
  const proposalBundleId = resolveBundleId(db, input.proposalBundleRef);
  const bindingDigest = input.bindingDigest.trim().toLowerCase();
  if (input.decision !== "accepted" && input.decision !== "rejected") {
    throw new BriefingStoreError("decision must be accepted or rejected");
  }
  if (!/^[0-9a-f]{64}$/.test(bindingDigest)) {
    throw new BriefingStoreError("binding_digest must be one exact SHA-256 digest");
  }
  const result = db.transaction(() => {
    const replay = db.prepare(`SELECT id, decision, expected_base_bundle_id, binding_digest,
        actor_user_id, evidence_method, credential_id
      FROM briefing_group_review_dispositions WHERE group_id = ? AND proposal_bundle_id = ?`)
      .get(groupId, proposalBundleId) as {
        id: string; decision: string; expected_base_bundle_id: string; binding_digest: string;
        actor_user_id: string; evidence_method: string; credential_id: string | null;
      } | undefined;
    if (replay) {
      if (replay.decision !== input.decision || replay.expected_base_bundle_id !== expectedBaseBundleId
          || replay.binding_digest !== bindingDigest || replay.actor_user_id !== actor.userId
          || replay.evidence_method !== actor.evidenceMethod || replay.credential_id !== actor.credentialId) {
        throw new BriefingStoreError("Applied human-review disposition does not match this exact replay", 409,
          "briefing_review_replay_drift");
      }
      const expectedChanges = db.prepare(`SELECT logical_artifact_id, expected_group_id
        FROM briefing_group_review_destination_items WHERE disposition_id = ? ORDER BY position`)
        .all(replay.id);
      const replayChanges = (input.destinationChanges ?? []).map((change) => destinationChangeIdentity(db, change))
        .sort((left, right) => left.logical_artifact_id.localeCompare(right.logical_artifact_id));
      if (canonicalJson(replayChanges) !== canonicalJson(expectedChanges)) {
        throw new BriefingStoreError("Destination changes do not match this exact replay", 409,
          "briefing_review_replay_drift");
      }
      return { dispositionId: replay.id, changed: false };
    }
    const group = db.prepare("SELECT current_bundle_id, archived_at FROM briefing_groups WHERE id = ?")
      .get(groupId) as { current_bundle_id: string | null; archived_at: number | null };
    if (group.archived_at !== null) throw new BriefingStoreError(
      "Archived Briefing groups cannot be dispositioned", 409, "briefing_review_group_archived",
    );
    if (group.current_bundle_id !== expectedBaseBundleId) throw new BriefingStoreError(
      "Briefing group Base does not match expected_base_bundle_ref", 409, "briefing_review_base_drift",
    );
    if (!db.prepare("SELECT 1 FROM briefing_group_updates WHERE group_id = ? AND bundle_id = ?")
      .get(groupId, proposalBundleId)) throw new BriefingStoreError(
      "Proposal bundle is not an active proposal in this group", 409, "briefing_review_proposal_drift",
    );
    const candidate = humanReviewCandidate(db, {
      groupId, expectedBaseBundleId, proposalBundleId, operatorUserId: actor.userId,
      destinationChanges: input.destinationChanges,
    });
    if (!candidate.ready || !candidate.binding_digest) {
      throw new BriefingStoreError(candidate.blocker_message ?? "Human-review binding is unavailable", 409,
        candidate.blocker_code ?? "briefing_review_binding_unavailable");
    }
    if (candidate.binding_digest !== bindingDigest) throw new BriefingStoreError(
      "Human-review binding no longer matches the frozen proposal and submissions", 409,
      "briefing_review_binding_drift",
    );
    const manifestJson = reviewBindingManifestJson(groupId, candidate);
    const dispositionId = randomUUID();
    removeActiveProposal(db, groupId, proposalBundleId);
    const resultingBaseBundleId = input.decision === "accepted" ? proposalBundleId : expectedBaseBundleId;
    if (input.decision === "accepted") {
      const changed = db.prepare(`UPDATE briefing_groups SET current_bundle_id = ?, updated_at = ?
        WHERE id = ? AND current_bundle_id = ?`).run(proposalBundleId, now, groupId, expectedBaseBundleId);
      if (changed.changes !== 1) throw new BriefingStoreError(
        "Briefing group Base changed during human review", 409, "briefing_review_base_drift",
      );
    } else {
      db.prepare("UPDATE briefing_groups SET updated_at = ? WHERE id = ?").run(now, groupId);
    }
    db.prepare(`INSERT INTO briefing_group_review_dispositions (
      id, group_id, decision, expected_base_bundle_id, proposal_bundle_id, composition_run_id,
      resulting_base_bundle_id, base_layout_digest, proposal_layout_digest, binding_digest, manifest_json,
      item_count, destination_change_count, actor_user_id, evidence_method, credential_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      dispositionId, groupId, input.decision, expectedBaseBundleId, proposalBundleId,
      candidate.composition_run_id, resultingBaseBundleId, candidate.base_layout_digest,
      candidate.proposal_layout_digest, bindingDigest, manifestJson, candidate.items.length,
      candidate.destination_changes.length, actor.userId, actor.evidenceMethod, actor.credentialId, now,
    );
    const insertAnchor = db.prepare(`INSERT INTO briefing_group_review_disposition_items (
      disposition_id, position, proposal_briefing_id, proposal_round_id, proposal_artifact_version_id,
      base_briefing_id, base_round_id, base_artifact_version_id, submission_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of candidate.items) insertAnchor.run(
      dispositionId, item.position, item.proposal_briefing_id, item.proposal_round_id,
      item.proposal_artifact_version_id, item.base_briefing_id, item.base_round_id,
      item.base_artifact_version_id, item.submission_id,
    );
    const insertDestinationAnchor = db.prepare(`INSERT INTO briefing_group_review_destination_items (
      disposition_id, position, logical_artifact_id, expected_group_id, resulting_group_id
    ) VALUES (?, ?, ?, ?, ?)`);
    for (const change of candidate.destination_changes) {
      insertDestinationAnchor.run(dispositionId, change.position, change.logical_artifact_id,
        change.expected_group_id, change.resulting_group_id);
      if (input.decision === "accepted") {
        const updated = change.expected_group_id === null
          ? db.prepare(`INSERT INTO briefing_destination_owners (
              logical_artifact_id, group_id, bound_by_user_id, evidence_method, credential_id, created_at, updated_at
            ) SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM briefing_destination_owners WHERE logical_artifact_id = ?)`).run(
            change.logical_artifact_id, groupId, actor.userId, actor.evidenceMethod, actor.credentialId,
            now, now, change.logical_artifact_id)
          : db.prepare(`UPDATE briefing_destination_owners
              SET group_id = ?, bound_by_user_id = ?, evidence_method = ?, credential_id = ?, updated_at = ?
              WHERE logical_artifact_id = ? AND group_id = ?`).run(
            groupId, actor.userId, actor.evidenceMethod, actor.credentialId, now,
            change.logical_artifact_id, change.expected_group_id);
        if (updated.changes !== 1) throw new BriefingStoreError(
          "Destination ownership changed during human review", 409, "briefing_destination_owner_drift",
        );
      }
    }
    return { dispositionId, changed: true };
  }).immediate();
  const group = readBriefingGroup(db, groupId, viewer);
  const disposition = group.history.find((entry) => entry.id === result.dispositionId);
  if (!disposition) throw new BriefingStoreError("Human-review history could not be read", 500,
    "briefing_review_history_missing");
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
  input: { key: string; name: string; currentBundleRef?: string | null; bundleRefs: readonly string[];
    viewer: BriefingBundleViewer; placementOverride?: PlacementOverride },
  now = Date.now(),
): BriefingGroup {
  const name = input.name.trim();
  if (!name) throw new BriefingStoreError("name must be a nonblank string");
  const key = groupKey(input.key);
  assertActiveGroupKeyAvailable(db, key);
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
    assertActiveGroupKeyAvailable(db, key);
    db.prepare(`INSERT INTO briefing_groups
      (id, key, name, current_bundle_id, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`)
      .run(groupId, key, name, currentBundleId, now, now);
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
    if (current.current_bundle_id !== null && current.current_bundle_id !== currentBundleId) {
      throw new BriefingStoreError(
        "An established Base can change only through guarded promotion or human-reviewed disposition",
        409,
        "briefing_group_base_transition_requires_promotion",
      );
    }
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
    if (archived && db.prepare("SELECT 1 FROM briefing_destination_owners WHERE group_id = ? LIMIT 1").get(groupId)) {
      throw new BriefingStoreError("A group that owns active destinations cannot be archived", 409,
        "briefing_destination_group_owned");
    }
    if (!archived) {
      const key = (db.prepare("SELECT key FROM briefing_groups WHERE id = ?").get(groupId) as { key: string }).key;
      assertActiveGroupKeyAvailable(db, key, groupId);
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
