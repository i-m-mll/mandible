import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../canonical-json.js";
import type { Db } from "../db.js";
import { requestOriginJson } from "../request-origin.js";
import { bundleMemberRows, resolveBundleId, writeBundleMemberRows } from "./briefing-bundles.js";
import { resolveGroupId } from "./briefing-groups.js";
import { BriefingStoreError } from "./briefing-errors.js";
import { mutateBriefing } from "./mutation-history.js";
import {
  isTrackedBriefingPath, recordedTrackedBriefingRename, trackedBriefingReader, trackedTreeBlob,
} from "./tracked-briefing-files.js";

type ConversionMember = { briefing_id: string; title: string; project_id: string | null; old_path: string | null } & (
  | { kind: "track"; project_key: string; path: string; commit_sha: string; evidence: "current_path" | "recorded_rename" }
  | { kind: "keep_custody"; reason: string }
);
type ConversionPlan = {
  group_name: string;
  group_id: string;
  base_bundle_id: string;
  pending_proposal_ids: string[];
  decision_count: number;
  members: ConversionMember[];
  plan_digest: string;
};

export function planTrackedBriefingGroupConversion(db: Db, groupRef: string): ConversionPlan {
  return db.transaction(() => readConversionPlan(db, groupRef)).deferred();
}

function readConversionPlan(db: Db, groupRef: string): ConversionPlan {
  const groupId = resolveGroupId(db, groupRef);
  const group = db.prepare("SELECT name, current_bundle_id, archived_at FROM briefing_groups WHERE id = ?")
    .get(groupId) as { name: string; current_bundle_id: string | null; archived_at: number | null };
  if (!group.current_bundle_id || group.archived_at !== null) {
    throw new BriefingStoreError("Conversion requires an active group with a current bundle", 409, "conversion_group_unavailable");
  }
  const base = group.current_bundle_id;
  const pending = db.prepare("SELECT bundle_id FROM briefing_group_updates WHERE group_id = ? ORDER BY position")
    .all(groupId) as Array<{ bundle_id: string }>;
  const history = db.prepare(`SELECT (SELECT COUNT(*) FROM briefing_group_dispositions WHERE group_id = ?)
    + (SELECT COUNT(*) FROM briefing_group_review_dispositions WHERE group_id = ?) AS count`)
    .get(groupId, groupId) as { count: number };
  const rows = db.prepare(`SELECT b.id AS briefing_id, b.title, av.source_project_id AS project_id,
      av.repo_path AS old_path, av.commit_sha, av.custody_mode,
      EXISTS(SELECT 1 FROM briefing_destination_owners o
        WHERE o.group_id = ? AND o.logical_artifact_id = b.logical_artifact_id) AS owns_destination
    FROM briefing_bundle_members m JOIN briefings b ON b.id = m.briefing_id
    LEFT JOIN briefing_rounds r ON r.id = b.latest_round_id
    LEFT JOIN artifact_version av ON av.id = r.artifact_version_id
    WHERE m.bundle_id = ? ORDER BY m.layout_position, m.subgroup_position`)
    .all(groupId, base) as Array<{
      briefing_id: string; title: string; project_id: string | null; old_path: string | null;
      commit_sha: string | null; custody_mode: string | null; owns_destination: number;
    }>;
  const reader = trackedBriefingReader(db);
  const candidates = rows.map(({ commit_sha, custody_mode, owns_destination, ...member }): ConversionMember => {
    const keep = (reason: string): ConversionMember => ({ ...member, kind: "keep_custody", reason });
    if (owns_destination) return keep("owned_custody_destination");
    if (custody_mode !== "git" || !member.project_id || !commit_sha || !isTrackedBriefingPath(member.old_path)) {
      return keep("no_git_custody_binding");
    }
    const tree = reader.tree(member.project_id);
    if (!tree.commit_sha) return keep("protected_commit_unavailable");
    const result = trackedTreeBlob(tree, member.old_path)
      ? { kind: "current" as const, path: member.old_path }
      : recordedTrackedBriefingRename(tree, commit_sha, member.old_path);
    if (result.kind === "unresolved") return keep(result.reason);
    return { ...member, kind: "track", project_key: tree.project_key, path: result.path,
      commit_sha: tree.commit_sha, evidence: result.kind === "current" ? "current_path" : "recorded_rename" };
  });
  const identity = (projectId: string | null, path: string) => JSON.stringify([projectId, path]);
  const layout = bundleMemberRows(db, base);
  const seen = new Set(layout.flatMap(row => row.briefing_id === null
    ? [identity(row.tracked_project_id, row.tracked_path)] : []));
  const collisions = new Set(seen);
  for (const candidate of candidates) {
    if (candidate.kind === "keep_custody") continue;
    const key = identity(candidate.project_id, candidate.path);
    if (seen.has(key)) collisions.add(key);
    seen.add(key);
  }
  const members = candidates.map((candidate): ConversionMember => {
    if (candidate.kind === "keep_custody" || !collisions.has(identity(candidate.project_id, candidate.path))) return candidate;
    const { briefing_id, title, project_id, old_path } = candidate;
    return { briefing_id, title, project_id, old_path, kind: "keep_custody", reason: "duplicate_tracked_path" };
  });
  const plan = { group_name: group.name, group_id: groupId, base_bundle_id: base, pending_proposal_ids: pending.map(row => row.bundle_id),
    decision_count: history.count, members };
  const plan_digest = createHash("sha256").update(canonicalJson({ plan, layout, custody: rows })).digest("hex");
  return { ...plan, plan_digest };
}

