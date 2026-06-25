import { IssueScanner } from "../issue-scanner.js";
import { WorkScanner } from "../work-scanner.js";
import { getDb, type Db } from "../db.js";
import { mapWorkUnitRow, computeLiveness } from "../work-unit-utils.js";
import { LedgerStore } from "../ledger/store.js";
import {
  LEDGER_ISSUE_KINDS,
  LEDGER_ISSUE_BRANCH_ROLES,
  LEDGER_ISSUE_RESOLUTIONS,
  LEDGER_ISSUE_STATUSES,
  LEDGER_PRIORITIES,
  LEDGER_RELATIONSHIP_PROVENANCES,
  LEDGER_RELATIONSHIP_TYPES,
  LEDGER_WORKER_STATUSES,
  type LedgerIssueKind,
  type LedgerIssueBranchRole,
  type LedgerIssueCheckpoint,
  type LedgerIssueResolution,
  type LedgerIssueStatus,
  type LedgerPriority,
  type LedgerRelationshipEdge,
  type LedgerRelationshipEntityType,
  type LedgerRelationshipProvenance,
  type LedgerRelationshipType,
  type LedgerWorkerStatus,
} from "../ledger/types.js";
import {
  buildLedgerIssueDetailInitialProjection,
  buildLedgerIssueDetailProjection,
  buildLedgerIssueDetailProjectionWithProfile,
  type LedgerIssueDetailProjection,
} from "../ledger/issue-detail.js";
import {
  getLedgerIssueHead,
} from "../ledger/issue-heads.js";
import {
  evaluateMarkdownBodyPolicy,
  getMarkdownBodyEscapePolicy,
  type MarkdownBodyPolicyWarning,
} from "../ledger/markdown-body.js";
import {
  resolveCheckoutPath,
  resolveProjectRef,
  suggestProjectRefs,
} from "../ledger/project-registry.js";
import {
  findLedgerIssueAcrossRepos,
  getLedgerIssueDetailForRoute,
  getLedgerIssueMigrationConfig,
  getReconciliationReport,
  isLedgerWriteModeEnabled,
  listLedgerIssueSummaries,
  listReconciliationReports,
  parseMigrationConfigPatch,
  resolveLedgerIssueIdForRoute,
  runIssueReconciliation,
  updateLedgerIssueMigrationConfig,
  type LedgerIssueMigrationConfig,
} from "../ledger/issue-migration.js";
import {
  linkCommitToLedgerIssue,
  resolveOperationalIssueRef,
} from "../ledger/operational-links.js";
import { SubprocessGitBugClient } from "../ledger/git-bug-client.js";
import {
  listLedgerSyncJobs,
  runGitBugSyncForRepos,
  type LedgerSyncDirection,
} from "../ledger/sync-runner.js";
import type { GitBugIssueDetail, IssueRepoSummary } from "../types.js";

export interface RouteHandler<Request = unknown, Response = unknown> {
  (req: Request, res: Response): void | Promise<void>;
}

export interface IssueServer {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put?(path: string, handler: RouteHandler): void;
  patch?(path: string, handler: RouteHandler): void;
}

// Bug: cbbb3d9 — spawn-from-issue deps type
interface SpawnDeps {
  sessionManager?: import("../session-manager.js").SessionManager;
  workScanner?: WorkScanner;
}

function getParam(req: unknown, key: string): string | undefined {
  if (!req || typeof req !== "object") {
    return undefined;
  }
  const record = req as Record<string, unknown>;
  if (record.params && typeof record.params === "object") {
    const params = record.params as Record<string, unknown>;
    if (typeof params[key] === "string") {
      return params[key] as string;
    }
  }
  if (typeof record.param === "function") {
    const value = (record.param as (k: string) => unknown)(key);
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function getQueryParam(req: unknown, key: string): string | undefined {
  if (!req || typeof req !== "object") {
    return undefined;
  }
  const record = req as Record<string, unknown>;
  if (!record.query || typeof record.query !== "object") {
    return undefined;
  }
  const query = record.query as Record<string, unknown>;
  const value = query[key];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? (value[0] as string) : undefined;
  }
  return typeof value === "string" ? (value as string) : undefined;
}

function getBody(req: unknown): Record<string, unknown> | null {
  if (!req || typeof req !== "object") {
    return null;
  }
  const record = req as Record<string, unknown>;
  if (record.body && typeof record.body === "object") {
    return record.body as Record<string, unknown>;
  }
  return null;
}

function getStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return undefined;
}

function sendJson(res: unknown, status: number, payload: unknown): void {
  if (!res || typeof res !== "object") {
    return;
  }
  const record = res as Record<string, unknown>;
  if (typeof record.status === "function") {
    (record.status as (code: number) => void)(status);
  } else if (typeof record.code === "function") {
    (record.code as (code: number) => void)(status);
  }

  if (typeof record.json === "function") {
    (record.json as (body: unknown) => void)(payload);
    return;
  }
  if (typeof record.send === "function") {
    (record.send as (body: unknown) => void)(payload);
    return;
  }
  if (typeof record.end === "function") {
    (record.end as (body: string) => void)(JSON.stringify(payload));
  }
}

function isBodyRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "LedgerBodyRevisionConflictError";
}

function applyMarkdownBodyPolicy(
  res: unknown,
  db: Db,
  body: string,
): { ok: true; warnings: MarkdownBodyPolicyWarning[] } | { ok: false } {
  const result = evaluateMarkdownBodyPolicy(body, getMarkdownBodyEscapePolicy(db));
  if (result.action === "reject") {
    sendJson(res, 422, {
      error: "markdown body contains likely accidental escaped newlines",
      markdown_body_warnings: [result.warning],
    });
    return { ok: false };
  }
  return {
    ok: true,
    warnings: result.action === "warn" ? [result.warning] : [],
  };
}

function withMarkdownBodyWarnings<T extends object>(
  payload: T,
  warnings: MarkdownBodyPolicyWarning[],
): T & { markdown_body_warnings?: MarkdownBodyPolicyWarning[] } {
  return warnings.length > 0 ? { ...payload, markdown_body_warnings: warnings } : payload;
}

