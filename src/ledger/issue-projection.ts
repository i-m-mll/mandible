import type { Db } from "../db.js";
import type {
  GitBugComment,
  GitBugIssue,
  GitBugIssueDetail,
  IssueRepoSummary,
} from "../types.js";
import type { RepoInfo, WorkScanner } from "../work-scanner.js";
import { AttributionReadResolver, resolvedActorDisplay } from "../identity/read-projection.js";
import { LedgerStore, type ResolveIssueRefResult } from "./store.js";
import type { LedgerIssueDetail } from "./types.js";

/**
 * Build the issue summary projection used by the existing issue routes.
 *
 * The projection is backed exclusively by the canonical ledger. Work scanner
 * data only supplies checkout display metadata for the route response.
 */
export function listLedgerIssueSummaries(
  db: Db,
  workScanner: Pick<WorkScanner, "getRepos">,
): IssueRepoSummary[] {
  const checkouts = representativeCheckouts(listCheckouts(db, workScanner.getRepos()));
  const store = new LedgerStore(db);
  const summaries: IssueRepoSummary[] = [];
  for (const checkout of checkouts) {
    const issues = store
      .listIssues({ project_id: checkout.project_id })
      .map((issue) => ledgerIssueToRouteIssue(db, checkout, store.getIssueDetail(issue.id)));
    if (issues.length === 0) continue;
    summaries.push({
      repo_id: checkout.repo_id,
      repo_name: checkout.repo_name,
      repo_root: checkout.repo_root,
      project_key: checkout.project_key || undefined,
      open_count: issues.filter((issue) => issue.status === "open").length,
      merged_count: issues.filter((issue) => issue.status === "closed" && issue.labels.includes("merged")).length,
      closed_count: issues.filter((issue) => issue.status === "closed" && !issue.labels.includes("merged")).length,
      issues,
    });
  }
  return summaries.sort((a, b) => a.repo_name.localeCompare(b.repo_name));
}

export function findLedgerIssueAcrossRepos(
  db: Db,
  workScanner: Pick<WorkScanner, "getRepos">,
  issueRef: string,
): { ok: true; detail: GitBugIssueDetail } | { ok: false; status: 404 | 409; error: string } {
  const checkouts = listCheckouts(db, workScanner.getRepos());
  const store = new LedgerStore(db);
  const matches: GitBugIssueDetail[] = [];
  for (const checkout of checkouts) {
    const resolved = store.resolveIssueRef(issueRef, { project_id: checkout.project_id });
    if (resolved.ok) {
      matches.push(ledgerIssueToRouteDetail(db, checkout, store.getIssueDetail(resolved.id)));
    } else if (resolved.error === "ambiguous") {
      return { ok: false, status: 409, error: "ambiguous issue reference" };
    }
  }
  if (matches.length === 1) return { ok: true, detail: matches[0] };
  if (matches.length > 1) return { ok: false, status: 409, error: "ambiguous issue reference" };
  return { ok: false, status: 404, error: "issue not found in ledger" };
}

export function getLedgerIssueDetailForRoute(
  db: Db,
  workScanner: Pick<WorkScanner, "getRepos" | "getRepoById">,
  repoRef: string,
  issueRef: string,
): { ok: true; detail: GitBugIssueDetail } | { ok: false; status: 404 | 409; error: string } {
  const checkout = resolveCheckout(db, workScanner, repoRef);
  if (!checkout) return { ok: false, status: 404, error: "repo not found in ledger" };
  const store = new LedgerStore(db);
  const resolved = store.resolveIssueRef(issueRef, { project_id: checkout.project_id });
  if (!resolved.ok) return resolveError(resolved);
  return { ok: true, detail: ledgerIssueToRouteDetail(db, checkout, store.getIssueDetail(resolved.id)) };
}

export function resolveLedgerIssueIdForRoute(
  db: Db,
  workScanner: Pick<WorkScanner, "getRepos" | "getRepoById">,
  repoRef: string,
  issueRef: string,
): { ok: true; issue_id: string; project_id: string; repo_id: string }
  | { ok: false; status: 404 | 409; error: string } {
  const checkout = resolveCheckout(db, workScanner, repoRef);
  if (!checkout) return { ok: false, status: 404, error: "repo not found in ledger" };
  const resolved = new LedgerStore(db).resolveIssueRef(issueRef, { project_id: checkout.project_id });
  if (!resolved.ok) return resolveError(resolved);
  return { ok: true, issue_id: resolved.id, project_id: checkout.project_id, repo_id: checkout.repo_id };
}

