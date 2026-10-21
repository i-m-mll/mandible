import type { Db } from "../db.js";
import { tableExists } from "../db-introspection.js";
import { createLedgerId } from "./ids.js";
import { LedgerStore, type ResolveIssueRefResult } from "./store.js";
import { assertEvidenceMethod, systemAction } from "../identity/resolver.js";
import { getAttributionEvidence } from "../users/store.js";
import type { LedgerActorInput, LedgerIssueResolution } from "./types.js";
import { parseJsonObject } from "../row-coerce.js";
import { resolveProjectRef } from "./project-registry.js";

export type OperationalLinkMismatchType = "unavailable" | "not_found" | "ambiguous";
export type OperationalLinkReportStatus = "clean" | "incomplete" | "failed";

export interface ResolveOperationalIssueOk {
  ok: true;
  issue_id: string;
  project_id: string;
}

export interface ResolveOperationalIssueError {
  ok: false;
  error: OperationalLinkMismatchType;
  matches?: string[];
}

export type ResolveOperationalIssueResult = ResolveOperationalIssueOk | ResolveOperationalIssueError;

export type OperationalLinkResult = ResolveOperationalIssueResult & {
  source_table?: string;
  source_id?: string;
  issue_ref?: string;
  repo_id?: string;
};

export interface OperationalLinkMismatch {
  id?: string;
  source_table: string;
  source_id: string;
  repo_id: string;
  issue_ref: string;
  mismatch_type: OperationalLinkMismatchType;
  metadata?: Record<string, unknown>;
}

export interface OperationalLinkReport {
  id: string;
  status: OperationalLinkReportStatus;
  resolved_count: number;
  unresolved_count: number;
  ambiguous_count: number;
  source_counts: Record<string, number>;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  mismatches: OperationalLinkMismatch[];
}

interface LinkOptions {
  source?: string;
  now?: number;
  metadata?: Record<string, unknown>;
  recordEvent?: boolean;
  actor?: LedgerActorInput;
}

export function ledgerOperationalLinksAvailable(db: Db): boolean {
  return tableExists(db, "ledger_issues") && tableExists(db, "ledger_work_unit_issue_links");
}

export function resolveOperationalIssueRef(
  db: Db,
  issueRef: string,
  repoRef?: string | null,
): ResolveOperationalIssueResult {
  if (!tableExists(db, "ledger_issues") || !tableExists(db, "ledger_issue_aliases")) {
    return { ok: false, error: "unavailable" };
  }
  const trimmed = issueRef.trim();
  if (!trimmed) return { ok: false, error: "not_found" };

  const store = new LedgerStore(db);
  const scoped = resolveInProjects(db, store, trimmed, candidateProjectIds(db, repoRef));
  if (scoped.ok || scoped.error === "ambiguous") return scoped;

  const global = withProject(db, store.resolveIssueRef(trimmed));
  if (global.ok || global.error === "ambiguous") return global;

  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return global;
  const project = resolveProjectRef(db, trimmed.slice(0, separator));
  if (project.ambiguous) return { ok: false, error: "ambiguous" };
  if (!project.ok || !project.project) return global;
  return resolveInProjects(db, store, trimmed.slice(separator + 1), [project.project.id]);
}

/**
 * Issue ids are global, so the caller's repo only ranks candidates: a ref
 * resolves in the repo's own projects first, then across the ledger, then as
 * `<project>/<id>`.
 */
function resolveInProjects(
  db: Db,
  store: LedgerStore,
  ref: string,
  projectIds: string[],
): ResolveOperationalIssueResult {
  const matches = new Set<string>();
  for (const projectId of projectIds) {
    const resolved = store.resolveIssueRef(ref, { project_id: projectId });
    if (resolved.ok) {
      matches.add(resolved.id);
    } else if (resolved.error === "ambiguous") {
      for (const match of resolved.matches) matches.add(match);
    }
  }

  if (matches.size === 0) return { ok: false, error: "not_found" };
  if (matches.size > 1) {
    return { ok: false, error: "ambiguous", matches: Array.from(matches).sort() };
  }
  return withProject(db, { ok: true, id: Array.from(matches)[0] });
}