function filterIssueSummaries(
  summaries: IssueRepoSummary[],
  filters: { repo?: string; status?: string; label?: string },
): IssueRepoSummary[] {
  let filtered = summaries;

  if (filters.repo) {
    filtered = filtered.filter(
      (s) => s.repo_id === filters.repo || s.repo_name === filters.repo || s.repo_root === filters.repo,
    );
  }

  // Bug: e32ee8b — three-state filter: "merged" = closed + has "merged" label
  if (filters.status === "open" || filters.status === "closed" || filters.status === "merged") {
    filtered = filtered.map((s) => ({
      ...s,
      issues: s.issues.filter((issue) => {
        if (filters.status === "merged") {
          return issue.status === "closed" && issue.labels.includes("merged");
        }
        if (filters.status === "closed") {
          return issue.status === "closed" && !issue.labels.includes("merged");
        }
        return issue.status === filters.status;
      }),
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

  return filtered.filter((s) => s.issues.length > 0 || (!filters.status && !filters.label));
}

function ledgerWriteUnavailable(res: unknown, mode: string): boolean {
  if (mode === "dual") {
    sendJson(res, 409, { error: "dual issue writes are not armed; use git_bug or ledger mode" });
    return true;
  }
  return false;
}

function resolveLedgerIssueId(db: Db, issueRef: string): { ok: true; issue_id: string } | { ok: false; status: 404 | 409; error: string } {
  const resolved = new LedgerStore(db).resolveIssueRef(issueRef);
  if (resolved.ok) return { ok: true, issue_id: resolved.id };
  if (resolved.error === "ambiguous") return { ok: false, status: 409, error: "ambiguous issue reference" };
  return { ok: false, status: 404, error: "ledger issue not found" };
}

function resolveRelationshipEntityRef(
  db: Db,
  ref: string,
): { ok: true; entity_type: LedgerRelationshipEntityType; entity_id: string }
  | { ok: false; status: 404 | 409; error: string } {
  const trimmed = ref.trim();
  const store = new LedgerStore(db);
  if (!trimmed) return { ok: false, status: 404, error: "relationship entity ref is empty" };
  if (trimmed.includes("#")) {
    const [issueRef, selector] = trimmed.split("#", 2);
    if (!issueRef || !selector) return { ok: false, status: 404, error: "invalid comment reference" };
    const resolvedIssue = resolveLedgerIssueId(db, issueRef);
    if (!resolvedIssue.ok) return resolvedIssue;
    const comments = store.getIssueDetail(resolvedIssue.issue_id)
      .comments
      .filter((comment) => comment.deleted_at === null)
      .sort((a, b) => a.ordinal - b.ordinal);
    const comment = selector === "last"
      ? comments.at(-1)
      : /^\d+$/.test(selector)
        ? comments.find((candidate) => candidate.ordinal === Number(selector))
        : undefined;
    if (!comment) return { ok: false, status: 404, error: "ledger comment not found" };
    return { ok: true, entity_type: "comment", entity_id: comment.id };
  }
  const resolvedIssue = resolveLedgerIssueId(db, trimmed);
  if (resolvedIssue.ok) return { ok: true, entity_type: "issue", entity_id: resolvedIssue.issue_id };
  if (resolvedIssue.error === "ambiguous issue reference") return resolvedIssue;
  try {
    const comment = store.getComment(trimmed);
    return { ok: true, entity_type: "comment", entity_id: comment.id };
  } catch {
    return resolvedIssue;
  }
}

function sendLedgerIssueProjection(
  res: unknown,
  db: Db,
  issueId: string,
  warnings: MarkdownBodyPolicyWarning[] = [],
  options: { stage?: "initial" | "full"; profile?: boolean } = {},
): void {
  try {
    if (options.profile) {
      const profiled = buildLedgerIssueDetailProjectionWithProfile(db, issueId, {
        stage: options.stage ?? "full",
        includeProfile: true,
      });
      sendJson(res, 200, withMarkdownBodyWarnings({
        ...profiled.projection,
        profile: profiled.profile,
      }, warnings));
      return;
    }
    const projection = options.stage === "initial"
      ? buildLedgerIssueDetailInitialProjection(db, issueId)
      : buildLedgerIssueDetailProjection(db, issueId);
    sendJson(res, 200, withMarkdownBodyWarnings(projection, warnings));
  } catch (error) {
    sendJson(res, 404, { error: error instanceof Error ? error.message : "ledger issue not found" });
  }
}

function checkpointPayload(row: LedgerIssueCheckpoint): unknown {
  try {
    return JSON.parse(row.payload_json) as unknown;
  } catch {
    return {};
  }
}

function checkpointResponse(row: LedgerIssueCheckpoint): Record<string, unknown> {
  return {
    id: row.id,
    issue_id: row.issue_id,
    kind: row.kind,
    payload: checkpointPayload(row),
    author: {
      id: row.author_actor_id,
      type: row.author_actor_type,
      display: row.author_display || row.author_actor_type,
    },
    source: row.source,
    created_at: row.created_at,
  };
}

function currentIssueBodyRevisionId(db: Db, issueId: string): string | null {
  const row = db.prepare(
    `SELECT id FROM ledger_body_revisions
     WHERE entity_type = 'issue_body' AND entity_id = ?
     ORDER BY revision_no DESC
     LIMIT 1`,
  ).get(issueId) as { id?: string } | undefined;
  return row?.id ?? null;
}

function sessionLiveness(db: Db, sessionId: string | null): Record<string, unknown> {
  if (!sessionId || !tableExists(db, "sessions")) {
    return { has_live_agent: false, agent_session_id: sessionId, agent_status: null, last_activity: null };
  }
  const row = db.prepare(
    "SELECT status, updated_at, last_active FROM sessions WHERE id = ?",
  ).get(sessionId) as { status?: string; updated_at?: string; last_active?: string | null } | undefined;
  if (!row) {
    return { has_live_agent: false, agent_session_id: sessionId, agent_status: null, last_activity: null };
  }
  const status = row.status ?? "unknown";
  return {
    has_live_agent: status === "active" || status === "idle",
    agent_session_id: sessionId,
    agent_status: status,
    last_activity: row.last_active ?? row.updated_at ?? null,
  };
}

function parentRoleHolders(db: Db, issueId: string): Array<Record<string, unknown>> {
  const store = new LedgerStore(db);
  return store.listIssueCheckpoints(issueId, "parent-role")
    .map((row) => {
      const payload = checkpointPayload(row);
      const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const sessionId = typeof payloadRecord.session_id === "string" ? payloadRecord.session_id : null;
      return {
        checkpoint_id: row.id,
        issue_id: row.issue_id,
        kind: row.kind,
        payload,
        session_id: sessionId,
        mechanism: typeof payloadRecord.mechanism === "string" ? payloadRecord.mechanism : null,
        assumed_at: typeof payloadRecord.assumed_at === "number" ? payloadRecord.assumed_at : row.created_at,
        created_at: row.created_at,
        liveness: sessionLiveness(db, sessionId),
      };
    })
    .sort((a, b) =>
      Number(b.assumed_at ?? 0) - Number(a.assumed_at ?? 0)
      || Number(b.created_at ?? 0) - Number(a.created_at ?? 0)
      || String(b.checkpoint_id ?? "").localeCompare(String(a.checkpoint_id ?? ""))
    );
}

function buildParentRoleStatus(db: Db, issueId: string): Record<string, unknown> {
  const holders = parentRoleHolders(db, issueId);
  const liveHolder = holders.find((holder) =>
    Boolean((holder.liveness as Record<string, unknown> | undefined)?.has_live_agent)
  ) ?? null;
  return {
    issue_id: issueId,
    holder: holders[0] ?? null,
    live_holder: liveHolder,
    stale_holders: holders.filter((holder) =>
      !Boolean((holder.liveness as Record<string, unknown> | undefined)?.has_live_agent)
    ),
    holders,
  };
}

function latestCheckpoint(projection: LedgerIssueDetailProjection, kind: string): unknown {
  return projection.checkpoints.find((checkpoint) => checkpoint.kind === kind) ?? null;
}

function latestComment(projection: LedgerIssueDetailProjection): unknown {
  return projection.comments
    .slice()
    .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0) || b.ordinal - a.ordinal)[0] ?? null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function issueRefFromCell(cell: string): string | null {
  const match = cell.match(/\[issue:([^\]\s]+)\]/);
  return match?.[1] ?? null;
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseCanonicalUmbrellaChildRefs(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+Children\s*$/i.test(line.trim()));
  if (headingIndex < 0) return [];

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (!line.startsWith("|")) {
      if (/^#{1,6}\s+/.test(line)) return [];
      continue;
    }

    const header = splitMarkdownTableRow(line).map((cell) => cell.toLowerCase());
    const issueColumn = header.indexOf("issue");
    if (issueColumn < 0) return [];
    const separator = splitMarkdownTableRow(lines[index + 1] ?? "");
    if (!isMarkdownSeparatorRow(separator)) return [];

    const refs: string[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex].trim();
      if (!rowLine.startsWith("|")) break;
      const cells = splitMarkdownTableRow(rowLine);
      const ref = issueRefFromCell(cells[issueColumn] ?? "");
      if (ref) refs.push(ref);
    }
    return uniqueStrings(refs);
  }

  return [];
}

function resolveIssueRefs(db: Db, refs: string[]): {
  ids: string[];
  unresolved: string[];
} {
  const ids: string[] = [];
  const unresolved: string[] = [];
  const seenIds = new Set<string>();
  for (const ref of uniqueStrings(refs)) {
    const resolved = resolveLedgerIssueId(db, ref);
    if (!resolved.ok) {
      unresolved.push(ref);
      continue;
    }
    if (!seenIds.has(resolved.issue_id)) {
      ids.push(resolved.issue_id);
      seenIds.add(resolved.issue_id);
    }
  }
  return { ids, unresolved };
}

function issueDisplayRef(db: Db, issueId: string): string {
  try {
    return getLedgerIssueHead(db, issueId).short_id;
  } catch {
    return issueId;
  }
}

function issueDisplayRefs(db: Db, issueIds: string[]): string[] {
  return issueIds.map((issueId) => issueDisplayRef(db, issueId));
}

function listUmbrellaStructuredChildEdgeIds(db: Db, umbrellaId: string): string[] {
  const store = new LedgerStore(db);
  return uniqueStrings(store.listRelationshipEdges({ source_issue_id: umbrellaId })
    .filter((edge: LedgerRelationshipEdge) =>
      edge.link_type === "parent_child"
      && edge.target_entity_type === "issue"
      && typeof edge.target_issue_id === "string"
      && edge.target_issue_id.length > 0
    )
    .map((edge) => edge.target_issue_id));
}

function listUmbrellaChildEdgeIds(db: Db, umbrellaId: string): string[] {
  const edgeChildIds = listUmbrellaStructuredChildEdgeIds(db, umbrellaId);
  const legacyChildIds = buildLedgerIssueDetailProjection(db, umbrellaId).relationships
    .filter((relationship) =>
      relationship.direction === "outgoing"
      && relationship.relationship_type === "parent_child"
      && relationship.related_issue
    )
    .map((relationship) => relationship.related_issue!.id);
  return uniqueStrings([...edgeChildIds, ...legacyChildIds]);
}

function buildUmbrellaChildDrift(db: Db, umbrella: LedgerIssueDetailProjection): Record<string, unknown> {
  const bodyRefs = parseCanonicalUmbrellaChildRefs(umbrella.body);
  const resolvedBody = resolveIssueRefs(db, bodyRefs);
  const linkedIds = listUmbrellaChildEdgeIds(db, umbrella.id);
  const linkedSet = new Set(linkedIds);
  const bodySet = new Set(resolvedBody.ids);
  return {
    body_child_refs: bodyRefs,
    linked_child_refs: issueDisplayRefs(db, linkedIds),
    missing_edge_refs: issueDisplayRefs(db, resolvedBody.ids.filter((id) => !linkedSet.has(id))),
    extra_edge_refs: issueDisplayRefs(db, linkedIds.filter((id) => !bodySet.has(id))),
    unresolved_child_refs: resolvedBody.unresolved,
  };
}

function refreshDelegationManifest(db: Db, umbrellaId: string, childIds: string[]): Record<string, unknown> {
  const payload = childIds.map((childId) => getLedgerIssueHead(db, childId));
  const checkpoint = new LedgerStore(db).addIssueCheckpoint(umbrellaId, {
    kind: "delegation-manifest",
    payload,
    actor_type: "mandible_user",
    author_display: "Mandible",
    source: "mandible",
  });
  return checkpointResponse(checkpoint);
}

function repoAuthQueueSummary(db: Db, projection: LedgerIssueDetailProjection): Record<string, unknown> {
  if (!tableExists(db, "auth_requests")) {
    return { repo: projection.project.repo_id, active_requests: [], pending_requests: [] };
  }
  const repoAliases = new Set([
    projection.project.repo_id,
    projection.project.work_repo_id,
    projection.project.repo_name,
    projection.project.repo_root,
  ].filter((value): value is string => typeof value === "string" && value.length > 0));
  const rows = db.prepare(
    `SELECT id, type, title, status, repo, base_branch, head_branch, created_at, updated_at, resolved_at
     FROM auth_requests
     ORDER BY created_at DESC`,
  ).all() as Array<Record<string, unknown>>;
  const activeStatuses = new Set(["pending", "approved", "executing", "failed", "expired", "needs_rebase"]);
  const active = rows
    .filter((row) => repoAliases.has(String(row.repo ?? "")) && activeStatuses.has(String(row.status ?? "")))
    .map((row) => ({
      id: String(row.id ?? ""),
      type: String(row.type ?? "merge"),
      title: String(row.title ?? ""),
      status: String(row.status ?? ""),
      repo: row.repo ?? null,
      base_branch: row.base_branch ?? null,
      head_branch: row.head_branch ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      resolved_at: row.resolved_at ?? null,
    }));
  return {
    repo: projection.project.repo_id,
    repo_aliases: Array.from(repoAliases),
    active_requests: active,
    pending_requests: active.filter((row) => row.status === "pending"),
  };
}

function buildUmbrellaStatus(db: Db, issueId: string, options: { deep?: boolean } = {}): Record<string, unknown> {
  const umbrella = buildLedgerIssueDetailProjection(db, issueId);
  const childIds = listUmbrellaChildEdgeIds(db, umbrella.id);
  const children = childIds.map((childId) => {
    const child = buildLedgerIssueDetailProjection(db, childId);
    const summary: Record<string, unknown> = {
      id: child.id,
      short_id: child.display_id,
      title: child.title,
      status: child.status,
      worker_status: child.worker_status,
      labels: child.labels,
      head: getLedgerIssueHead(db, child.id),
      issue_branches: child.issue_branches,
      branches: child.issue_branches,
      auth_requests: child.auth_requests,
      latest_comment: latestComment(child),
      latest_closeout: latestCheckpoint(child, "closeout"),
    };
    if (!options.deep) return summary;
    return {
      ...summary,
      body: child.body,
      current_revision_id: currentIssueBodyRevisionId(db, child.id),
      resolution: child.resolution,
      kind: child.kind,
      priority: child.priority,
      source: child.source,
      author: child.author,
      project: child.project,
      created_at: child.created_at,
      updated_at: child.updated_at,
      closed_at: child.closed_at,
      aliases: child.aliases,
      relationships: child.relationships,
      work_units: child.work_units,
      sessions: child.sessions,
      associated_artifacts: child.associated_artifacts,
      conflicts: child.conflicts,
      sync: child.sync,
    };
  });
  return {
    umbrella: {
      id: umbrella.id,
      short_id: umbrella.display_id,
      title: umbrella.title,
      status: umbrella.status,
      worker_status: umbrella.worker_status,
      labels: umbrella.labels,
      body: umbrella.body,
      current_revision_id: currentIssueBodyRevisionId(db, umbrella.id),
      head: getLedgerIssueHead(db, umbrella.id),
      parent_role: buildParentRoleStatus(db, umbrella.id),
    },
    delegation_manifest: latestCheckpoint(umbrella, "delegation-manifest"),
    child_drift: buildUmbrellaChildDrift(db, umbrella),
    children,
    auth_queue: repoAuthQueueSummary(db, umbrella),
  };
}

function linkMissingUmbrellaChildren(db: Db, umbrellaId: string, childIds: string[], note: string): {
  beforeIds: string[];
  missingIds: string[];
  action_id: string | null;
} {
  const beforeIds = listUmbrellaStructuredChildEdgeIds(db, umbrellaId);
  const beforeSet = new Set(beforeIds);
  const missingIds = childIds.filter((childId) => !beforeSet.has(childId));
  if (missingIds.length === 0) return { beforeIds, missingIds, action_id: null };
  const result = new LedgerStore(db).linkRelationshipEdges({
    source_entity: { entity_type: "issue", entity_id: umbrellaId },
    target_entities: missingIds.map((childId) => ({ entity_type: "issue", entity_id: childId })),
    link_type: "parent_child",
    provenance: "manual",
    note,
    actor: { actor_type: "mandible_user", author_display: "Mandible" },
    source: "mandible",
  });
  return { beforeIds, missingIds, action_id: result.action_id };
}

function buildUmbrellaAdoptionResponse(
  db: Db,
  umbrellaId: string,
  childRefs: string[],
  kind: "adopt" | "reconcile",
): Record<string, unknown> {
  const resolved = resolveIssueRefs(db, childRefs);
  const linked = linkMissingUmbrellaChildren(
    db,
    umbrellaId,
    resolved.ids,
    kind === "adopt" ? "Umbrella child adoption" : "Umbrella child-table reconciliation",
  );
  const childIds = listUmbrellaChildEdgeIds(db, umbrellaId);
  const checkpoint = refreshDelegationManifest(db, umbrellaId, childIds);
  const status = buildUmbrellaStatus(db, umbrellaId);
  return {
    ...status,
    operation: {
      kind,
      requested_child_refs: childRefs,
      resolved_child_refs: issueDisplayRefs(db, resolved.ids),
      unresolved_child_refs: resolved.unresolved,
      created_child_refs: issueDisplayRefs(db, linked.missingIds),
      existing_child_refs: issueDisplayRefs(
        db,
        resolved.ids.filter((childId) => linked.beforeIds.includes(childId)),
      ),
      action_id: linked.action_id,
      delegation_manifest: checkpoint,
      drift: (status as Record<string, unknown>).child_drift,
    },
  };
}

function buildUmbrellaManifestRefreshResponse(db: Db, umbrellaId: string): Record<string, unknown> {
  const childIds = listUmbrellaChildEdgeIds(db, umbrellaId);
  const checkpoint = refreshDelegationManifest(db, umbrellaId, childIds);
  const status = buildUmbrellaStatus(db, umbrellaId);
  return {
    ...status,
    operation: {
      kind: "manifest-refresh",
      refreshed_child_refs: issueDisplayRefs(db, childIds),
      delegation_manifest: checkpoint,
    },
  };
}

function parentRoleReconcileBlocker(db: Db, umbrellaId: string): Record<string, unknown> | null {
  const umbrella = buildLedgerIssueDetailProjection(db, umbrellaId);
  const childRefs = parseCanonicalUmbrellaChildRefs(umbrella.body);
  if (childRefs.length === 0) return null;
  const drift = buildUmbrellaChildDrift(db, umbrella);
  const missing = Array.isArray(drift.missing_edge_refs) ? drift.missing_edge_refs : [];
  const unresolved = Array.isArray(drift.unresolved_child_refs) ? drift.unresolved_child_refs : [];
  if (missing.length === 0 && unresolved.length === 0) return null;
  return {
    error: "umbrella child table is not reconciled; run `mandible umbrella reconcile <umbrella>` first",
    reconcile_command: `mandible umbrella reconcile ${umbrella.display_id}`,
    child_drift: drift,
  };
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T[number] : null;
}

function invalidRelationshipTypeResponse(value: unknown): {
  error: string;
  accepted_relationship_types: readonly LedgerRelationshipType[];
} {
  const rendered = typeof value === "string" && value.trim()
    ? value
    : String(value ?? "");
  return {
    error: `invalid link_type: ${rendered}. Accepted relationship types: ${LEDGER_RELATIONSHIP_TYPES.join(", ")}`,
    accepted_relationship_types: LEDGER_RELATIONSHIP_TYPES,
  };
}

function parseSyncDirection(value: unknown): LedgerSyncDirection {
  return value === "export" || value === "full" ? value : "import";
}

function kindFromLabels(labels: string[]): LedgerIssueKind {
  if (labels.includes("error")) return "bug";
  if (labels.includes("umbrella")) return "umbrella";
  if (labels.includes("deferred")) return "deferred";
  if (labels.includes("feature")) return "feature";
  return "unknown";
}

function tableExists(db: Db, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function resolveContextLedgerIssueId(db: Db, issueId: string, repoId: string): string | null {
  try {
    const resolved = resolveOperationalIssueRef(db, issueId, repoId);
    return resolved.ok ? resolved.issue_id : null;
  } catch {
    return null;
  }
}

interface ResolvedRouteIssue {
  repoId: string;
  issue: GitBugIssueDetail;
  source: "scanner" | "ledger";
}

function resolveScannerIssueDetail(
  issueScanner: IssueScanner,
  repoIdParam: string,
  issueId: string,
): ResolvedRouteIssue | null {
  let repoId = repoIdParam;
  let detail = issueScanner.getIssueDetail(repoId, issueId);
  if (!detail) {
    const byName = issueScanner
      .getRepoSummaries()
      .find((summary) => summary.repo_name === repoIdParam || summary.repo_root === repoIdParam);
    if (byName) {
      repoId = byName.repo_id;
      detail = issueScanner.getIssueDetail(repoId, issueId);
    }
  }
  return detail ? { repoId, issue: detail, source: "scanner" } : null;
}

function resolveIssueDetailForRoute(
  db: Db,
  config: LedgerIssueMigrationConfig,
  workScanner: WorkScanner,
  issueScanner: IssueScanner,
  repoIdParam: string,
  issueId: string,
): { ok: true; resolved: ResolvedRouteIssue } | { ok: false; status: 404 | 409 | 500; error: string } {
  if (config.read_mode === "ledger") {
    try {
      const result = getLedgerIssueDetailForRoute(db, workScanner, repoIdParam, issueId);
      if (result.ok) {
        return {
          ok: true,
          resolved: { repoId: result.detail.repo_id, issue: result.detail, source: "ledger" },
        };
      }
      if (!config.fallback_on_ledger_error || result.status === 409) {
        return { ok: false, status: result.status, error: result.error };
      }
    } catch (error) {
      if (!config.fallback_on_ledger_error) {
        return {
          ok: false,
          status: 500,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const scannerResult = resolveScannerIssueDetail(issueScanner, repoIdParam, issueId);
  return scannerResult
    ? { ok: true, resolved: scannerResult }
    : { ok: false, status: 404, error: "issue not found" };
}

// Bug: f3dbb3e — accept optional sessionRegistry + sessionManager for canonical
// liveness computation on work units in the context endpoint.
// Bug: cbbb3d9 — deps extended with sessionManager for spawn-from-issue endpoint.
export function registerIssueRoutes(
  server: IssueServer,
  workScanner: WorkScanner,
  deps?: { sessionRegistry?: import("../registry.js").SessionRegistry; sessionManager?: import("../session-manager.js").SessionManager },
): IssueScanner {
  const issueScanner = new IssueScanner(workScanner);

  // GET /api/issues — list repo summaries with optional filtering
  server.get("/api/issues", (req, res) => {
    const repoFilter = getQueryParam(req, "repo");
    const statusFilter = getQueryParam(req, "status");
    const labelFilter = getQueryParam(req, "label");
    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);

    let summaries: IssueRepoSummary[];
    if (config.read_mode === "ledger") {
      try {
        summaries = listLedgerIssueSummaries(db, workScanner);
      } catch (error) {
        if (!config.fallback_on_ledger_error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
        summaries = issueScanner.getRepoSummaries();
      }
    } else {
      summaries = issueScanner.getRepoSummaries();
      if (config.read_mode === "shadow" && config.shadow_report_enabled) {
        runIssueReconciliation(db, issueScanner, workScanner, "shadow");
      }
    }

    summaries = filterIssueSummaries(summaries, {
      repo: repoFilter,
      status: statusFilter,
      label: labelFilter,
    });

    sendJson(res, 200, summaries);
  });

  server.get("/api/issues/migration", (_req, res) => {
    const db = getDb();
    sendJson(res, 200, {
      config: getLedgerIssueMigrationConfig(db),
      reports: listReconciliationReports(db, 10),
      sync_jobs: listLedgerSyncJobs(db).slice(0, 10),
    });
  });

  server.put?.("/api/issues/migration", (req, res) => {
    const db = getDb();
    const config = updateLedgerIssueMigrationConfig(db, parseMigrationConfigPatch(getBody(req)));
    sendJson(res, 200, { config });
  });

  server.post("/api/issues/reconcile", (_req, res) => {
    const db = getDb();
    const report = runIssueReconciliation(
      db,
      issueScanner,
      workScanner,
      getLedgerIssueMigrationConfig(db).read_mode,
    );
    sendJson(res, 200, report);
  });

  server.post("/api/issues/migration/sync", async (req, res) => {
    const body = getBody(req) ?? {};
    const db = getDb();
    const direction = parseSyncDirection(body.direction);
    const repos = getStringArray(body.repos ?? body.repo);
    const result = await runGitBugSyncForRepos({
      db,
      client: new SubprocessGitBugClient(),
      repos: workScanner.getRepos(),
      direction,
      repoRefs: repos,
    });
    sendJson(res, 200, result);
  });

  server.get("/api/issues/reconcile/:reportId", (req, res) => {
    const reportId = getParam(req, "reportId");
    if (!reportId) {
      sendJson(res, 400, { error: "missing reportId" });
      return;
    }
    const report = getReconciliationReport(getDb(), reportId);
    if (!report) {
      sendJson(res, 404, { error: "reconciliation report not found" });
      return;
    }
    sendJson(res, 200, report);
  });

  // GET /api/ledger/issues/:issueId — canonical ledger issue detail projection
  server.get("/api/ledger/issues/:issueId", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    sendLedgerIssueProjection(res, db, resolved.issue_id, [], {
      stage: getQueryParam(req, "stage") === "initial" ? "initial" : "full",
      profile: getQueryParam(req, "profile") === "1",
    });
  });

  server.get("/api/ledger/issues/:issueId/umbrella-status", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    try {
      const deep = getQueryParam(req, "deep") === "true";
      sendJson(res, 200, buildUmbrellaStatus(db, resolved.issue_id, { deep }));
    } catch (error) {
      sendJson(res, 404, { error: error instanceof Error ? error.message : "ledger issue not found" });
    }
  });

  server.post("/api/ledger/issues/:issueId/umbrella-adopt", (req, res) => {
    const issueRef = getParam(req, "issueId");
    const body = getBody(req) ?? {};
    const childRefs = getStringArray(body.child_refs ?? body.children ?? body.child);
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    if (!childRefs) {
      sendJson(res, 400, { error: "child_refs are required" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    try {
      sendJson(res, 200, buildUmbrellaAdoptionResponse(db, resolved.issue_id, childRefs, "adopt"));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "failed to adopt children" });
    }
  });

  server.post("/api/ledger/issues/:issueId/umbrella-reconcile", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    try {
      const umbrella = buildLedgerIssueDetailProjection(db, resolved.issue_id);
      sendJson(
        res,
        200,
        buildUmbrellaAdoptionResponse(
          db,
          resolved.issue_id,
          parseCanonicalUmbrellaChildRefs(umbrella.body),
          "reconcile",
        ),
      );
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "failed to reconcile umbrella" });
    }
  });

  server.post("/api/ledger/issues/:issueId/umbrella-manifest-refresh", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    try {
      sendJson(res, 200, buildUmbrellaManifestRefreshResponse(db, resolved.issue_id));
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : "failed to refresh umbrella manifest",
      });
    }
  });

  server.get("/api/ledger/issues/:issueId/parent-role", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    sendJson(res, 200, buildParentRoleStatus(db, resolved.issue_id));
  });

  server.post("/api/ledger/issues/:issueId/parent-role", (req, res) => {
    const issueRef = getParam(req, "issueId");
    const body = getBody(req) ?? {};
    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const mechanism = typeof body.mechanism === "string" && body.mechanism.trim()
      ? body.mechanism.trim()
      : "unknown";
    const override = body.override === true;
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    if (!sessionId) {
      sendJson(res, 400, { error: "session_id is required" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    const reconcileBlocker = parentRoleReconcileBlocker(db, resolved.issue_id);
    if (reconcileBlocker) {
      sendJson(res, 409, reconcileBlocker);
      return;
    }
    const current = buildParentRoleStatus(db, resolved.issue_id);
    const liveHolder = current.live_holder as Record<string, unknown> | null;
    if (liveHolder && liveHolder.session_id !== sessionId && !override) {
      sendJson(res, 409, {
        error: "parent role already held by a live session; pass override to retake",
        live_holder: liveHolder,
        parent_role: current,
      });
      return;
    }
    const now = Date.now();
    const checkpoint = new LedgerStore(db).addIssueCheckpoint(resolved.issue_id, {
      kind: "parent-role",
      payload: {
        session_id: sessionId,
        mechanism,
        assumed_at: now,
        override,
        previous_live_holder: liveHolder,
      },
      actor_type: "mandible_user",
      author_display: "Mandible",
      source: "mandible",
      created_at: now,
    });
    sendJson(res, 200, {
      ok: true,
      checkpoint: checkpointResponse(checkpoint),
      parent_role: buildParentRoleStatus(db, resolved.issue_id),
      override_required: false,
    });
  });

  server.get("/api/ledger/issues/:issueId/head", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const atParam = getQueryParam(req, "at");
    const at = atParam === undefined ? null : Number(atParam);
    if (at !== null && (!Number.isFinite(at) || at < 0)) {
      sendJson(res, 400, { error: "invalid at timestamp" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    try {
      sendJson(res, 200, getLedgerIssueHead(db, resolved.issue_id, at === null ? {} : { at }));
    } catch (error) {
      sendJson(res, 404, { error: error instanceof Error ? error.message : "ledger issue not found" });
    }
  });

  server.get("/api/ledger/issues/:issueId/body/revisions", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    const revisions = new LedgerStore(db).listBodyRevisions({
      entity_type: "issue_body",
      entity_id: resolved.issue_id,
    });
    sendJson(res, 200, { revisions });
  });

  server.post("/api/ledger/relationships", (req, res) => {
    const body = getBody(req) ?? {};
    const sourceRef = typeof body.source_ref === "string"
      ? body.source_ref.trim()
      : typeof body.source === "string"
        ? body.source.trim()
        : "";
    const targetRefs = getStringArray(body.target_refs ?? body.targets ?? body.target);
    if (!sourceRef) {
      sendJson(res, 400, { error: "source_ref is required" });
      return;
    }
    if (!targetRefs) {
      sendJson(res, 400, { error: "target_refs are required" });
      return;
    }
    const requestedLinkType = body.link_type ?? body.type ?? "references";
    const linkType = enumValue(requestedLinkType, LEDGER_RELATIONSHIP_TYPES);
    const provenance = enumValue(body.provenance ?? "manual", LEDGER_RELATIONSHIP_PROVENANCES);
    if (!linkType) {
      sendJson(res, 400, invalidRelationshipTypeResponse(requestedLinkType));
      return;
    }
    if (!provenance) {
      sendJson(res, 400, { error: "invalid provenance" });
      return;
    }
    const db = getDb();
    const sourceEntity = resolveRelationshipEntityRef(db, sourceRef);
    if (!sourceEntity.ok) {
      sendJson(res, sourceEntity.status, { error: sourceEntity.error });
      return;
    }
    const targetEntities = [];
    for (const targetRef of targetRefs) {
      const targetEntity = resolveRelationshipEntityRef(db, targetRef);
      if (!targetEntity.ok) {
        sendJson(res, targetEntity.status, { error: targetEntity.error, target_ref: targetRef });
        return;
      }
      targetEntities.push(targetEntity);
    }
    try {
      const result = new LedgerStore(db).linkRelationshipEdges({
        source_entity: sourceEntity,
        target_entities: targetEntities,
        link_type: linkType as LedgerRelationshipType,
        provenance: provenance as LedgerRelationshipProvenance,
        note: typeof body.note === "string" ? body.note : null,
        actor: { actor_type: "mandible_user", author_display: "Mandible" },
        source: "mandible",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "failed to link relationship" });
    }
  });

  server.post("/api/ledger/relationships/unlink", (req, res) => {
    const body = getBody(req) ?? {};
    const sourceRef = typeof body.source_ref === "string"
      ? body.source_ref.trim()
      : typeof body.source === "string"
        ? body.source.trim()
        : "";
    const targetRefs = getStringArray(body.target_refs ?? body.targets ?? body.target);
    if (!sourceRef) {
      sendJson(res, 400, { error: "source_ref is required" });
      return;
    }
    if (!targetRefs) {
      sendJson(res, 400, { error: "target_refs are required" });
      return;
    }
    const requestedLinkType = body.link_type ?? body.type ?? "references";
    const linkType = enumValue(requestedLinkType, LEDGER_RELATIONSHIP_TYPES);
    if (!linkType) {
      sendJson(res, 400, invalidRelationshipTypeResponse(requestedLinkType));
      return;
    }
    const db = getDb();
    const sourceEntity = resolveRelationshipEntityRef(db, sourceRef);
    if (!sourceEntity.ok) {
      sendJson(res, sourceEntity.status, { error: sourceEntity.error });
      return;
    }
    const targetEntities = [];
    for (const targetRef of targetRefs) {
      const targetEntity = resolveRelationshipEntityRef(db, targetRef);
      if (!targetEntity.ok) {
        sendJson(res, targetEntity.status, { error: targetEntity.error, target_ref: targetRef });
        return;
      }
      targetEntities.push(targetEntity);
    }
    try {
      const result = new LedgerStore(db).unlinkRelationshipEdges({
        source_entity: sourceEntity,
        target_entities: targetEntities,
        link_type: linkType as LedgerRelationshipType,
        actor: { actor_type: "mandible_user", author_display: "Mandible" },
        source: "mandible",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "failed to unlink relationship" });
    }
  });

  server.get("/api/ledger/comments/:commentId/revisions", (req, res) => {
    const commentId = getParam(req, "commentId");
    if (!commentId) {
      sendJson(res, 400, { error: "missing commentId" });
      return;
    }
    const db = getDb();
    const store = new LedgerStore(db);
    try {
      store.getComment(commentId);
      const revisions = store.listBodyRevisions({
        entity_type: "comment_body",
        entity_id: commentId,
      });
      sendJson(res, 200, { revisions });
    } catch (error) {
      sendJson(res, 404, { error: error instanceof Error ? error.message : "comment not found" });
    }
  });

  server.get("/api/ledger/body-revisions/:revisionId", (req, res) => {
    const revisionId = getParam(req, "revisionId");
    if (!revisionId) {
      sendJson(res, 400, { error: "missing revisionId" });
      return;
    }
    try {
      const revision = new LedgerStore(getDb()).getBodyRevision(revisionId);
      sendJson(res, 200, { revision });
    } catch (error) {
      sendJson(res, 404, { error: error instanceof Error ? error.message : "body revision not found" });
    }
  });

  // GET /api/issues/:repoId/:issueId/ledger-detail — resolve a route issue ref
  // into the canonical projection used by graph and issue detail panes.
  server.get("/api/issues/:repoId/:issueId/ledger-detail", (req, res) => {
    const repoId = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoId || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueIdForRoute(db, workScanner, repoId, issueId);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    sendLedgerIssueProjection(res, db, resolved.issue_id, [], {
      stage: getQueryParam(req, "stage") === "initial" ? "initial" : "full",
      profile: getQueryParam(req, "profile") === "1",
    });
  });

  server.post("/api/issues/:repoId", (req, res) => {
    const repoRef = getParam(req, "repoId");
    if (!repoRef) {
      sendJson(res, 400, { error: "missing repoId" });
      return;
    }
    const body = getBody(req) ?? {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const issueBody = typeof body.body === "string" ? body.body : "";
    const labels = getStringArray(body.labels ?? body.label) ?? [];
    const root = typeof body.root === "string" && body.root.trim() ? body.root.trim() : repoRef;
    if (!title || !issueBody.trim()) {
      sendJson(res, 400, { error: "title and body are required" });
      return;
    }

    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    if (!isLedgerWriteModeEnabled(config)) {
      sendJson(res, 409, { error: "ledger issue writes are not enabled" });
      return;
    }
    if (ledgerWriteUnavailable(res, config.write_mode)) return;
    const markdownPolicy = applyMarkdownBodyPolicy(res, db, issueBody);
    if (!markdownPolicy.ok) return;

    // Issue: 3d85f43 / dba7c41 — resolve to an ALREADY-REGISTERED project. Issue
    // creation must never mint a project/checkout as a side effect: an explicit
    // `project` ref wins, otherwise cwd inference resolves ONLY when the posted
    // root (or repo param) is a registered checkout/project. Unknown targets are
    // rejected with near-match suggestions, never auto-created.
    const explicitProject =
      typeof body.project === "string" && body.project.trim() ? body.project.trim() : "";
    let project: { id: string } | null = null;
    if (explicitProject) {
      const resolved = resolveProjectRef(db, explicitProject);
      if (resolved.ambiguous) {
        sendJson(res, 409, {
          error: `ambiguous project ref: ${explicitProject}`,
          candidates: resolved.candidates ?? [],
        });
        return;
      }
      if (!resolved.ok || !resolved.project) {
        sendJson(res, 400, {
          error: `unknown project: ${explicitProject}`,
          suggestions: suggestProjectRefs(db, explicitProject),
        });
        return;
      }
      project = resolved.project;
    } else {
      project =
        resolveCheckoutPath(db, root) ??
        resolveProjectRef(db, repoRef).project ??
        (root !== repoRef ? resolveProjectRef(db, root).project ?? null : null);
      if (!project) {
        sendJson(res, 400, {
          error:
            `'${repoRef}' (root '${root}') does not resolve to a registered project; ` +
            `pass --project <ref> or register the checkout with 'mandible project add-checkout'`,
          suggestions: suggestProjectRefs(db, repoRef),
        });
        return;
      }
    }
    const store = new LedgerStore(db);
    const issue = store.createIssue({
      project_id: project.id,
      title,
      body: issueBody,
      labels,
      kind: kindFromLabels(labels),
      actor_type: "mandible_user",
      author_display: "Mandible",
      source: "mandible",
    });
    sendLedgerIssueProjection(res, db, issue.id, markdownPolicy.warnings);
  });

  server.post("/api/ledger/issues/:issueId/comments", (req, res) => {
    const issueRef = getParam(req, "issueId");
    const body = getBody(req);
    const message = typeof body?.body === "string"
      ? body.body
      : typeof body?.message === "string"
        ? body.message
        : "";
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    if (!message.trim()) {
      sendJson(res, 400, { error: "message is required" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    const markdownPolicy = applyMarkdownBodyPolicy(res, db, message);
    if (!markdownPolicy.ok) return;
    new LedgerStore(db).addComment(resolved.issue_id, {
      body: message,
      actor_type: "mandible_user",
      author_display: "Mandible",
      source: "mandible",
      reopen: body?.reopen === true,
    });
    sendLedgerIssueProjection(res, db, resolved.issue_id, markdownPolicy.warnings);
  });

  server.post("/api/ledger/issues/:issueId/checkpoints", (req, res) => {
    const issueRef = getParam(req, "issueId");
    const body = getBody(req) ?? {};
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    const payload = body.payload;
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    if (!kind) {
      sendJson(res, 400, { error: "kind is required" });
      return;
    }
    if (payload === undefined) {
      sendJson(res, 400, { error: "payload is required" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    try {
      const checkpoint = new LedgerStore(db).addIssueCheckpoint(resolved.issue_id, {
        kind,
        payload,
        actor_type: "mandible_user",
        author_display: "Mandible",
        source: "mandible",
      });
      sendJson(res, 200, checkpointResponse(checkpoint));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid checkpoint" });
    }
  });

  server.get("/api/ledger/issues/:issueId/checkpoints", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    const kind = getQueryParam(req, "kind");
    const latest = getQueryParam(req, "latest");
    const store = new LedgerStore(db);
    if (latest === "1" || latest === "true") {
      const checkpoint = store.getLatestIssueCheckpoint(resolved.issue_id, kind);
      if (!checkpoint) {
        sendJson(res, 404, { error: "checkpoint not found" });
        return;
      }
      sendJson(res, 200, checkpointResponse(checkpoint));
      return;
    }
    const checkpoints = store
      .listIssueCheckpoints(resolved.issue_id, kind)
      .map(checkpointResponse);
    sendJson(res, 200, { checkpoints });
  });

  server.patch?.("/api/ledger/comments/:commentId", (req, res) => {
    const commentId = getParam(req, "commentId");
    if (!commentId) {
      sendJson(res, 400, { error: "missing commentId" });
      return;
    }
    const body = getBody(req) ?? {};
    const patch: { body?: string; author_display?: string } = {};
    let markdownWarnings: MarkdownBodyPolicyWarning[] = [];
    const db = getDb();
    if (typeof body.body === "string") {
      const markdownPolicy = applyMarkdownBodyPolicy(res, db, body.body);
      if (!markdownPolicy.ok) return;
      markdownWarnings = markdownPolicy.warnings;
      patch.body = body.body;
    }
    if (typeof body.author_display === "string") {
      patch.author_display = body.author_display;
    }
    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: "body or author_display is required" });
      return;
    }
    const store = new LedgerStore(db);
    try {
      const comment = store.updateComment(commentId, patch, {
        actor_type: "mandible_user",
        author_display: "Mandible",
        base_body_revision_id: typeof body.base_revision_id === "string"
          ? body.base_revision_id
          : typeof body.base_body_revision_id === "string"
            ? body.base_body_revision_id
            : undefined,
        base_body_hash: typeof body.base_body_hash === "string" ? body.base_body_hash : undefined,
      });
      sendLedgerIssueProjection(res, db, comment.issue_id, markdownWarnings);
    } catch (error) {
      if (isBodyRevisionConflict(error)) {
        sendJson(res, 409, { error: error instanceof Error ? error.message : "stale body revision" });
        return;
      }
      sendJson(res, 404, { error: error instanceof Error ? error.message : "comment not found" });
    }
  });

  server.patch?.("/api/ledger/issues/:issueId", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const body = getBody(req) ?? {};
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }

    let markdownWarnings: MarkdownBodyPolicyWarning[] = [];
    const patch: {
      title?: string;
      body?: string;
      kind?: LedgerIssueKind;
      priority?: LedgerPriority;
    } = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.body === "string") {
      const markdownPolicy = applyMarkdownBodyPolicy(res, db, body.body);
      if (!markdownPolicy.ok) return;
      markdownWarnings = markdownPolicy.warnings;
      patch.body = body.body;
    }
    const kind = enumValue(body.kind, LEDGER_ISSUE_KINDS);
    const priority = enumValue(body.priority, LEDGER_PRIORITIES);
    if (body.kind !== undefined && !kind) {
      sendJson(res, 400, { error: "invalid kind" });
      return;
    }
    if (body.priority !== undefined && !priority) {
      sendJson(res, 400, { error: "invalid priority" });
      return;
    }
    if (kind) patch.kind = kind;
    if (priority) patch.priority = priority;

    const store = new LedgerStore(db);
    if (Object.keys(patch).length > 0) {
      try {
        store.updateIssue(resolved.issue_id, patch, {
          actor_type: "mandible_user",
          author_display: "Mandible",
          base_body_revision_id: typeof body.base_body_revision_id === "string"
            ? body.base_body_revision_id
            : typeof body.base_revision_id === "string"
              ? body.base_revision_id
              : undefined,
          base_body_hash: typeof body.base_body_hash === "string" ? body.base_body_hash : undefined,
        });
      } catch (error) {
        if (isBodyRevisionConflict(error)) {
          sendJson(res, 409, { error: error instanceof Error ? error.message : "stale body revision" });
          return;
        }
        throw error;
      }
    }
    if (body.status !== undefined || body.resolution !== undefined) {
      const status = enumValue(body.status, LEDGER_ISSUE_STATUSES);
      const resolution = body.resolution === null
        ? null
        : enumValue(body.resolution, LEDGER_ISSUE_RESOLUTIONS);
      if (body.status !== undefined && !status) {
        sendJson(res, 400, { error: "invalid status" });
        return;
      }
      if (body.resolution !== undefined && body.resolution !== null && !resolution) {
        sendJson(res, 400, { error: "invalid resolution" });
        return;
      }
      const current = store.getIssue(resolved.issue_id);
      store.setIssueStatus(
        resolved.issue_id,
        (status ?? current.status) as LedgerIssueStatus,
        resolution as LedgerIssueResolution | null,
        { actor_type: "mandible_user", author_display: "Mandible" },
        "mandible",
      );
    }
    sendLedgerIssueProjection(res, db, resolved.issue_id, markdownWarnings);
  });

  server.post("/api/ledger/issues/:issueId/worker-status", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const body = getBody(req) ?? {};
    const workerStatus = enumValue(body.worker_status ?? body.status, LEDGER_WORKER_STATUSES);
    if (!workerStatus) {
      sendJson(res, 400, { error: "invalid worker_status" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    new LedgerStore(db).setWorkerStatus(
      resolved.issue_id,
      workerStatus as LedgerWorkerStatus,
      { actor_type: "mandible_user", author_display: "Mandible" },
      "mandible",
    );
    sendLedgerIssueProjection(res, db, resolved.issue_id);
  });

  server.post("/api/ledger/issues/:issueId/branches", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const body = getBody(req) ?? {};
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";
    const role = enumValue(body.role ?? "primary", LEDGER_ISSUE_BRANCH_ROLES);
    if (!branch) {
      sendJson(res, 400, { error: "branch is required" });
      return;
    }
    if (!role) {
      sendJson(res, 400, { error: "invalid branch role" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    new LedgerStore(db).addIssueBranch(
      resolved.issue_id,
      branch,
      role as LedgerIssueBranchRole,
      { actor_type: "mandible_user", author_display: "Mandible" },
      "mandible",
    );
    sendLedgerIssueProjection(res, db, resolved.issue_id);
  });

  server.post("/api/ledger/issues/:issueId/labels", (req, res) => {
    const issueRef = getParam(req, "issueId");
    const body = getBody(req);
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    const present = typeof body?.present === "boolean"
      ? body.present
      : body?.action === "add"
        ? true
        : body?.action === "remove"
          ? false
          : null;
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    if (present === null) {
      sendJson(res, 400, { error: "present boolean or add/remove action is required" });
      return;
    }
    if (!label) {
      sendJson(res, 400, { error: "label is required" });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    new LedgerStore(db).setLabel(resolved.issue_id, label, present, "mandible", {
      actor_type: "mandible_user",
      author_display: "Mandible",
    });
    sendLedgerIssueProjection(res, db, resolved.issue_id);
  });

  server.post("/api/ledger/conflicts/:conflictId/resolve", (req, res) => {
    const conflictId = getParam(req, "conflictId");
    if (!conflictId) {
      sendJson(res, 400, { error: "missing conflictId" });
      return;
    }
    const body = getBody(req) ?? {};
    const resolution = typeof body.resolution === "string" && body.resolution.trim()
      ? body.resolution.trim()
      : "keep_mandible";
    const status = body.status === "dismissed" ? "dismissed" : "resolved";
    try {
      const conflict = new LedgerStore(getDb()).resolveConflict(conflictId, {
        resolution,
        status,
        actor_type: "mandible_user",
        author_display: "Mandible",
      });
      sendJson(res, 200, { ok: true, conflict });
    } catch (error) {
      sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/issues/find/:issueId — search all scanned repos for an issue by ID prefix.
  // Registered before /:repoId/:issueId to avoid the literal "find" being treated as repoId.
  server.get("/api/issues/find/:issueId", (req, res) => {
    const issueId = getParam(req, "issueId");
    if (!issueId) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    if (config.read_mode === "ledger") {
      try {
        const result = findLedgerIssueAcrossRepos(db, workScanner, issueId);
        if (result.ok) {
          sendJson(res, 200, result.detail);
          return;
        }
        if (!config.fallback_on_ledger_error || result.status === 409) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
      } catch (error) {
        if (!config.fallback_on_ledger_error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
    }
    const detail = issueScanner.findIssueAcrossRepos(issueId);
    if (!detail) {
      sendJson(res, 404, { error: "issue not found in any scanned repo" });
      return;
    }
    sendJson(res, 200, detail);
  });

  // POST /api/issues/resolutions — record a commit that resolved an issue
  // Registered before /:repoId/:issueId to avoid "resolutions" being treated as repoId.
  // Bug: c934e60 — issue lifecycle tracking
  server.post("/api/issues/resolutions", (req, res) => {
    const body = getBody(req);
    const issue_id = typeof body?.issue_id === "string" ? body.issue_id : "";
    const commit_sha = typeof body?.commit_sha === "string" ? body.commit_sha : "";
    const repo_id = typeof body?.repo_id === "string" ? body.repo_id : "";

    if (!issue_id || !commit_sha || !repo_id) {
      sendJson(res, 400, { error: "issue_id, commit_sha, and repo_id are required" });
      return;
    }

    const db = getDb();
    const resolvedAt = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO issue_resolutions (issue_id, commit_sha, repo_id, resolved_at)
       VALUES (?, ?, ?, ?)`
    ).run(issue_id, commit_sha, repo_id, resolvedAt);

    let ledgerIssueId: string | null = null;
    try {
      const result = linkCommitToLedgerIssue(db, {
        commit_sha,
        issue_ref: issue_id,
        repo_ref: repo_id,
        now: resolvedAt,
      });
      ledgerIssueId = result.ok ? result.issue_id : null;
    } catch {
      ledgerIssueId = null;
    }

    sendJson(res, 200, { ok: true, ledger_issue_id: ledgerIssueId });
  });

  // GET /api/issues/resolutions/:issueId — get resolutions for an issue
  // Bug: c934e60 — issue lifecycle tracking
  server.get("/api/issues/resolutions/:issueId", (req, res) => {
    const issueId = getParam(req, "issueId");
    if (!issueId) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }

    const db = getDb();
    const rows = db.prepare(
      `SELECT commit_sha, repo_id, resolved_at
       FROM issue_resolutions
       WHERE issue_id = ?
       ORDER BY resolved_at ASC`
    ).all(issueId);

    sendJson(res, 200, rows);
  });

  // GET /api/issues/:repoId/:issueId — issue detail with comments
  server.get("/api/issues/:repoId/:issueId", (req, res) => {
    const repoIdParam = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoIdParam || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    const result = resolveIssueDetailForRoute(
      db,
      config,
      workScanner,
      issueScanner,
      repoIdParam,
      issueId,
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return;
    }
    sendJson(res, 200, result.resolved.issue);
  });

  // POST /api/issues/:repoId/:issueId/status — close or reopen
  server.post("/api/issues/:repoId/:issueId/status", (req, res) => {
    const repoId = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoId || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const body = getBody(req);
    const newStatus = body?.status;
    if (newStatus !== "open" && newStatus !== "closed") {
      sendJson(res, 400, { error: "status must be 'open' or 'closed'" });
      return;
    }
    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    if (isLedgerWriteModeEnabled(config)) {
      if (ledgerWriteUnavailable(res, config.write_mode)) return;
      const resolved = resolveLedgerIssueIdForRoute(db, workScanner, repoId, issueId);
      if (!resolved.ok) {
        sendJson(res, resolved.status, { error: resolved.error });
        return;
      }
      new LedgerStore(db).setIssueStatus(resolved.issue_id, newStatus);
      sendJson(res, 200, { ok: true, source: "ledger" });
      return;
    }
    const ok = newStatus === "closed"
      ? issueScanner.closeIssue(repoId, issueId)
      : issueScanner.reopenIssue(repoId, issueId);
    if (!ok) {
      sendJson(res, 500, { error: "failed to update issue status" });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/issues/:repoId/:issueId/comment — add comment
  server.post("/api/issues/:repoId/:issueId/comment", (req, res) => {
    const repoId = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoId || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const body = getBody(req);
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message.trim()) {
      sendJson(res, 400, { error: "message is required" });
      return;
    }
    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    if (isLedgerWriteModeEnabled(config)) {
      if (ledgerWriteUnavailable(res, config.write_mode)) return;
      const resolved = resolveLedgerIssueIdForRoute(db, workScanner, repoId, issueId);
      if (!resolved.ok) {
        sendJson(res, resolved.status, { error: resolved.error });
        return;
      }
      const markdownPolicy = applyMarkdownBodyPolicy(res, db, message);
      if (!markdownPolicy.ok) return;
      new LedgerStore(db).addComment(resolved.issue_id, {
        body: message,
        actor_type: "mandible_user",
        author_display: "Mandible",
        reopen: body?.reopen === true,
      });
      sendJson(res, 200, withMarkdownBodyWarnings({ ok: true, source: "ledger" }, markdownPolicy.warnings));
      return;
    }
    const ok = issueScanner.addComment(repoId, issueId, message);
    if (!ok) {
      sendJson(res, 500, { error: "failed to add comment" });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/issues/:repoId/:issueId/label — add or remove label
  server.post("/api/issues/:repoId/:issueId/label", (req, res) => {
    const repoId = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoId || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const body = getBody(req);
    const action = body?.action;
    const label = typeof body?.label === "string" ? body.label : "";
    if (action !== "add" && action !== "remove") {
      sendJson(res, 400, { error: "action must be 'add' or 'remove'" });
      return;
    }
    if (!label.trim()) {
      sendJson(res, 400, { error: "label is required" });
      return;
    }
    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    if (isLedgerWriteModeEnabled(config)) {
      if (ledgerWriteUnavailable(res, config.write_mode)) return;
      const resolved = resolveLedgerIssueIdForRoute(db, workScanner, repoId, issueId);
      if (!resolved.ok) {
        sendJson(res, resolved.status, { error: resolved.error });
        return;
      }
      new LedgerStore(db).setLabel(resolved.issue_id, label, action === "add", "mandible", {
        actor_type: "mandible_user",
        author_display: "Mandible",
      });
      sendJson(res, 200, { ok: true, source: "ledger" });
      return;
    }
    const ok = action === "add"
      ? issueScanner.addLabel(repoId, issueId, label)
      : issueScanner.removeLabel(repoId, issueId, label);
    if (!ok) {
      sendJson(res, 500, { error: `failed to ${action} label` });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/issues/scan — force rescan all repos
  server.post("/api/issues/scan", async (_req, res) => {
    const summaries = await issueScanner.scanAllAsync();
    sendJson(res, 200, summaries);
  });

  // POST /api/issues/:repoId/scan — force-scan a single repo by ID.
  // Used by the UI to unblock deep-link 404s on daemon reload: if the
  // IssueScanner hasn't scanned a repo yet, the UI can trigger a targeted
  // scan and retry the detail fetch rather than showing "Failed to load".
  server.post("/api/issues/:repoId/scan", async (req, res) => {
    const repoId = getParam(req, "repoId");
    if (!repoId) {
      sendJson(res, 400, { error: "missing repoId" });
      return;
    }
    const ok = await issueScanner.scanRepoByIdAsync(repoId);
    if (!ok) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    sendJson(res, 200, { ok: true });
  });


  // GET /api/issues/:repoId/:issueId/context — comprehensive issue context hub
  // Bug: 84cd5ae — issue detail hub aggregation endpoint
  server.get("/api/issues/:repoId/:issueId/context", (req, res) => {
    const repoIdParam = getParam(req, "repoId");
    const issueIdParam = getParam(req, "issueId");
    if (!repoIdParam || !issueIdParam) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }

    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    const resolvedIssue = resolveIssueDetailForRoute(
      db,
      config,
      workScanner,
      issueScanner,
      repoIdParam,
      issueIdParam,
    );
    if (!resolvedIssue.ok) {
      sendJson(res, resolvedIssue.status, { error: resolvedIssue.error });
      return;
    }
    const { repoId, issue } = resolvedIssue.resolved;
    const ledgerIssueId = resolveContextLedgerIssueId(db, issue.id, repoId);

    // 2. Work unit for this issue+repo
    const workUnitRow = ledgerIssueId
      ? db
          .prepare(
            `SELECT * FROM work_units
             WHERE ledger_issue_id = ? OR (issue_id = ? AND repo_id = ?)
             ORDER BY CASE WHEN ledger_issue_id = ? THEN 0 ELSE 1 END, created_at DESC
             LIMIT 1`
          )
          .get(ledgerIssueId, issue.id, repoId, ledgerIssueId) as Record<string, unknown> | undefined
      : db
          .prepare(
            `SELECT * FROM work_units
             WHERE issue_id = ? AND repo_id = ?
             ORDER BY created_at DESC LIMIT 1`
          )
          .get(issue.id, repoId) as Record<string, unknown> | undefined;

    // Bug: f3dbb3e — use canonical liveness computation from work-unit-utils
    let workUnit: Record<string, unknown> | null = null;
    if (workUnitRow) {
      const wu = mapWorkUnitRow(workUnitRow);
      const liveness = deps?.sessionRegistry && deps?.sessionManager
        ? computeLiveness(wu, deps.sessionRegistry, deps.sessionManager)
        : (() => {
            // Fallback: inline approximation when session deps not available
            const assignedSessionId = wu.assigned_session_id;
            if (!assignedSessionId) {
              return { has_live_agent: false, agent_session_id: null, agent_status: null, is_processing: false, last_activity: null };
            }
            const sessionRow = db
              .prepare("SELECT status, updated_at, last_active FROM sessions WHERE id = ?")
              .get(assignedSessionId) as Record<string, unknown> | undefined;
            if (!sessionRow) {
              return { has_live_agent: false, agent_session_id: null, agent_status: null, is_processing: false, last_activity: null };
            }
            const status = String(sessionRow.status ?? "unknown");
            return {
              has_live_agent: status === "active" || status === "idle",
              agent_session_id: assignedSessionId,
              agent_status: status,
              is_processing: status === "active",
              last_activity: sessionRow.last_active ?? sessionRow.updated_at ?? null,
            };
          })();

      workUnit = {
        branch: wu.branch,
        state: wu.state,
        continuation: wu.continuation,
        assigned_session_id: wu.assigned_session_id,
        ledger_issue_id: wu.ledger_issue_id,
        liveness,
      };
    }

    // 3. Linked sessions via canonical ledger links plus legacy session_issues.
    const sessionLinksById = new Map<string, Record<string, unknown>>();
    const legacySessionLinks = db
      .prepare(
        `SELECT si.session_id, s.status, s.created_at, s.app, si.created_at AS link_created_at
         FROM session_issues si
         LEFT JOIN sessions s ON s.id = si.session_id
         WHERE si.issue_id = ? AND si.repo_id = ?
         ORDER BY si.created_at ASC`
      )
      .all(issue.id, repoId) as Array<Record<string, unknown>>;
    for (const row of legacySessionLinks) {
      sessionLinksById.set(String(row.session_id ?? ""), row);
    }
    if (ledgerIssueId && tableExists(db, "ledger_session_issue_links")) {
      const ledgerSessionLinks = db
        .prepare(
          `SELECT l.session_id, s.status, s.created_at, s.app, l.created_at AS link_created_at
           FROM ledger_session_issue_links l
           LEFT JOIN sessions s ON s.id = l.session_id
           WHERE l.issue_id = ?
           ORDER BY l.created_at ASC`
        )
        .all(ledgerIssueId) as Array<Record<string, unknown>>;
      for (const row of ledgerSessionLinks) {
        const sessionId = String(row.session_id ?? "");
        if (!sessionLinksById.has(sessionId)) sessionLinksById.set(sessionId, row);
      }
    }

    const sessions = Array.from(sessionLinksById.values()).map((row) => ({
      session_id: String(row.session_id ?? ""),
      status: String(row.status ?? "unknown"),
      created_at: row.created_at ?? null,
      app: String(row.app ?? ""),
      has_conversation: false, // populated below
    }));

    // Check which sessions have conversations
    if (sessions.length > 0) {
      const sessionIds = sessions.map((s) => s.session_id);
      // Query conversations table for these session_ids
      try {
        const placeholders = sessionIds.map(() => "?").join(",");
        const convRows = db
          .prepare(
            `SELECT DISTINCT session_id FROM conversations WHERE session_id IN (${placeholders})`
          )
          .all(...sessionIds) as Array<{ session_id: string }>;
        const convSet = new Set(convRows.map((r) => r.session_id));
        for (const s of sessions) {
          s.has_conversation = convSet.has(s.session_id);
        }
      } catch {
        // conversations table may not exist in all setups
      }
    }

    // 4. Auth requests linked to this issue, preferring canonical ledger links
    // and keeping legacy JSON issue matching for pre-ledger rows.
    const authRows = db
      .prepare(
        `SELECT id, title, status, head_branch,
                issue_references, issue_closures, issue_ids, issues, created_at
         FROM auth_requests
         ORDER BY created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    // Bug: f3dbb3e — bidirectional prefix matching for issue IDs (same fix
    // as auth-queue.ts resolveWorkUnitsOnMerge)
    const legacyAuthRequests = authRows
      .filter((row) => {
        const refs = [
          ...parseJsonStringArray(row.issue_references),
          ...parseJsonStringArray(row.issue_closures),
          ...parseJsonStringArray(row.issue_ids),
          ...parseJsonStringArray(row.issues),
        ];
        return refs.some(
          (id: string) => id.startsWith(issue.id) || issue.id.startsWith(id)
        );
      })
      .map((row) => ({
        id: String(row.id ?? ""),
        title: String(row.title ?? ""),
        status: String(row.status ?? ""),
        head_branch: row.head_branch ?? null,
        created_at: row.created_at ?? null,
      }));
    const authRequestsById = new Map(legacyAuthRequests.map((row) => [row.id, row]));
    if (ledgerIssueId && tableExists(db, "ledger_auth_issue_links")) {
      const canonicalAuthRows = db
        .prepare(
          `SELECT ar.id, ar.title, ar.status, ar.head_branch, ar.created_at
           FROM ledger_auth_issue_links l
           JOIN auth_requests ar ON ar.id = l.auth_request_id
           WHERE l.issue_id = ?
           ORDER BY ar.created_at DESC`
        )
        .all(ledgerIssueId) as Array<Record<string, unknown>>;
      for (const row of canonicalAuthRows) {
        const id = String(row.id ?? "");
        authRequestsById.set(id, {
          id,
          title: String(row.title ?? ""),
          status: String(row.status ?? ""),
          head_branch: row.head_branch ?? null,
          created_at: row.created_at ?? null,
        });
      }
    }
    const authRequests = Array.from(authRequestsById.values())
      .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0));

    // 5. Branch info from work scanner if available
    let branchInfo: Record<string, unknown> | null = null;
    const branch = workUnitRow?.branch;
    if (typeof branch === "string" && branch) {
      const scannerRepos = workScanner.getRepos();
      const scannerRepo = scannerRepos.find((r) => r.id === repoId);
      if (scannerRepo) {
        const branches = workScanner.getBranches(scannerRepo.root);
        const branchData = branches.find((b) => b.branch === branch);
        if (branchData) {
          branchInfo = {
            ahead: branchData.ahead,
            behind: branchData.behind,
            last_commit_date: branchData.last_commit_date ?? null,
          };
        }
      }
    }

    sendJson(res, 200, {
      issue,
      work_unit: workUnit,
      sessions,
      auth_requests: authRequests,
      branch_info: branchInfo,
    });
  });

  // GET /api/issues/:repoId/:issueId/sessions — get linked sessions for an issue
  server.get("/api/issues/:repoId/:issueId/sessions", (req, res) => {
    const repoIdParam = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoIdParam || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    const resolvedIssue = resolveIssueDetailForRoute(
      db,
      config,
      workScanner,
      issueScanner,
      repoIdParam,
      issueId,
    );
    if (!resolvedIssue.ok) {
      sendJson(res, resolvedIssue.status, { error: resolvedIssue.error });
      return;
    }
    const { repoId, issue } = resolvedIssue.resolved;
    const linkMap = new Map<string, Record<string, unknown>>();
    const links = db.prepare(
      `SELECT session_id, issue_id, repo_id, created_at
       FROM session_issues
       WHERE issue_id = ? AND repo_id = ?
       ORDER BY created_at ASC`
    ).all(issue.id, repoId) as Array<Record<string, unknown>>;
    for (const link of links) {
      linkMap.set(String(link.session_id ?? ""), link);
    }
    const ledgerIssueId = resolveContextLedgerIssueId(db, issue.id, repoId);
    if (ledgerIssueId && tableExists(db, "ledger_session_issue_links")) {
      const canonicalLinks = db.prepare(
        `SELECT session_id, created_at, issue_id AS ledger_issue_id
         FROM ledger_session_issue_links
         WHERE issue_id = ?
         ORDER BY created_at ASC`
      ).all(ledgerIssueId) as Array<Record<string, unknown>>;
      for (const link of canonicalLinks) {
        const sessionId = String(link.session_id ?? "");
        if (!linkMap.has(sessionId)) {
          linkMap.set(sessionId, {
            session_id: sessionId,
            issue_id: issue.id,
            repo_id: repoId,
            created_at: link.created_at,
            ledger_issue_id: link.ledger_issue_id,
          });
        }
      }
    }
    sendJson(res, 200, Array.from(linkMap.values()));
  });

  // POST /api/issues/:repoId/:issueId/spawn — spawn an SDK console session for this issue
  // Bug: cbbb3d9 — spawn agent from issue hub
  server.post("/api/issues/:repoId/:issueId/spawn", (req, res) => {
    const repoIdParam = getParam(req, "repoId");
    const issueIdParam = getParam(req, "issueId");
    if (!repoIdParam || !issueIdParam) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }

    const sessionManager = deps?.sessionManager;
    if (!sessionManager) {
      sendJson(res, 503, { error: "session manager not available" });
      return;
    }

    const db = getDb();
    const config = getLedgerIssueMigrationConfig(db);
    const resolvedIssue = resolveIssueDetailForRoute(
      db,
      config,
      workScanner,
      issueScanner,
      repoIdParam,
      issueIdParam,
    );
    if (!resolvedIssue.ok) {
      sendJson(res, resolvedIssue.status, { error: resolvedIssue.error });
      return;
    }
    const { repoId, issue } = resolvedIssue.resolved;
    const body = getBody(req);
    const label = typeof body?.label === "string" && body.label.trim()
      ? body.label.trim()
      : `Issue: ${issue.title.slice(0, 40)}`;

    // 2. Look up work unit for branch and continuation
    const workUnitRow = db
      .prepare(
        `SELECT * FROM work_units
         WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(issue.id, repoId) as Record<string, unknown> | undefined;

    const branch = workUnitRow?.branch ? String(workUnitRow.branch) : null;
    const continuation = workUnitRow?.continuation ? String(workUnitRow.continuation) : null;

    // 3. Look up worktree path for the branch
    let cwd: string | null = null;
    if (branch) {
      const scannerRepos = workScanner.getRepos();
      const scannerRepo = scannerRepos.find((r) => r.id === repoId);
      if (scannerRepo) {
        const branches = workScanner.getBranches(scannerRepo.root);
        const branchData = branches.find((b) => b.branch === branch);
        if (branchData?.worktree_path) {
          cwd = branchData.worktree_path;
        } else {
          // Fall back to repo root
          cwd = scannerRepo.root;
        }
      }
    }
    if (!cwd) {
      // Fall back: find repo root from work scanner
      const scannerRepos = workScanner.getRepos();
      const scannerRepo = scannerRepos.find((r) => r.id === repoId);
      if (scannerRepo) {
        cwd = scannerRepo.root;
      }
    }

    // 4. Find provider_session_id from latest conversation linked to this issue (for resume)
    let providerSessionId: string | null = null;
    try {
      const sessionLink = db
        .prepare(
          `SELECT si.session_id FROM session_issues si
           JOIN sessions s ON s.id = si.session_id
           WHERE si.issue_id = ? AND si.repo_id = ?
           ORDER BY si.created_at DESC LIMIT 1`
        )
        .get(issue.id, repoId) as { session_id: string } | undefined;

      if (sessionLink) {
        // Check if there's a console session with this mandible_session_id
        const consoleRow = db
          .prepare(
            `SELECT provider_session_id FROM console_sessions
             WHERE mandible_session_id = ? AND provider_session_id IS NOT NULL
             ORDER BY created_at DESC LIMIT 1`
          )
          .get(sessionLink.session_id) as { provider_session_id: string } | undefined;

        if (consoleRow?.provider_session_id) {
          providerSessionId = consoleRow.provider_session_id;
        }
      }
    } catch {
      // Non-critical — proceed without provider_session_id
    }

    // 5. Create SDK console session (stopped — user sends the first prompt)
    const consoleSession = sessionManager.create({
      label,
      command: "claude",
      backend_type: "sdk",
      cwd,
      provider_session_id: providerSessionId,
    });

    // 6. Update work unit: assigned_session_id with the console session ID
    if (workUnitRow?.id) {
      db.prepare(
        "UPDATE work_units SET assigned_session_id = ?, updated_at = ? WHERE id = ?"
      ).run(consoleSession.id, Date.now(), String(workUnitRow.id));
    }

    sendJson(res, 200, {
      console_session_id: consoleSession.id,
      continuation,
      branch,
      cwd,
    });
  });

  return issueScanner;
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