interface CheckoutProjection {
  project_id: string;
  checkout_id: string;
  repo_id: string;
  repo_name: string;
  repo_root: string;
  project_key: string;
  last_scanned_at: string | null;
}

function listCheckouts(db: Db, repos: RepoInfo[]): CheckoutProjection[] {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]));
  const repoByRoot = new Map(repos.map((repo) => [repo.root, repo]));
  const rows = db.prepare(
    `SELECT c.id AS checkout_id, c.project_id, c.work_repo_id, c.root, c.name,
            p.display_name, COALESCE(p.project_key, '') AS project_key
     FROM ledger_project_checkouts c
     JOIN ledger_projects p ON p.id = c.project_id
     ORDER BY c.name, c.root`,
  ).all() as Array<{
    checkout_id: string;
    project_id: string;
    work_repo_id: string | null;
    root: string;
    name: string;
    display_name: string;
    project_key: string;
  }>;
  return rows.map((row) => {
    const repo = (row.work_repo_id ? repoById.get(row.work_repo_id) : undefined) ?? repoByRoot.get(row.root);
    return {
      project_id: row.project_id,
      checkout_id: row.checkout_id,
      repo_id: repo?.id ?? row.work_repo_id ?? row.project_id,
      repo_name: repo?.name ?? row.name ?? row.display_name,
      repo_root: repo?.root ?? row.root,
      project_key: row.project_key,
      last_scanned_at: repo?.last_scanned_at ?? null,
    };
  });
}

function checkoutFromRow(row: {
  checkout_id: string;
  project_id: string;
  work_repo_id: string | null;
  root: string;
  name: string;
  display_name: string;
  project_key?: string;
}, repo?: RepoInfo): CheckoutProjection {
  return {
    project_id: row.project_id,
    checkout_id: row.checkout_id,
    repo_id: repo?.id ?? row.work_repo_id ?? row.project_id,
    repo_name: repo?.name ?? row.name ?? row.display_name,
    repo_root: repo?.root ?? row.root,
    project_key: row.project_key ?? "",
    last_scanned_at: repo?.last_scanned_at ?? null,
  };
}

function findCheckoutByRepoRef(
  db: Db,
  repoRef: string,
  repo?: RepoInfo,
): CheckoutProjection | null {
  const candidates = new Set<string>([repoRef]);
  if (repo) {
    candidates.add(repo.id);
    candidates.add(repo.name);
    candidates.add(repo.root);
  }
  const values = [...candidates].filter((value) => value.trim() !== "");
  if (values.length === 0) return null;
  const placeholders = values.map(() => "?").join(", ");
  // Issue: 3d85f43 — the canonical project key is a valid repo ref, so links
  // resolve correctly when they carry it instead of a path-derived repo id.
  const row = db.prepare(
    `SELECT c.id AS checkout_id, c.project_id, c.work_repo_id, c.root, c.name,
            p.display_name, COALESCE(p.project_key, '') AS project_key
     FROM ledger_project_checkouts c
     JOIN ledger_projects p ON p.id = c.project_id
     WHERE c.work_repo_id IN (${placeholders})
        OR c.root IN (${placeholders})
        OR c.name IN (${placeholders})
        OR c.project_id IN (${placeholders})
        OR p.display_name IN (${placeholders})
        OR (p.project_key != '' AND p.project_key IN (${placeholders}))
     ORDER BY c.updated_at DESC, c.name, c.root
     LIMIT 1`,
  ).get(...values, ...values, ...values, ...values, ...values, ...values) as {
    checkout_id: string;
    project_id: string;
    work_repo_id: string | null;
    root: string;
    name: string;
    display_name: string;
    project_key: string;
  } | undefined;
  return row ? checkoutFromRow(row, repo) : null;
}

function representativeCheckouts(checkouts: CheckoutProjection[]): CheckoutProjection[] {
  const byProject = new Map<string, CheckoutProjection>();
  for (const checkout of checkouts) {
    const current = byProject.get(checkout.project_id);
    if (!current || checkoutRank(checkout) > checkoutRank(current)) {
      byProject.set(checkout.project_id, checkout);
    }
  }
  return Array.from(byProject.values());
}