export function linkWorkUnitToLedgerIssue(
  db: Db,
  input: { work_unit_id: string; issue_ref: string; repo_ref: string; link_type?: string } & LinkOptions,
): OperationalLinkResult {
  if (!ledgerOperationalLinksAvailable(db)) {
    return { ok: false, error: "unavailable", source_table: "work_units", source_id: input.work_unit_id };
  }
  const resolved = resolveOperationalIssueRef(db, input.issue_ref, input.repo_ref);
  if (!resolved.ok) {
    return linkError("work_units", input.work_unit_id, input.issue_ref, input.repo_ref, resolved);
  }
  const now = input.now ?? Date.now();
  const linkType = input.link_type ?? "work_unit_tracks";
  const metadata = {
    legacy_issue_id: input.issue_ref,
    repo_id: input.repo_ref,
    ...(input.metadata ?? {}),
  };
  db.transaction(() => {
    db.prepare("UPDATE work_units SET ledger_issue_id = ? WHERE id = ?").run(
      resolved.issue_id,
      input.work_unit_id,
    );
    db.prepare(
      `INSERT INTO ledger_work_unit_issue_links (
        work_unit_id, issue_id, link_type, source, created_at, last_seen_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_unit_id, issue_id, link_type) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        metadata_json = excluded.metadata_json`,
    ).run(
      input.work_unit_id,
      resolved.issue_id,
      linkType,
      input.source ?? "work_unit",
      now,
      now,
      JSON.stringify(metadata),
    );
  })();
  maybeRecordLinkEvent(db, input.recordEvent, {
    entity_type: "work_unit",
    entity_id: input.work_unit_id,
    event_type: "work_unit.issue_linked",
    source: "work_unit",
    project_id: resolved.project_id,
    payload: { work_unit_id: input.work_unit_id, issue_id: resolved.issue_id, link_type: linkType },
  });
  return { ok: true, issue_id: resolved.issue_id, project_id: resolved.project_id };
}

export function linkSessionToLedgerIssue(
  db: Db,
  input: { session_id: string; issue_ref: string; repo_ref: string; link_type?: string } & LinkOptions,
): OperationalLinkResult {
  if (!ledgerOperationalLinksAvailable(db) || !tableExists(db, "ledger_session_issue_links")) {
    return { ok: false, error: "unavailable", source_table: "session_issues", source_id: input.session_id };
  }
  const resolved = resolveOperationalIssueRef(db, input.issue_ref, input.repo_ref);
  if (!resolved.ok) {
    return linkError("session_issues", input.session_id, input.issue_ref, input.repo_ref, resolved);
  }
  const now = input.now ?? Date.now();
  const linkType = input.link_type ?? "worked_on";
  db.prepare(
    `INSERT INTO ledger_session_issue_links (
      session_id, issue_id, link_type, source, created_at, last_seen_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, issue_id, link_type) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      metadata_json = excluded.metadata_json`,
  ).run(
    input.session_id,
    resolved.issue_id,
    linkType,
    input.source ?? "session",
    now,
    now,
    JSON.stringify({ legacy_issue_id: input.issue_ref, repo_id: input.repo_ref, ...(input.metadata ?? {}) }),
  );
  maybeRecordLinkEvent(db, input.recordEvent, {
    entity_type: "session",
    entity_id: input.session_id,
    event_type: "session.issue_linked",
    source: "session",
    project_id: resolved.project_id,
    payload: { session_id: input.session_id, issue_id: resolved.issue_id, link_type: linkType },
  });
  return { ok: true, issue_id: resolved.issue_id, project_id: resolved.project_id };
}

export function linkAuthRequestToLedgerIssue(
  db: Db,
  input: { auth_request_id: string; issue_ref: string; repo_ref?: string | null; link_type?: string } & LinkOptions,
): OperationalLinkResult {
  if (!ledgerOperationalLinksAvailable(db) || !tableExists(db, "ledger_auth_issue_links")) {
    return { ok: false, error: "unavailable", source_table: "auth_requests", source_id: input.auth_request_id };
  }
  const resolved = resolveOperationalIssueRef(db, input.issue_ref, input.repo_ref);
  if (!resolved.ok) {
    return linkError("auth_requests", input.auth_request_id, input.issue_ref, input.repo_ref ?? "", resolved);
  }
  const now = input.now ?? Date.now();
  const linkType = input.link_type ?? "references";
  db.prepare(
    `INSERT INTO ledger_auth_issue_links (
      auth_request_id, issue_id, link_type, source, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(auth_request_id, issue_id, link_type) DO UPDATE SET
      metadata_json = excluded.metadata_json`,
  ).run(
    input.auth_request_id,
    resolved.issue_id,
    linkType,
    input.source ?? "auth_queue",
    now,
    JSON.stringify({ legacy_issue_id: input.issue_ref, repo_id: input.repo_ref ?? "", ...(input.metadata ?? {}) }),
  );
  maybeRecordLinkEvent(db, input.recordEvent, {
    entity_type: "auth_request",
    entity_id: input.auth_request_id,
    event_type: "auth_request.issue_linked",
    source: "auth_queue",
    project_id: resolved.project_id,
    payload: { auth_request_id: input.auth_request_id, issue_id: resolved.issue_id, link_type: linkType },
  }, input.actor);
  return { ok: true, issue_id: resolved.issue_id, project_id: resolved.project_id };
}

