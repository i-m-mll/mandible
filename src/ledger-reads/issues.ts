import type { Db } from "../db.js";
import type { IssueRepoSummary } from "../types.js";
import type { RepoInfo } from "../work-scanner.js";
import type { ResolvedClientIdentity } from "../server.js";
import { listLedgerIssueSummaries } from "../ledger/issue-projection.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import { evaluateProjectAccess } from "../permissions/store.js";

function filterIssueSummaries(
  summaries: IssueRepoSummary[],
  filters: { repo?: string; status?: string; resolution?: string; label?: string },
): IssueRepoSummary[] {
  let filtered = summaries;

  if (filters.repo) {
    // Issue 3d85f43: accept the canonical project_key as a repo filter (the
    // value the issue-detail surface and /r/issue redirect now emit), alongside
    // the legacy work_repo_id / name / root, so the key round-trips.
    filtered = filtered.filter(
      (s) =>
        s.repo_id === filters.repo ||
        s.repo_name === filters.repo ||
        s.repo_root === filters.repo ||
        (s.project_key !== undefined && s.project_key === filters.repo),
    );
  }

  if (filters.status === "open" || filters.status === "closed") {
    filtered = filtered.map((s) => ({
      ...s,
      issues: s.issues.filter((issue) => issue.status === filters.status),
    }));
  }

  if (filters.resolution) {
    filtered = filtered.map((s) => ({
      ...s,
      issues: s.issues.filter((issue) => issue.resolution === filters.resolution),
    }));
  }

  if (filters.label) {
    filtered = filtered.map((s) => ({
      ...s,
      issues: s.issues.filter((issue) =>
        issue.labels.some((label) => label.toLowerCase() === filters.label!.toLowerCase()),
      ),
    }));
  }

  return filtered.filter((s) => s.issues.length > 0 || (!filters.status && !filters.resolution && !filters.label));
}

export function issueSummaries(db: Db, params: {
  repos: RepoInfo[];
  identity: ResolvedClientIdentity | null;
  filters: Parameters<typeof filterIssueSummaries>[1];
}) {
  return filterIssueSummaries(listLedgerIssueSummaries(db, { getRepos: () => params.repos }), params.filters)
    .filter(summary => {
      const project = resolveProjectRef(db, summary.project_key ?? summary.repo_id);
      if (!project.ok && project.reason === "ambiguous") return false;
      if (!project.ok) return true;
      return evaluateProjectAccess(db, { identity: params.identity, project_id: project.project.id, required_role: "read" }).allowed;
    });
}
