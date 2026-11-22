import { authDependencies } from "../auth-dependency.js";
import { decodeAuthDependencies, parseChangeReport } from "../auth-request-row.js";
import type {
  TrackedBriefingMatch, TrackedBriefingPath, TrackedBriefingProposal, TrackedBriefingReviewGroup,
} from "../contracts.js";
import type { Db } from "../db.js";
import { shortRef } from "../entity-refs.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import type { AuthRequest } from "../types.js";
import { trackedBriefingReader } from "./tracked-briefing-files.js";

type RequestInventory = Pick<AuthRequest, "repo" | "target_repo_root" | "type" | "change_report">;

function requestProjectId(db: Db, request: RequestInventory): string | null {
  if (request.target_repo_root) {
    const checkout = db.prepare("SELECT project_id FROM ledger_project_checkouts WHERE root = ?")
      .get(request.target_repo_root) as { project_id: string } | undefined;
    if (checkout) return checkout.project_id;
  }
  const resolved = resolveProjectRef(db, request.repo);
  return resolved.ok ? resolved.project.id : null;
}

function inventory(db: Db, request: RequestInventory) {
  if (request.type !== "merge" || !request.change_report) return null;
  const projectId = requestProjectId(db, request);
  if (!projectId) return null;
  const indexes = new Map<string, number[]>();
  request.change_report.files.forEach((file, index) => {
    const paths = new Set([file.new_path, file.change_kind === "copied" ? null : file.old_path]);
    for (const path of paths) {
      if (path === null) continue;
      const prior = indexes.get(path);
      if (prior) prior.push(index);
      else indexes.set(path, [index]);
    }
  });
  return { projectId, indexes };
}

function matchMembers(members: readonly TrackedBriefingPath[], changed: NonNullable<ReturnType<typeof inventory>>): TrackedBriefingMatch[] {
  return members.flatMap(member => {
    const fileIndexes = member.project_id === changed.projectId ? changed.indexes.get(member.path) : undefined;
    return fileIndexes ? [{ ...member, file_indexes: fileIndexes }] : [];
  });
}

export function trackedBriefingProposals(db: Db, members: readonly TrackedBriefingPath[]): TrackedBriefingProposal[] {
  if (!members.length) return [];
  const rows = db.prepare(`SELECT id, title, repo, target_repo_root, type, depends_on_id, depends_on_ids,
      change_report_json, frozen_change_report_json FROM auth_requests
    WHERE type = 'merge' AND status = 'pending' AND expires_at > ?
      AND COALESCE(frozen_change_report_json, change_report_json) IS NOT NULL
    ORDER BY created_at, id`).all(Date.now()) as Array<Record<string, unknown> & Pick<AuthRequest, "id" | "title" | "type" | "repo" | "target_repo_root">>;
  const requests = rows.map(row => ({ ...row,
    depends_on_ids: decodeAuthDependencies(row),
    change_report: parseChangeReport(row.frozen_change_report_json) ?? parseChangeReport(row.change_report_json),
  }));
  const dependencies = authDependencies(db, [...new Set(requests.flatMap(request => request.depends_on_ids))]);
  const projectKey = db.prepare("SELECT project_key FROM ledger_projects WHERE id = ?");
  return requests.flatMap(request => {
    const changed = inventory(db, request);
    if (!changed) return [];
    const matched = matchMembers(members, changed);
    return matched.length ? [{
      request_id: request.id, request_ref: shortRef(db, "auth_request", request.id), title: request.title,
      project_id: changed.projectId, members: matched,
      project_key: (projectKey.get(changed.projectId) as { project_key: string }).project_key,
      depends_on: request.depends_on_ids.map(id => dependencies.get(id)!),
    }] : [];
  });
}

export function trackedReviewGroups(db: Db, request: RequestInventory): TrackedBriefingReviewGroup[] {
  const changed = inventory(db, request);
  if (!changed) return [];
  const rows = db.prepare(`SELECT g.id AS group_id, g.key AS group_key, g.name, b.tracked_project_id AS project_id, b.tracked_path AS path
    FROM briefing_groups g JOIN briefing_bundle_members b ON b.bundle_id = g.current_bundle_id
    WHERE g.archived_at IS NULL AND b.tracked_project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM briefing_bundle_members candidate
      WHERE candidate.bundle_id = g.current_bundle_id AND candidate.tracked_project_id = ?
    )
    ORDER BY g.created_at, g.id, b.layout_position, b.subgroup_position`)
    .all(changed.projectId) as Array<TrackedBriefingPath & Pick<TrackedBriefingReviewGroup, "group_id" | "group_key" | "name">>;
  const groups = new Map<string, { group_id: string; group_key: string; name: string; paths: TrackedBriefingPath[] }>();
  for (const { group_id, group_key, name, ...member } of rows) {
    let group = groups.get(group_id);
    if (!group) {
      group = { group_id, group_key, name, paths: [] };
      groups.set(group_id, group);
    }
    group.paths.push(member);
  }
  const reader = trackedBriefingReader(db);
  return [...groups.values()].flatMap(({ paths, ...group }) => {
    const members = matchMembers(paths, changed);
    return members.length ? [{ ...group, members, documents: paths.map(reader.read) }] : [];
  });
}

export function storedTrackedReviewGroups(db: Db, roundId: string): TrackedBriefingReviewGroup[] | null {
  const stored = db.prepare("SELECT snapshot_json FROM briefing_request_group_snapshots WHERE round_id = ?")
    .get(roundId) as { snapshot_json: string } | undefined;
  return stored ? JSON.parse(stored.snapshot_json) as TrackedBriefingReviewGroup[] : null;
}