export function linkCommitToLedgerIssue(
  db: Db,
  input: { commit_sha: string; issue_ref: string; repo_ref: string; link_type?: string } & LinkOptions,
): OperationalLinkResult {
  if (!ledgerOperationalLinksAvailable(db) || !tableExists(db, "ledger_commit_issue_links")) {
    return { ok: false, error: "unavailable", source_table: "issue_resolutions", source_id: input.commit_sha };
  }
  const resolved = resolveOperationalIssueRef(db, input.issue_ref, input.repo_ref);
  if (!resolved.ok) {
    return linkError("issue_resolutions", input.commit_sha, input.issue_ref, input.repo_ref, resolved);
  }
  const now = input.now ?? Date.now();
  const linkType = input.link_type ?? "fixed_by";
  db.prepare(
    `INSERT INTO ledger_commit_issue_links (
      commit_sha, project_id, issue_id, link_type, source, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(commit_sha, issue_id, link_type) DO UPDATE SET
      metadata_json = excluded.metadata_json`,
  ).run(
    input.commit_sha,
    resolved.project_id,
    resolved.issue_id,
    linkType,
    input.source ?? "auth_queue",
    now,
    JSON.stringify({ legacy_issue_id: input.issue_ref, repo_id: input.repo_ref, ...(input.metadata ?? {}) }),
  );
  maybeRecordLinkEvent(db, input.recordEvent, {
    entity_type: "commit",
    entity_id: input.commit_sha,
    event_type: "commit.issue_linked",
    source: "auth_queue",
    project_id: resolved.project_id,
    payload: { commit_sha: input.commit_sha, issue_id: resolved.issue_id, link_type: linkType },
  }, input.actor);
  return { ok: true, issue_id: resolved.issue_id, project_id: resolved.project_id };
}

export function syncAuthRequestLedgerLinks(
  db: Db,
  input: {
    auth_request_id: string;
    repo_ref?: string | null;
    issue_references?: string[] | null;
    issue_closures?: string[] | null;
    issue_ids?: string[] | null;
    issues?: string[] | null;
    commit_message?: string | null;
    merge_output?: string | null;
    recordEvent?: boolean;
    actor?: LedgerActorInput;
  },
): OperationalLinkResult[] {
  const refs = new Map<string, "references" | "resolves">();
  const actionIssueClosures = authRequestActionIssueCloseRefs(db, input.auth_request_id);
  for (const ref of input.issue_references ?? []) refs.set(ref, "references");
  for (const ref of input.issue_closures ?? []) refs.set(ref, "resolves");
  // Legacy issues were documented as close-on-merge; preserve that meaning.
  for (const ref of input.issues ?? []) refs.set(ref, "resolves");
  for (const ref of actionIssueClosures) refs.set(ref, "resolves");
  for (const ref of extractMergeResultIssueRefs(input.merge_output)) refs.set(ref, "resolves");

  const results: OperationalLinkResult[] = [];
  for (const [ref, linkType] of refs) {
    results.push(linkAuthRequestToLedgerIssue(db, {
      auth_request_id: input.auth_request_id,
      issue_ref: ref,
      repo_ref: input.repo_ref,
      link_type: linkType,
      metadata: { source_fields: sourceFieldsForAuthRef(ref, { ...input, action_issue_closures: actionIssueClosures }) },
      recordEvent: input.recordEvent,
      actor: input.actor,
    }));
  }
  return results;
}

export function applyAuthRequestLedgerCompletion(
  db: Db,
  input: {
    auth_request_id: string;
    repo_ref?: string | null;
    issue_references?: string[] | null;
    issue_closures?: string[] | null;
    issue_ids?: string[] | null;
    issues?: string[] | null;
    commit_message?: string | null;
    merge_output?: string | null;
    approval_source?: string | null;
    approval_lease_id?: string | null;
    approved_by_user_id?: string | null;
    execution_evidence_id?: string | null;
    resolution?: LedgerIssueResolution;
    /**
     * Issue 27241e6 — when a required post-merge hook has not converged, the
     * merge is real but the delivery is not live, so issue closure is
     * withheld. The completion event remains recorded; only the typed
     * resolution and "this is done" assertion wait.
     */
    withhold_issue_closure?: boolean;
    /** Canonical target selected by the guarded deferred action executor. */
    closure_issue_ids?: string[];
  },
): OperationalLinkResult[] {
  const actor = authFinalizationActor(db, input);
  const results = syncAuthRequestLedgerLinks(db, { ...input, recordEvent: true, actor });
  if (!ledgerOperationalLinksAvailable(db)) return results;

  const store = new LedgerStore(db);
  const mergeResult = parseMergeResult(input.merge_output);
  const mergeSha = mergeResult?.merge_sha ?? null;
  const completedAt = authRequestCompletedAt(db, input.auth_request_id);
  const linked = db.prepare(
    `SELECT issue_id, link_type FROM ledger_auth_issue_links
     WHERE auth_request_id = ? AND link_type IN ('resolves', 'fixed_by')`,
  ).all(input.auth_request_id) as Array<{ issue_id: string; link_type: string }>;
  const closureTargets = new Set(authClosureTargets(db, input, linked.map((row) => row.issue_id)));
  const uniqueIssueIds = Array.from(new Set(input.closure_issue_ids ?? linked.map((row) => row.issue_id)));
  for (const issueId of uniqueIssueIds) {
    const issue = store.getIssue(issueId);
    if (issue.status === "open" && completedAt != null && latestIssueReopenedAt(db, issueId) > completedAt) {
      continue;
    }
    store.recordEvent({
      entity_type: "auth_request",
      entity_id: input.auth_request_id,
      event_type: "auth_request.completed",
      actor_type: "system",
      attribution: actor.attribution,
      source: "auth_queue",
      project_id: issue.project_id,
      payload: {
        auth_request_id: input.auth_request_id,
        issue_id: issueId,
        approval_source: input.approval_source ?? null,
        approval_lease_id: input.approval_lease_id ?? null,
        approved_by_user_id: input.approved_by_user_id ?? null,
        execution_evidence_id: input.execution_evidence_id ?? null,
      },
    });
    if (!input.withhold_issue_closure && closureTargets.has(issueId)) {
      closeAuthRequestIssue(db, input, issueId, actor, mergeSha, completedAt);
    }
  }
  return results;
}