function checkoutRank(checkout: CheckoutProjection): number {
  const scanned = checkout.last_scanned_at ? Date.parse(checkout.last_scanned_at) : 0;
  return Number.isFinite(scanned) ? scanned : 0;
}

function resolveCheckout(
  db: Db,
  workScanner: Pick<WorkScanner, "getRepos" | "getRepoById">,
  repoRef: string,
): CheckoutProjection | null {
  const direct = findCheckoutByRepoRef(db, repoRef);
  if (direct) return direct;
  const repo = workScanner.getRepoById(repoRef);
  const scannerDirect = repo ? findCheckoutByRepoRef(db, repoRef, repo) : null;
  if (scannerDirect) return scannerDirect;
  const checkouts = listCheckouts(db, workScanner.getRepos());
  return checkouts.find((checkout) =>
    checkout.repo_id === repoRef ||
    checkout.repo_name === repoRef ||
    checkout.repo_root === repoRef ||
    checkout.project_id === repoRef ||
    (repo && checkout.repo_id === repo.id)
  ) ?? null;
}

function ledgerIssueToRouteIssue(
  db: Db,
  checkout: CheckoutProjection,
  detail: LedgerIssueDetail,
): GitBugIssue {
  const attribution = new AttributionReadResolver(db).attribution({
    user_id: detail.author_user_id,
    evidence_method: detail.evidence_method,
    evidence_id: detail.evidence_id,
  });
  const labels = detail.labels
    .filter((label) => label.deleted_at === null)
    .map((label) => label.label)
    .sort();
  return {
    id: displayIssueId(detail),
    repo_id: checkout.repo_id,
    repo_name: checkout.repo_name,
    title: detail.title,
    status: detail.status,
    labels,
    author: resolvedActorDisplay(detail.author_display, detail.author_actor_type, attribution),
    author_legacy_display: detail.author_display,
    author_attribution: attribution,
    created_at: new Date(detail.created_at).toISOString(),
    description: detail.body,
    parent_id: parentRef(db, detail, labels),
  };
}

function ledgerIssueToRouteDetail(
  db: Db,
  checkout: CheckoutProjection,
  detail: LedgerIssueDetail,
): GitBugIssueDetail {
  const attributionResolver = new AttributionReadResolver(db);
  return {
    ...ledgerIssueToRouteIssue(db, checkout, detail),
    comments: detail.comments
      .filter((comment) => comment.deleted_at === null)
      .map((comment): GitBugComment => {
        const attribution = attributionResolver.attribution({
          user_id: comment.author_user_id,
          evidence_method: comment.evidence_method,
          evidence_id: comment.evidence_id,
        });
        return {
          id: comment.id,
          author: resolvedActorDisplay(comment.author_display, comment.author_actor_type, attribution),
          author_legacy_display: comment.author_display,
          author_attribution: attribution,
          date: new Date(comment.created_at).toISOString(),
          body: comment.body,
        };
      }),
  };
}

function displayIssueId(detail: LedgerIssueDetail): string {
  return detail.short_id || detail.id.slice(0, 7);
}

function parentRef(db: Db, detail: LedgerIssueDetail, labels: string[]): string | undefined {
  const legacy = labels.find((label) => label.startsWith("parent:"))?.slice("parent:".length);
  if (legacy) return legacy;
  const parent = detail.incoming_relationships.find((relationship) =>
    relationship.relationship_type === "parent_child" && relationship.deleted_at === null
  );
  if (!parent) return undefined;
  const row = db.prepare(
    `SELECT alias FROM ledger_issue_aliases
     WHERE issue_id = ? AND project_id = ?
     ORDER BY is_primary DESC, alias_kind
     LIMIT 1`,
  ).get(parent.source_issue_id, detail.project_id) as { alias: string } | undefined;
  return row?.alias ?? parent.source_issue_id;
}

function resolveError(resolved: Exclude<ResolveIssueRefResult, { ok: true }>) {
  if (resolved.error === "ambiguous") {
    return { ok: false as const, status: 409 as const, error: "ambiguous issue reference" };
  }
  return { ok: false as const, status: 404 as const, error: "issue not found in ledger" };
}