type ReviewedConversion = { groupRef: string; expectedBaseRef: string; planDigest: string };

function reviewedConversion(db: Db, input: ReviewedConversion): ConversionPlan {
  const plan = readConversionPlan(db, input.groupRef);
  if (plan.base_bundle_id !== resolveBundleId(db, input.expectedBaseRef)) {
    throw new BriefingStoreError("The group’s current bundle changed", 409, "conversion_base_drift");
  }
  if (plan.pending_proposal_ids.length) {
    throw new BriefingStoreError("Decide all custody proposals before conversion", 409, "conversion_pending_proposals",
      { proposal_ids: plan.pending_proposal_ids });
  }
  if (plan.plan_digest !== input.planDigest) {
    throw new BriefingStoreError("The group’s conversion plan changed. Review it again.", 409, "conversion_plan_drift");
  }
  return plan;
}

const CONVERSION_COMMAND = "mandible-native:briefing-group-convert";
const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const CONVERSION_ARGUMENTS = new RegExp(`^${CONVERSION_COMMAND} (${UUID}) (${UUID}) ([a-f0-9]{64})$`);

export function briefingConversionArguments(command: string): ReviewedConversion | null {
  if (command.split(" ", 1)[0] !== CONVERSION_COMMAND) return null;
  const match = CONVERSION_ARGUMENTS.exec(command);
  if (!match || match[0] !== command) throw new BriefingStoreError("Invalid reviewed conversion arguments", 400, "invalid_conversion_arguments");
  const [, groupRef, expectedBaseRef, planDigest] = match;
  return { groupRef, expectedBaseRef, planDigest };
}

export function prepareBriefingConversionRequest(db: Db, input: ReviewedConversion) {
  const plan = db.transaction(() => reviewedConversion(db, input)).deferred();
  if (!plan.members.some(member => member.kind === "track")) {
    throw new BriefingStoreError("No Briefing members to convert", 409, "conversion_empty");
  }
  return {
    type: "config-change" as const,
    command: `${CONVERSION_COMMAND} ${plan.group_id} ${plan.base_bundle_id} ${plan.plan_digest}`,
    title: `Track files in ${plan.group_name}`,
    commit_message: [
      "Read these Briefing members from their projects’ protected branches. Preserve the group layout and existing review decisions.",
      "Take a ledger backup before changing the current bundle.",
      [
        "```text",
        ...plan.members.map(member => member.kind === "track"
          ? `Track ${JSON.stringify(member.project_key + "/" + member.path)}${member.path === member.old_path ? "" : ` from ${JSON.stringify(member.old_path)}`}`
          : `Keep ${JSON.stringify(member.title)} in custody (${member.reason.replaceAll("_", " ")}).`),
        "```",
      ].join("\n"),
    ].join("\n\n"),
  };
}

export function convertTrackedBriefingGroup(db: Db, input: ReviewedConversion, now = Date.now()) {
  return db.transaction(() => {
    const plan = reviewedConversion(db, input);
    const conversions = new Map(plan.members.flatMap(member => member.kind === "track" ? [[member.briefing_id, member]] : []));
    if (!conversions.size) return { plan, bundle_id: plan.base_bundle_id, changed: false, backup_path: null };
    const directory = path.join(path.dirname(path.resolve(db.name)), "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date(now).toISOString().replaceAll(":", "-");
    const backup_path = path.join(directory, `before-briefing-conversion-${stamp}-${randomUUID()}.db`);
    db.backupBeforeMigration(backup_path);
    // The SQLite writer excludes layout changes while the backup runs. Git refs can still advance.
    reviewedConversion(db, input);
    const bundleId = randomUUID();
    const rows = bundleMemberRows(db, plan.base_bundle_id).map(row => {
      const member = row.briefing_id === null ? undefined : conversions.get(row.briefing_id);
      if (!member) return row;
      return { ...row, briefing_id: null, tracked_project_id: member.project_id!, tracked_path: member.path };
    });
    mutateBriefing(db, "briefing_bundle", bundleId, () => {
      db.prepare(`INSERT INTO briefing_bundles (id, name, created_at, updated_at, request_origin_json)
        SELECT ?, name, ?, ?, ? FROM briefing_bundles WHERE id = ?`)
        .run(bundleId, now, now, requestOriginJson(), plan.base_bundle_id);
      writeBundleMemberRows(db, bundleId, rows, now);
    });
    mutateBriefing(db, "briefing_group", plan.group_id, () =>
      db.prepare("UPDATE briefing_groups SET current_bundle_id = ?, updated_at = ? WHERE id = ?")
        .run(bundleId, now, plan.group_id));
    return { plan, bundle_id: bundleId, changed: true, backup_path };
  }).immediate();
}