/**
 * Issue 27241e6 — release the issue closures that `withhold_issue_closure`
 * deferred, once post-merge convergence completed.
 *
 * This deliberately re-runs only the closing half of
 * `applyAuthRequestLedgerCompletion`: the completion event and link sync
 * already landed at merge time, and re-recording them would duplicate history
 * for something that happened once. Issues already closed are skipped, so the
 * call is idempotent.
 */
export function applyWithheldAuthRequestClosures(
  db: Db,
  input: {
    auth_request_id: string;
    repo_ref?: string | null;
    merge_output?: string | null;
    approval_source?: string | null;
    approval_lease_id?: string | null;
    approved_by_user_id?: string | null;
    execution_evidence_id?: string | null;
    resolution?: LedgerIssueResolution;
  },
): string[] {
  if (!ledgerOperationalLinksAvailable(db)) return [];
  const actor = authFinalizationActor(db, input);
  const mergeSha = parseMergeResult(input.merge_output)?.merge_sha ?? null;
  const completedAt = authRequestCompletedAt(db, input.auth_request_id);
  const linked = db.prepare(
    `SELECT issue_id FROM ledger_auth_issue_links
     WHERE auth_request_id = ? AND link_type IN ('resolves', 'fixed_by')`,
  ).all(input.auth_request_id) as Array<{ issue_id: string }>;

  const closed: string[] = [];
  for (const issueId of authClosureTargets(db, input, linked.map((row) => row.issue_id))) {
    if (new LedgerStore(db).getIssue(issueId).status !== "open") continue;
    if (closeAuthRequestIssue(db, input, issueId, actor, mergeSha, completedAt)) closed.push(issueId);
  }
  return closed;
}

// Persisted action targets belong exclusively to their individual guards, in
// every state. Legacy request-wide completion must never bypass those guards.
function authClosureTargets(
  db: Db,
  input: { auth_request_id: string; repo_ref?: string | null; closure_issue_ids?: string[] },
  linkedIds: string[],
): string[] {
  if (input.closure_issue_ids) return Array.from(new Set(input.closure_issue_ids));
  const owned = new Set<string>();
  if (tableExists(db, "auth_request_actions")) {
    const actions = db.prepare(
      "SELECT target_issue_ref FROM auth_request_actions WHERE auth_request_id = ? AND kind = 'issue_close'",
    ).all(input.auth_request_id) as Array<{ target_issue_ref: string }>;
    for (const action of actions) {
      const target = resolveOperationalIssueRef(db, action.target_issue_ref, input.repo_ref);
      if (!target.ok) throw new Error(`Cannot resolve action-owned closure target '${action.target_issue_ref}'`);
      owned.add(target.issue_id);
    }
  }
  return Array.from(new Set(linkedIds)).filter((id) => !owned.has(id));
}

function closeAuthRequestIssue(
  db: Db,
  input: {
    auth_request_id: string; repo_ref?: string | null;
    approval_lease_id?: string | null; resolution?: LedgerIssueResolution;
  },
  issueId: string,
  actor: LedgerActorInput,
  mergeSha: string | null,
  completedAt: number | null,
): boolean {
  const store = new LedgerStore(db);
  const issue = store.getIssue(issueId);
  if (issue.kind === "tracker") return false;
  if (issue.status === "open" && completedAt != null && latestIssueReopenedAt(db, issueId) > completedAt) return false;
  if (mergeSha) recordIssueResolution(db, {
    authRequestId: input.auth_request_id, issueId, commitSha: mergeSha, repoRef: input.repo_ref ?? "",
  }, actor);
  store.setIssueStatus(issueId, "closed", input.resolution ?? "delivered", {
    actor_type: "system", actor_id: input.approval_lease_id ?? null, attribution: actor.attribution,
  }, "auth_queue");
  return true;
}

/**
 * Record the request-scoped successful-merge fact. Unlike
 * auth_request.completed, this is not coupled to issue links and remains after
 * the auth request itself is pruned.
 */
export function recordAuthRequestMergeSucceededFact(db: Db, authRequestId: string): void {
  if (!tableExists(db, "auth_request_merge_succeeded_facts")) return;
  const request = db.prepare(
    `SELECT id, type, status, exit_code, repo, cwd, target_repo_root,
            base_branch, resolved_at, updated_at, commit_message_digest
       FROM auth_requests WHERE id = ?`,
  ).get(authRequestId) as {
    id: string;
    type: string;
    status: string;
    exit_code: number | null;
    repo: string | null;
    cwd: string | null;
    target_repo_root: string | null;
    base_branch: string | null;
    resolved_at: number | null;
    updated_at: number;
    commit_message_digest: string | null;
  } | undefined;
  if (!request || request.type !== "merge" || request.status !== "completed" || request.exit_code !== 0) {
    return;
  }
  const projectId = resolveCanonicalProjectId(db, [
    request.target_repo_root,
    request.cwd,
    request.repo,
  ]);
  if (!projectId) {
    throw new Error(`Cannot resolve canonical project for successful auth request '${authRequestId}'`);
  }
  const completedAt = request.resolved_at ?? request.updated_at;
  db.prepare(
    `INSERT OR IGNORE INTO auth_request_merge_succeeded_facts (
       auth_request_id, project_id, base_branch, completed_at,
       canonical_message, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    request.id,
    projectId,
    request.base_branch ?? "",
    completedAt,
    request.commit_message_digest == null ? 0 : 1,
    completedAt,
  );
}

function authFinalizationActor(
  db: Db,
  input: {
    approved_by_user_id?: string | null;
    execution_evidence_id?: string | null;
  },
): LedgerActorInput {
  const approvedBy = input.approved_by_user_id ?? null;
  const evidenceId = input.execution_evidence_id ?? null;
  if (!evidenceId) {
    const attribution = systemAction();
    if (approvedBy) attribution.authorizer_user_id = approvedBy;
    return { actor_type: "system", attribution };
  }
  if (!approvedBy) {
    throw new Error("Auth finalization evidence requires an approving user.");
  }
  const evidence = getAttributionEvidence(db, evidenceId);
  if (!evidence) {
    throw new Error(`Auth finalization evidence '${evidenceId}' is missing.`);
  }
  assertEvidenceMethod(evidence.evidence_method);
  if (evidence.details.authorizer_user_id !== approvedBy) {
    throw new Error("Auth finalization evidence authorizer does not match the approved request.");
  }
  return {
    actor_type: "system",
    attribution: {
      ...systemAction(),
      evidence_method: evidence.evidence_method,
      evidence_id: evidence.id,
      authorizer_user_id: approvedBy,
    },
  };
}

function authRequestCompletedAt(db: Db, authRequestId: string): number | null {
  if (!tableExists(db, "auth_requests")) return null;
  const row = db.prepare(
    "SELECT resolved_at, updated_at, approved_at, created_at FROM auth_requests WHERE id = ?",
  ).get(authRequestId) as
    | { resolved_at: number | null; updated_at: number | null; approved_at: number | null; created_at: number | null }
    | undefined;
  return row?.resolved_at ?? row?.updated_at ?? row?.approved_at ?? row?.created_at ?? null;
}

function latestIssueReopenedAt(db: Db, issueId: string): number {
  if (!tableExists(db, "ledger_events")) return 0;
  const row = db.prepare(
    `SELECT occurred_at
     FROM ledger_events
     WHERE entity_type = 'issue'
       AND entity_id = ?
       AND event_type = 'issue.reopened'
     ORDER BY occurred_at DESC
     LIMIT 1`,
  ).get(issueId) as { occurred_at: number } | undefined;
  return row?.occurred_at ?? 0;
}

export function runOperationalLinkBackfill(db: Db): OperationalLinkReport {
  const started = Date.now();
  const report: OperationalLinkReport = {
    id: createLedgerId("opb", { now: started }),
    status: "clean",
    resolved_count: 0,
    unresolved_count: 0,
    ambiguous_count: 0,
    source_counts: {},
    error: null,
    started_at: started,
    finished_at: null,
    mismatches: [],
  };

  try {
    backfillWorkUnits(db, report);
    backfillSessions(db, report);
    backfillAuthRequests(db, report);
    backfillCommitResolutions(db, report);
    report.status = report.mismatches.length === 0 ? "clean" : "incomplete";
    report.finished_at = Date.now();
    persistOperationalLinkReport(db, report);
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    report.finished_at = Date.now();
    persistOperationalLinkReport(db, report);
    return report;
  }
}

export function listOperationalLinkReports(db: Db, limit = 20): OperationalLinkReport[] {
  if (!tableExists(db, "ledger_operational_link_reports")) return [];
  const rows = db.prepare(
    "SELECT * FROM ledger_operational_link_reports ORDER BY COALESCE(finished_at, started_at) DESC LIMIT ?",
  ).all(limit) as OperationalLinkReportRow[];
  return rows.map((row) => hydrateOperationalLinkReport(db, row));
}

function backfillWorkUnits(db: Db, report: OperationalLinkReport): void {
  if (!tableExists(db, "work_units")) return;
  const rows = db.prepare("SELECT id, issue_id, repo_id FROM work_units").all() as Array<{
    id: string;
    issue_id: string;
    repo_id: string;
  }>;
  report.source_counts.work_units = rows.length;
  for (const row of rows) {
    const result = linkWorkUnitToLedgerIssue(db, {
      work_unit_id: row.id,
      issue_ref: row.issue_id,
      repo_ref: row.repo_id,
      source: "system",
      recordEvent: false,
    });
    tally(report, result, "work_units", row.id, row.issue_id, row.repo_id);
  }
}

function backfillSessions(db: Db, report: OperationalLinkReport): void {
  if (!tableExists(db, "session_issues")) return;
  const rows = db.prepare("SELECT session_id, issue_id, repo_id, created_at FROM session_issues").all() as Array<{
    session_id: string;
    issue_id: string;
    repo_id: string;
    created_at: number;
  }>;
  report.source_counts.session_issues = rows.length;
  for (const row of rows) {
    const result = linkSessionToLedgerIssue(db, {
      session_id: row.session_id,
      issue_ref: row.issue_id,
      repo_ref: row.repo_id,
      source: "system",
      now: row.created_at,
      recordEvent: false,
    });
    tally(report, result, "session_issues", row.session_id, row.issue_id, row.repo_id);
  }
}

function backfillAuthRequests(db: Db, report: OperationalLinkReport): void {
  if (!tableExists(db, "auth_requests")) return;
  const rows = db.prepare(
    `SELECT id, repo, cwd, target_repo_root, issue_references, issue_closures,
            issue_ids, issues, commit_message
     FROM auth_requests`,
  ).all() as Array<Record<string, unknown>>;
  report.source_counts.auth_requests = rows.length;
  for (const row of rows) {
    const repoRef = stringOrNull(row.repo) ?? stringOrNull(row.cwd) ?? stringOrNull(row.target_repo_root);
    const results = syncAuthRequestLedgerLinks(db, {
      auth_request_id: String(row.id),
      repo_ref: repoRef,
      issue_references: parseStringArray(row.issue_references),
      issue_closures: parseStringArray(row.issue_closures),
      issue_ids: parseStringArray(row.issue_ids),
      issues: parseStringArray(row.issues),
      commit_message: stringOrNull(row.commit_message),
      recordEvent: false,
    });
    if (results.length === 0) continue;
    for (const result of results) {
      tally(report, result, "auth_requests", String(row.id), result.issue_ref ?? "", repoRef ?? "");
    }
  }
}

function backfillCommitResolutions(db: Db, report: OperationalLinkReport): void {
  if (!tableExists(db, "issue_resolutions")) return;
  const rows = db.prepare("SELECT issue_id, commit_sha, repo_id, resolved_at FROM issue_resolutions").all() as Array<{
    issue_id: string;
    commit_sha: string;
    repo_id: string;
    resolved_at: number;
  }>;
  report.source_counts.issue_resolutions = rows.length;
  for (const row of rows) {
    const result = linkCommitToLedgerIssue(db, {
      commit_sha: row.commit_sha,
      issue_ref: row.issue_id,
      repo_ref: row.repo_id,
      source: "system",
      now: row.resolved_at,
      recordEvent: false,
    });
    tally(report, result, "issue_resolutions", row.commit_sha, row.issue_id, row.repo_id);
  }
}

function tally(
  report: OperationalLinkReport,
  result: OperationalLinkResult,
  sourceTable: string,
  sourceId: string,
  issueRef: string,
  repoId: string,
): void {
  if (result.ok) {
    report.resolved_count++;
    return;
  }
  if (result.error === "ambiguous") {
    report.ambiguous_count++;
  } else {
    report.unresolved_count++;
  }
  report.mismatches.push({
    source_table: sourceTable,
    source_id: sourceId,
    repo_id: repoId,
    issue_ref: issueRef,
    mismatch_type: result.error,
    metadata: { matches: result.matches ?? [] },
  });
}

function persistOperationalLinkReport(db: Db, report: OperationalLinkReport): void {
  if (!tableExists(db, "ledger_operational_link_reports")) return;
  const insertReport = db.prepare(
    `INSERT INTO ledger_operational_link_reports (
      id, status, resolved_count, unresolved_count, ambiguous_count,
      source_counts_json, error, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMismatch = db.prepare(
    `INSERT INTO ledger_operational_link_mismatches (
      id, report_id, source_table, source_id, repo_id, issue_ref,
      mismatch_type, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    insertReport.run(
      report.id,
      report.status,
      report.resolved_count,
      report.unresolved_count,
      report.ambiguous_count,
      JSON.stringify(report.source_counts),
      report.error,
      report.started_at,
      report.finished_at,
    );
    report.mismatches.forEach((mismatch, index) => {
      insertMismatch.run(
        mismatch.id ?? createLedgerId("opm", { now: report.started_at + index }),
        report.id,
        mismatch.source_table,
        mismatch.source_id,
        mismatch.repo_id,
        mismatch.issue_ref,
        mismatch.mismatch_type,
        JSON.stringify(mismatch.metadata ?? {}),
        report.finished_at ?? Date.now(),
      );
    });
  })();
}

function hydrateOperationalLinkReport(db: Db, row: OperationalLinkReportRow): OperationalLinkReport {
  const mismatches = db.prepare(
    "SELECT * FROM ledger_operational_link_mismatches WHERE report_id = ? ORDER BY created_at, id",
  ).all(row.id) as OperationalLinkMismatchRow[];
  return {
    id: row.id,
    status: row.status,
    resolved_count: row.resolved_count,
    unresolved_count: row.unresolved_count,
    ambiguous_count: row.ambiguous_count,
    source_counts: parseJsonNumberRecord(row.source_counts_json),
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
    mismatches: mismatches.map((mismatch) => ({
      id: mismatch.id,
      source_table: mismatch.source_table,
      source_id: mismatch.source_id,
      repo_id: mismatch.repo_id,
      issue_ref: mismatch.issue_ref,
      mismatch_type: mismatch.mismatch_type,
      metadata: parseJsonObject(mismatch.metadata_json),
    })),
  };
}

function withProject(db: Db, resolved: ResolveIssueRefResult): ResolveOperationalIssueResult {
  if (!resolved.ok) {
    return resolved.error === "ambiguous"
      ? { ok: false, error: "ambiguous", matches: resolved.matches }
      : { ok: false, error: "not_found" };
  }
  const row = db.prepare("SELECT project_id FROM ledger_issues WHERE id = ?").get(resolved.id) as
    | { project_id: string }
    | undefined;
  return row ? { ok: true, issue_id: resolved.id, project_id: row.project_id } : { ok: false, error: "not_found" };
}

function linkError(
  sourceTable: string,
  sourceId: string,
  issueRef: string,
  repoId: string,
  error: ResolveOperationalIssueError,
): OperationalLinkResult {
  return {
    ...error,
    source_table: sourceTable,
    source_id: sourceId,
    issue_ref: issueRef,
    repo_id: repoId,
  };
}

function maybeRecordLinkEvent(
  db: Db,
  recordEvent: boolean | undefined,
  input: {
    entity_type: string;
    entity_id: string;
    event_type: string;
    source: "work_unit" | "session" | "auth_queue";
    project_id: string;
    payload: Record<string, unknown>;
  },
  actor?: LedgerActorInput,
): void {
  if (recordEvent === false) return;
  new LedgerStore(db).recordEvent({
    ...input,
    actor_type: actor?.actor_type ?? "system",
    actor_id: actor?.actor_id ?? null,
    attribution: actor?.attribution ?? systemAction(),
  });
}

function candidateProjectIds(db: Db, repoRef?: string | null): string[] {
  const trimmed = repoRef?.trim();
  if (!trimmed || !tableExists(db, "ledger_project_checkouts")) return [];
  const ids = new Set<string>();
  const checkoutRows = db.prepare(
    `SELECT project_id FROM ledger_project_checkouts
     WHERE work_repo_id = ? OR root = ? OR name = ? OR project_id = ?`,
  ).all(trimmed, trimmed, trimmed, trimmed) as Array<{ project_id: string }>;
  for (const row of checkoutRows) ids.add(row.project_id);
  // Issue 3d85f43: the canonical project_key is a valid repo ref (case-insensitive,
  // so `Feedbax` and `feedbax` resolve the same), so work-unit/auth/relationship
  // refs that carry the key link to the right project.
  const hasProjectKey = (db.prepare("PRAGMA table_info(ledger_projects)").all() as Array<{ name: string }>)
    .some((column) => column.name === "project_key");
  const projectRows = db.prepare(
    `SELECT id FROM ledger_projects
     WHERE id = ? OR display_name = ? OR remote_identity = ? OR upstream_identity = ?${
       hasProjectKey ? " OR (project_key != '' AND lower(project_key) = lower(?))" : ""
     }`,
  ).all(...(hasProjectKey ? [trimmed, trimmed, trimmed, trimmed, trimmed] : [trimmed, trimmed, trimmed, trimmed])) as Array<{ id: string }>;
  for (const row of projectRows) ids.add(row.id);
  return Array.from(ids).sort();
}

function resolveCanonicalProjectId(db: Db, refs: Array<string | null>): string | null {
  for (const ref of refs) {
    const ids = new Set(candidateProjectIds(db, ref));
    const trimmed = ref?.trim();
    if (trimmed && tableExists(db, "work_repos")) {
      const roots = db.prepare(
        `SELECT root FROM work_repos WHERE id = ? OR name = ? OR root = ?`,
      ).all(trimmed, trimmed, trimmed) as Array<{ root: string }>;
      for (const row of roots) {
        for (const projectId of candidateProjectIds(db, row.root)) ids.add(projectId);
      }
    }
    if (ids.size === 1) return [...ids][0]!;
    if (ids.size > 1) return null;
  }
  return null;
}

function sourceFieldsForAuthRef(
  ref: string,
  input: {
    issue_references?: string[] | null;
    issue_closures?: string[] | null;
    issue_ids?: string[] | null;
    issues?: string[] | null;
    action_issue_closures?: string[] | null;
    commit_message?: string | null;
    merge_output?: string | null;
  },
): string[] {
  const fields: string[] = [];
  if ((input.issue_references ?? []).includes(ref)) fields.push("issue_references");
  if ((input.issue_closures ?? []).includes(ref)) fields.push("issue_closures");
  if ((input.issues ?? []).includes(ref)) fields.push("issues");
  if ((input.action_issue_closures ?? []).includes(ref)) fields.push("auth_request_actions");
  if (extractMergeResultIssueRefs(input.merge_output).includes(ref)) fields.push("merge_output");
  return fields;
}

function authRequestActionIssueCloseRefs(db: Db, authRequestId: string): string[] {
  if (!tableExists(db, "auth_request_actions")) return [];
  const rows = db.prepare(
    `SELECT target_issue_ref
     FROM auth_request_actions
     WHERE auth_request_id = ?
       AND kind = 'issue_close'
       AND state IN ('staged', 'applied')`,
  ).all(authRequestId) as Array<{ target_issue_ref: string }>;
  return rows.map((row) => row.target_issue_ref).filter((ref) => ref.trim());
}

interface MergeResult {
  merge_sha?: string;
  declared_issues?: string[];
}

function parseMergeResult(output?: string | null): MergeResult | null {
  if (!output) return null;
  const prefix = "MANDIBLE_MERGE_RESULT ";
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  const line = lines.at(-1);
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as Partial<MergeResult>;
    return {
      merge_sha: typeof parsed.merge_sha === "string" ? parsed.merge_sha : undefined,
      declared_issues: stringArray(parsed.declared_issues),
    };
  } catch {
    return null;
  }
}

function extractMergeResultIssueRefs(output?: string | null): string[] {
  const result = parseMergeResult(output);
  if (!result) return [];
  return result.declared_issues ?? [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordIssueResolution(
  db: Db,
  input: { authRequestId: string; issueId: string; commitSha: string; repoRef: string },
  actor?: LedgerActorInput,
): void {
  const now = Date.now();
  const issue = new LedgerStore(db).getIssue(input.issueId);
  const legacyRef = legacyIssueRefForAuthLink(db, input.authRequestId, input.issueId);
  if (tableExists(db, "issue_resolutions")) {
    db.prepare(
      `INSERT OR IGNORE INTO issue_resolutions (issue_id, commit_sha, repo_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    ).run(legacyRef ?? (issue.short_id || input.issueId), input.commitSha, input.repoRef, now);
  }
  linkCommitToLedgerIssue(db, {
    commit_sha: input.commitSha,
    issue_ref: input.issueId,
    repo_ref: input.repoRef,
    now,
    recordEvent: true,
    actor,
  });
}

function legacyIssueRefForAuthLink(db: Db, authRequestId: string, issueId: string): string | null {
  if (!tableExists(db, "ledger_auth_issue_links")) return null;
  const rows = db.prepare(
    `SELECT metadata_json
     FROM ledger_auth_issue_links
     WHERE auth_request_id = ? AND issue_id = ? AND link_type IN ('resolves', 'fixed_by')
     ORDER BY created_at DESC`,
  ).all(authRequestId, issueId) as Array<{ metadata_json: string }>;
  for (const row of rows) {
    try {
      const metadata = JSON.parse(row.metadata_json) as { legacy_issue_id?: unknown };
      if (typeof metadata.legacy_issue_id === "string" && metadata.legacy_issue_id.trim()) {
        return metadata.legacy_issue_id;
      }
    } catch {
      // Ignore malformed metadata from older rows.
    }
  }
  return null;
}

function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}


function parseJsonNumberRecord(value: string): Record<string, number> {
  const parsed = parseJsonObject(value);
  const record: Record<string, number> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item === "number") record[key] = item;
  }
  return record;
}

interface OperationalLinkReportRow {
  id: string;
  status: OperationalLinkReportStatus;
  resolved_count: number;
  unresolved_count: number;
  ambiguous_count: number;
  source_counts_json: string;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

interface OperationalLinkMismatchRow {
  id: string;
  source_table: string;
  source_id: string;
  repo_id: string;
  issue_ref: string;
  mismatch_type: OperationalLinkMismatchType;
  metadata_json: string;
}
