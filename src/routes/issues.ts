import type { SessionExecutionObservation } from "../contracts.js";
import { formatExecutionEvidence } from "../session-execution-format.js";
import { existsSync } from "node:fs";
import { WorkScanner } from "../work-scanner.js";
import { getDb, type Db } from "../db.js";
import { tableExists } from "../db-introspection.js";
import {
  resolveSessionAlias,
  sessionAliasIds,
  type LivenessState,
  type SessionAliasResolution,
} from "../session-liveness.js";
import { summarizeSessionKey } from "../session-summary.js";
import { mapWorkUnitRow, computeWorkUnitLiveness } from "../work-unit-utils.js";
import { ledgerIssueLifecycleError, LedgerSingletonKindError, LedgerStore, storedWorkerStatusError } from "../ledger/store.js";
import type { AttributionContext } from "../identity/resolver.js";
import {
  attributionForRequest,
  isOperator,
  operatorOnlyManagedSessionRoute,
} from "../client-auth/authz.js";
import {
  LEDGER_CONCRETE_ISSUE_KINDS,
  LEDGER_ISSUE_KINDS,
  LEDGER_ISSUE_BRANCH_ROLES,
  LEDGER_ISSUE_RESOLUTIONS,
  LEDGER_ISSUE_STATUSES,
  LEDGER_PRIORITIES,
  LEDGER_RELATIONSHIP_PROVENANCES,
  LEDGER_RELATIONSHIP_TYPES,
  LEDGER_STORED_WORKER_STATUSES,
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
  type LedgerStoredWorkerStatus,
} from "../ledger/types.js";
import { getUserById } from "../users/store.js";
import { batchIssueBranches, effectiveWorkerStatusSql } from "../ledger/issue-work-state.js";
import {
  buildLedgerIssueDetailInitialProjection,
  buildLedgerIssueDetailProjection,
  buildLedgerIssueDetailProjectionWithProfile,
  type LedgerIssueDetailProjection,
} from "../ledger/issue-detail.js";
import {
  getLedgerIssueHead,
  batchLedgerIssueHeads,
} from "../ledger/issue-heads.js";
import {
  evaluateMarkdownBodyPolicy,
  getMarkdownBodyEscapePolicy,
  type MarkdownBodyPolicyWarning,
} from "../ledger/markdown-body.js";
import {
  resolveProjectRef,
  suggestProjectRefs,
} from "../ledger/project-registry.js";
import {
  findLedgerIssueAcrossRepos,
  getLedgerIssueDetailForRoute,
  listLedgerIssueSummaries,
  resolveLedgerIssueIdForRoute,
} from "../ledger/issue-projection.js";
import { issueSearchExpression, searchLedgerIssues } from "../ledger/issue-search.js";
import {
  linkCommitToLedgerIssue,
  resolveOperationalIssueRef,
} from "../ledger/operational-links.js";
import type { GitBugIssueDetail, IssueRepoSummary } from "../types.js";
import type { RequestLike, ResponseLike, RouteOptions } from "../server.js";
import { sendJson } from "./http.js";
import { entityRefs, resolveCommentRef } from "../entity-refs.js";
import {
  PermissionError,
  evaluateProjectAccess,
  requireProjectAccess,
  sendPermissionError,
  type ProjectRole,
} from "../permissions/store.js";
import { parseJsonObject } from "../row-coerce.js";

export interface RouteHandler<Request = RequestLike, Response = ResponseLike> {
  (req: Request, res: Response): unknown;
}

export interface IssueServer {
  get(path: string, handler: RouteHandler, options: RouteOptions): void;
  post(path: string, handler: RouteHandler, options: RouteOptions): void;
  put?(path: string, handler: RouteHandler, options: RouteOptions): void;
  patch?(path: string, handler: RouteHandler, options: RouteOptions): void;
  delete?(path: string, handler: RouteHandler, options: RouteOptions): void;
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

function isBodyRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "LedgerBodyRevisionConflictError";
}

/** Answer a singleton-kind refusal with 409; returns false for any other error. */
function sendSingletonKindConflict(res: unknown, error: unknown): boolean {
  if (!(error instanceof LedgerSingletonKindError)) return false;
  sendJson(res, 409, {
    error: error.message,
    code: error.code,
    kind: error.kind,
    existing_issue_ids: error.existingIssueIds,
  });
  return true;
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

function resolveLedgerIssueId(
  db: Db,
  issueRef: string,
): { ok: true; issue_id: string } | { ok: false; status: 404 | 409; error: string } {
  const resolved = resolveOperationalIssueRef(db, issueRef);
  if (resolved.ok) return { ok: true, issue_id: resolved.issue_id };
  if (resolved.error === "ambiguous") return { ok: false, status: 409, error: "ambiguous issue reference" };
  return { ok: false, status: 404, error: "ledger issue not found" };
}

function resolveRelationshipEntityRef(
  db: Db,
  ref: string,
): { ok: true; entity_type: LedgerRelationshipEntityType; entity_id: string }
  | { ok: false; status: 404 | 409; error: string } {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: false, status: 404, error: "relationship entity ref is empty" };
  if (trimmed.includes("#")) {
    const comment = resolveCommentRef(db, trimmed);
    if (comment.ok) return { ok: true, entity_type: "comment", entity_id: comment.id };
    return comment.error === "ambiguous"
      ? { ok: false, status: 409, error: "ambiguous issue reference" }
      : { ok: false, status: 404, error: "ledger comment not found" };
  }
  const resolvedIssue = resolveLedgerIssueId(db, trimmed);
  if (resolvedIssue.ok) return { ok: true, entity_type: "issue", entity_id: resolvedIssue.issue_id };
  if (resolvedIssue.error === "ambiguous issue reference") return resolvedIssue;
  const comment = resolveCommentRef(db, trimmed);
  if (comment.ok) return { ok: true, entity_type: "comment", entity_id: comment.id };
  if (comment.error === "ambiguous") return { ok: false, status: 409, error: "ambiguous comment reference" };
  return resolvedIssue;
}

function relationshipEntityIssueId(
  db: Db,
  entity: { entity_type: LedgerRelationshipEntityType; entity_id: string },
): string | null {
  if (entity.entity_type === "issue") return entity.entity_id;
  const row = db.prepare("SELECT issue_id FROM ledger_comments WHERE id = ?")
    .get(entity.entity_id) as { issue_id: string } | undefined;
  return row?.issue_id ?? null;
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

/**
 * Holder liveness, through the one canonical session resolver (issue 5b2cdbf).
 *
 * This used to compare `sessions.status` directly, which understood only a
 * `sessions.id`. A coordinator holding a provider thread id therefore resolved
 * to nothing and was reported as a dead holder, so the next coordinator took
 * the same umbrella without an override. The `agent_*` fields keep their names
 * and meanings for existing readers; the resolved identities are added
 * alongside them.
 */
type SessionAliasResolver = (db: Db, sessionId: string) => SessionAliasResolution | null;

function sessionLiveness(
  db: Db,
  sessionId: string | null,
  resolver: SessionAliasResolver = resolveSessionAlias,
): Record<string, unknown> {
  const resolved = sessionId ? resolver(db, sessionId) : null;
  return {
    state: resolved?.liveness ?? "stopped",
    execution: resolved?.execution ?? null,
    agent_session_id: sessionId,
    agent_status: resolved
      ? resolved.mandible_status ?? resolved.console_status ?? (resolved.liveness === "live" ? "active" : resolved.liveness)
      : null,
    last_activity: resolved?.last_activity ?? null,
    resolved_session_id: resolved?.mandible_session_id ?? null,
    console_session_id: resolved?.console_session_id ?? null,
    provider: resolved?.provider ?? null,
    provider_session_id: resolved?.provider_session_id ?? null,
  };
}

/**
 * Every id that names the same agent as this parent-role holder.
 *
 * A holder recorded under one alias must not be treated as a different holder
 * when the same coordinator returns with another: the lease is on the agent,
 * not on the spelling of its id.
 */
function holderAliasIds(holder: Record<string, unknown> | null): Set<string> {
  const ids = new Set<string>();
  if (!holder) return ids;
  const liveness = holder.liveness as Record<string, unknown> | undefined;
  const payload = holder.payload as Record<string, unknown> | undefined;
  for (const source of [holder, liveness, payload]) {
    if (!source) continue;
    for (const key of PARENT_ROLE_IDENTITY_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) ids.add(value.trim());
    }
  }
  return ids;
}

const PARENT_ROLE_IDENTITY_KEYS = [
  "session_id",
  "agent_session_id",
  "resolved_session_id",
  "console_session_id",
  "provider_session_id",
] as const;

function unregisteredSessionResponse(suppliedId: string): Record<string, unknown> {
  return {
    error: `unknown session id "${suppliedId}": Mandible has no session row, console session, `
      + "or ingested provider transcript recorded under it, so a parent-role holder recorded under it "
      + "could never be verified. Retry once the provider transcript has been ingested, or assume the role "
      + "from a session Mandible already knows.",
    supplied_session_id: suppliedId,
    accepted_session_id_forms: [
      "a session row id (sessions.id)",
      "a console session id (console_sessions.id)",
      "an ingested provider session id (conversations.session_id)",
    ],
  };
}

/**
 * The umbrella's current parent-role holder: its latest `parent-role`
 * checkpoint, or none when that checkpoint is a release.
 *
 * Every recorded assume was authorized against the holder before it (vacant,
 * the holder itself, or the operator), so an earlier checkpoint never holds the
 * role again: a predecessor that handed the role on stays live without
 * keeping it.
 */
function currentParentRoleHolder(
  db: Db,
  issueId: string,
  resolver: SessionAliasResolver,
): Record<string, unknown> | null {
  const row = new LedgerStore(db).getLatestIssueCheckpoint(issueId, "parent-role");
  if (!row) return null;
  const payload = parseJsonObject(row.payload_json);
  if (payload.released === true) return null;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  return {
    checkpoint_id: row.id,
    issue_id: row.issue_id,
    kind: row.kind,
    payload,
    session_id: sessionId,
    mechanism: typeof payload.mechanism === "string" ? payload.mechanism : null,
    assumed_at: typeof payload.assumed_at === "number" ? payload.assumed_at : row.created_at,
    created_at: row.created_at,
    liveness: sessionLiveness(db, sessionId, resolver),
  };
}

function buildParentRoleStatus(
  db: Db,
  issueId: string,
  resolver: SessionAliasResolver = resolveSessionAlias,
): Record<string, unknown> {
  const holder = currentParentRoleHolder(db, issueId, resolver);
  const state = (holder?.liveness as { state: LivenessState } | undefined)?.state;
  return {
    issue_id: issueId,
    holder,
    live_holder: state === "live" ? holder : null,
  };
}

/** Every id the given session is known by, or just the id when Mandible has no record of it. */
function sessionAliasSet(db: Db, resolver: SessionAliasResolver, sessionId: string | null | undefined): Set<string> {
  if (!sessionId) return new Set();
  const resolution = resolver(db, sessionId);
  return new Set([sessionId, ...(resolution ? sessionAliasIds(resolution) : [])]);
}

type ParentRoleAuthority = "vacant" | "holder" | "operator_override";

/**
 * Who may change the parent role. A stopped holder is informational, so the
 * role is vacant. Otherwise the holder itself may (re-assume, hand off, or
 * release), and only the operator may displace it with an override. Session
 * ids are claimed attribution: this is advisory coordination between
 * cooperating agents, not a security boundary.
 */
function parentRoleAuthority(
  db: Db,
  req: RequestLike,
  holder: Record<string, unknown> | null,
  callerAliases: Set<string>,
  override: boolean,
): { ok: true; authority: ParentRoleAuthority } | { ok: false; refusal: Record<string, unknown> } {
  const state = (holder?.liveness as { state: LivenessState } | undefined)?.state;
  if (!holder || state === "stopped") return { ok: true, authority: "vacant" };
  if ([...holderAliasIds(holder)].some((id) => callerAliases.has(id))) return { ok: true, authority: "holder" };
  const identity = req.client_identity;
  if (override && identity && isOperator(db, identity)) return { ok: true, authority: "operator_override" };
  const execution = (holder?.liveness as { execution?: SessionExecutionObservation | null } | undefined)?.execution;
  const held = (state === "live"
    ? "parent role is held by a live session"
    : "parent role is held by a session whose liveness cannot be established") + formatExecutionEvidence(execution);
  return {
    ok: false,
    refusal: {
      error: override
        ? `${held}; --override displaces another session's holder only for the operator, and the holder can hand the role over with --session <successor>`
        : `${held}; the holder can hand the role over with --session <successor>, and only the operator can displace it with --override`,
      blocking_holder: holder,
    },
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
  const legacyChildIds = tableExists(db, "ledger_issue_relationships")
    ? (db.prepare(
        `SELECT target_issue_id
           FROM ledger_issue_relationships
          WHERE source_issue_id = ?
            AND relationship_type = 'parent_child'
            AND deleted_at IS NULL
          ORDER BY created_at, id`,
      ).all(umbrellaId) as Array<{ target_issue_id: string }>)
        .map((row) => row.target_issue_id)
    : [];
  return uniqueStrings([...edgeChildIds, ...legacyChildIds]);
}

function refreshDelegationManifest(
  db: Db,
  umbrellaId: string,
  childIds: string[],
  attribution: AttributionContext | null,
): Record<string, unknown> {
  // The first payload entry is the umbrella's own head, marked `self: true`.
  // It is an explicit stored baseline for the umbrella itself, not a child
  // entry: `mandible issue changed --since-issue` compares it directly and its
  // presence is the trusted marker that the checkpoint post-dates subtree
  // digests. Legacy checkpoints without a self entry get an "unknown" subtree
  // classification for the umbrella (never a silently reconstructed baseline),
  // including the previously ambiguous zero-child case where an empty payload
  // is indistinguishable from a pre-upgrade one.
  const payload: Array<Record<string, unknown>> = [
    { ...getLedgerIssueHead(db, umbrellaId), self: true },
    ...childIds.map((childId) => ({ ...getLedgerIssueHead(db, childId) })),
  ];
  const checkpoint = new LedgerStore(db).addIssueCheckpoint(umbrellaId, {
    kind: "delegation-manifest",
    payload,
    actor_type: "mandible_user",
    author_display: "Mandible",
    attribution,
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

function placeholders(values: string[], prefix: string): { sql: string; bindings: Record<string, string> } {
  const bindings: Record<string, string> = {};
  const keys = values.map((value, index) => {
    const key = `${prefix}${index}`;
    bindings[key] = value;
    return `:${key}`;
  });
  return { sql: keys.join(", "), bindings };
}


function latestCommentsByIssue(db: Db, issueIds: string[]): Map<string, unknown> {
  if (issueIds.length === 0) return new Map();
  const { sql, bindings } = placeholders(issueIds, "issue");
  const rows = db.prepare(
    `SELECT * FROM (
       SELECT c.*,
              ROW_NUMBER() OVER (
                PARTITION BY c.issue_id
                ORDER BY c.created_at DESC, c.ordinal DESC
              ) AS rn
         FROM ledger_comments c
        WHERE c.deleted_at IS NULL AND c.issue_id IN (${sql})
     )
     WHERE rn = 1`,
  ).all(bindings) as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [String(row.issue_id), {
    id: row.id,
    ordinal: row.ordinal,
    body: row.body,
    author: {
      id: row.author_actor_id,
      type: row.author_actor_type,
      display: row.author_display || row.author_actor_type,
    },
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }]));
}

function latestCloseoutsByIssue(db: Db, issueIds: string[]): Map<string, unknown> {
  if (issueIds.length === 0) return new Map();
  const { sql, bindings } = placeholders(issueIds, "issue");
  const rows = db.prepare(
    `SELECT * FROM (
       SELECT c.*,
              ROW_NUMBER() OVER (
                PARTITION BY c.issue_id
                ORDER BY c.created_at DESC, c.id DESC
              ) AS rn
         FROM ledger_issue_checkpoints c
        WHERE c.kind = 'closeout' AND c.issue_id IN (${sql})
     )
     WHERE rn = 1`,
  ).all(bindings) as LedgerIssueCheckpoint[];
  return new Map(rows.map((row) => [row.issue_id, checkpointResponse(row)]));
}

function labelsByIssue(db: Db, issueIds: string[]): Map<string, string[]> {
  if (issueIds.length === 0) return new Map();
  const { sql, bindings } = placeholders(issueIds, "issue");
  const rows = db.prepare(
    `SELECT issue_id, label FROM ledger_labels
      WHERE deleted_at IS NULL AND issue_id IN (${sql})
      ORDER BY label`,
  ).all(bindings) as Array<{ issue_id: string; label: string }>;
  const labels = new Map<string, string[]>();
  for (const row of rows) {
    const group = labels.get(row.issue_id) ?? [];
    group.push(row.label);
    labels.set(row.issue_id, group);
  }
  return labels;
}

function authRequestsByIssue(db: Db, issueIds: string[]): Map<string, unknown[]> {
  if (issueIds.length === 0 || !tableExists(db, "ledger_auth_issue_links") || !tableExists(db, "auth_requests")) {
    return new Map();
  }
  const { sql, bindings } = placeholders(issueIds, "issue");
  const rows = db.prepare(
    `SELECT l.issue_id, l.auth_request_id, l.link_type, l.source AS link_source,
            l.created_at AS link_created_at, l.metadata_json AS link_metadata_json,
            ar.type, ar.title, ar.status, ar.repo, ar.base_branch, ar.head_branch,
            ar.created_at, ar.approved_at, ar.resolved_at, ar.skipped_at,
            ar.exit_code, ar.error
       FROM ledger_auth_issue_links l
       LEFT JOIN auth_requests ar ON ar.id = l.auth_request_id
      WHERE l.issue_id IN (${sql})
      ORDER BY l.issue_id, ar.created_at DESC, l.created_at DESC`,
  ).all(bindings) as Array<Record<string, unknown>>;
  const grouped = new Map<string, unknown[]>();
  for (const row of rows) {
    const issueId = String(row.issue_id);
    const group = grouped.get(issueId) ?? [];
    group.push({
      id: String(row.auth_request_id ?? ""),
      type: String(row.type ?? "merge"),
      title: String(row.title ?? ""),
      status: String(row.status ?? "unknown"),
      repo: row.repo ?? null,
      base_branch: row.base_branch ?? null,
      head_branch: row.head_branch ?? null,
      created_at: row.created_at ?? null,
      approved_at: row.approved_at ?? null,
      resolved_at: row.resolved_at ?? null,
      skipped_at: row.skipped_at ?? null,
      exit_code: row.exit_code ?? null,
      error: row.error ?? null,
      link_type: String(row.link_type ?? "references"),
      link_source: String(row.link_source ?? "auth_queue"),
      link_created_at: row.link_created_at ?? null,
      metadata: parseJsonObject(row.link_metadata_json),
    });
    grouped.set(issueId, group);
  }
  return grouped;
}

/**
 * Count each issue's direct parent_child children (structured edges plus legacy
 * relationships), de-duplicating a child that is linked through both surfaces so
 * it is counted once. Batched: one query per relationship surface for the whole
 * id set.
 */
function directChildCountsByIssue(db: Db, issueIds: string[]): Map<string, number> {
  if (issueIds.length === 0) return new Map();
  const { sql, bindings } = placeholders(issueIds, "issue");
  const rows = db.prepare(
    `SELECT source_issue_id, target_issue_id
       FROM ledger_relationship_edges
      WHERE link_type = 'parent_child'
        AND target_entity_type = 'issue'
        AND deleted_at IS NULL
        AND target_issue_id IS NOT NULL
        AND source_issue_id IN (${sql})
     UNION
     SELECT source_issue_id, target_issue_id
       FROM ledger_issue_relationships
      WHERE relationship_type = 'parent_child'
        AND deleted_at IS NULL
        AND source_issue_id IN (${sql})`,
  ).all(bindings) as Array<{ source_issue_id: string; target_issue_id: string }>;
  const counts = new Map<string, number>();
  for (const id of issueIds) counts.set(id, 0);
  for (const row of rows) {
    counts.set(row.source_issue_id, (counts.get(row.source_issue_id) ?? 0) + 1);
  }
  return counts;
}

function buildUmbrellaChildSummaries(db: Db, childIds: string[]): Array<Record<string, unknown>> {
  if (childIds.length === 0) return [];
  const { sql, bindings } = placeholders(childIds, "issue");
  const rows = db.prepare(
    `SELECT id, short_id, title, status, ${effectiveWorkerStatusSql("ledger_issues")} AS worker_status, kind
       FROM ledger_issues
      WHERE id IN (${sql}) AND deleted_at IS NULL`,
  ).all(bindings) as Array<{
    id: string;
    short_id: string;
    title: string;
    status: string;
    worker_status: string;
    kind: LedgerIssueKind;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const labels = labelsByIssue(db, childIds);
  const heads = batchLedgerIssueHeads(db, childIds);
  const branches = batchIssueBranches(db, childIds);
  const authRequests = authRequestsByIssue(db, childIds);
  const latestComments = latestCommentsByIssue(db, childIds);
  const closeouts = latestCloseoutsByIssue(db, childIds);
  const childCounts = directChildCountsByIssue(db, childIds);
  const summaries: Array<Record<string, unknown>> = [];
  for (const childId of childIds) {
    const row = byId.get(childId);
    if (!row) continue;
    const issueBranches = branches.get(childId) ?? [];
    const childLabels = labels.get(childId) ?? [];
    summaries.push({
      id: row.id,
      short_id: row.short_id || row.id.slice(0, 7),
      title: row.title,
      status: row.status,
      worker_status: row.worker_status,
      labels: childLabels,
      kind: row.kind,
      child_count: childCounts.get(childId) ?? 0,
      head: heads.get(childId) ?? getLedgerIssueHead(db, childId),
      issue_branches: issueBranches,
      branches: issueBranches,
      auth_requests: authRequests.get(childId) ?? [],
      latest_comment: latestComments.get(childId) ?? null,
      latest_closeout: closeouts.get(childId) ?? null,
    });
  }
  return summaries;
}

export function buildUmbrellaStatus(db: Db, issueId: string, options: { deep?: boolean } = {}): Record<string, unknown> {
  const umbrella = buildLedgerIssueDetailProjection(db, issueId);
  const childIds = listUmbrellaChildEdgeIds(db, umbrella.id);
  const deepChildCounts = options.deep ? directChildCountsByIssue(db, childIds) : new Map<string, number>();
  const children = options.deep ? childIds.map((childId) => {
    const child = buildLedgerIssueDetailProjection(db, childId);
    const summary: Record<string, unknown> = {
      id: child.id,
      short_id: child.display_id,
      title: child.title,
      status: child.status,
      worker_status: child.worker_status,
      labels: child.labels,
      kind: child.kind,
      child_count: deepChildCounts.get(childId) ?? 0,
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
    };
  }) : buildUmbrellaChildSummaries(db, childIds);
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
    children,
    auth_queue: repoAuthQueueSummary(db, umbrella),
  };
}

function linkMissingUmbrellaChildren(
  db: Db,
  umbrellaId: string,
  childIds: string[],
  note: string,
  attribution: AttributionContext | null,
): {
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
    actor: { actor_type: "mandible_user", author_display: "Mandible", attribution },
    source: "mandible",
  });
  return { beforeIds, missingIds, action_id: result.action_id };
}

function buildUmbrellaAdoptionResponse(
  db: Db,
  umbrellaId: string,
  childRefs: string[],
  attribution: AttributionContext | null,
): Record<string, unknown> {
  const resolved = resolveIssueRefs(db, childRefs);
  const linked = linkMissingUmbrellaChildren(
    db,
    umbrellaId,
    resolved.ids,
    "Umbrella child adoption",
    attribution,
  );
  const childIds = listUmbrellaChildEdgeIds(db, umbrellaId);
  const checkpoint = refreshDelegationManifest(db, umbrellaId, childIds, attribution);
  const status = buildUmbrellaStatus(db, umbrellaId);
  return {
    ...status,
    operation: {
      kind: "adopt",
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
    },
  };
}

function buildUmbrellaManifestRefreshResponse(
  db: Db,
  umbrellaId: string,
  attribution: AttributionContext | null,
): Record<string, unknown> {
  const childIds = listUmbrellaChildEdgeIds(db, umbrellaId);
  const checkpoint = refreshDelegationManifest(db, umbrellaId, childIds, attribution);
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

function kindFromLabels(labels: string[]): LedgerIssueKind {
  if (labels.includes("error")) return "bug";
  if (labels.includes("umbrella")) return "umbrella";
  if (labels.includes("feature")) return "feature";
  return "unknown";
}

function resolveContextLedgerIssueId(db: Db, issueId: string, repoId: string): string | null {
  try {
    const resolved = resolveOperationalIssueRef(db, issueId, repoId);
    return resolved.ok ? resolved.issue_id : null;
  } catch {
    return null;
  }
}

function enforceIssueProjectAccess(
  db: Db,
  req: RequestLike,
  res: ResponseLike,
  issueId: string,
  role: ProjectRole,
): boolean {
  const row = db.prepare("SELECT project_id FROM ledger_issues WHERE id = ?")
    .get(issueId) as { project_id: string } | undefined;
  if (!row) {
    sendJson(res, 404, { error: "ledger issue not found" });
    return false;
  }
  try {
    requireProjectAccess(db, req, row.project_id, role);
    return true;
  } catch (error) {
    if (error instanceof PermissionError) {
      sendPermissionError(res, error);
      return false;
    }
    throw error;
  }
}

interface ResolvedRouteIssue {
  repoId: string;
  issue: GitBugIssueDetail;
  source: "scanner" | "ledger";
}

function resolveIssueDetailForRoute(
  db: Db,
  workScanner: WorkScanner,
  repoIdParam: string,
  issueId: string,
): { ok: true; resolved: ResolvedRouteIssue } | { ok: false; status: 404 | 409 | 500; error: string } {
  try {
    const result = getLedgerIssueDetailForRoute(db, workScanner, repoIdParam, issueId);
    if (result.ok) {
      return {
        ok: true,
        resolved: { repoId: result.detail.repo_id, issue: result.detail, source: "ledger" },
      };
    }
    return { ok: false, status: result.status, error: result.error };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Bug: f3dbb3e — accept optional sessionRegistry + sessionManager for canonical
// liveness computation on work units in the context endpoint.
// Bug: cbbb3d9 — deps extended with sessionManager for spawn-from-issue endpoint.
export function registerIssueRoutes(
  server: IssueServer,
  workScanner: WorkScanner,
  deps?: {
    sessionRegistry?: import("../registry.js").SessionRegistry;
    sessionManager?: import("../session-manager.js").SessionManager;
    conversationControl?: import("../conversation-control/service.js").ConversationControlService;
    sessionAliasResolver?: SessionAliasResolver;
  },
): void {
  const sessionAliasResolver = deps?.sessionAliasResolver ?? resolveSessionAlias;

  // GET /api/issues — list repo summaries with optional filtering
  server.get("/api/issues", (req, res) => {
    const repoFilter = getQueryParam(req, "repo");
    const statusFilter = getQueryParam(req, "status");
    const resolutionFilter = getQueryParam(req, "resolution");
    const labelFilter = getQueryParam(req, "label");
    if (statusFilter && !["all", "open", "closed"].includes(statusFilter)) {
      sendJson(res, 400, { error: "status must be open, closed, or all; use resolution=delivered instead of status=merged" });
      return;
    }
    if (resolutionFilter && !(LEDGER_ISSUE_RESOLUTIONS as readonly string[]).includes(resolutionFilter)) {
      sendJson(res, 400, { error: `resolution must be ${LEDGER_ISSUE_RESOLUTIONS.join(", ")}` });
      return;
    }
    const db = getDb();

    let summaries: IssueRepoSummary[];
    try {
      summaries = listLedgerIssueSummaries(db, workScanner);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    summaries = filterIssueSummaries(summaries, {
      repo: repoFilter,
      status: statusFilter,
      resolution: resolutionFilter,
      label: labelFilter,
    });
    summaries = summaries.filter((summary) => {
      const project = resolveProjectRef(db, summary.project_key ?? summary.repo_id);
      if ((!project.ok && project.reason === "ambiguous")) return false;
      if (!project.ok) return true;
      return evaluateProjectAccess(db, {
        identity: req.client_identity ?? null,
        project_id: project.project.id,
        required_role: "read",
      }).allowed;
    });

    sendJson(res, 200, summaries);
  }, { operation: { id: "get:/api/issues", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/issues/search", (req, res) => {
    const expression = issueSearchExpression(getQueryParam(req, "q") ?? "");
    const status = getQueryParam(req, "status") ?? "all";
    const limit = Number(getQueryParam(req, "limit") ?? 20);
    if (!expression) return sendJson(res, 400, { error: "q must contain at least one word" });
    if (status !== "all" && !(LEDGER_ISSUE_STATUSES as readonly string[]).includes(status)) {
      return sendJson(res, 400, { error: "status must be open, closed, or all" });
    }
    if (!Number.isInteger(limit) || limit < 1) return sendJson(res, 400, { error: "limit must be a positive integer" });
    const db = getDb();
    const repo = getQueryParam(req, "repo");
    let projectIds = (db.prepare("SELECT id FROM ledger_projects").all() as Array<{ id: string }>).map((row) => row.id);
    if (repo) {
      const resolved = resolveProjectRef(db, repo);
      if ((!resolved.ok && resolved.reason === "ambiguous")) return sendJson(res, 409, { error: `ambiguous project ref: ${repo}`, candidates: resolved.candidates ?? [] });
      if (!resolved.ok) return sendJson(res, 400, { error: `unknown project: ${repo}`, suggestions: suggestProjectRefs(db, repo) });
      projectIds = [resolved.project.id];
    }
    projectIds = projectIds.filter((project_id) => evaluateProjectAccess(db, {
      identity: req.client_identity ?? null, project_id, required_role: "read",
    }).allowed);
    sendJson(res, 200, searchLedgerIssues(db, { expression, projectIds, status: status as LedgerIssueStatus | "all", limit }));
  }, { operation: { id: "get:/api/issues/search", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "read")) return;
    sendLedgerIssueProjection(res, db, resolved.issue_id, [], {
      stage: getQueryParam(req, "stage") === "initial" ? "initial" : "full",
      profile: getQueryParam(req, "profile") === "1",
    });
  }, { operation: { id: "get:/api/ledger/issues/:issueId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "read")) return;
    try {
      const deep = getQueryParam(req, "deep") === "true";
      sendJson(res, 200, buildUmbrellaStatus(db, resolved.issue_id, { deep }));
    } catch (error) {
      sendJson(res, 404, { error: error instanceof Error ? error.message : "ledger issue not found" });
    }
  }, { operation: { id: "get:/api/ledger/issues/:issueId/umbrella-status", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return;
    try {
      sendJson(res, 200, buildUmbrellaAdoptionResponse(
        db,
        resolved.issue_id,
        childRefs,
        attributionForRequest(db, req),
      ));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "failed to adopt children" });
    }
  }, { operation: { id: "post:/api/ledger/issues/:issueId/umbrella-adopt", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return;
    try {
      sendJson(res, 200, buildUmbrellaManifestRefreshResponse(
        db,
        resolved.issue_id,
        attributionForRequest(db, req),
      ));
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : "failed to refresh umbrella manifest",
      });
    }
  }, { operation: { id: "post:/api/ledger/issues/:issueId/umbrella-manifest-refresh", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "read")) return;
    sendJson(res, 200, buildParentRoleStatus(db, resolved.issue_id, sessionAliasResolver));
  }, { operation: { id: "get:/api/ledger/issues/:issueId/parent-role", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Resolves the umbrella and the caller's write access, or answers the request.
  const parentRoleIssue = (req: RequestLike, res: ResponseLike): string | null => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return null;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return null;
    }
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return null;
    return resolved.issue_id;
  };

  // Strictly after the current checkpoint, so "latest" is a total order even
  // when two changes land in the same millisecond.
  const recordParentRoleCheckpoint = (
    req: RequestLike,
    issueId: string,
    payload: (now: number) => Record<string, unknown>,
  ): LedgerIssueCheckpoint => {
    const db = getDb();
    const store = new LedgerStore(db);
    const latest = store.getLatestIssueCheckpoint(issueId, "parent-role");
    const now = Math.max(Date.now(), (latest?.created_at ?? 0) + 1);
    return store.addIssueCheckpoint(issueId, {
      kind: "parent-role",
      payload: payload(now),
      actor_type: "mandible_user",
      author_display: "Mandible",
      attribution: attributionForRequest(db, req),
      source: "mandible",
      created_at: now,
    });
  };

  server.post("/api/ledger/issues/:issueId/parent-role", (req, res) => {
    const body = getBody(req) ?? {};
    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const mechanism = typeof body.mechanism === "string" && body.mechanism.trim()
      ? body.mechanism.trim()
      : "unknown";
    const override = body.override === true;
    const issueId = parentRoleIssue(req, res);
    if (!issueId) return;
    if (!sessionId) {
      sendJson(res, 400, { error: "session_id is required" });
      return;
    }
    const db = getDb();
    // Issue 5b2cdbf: refuse an id Mandible cannot verify. Recording one produced
    // a holder that every liveness check judged dead, so the next coordinator
    // took the same umbrella without an override while both were told the lease
    // had succeeded.
    const resolution = sessionAliasResolver(db, sessionId);
    if (!resolution) {
      sendJson(res, 400, unregisteredSessionResponse(sessionId));
      return;
    }
    const holder = currentParentRoleHolder(db, issueId, sessionAliasResolver);
    // Holder authority comes only from the caller's own session: a re-assume
    // under any alias, or the holder handing the role to a successor with
    // --session (issue 23a4edf). Naming the holder's session confers nothing,
    // since the checkpoint carries the caller's credential.
    const callerAliases = sessionAliasSet(db, sessionAliasResolver, req.ambient_identity?.provider_session_id);
    const decision = parentRoleAuthority(db, req, holder, callerAliases, override);
    if (!decision.ok) {
      sendJson(res, 409, { ...decision.refusal, parent_role: buildParentRoleStatus(db, issueId, sessionAliasResolver) });
      return;
    }
    const checkpoint = recordParentRoleCheckpoint(req, issueId, (now) => ({
      // `session_id` stays exactly what the caller supplied; existing readers
      // (including the archive path's holder protection) depend on it.
      session_id: sessionId,
      resolved_session_id: resolution.mandible_session_id,
      console_session_id: resolution.console_session_id,
      provider: resolution.provider,
      provider_session_id: resolution.provider_session_id,
      mechanism,
      assumed_at: now,
      override,
      authority: decision.authority,
      previous_holder: holder,
      // The audited credential an integration promotion or custody handoff
      // checks against this checkpoint.
      authenticated_user_id: req.client_identity?.method === "api_token" ? req.client_identity.user_id : null,
      authenticated_credential_id: req.client_identity?.method === "api_token" ? req.client_identity.credential_id : null,
    }));
    sendJson(res, 200, {
      ok: true,
      checkpoint: checkpointResponse(checkpoint),
      parent_role: buildParentRoleStatus(db, issueId, sessionAliasResolver),
    });
  }, { operation: { id: "post:/api/ledger/issues/:issueId/parent-role", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow", refs: { body: { session_id: entityRefs.session } } });

  // The holder steps down. Its authority is the caller's own session, never a
  // session named in the request, so releasing someone else's live holder
  // stays an operator override.
  server.delete?.("/api/ledger/issues/:issueId/parent-role", (req, res) => {
    const body = getBody(req) ?? {};
    const override = body.override === true;
    const issueId = parentRoleIssue(req, res);
    if (!issueId) return;
    const db = getDb();
    const holder = currentParentRoleHolder(db, issueId, sessionAliasResolver);
    if (!holder) {
      sendJson(res, 200, { ok: true, released: false, checkpoint: null, parent_role: buildParentRoleStatus(db, issueId, sessionAliasResolver) });
      return;
    }
    const callerAliases = sessionAliasSet(db, sessionAliasResolver, req.ambient_identity?.provider_session_id);
    const decision = parentRoleAuthority(db, req, holder, callerAliases, override);
    if (!decision.ok) {
      sendJson(res, 409, { ...decision.refusal, parent_role: buildParentRoleStatus(db, issueId, sessionAliasResolver) });
      return;
    }
    // A release carries no `session_id` and no authenticated credential, so it
    // names no holder and authorizes no integration promotion or handoff.
    const checkpoint = recordParentRoleCheckpoint(req, issueId, (now) => ({
      released: true,
      released_at: now,
      released_by_session_id: req.ambient_identity?.provider_session_id ?? null,
      authority: decision.authority,
      previous_holder: holder,
    }));
    sendJson(res, 200, {
      ok: true,
      released: true,
      checkpoint: checkpointResponse(checkpoint),
      parent_role: buildParentRoleStatus(db, issueId, sessionAliasResolver),
    });
  }, { operation: { id: "delete:/api/ledger/issues/:issueId/parent-role", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "read")) return;
    const excludeCheckpointId = getQueryParam(req, "exclude_checkpoint");
    if (excludeCheckpointId !== undefined) {
      const checkpoint = db.prepare(
        `SELECT kind, payload_json
           FROM ledger_issue_checkpoints
          WHERE id = ? AND issue_id = ?`,
      ).get(excludeCheckpointId, resolved.issue_id) as {
        kind: string;
        payload_json: string;
      } | undefined;
      let establishesSelfBaseline = false;
      if (checkpoint?.kind === "delegation-manifest") {
        try {
          const payload = JSON.parse(checkpoint.payload_json) as unknown;
          establishesSelfBaseline = Array.isArray(payload) && payload.some((entry) =>
            entry !== null
            && typeof entry === "object"
            && (entry as Record<string, unknown>).self === true
            && (entry as Record<string, unknown>).issue_id === resolved.issue_id);
        } catch {
          establishesSelfBaseline = false;
        }
      }
      if (!establishesSelfBaseline) {
        sendJson(res, 400, {
          error: "exclude_checkpoint must name this issue's self-baselined delegation manifest",
        });
        return;
      }
    }
    try {
      sendJson(res, 200, getLedgerIssueHead(db, resolved.issue_id, {
        ...(at === null ? {} : { at }),
        ...(excludeCheckpointId === undefined ? {} : { excludeCheckpointId }),
      }));
    } catch (error) {
      sendJson(res, 404, { error: error instanceof Error ? error.message : "ledger issue not found" });
    }
  }, { operation: { id: "get:/api/ledger/issues/:issueId/head", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "read")) return;
    const revisions = new LedgerStore(db).listBodyRevisions({
      entity_type: "issue_body",
      entity_id: resolved.issue_id,
    });
    sendJson(res, 200, { revisions });
  }, { operation: { id: "get:/api/ledger/issues/:issueId/body/revisions", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/ledger/issues/:issueId/work-notes/history", (req, res) => {
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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "read")) return;
    const revisions = new LedgerStore(db).listBodyRevisions({
      entity_type: "issue_work_notes",
      entity_id: resolved.issue_id,
    });
    sendJson(res, 200, { revisions });
  }, { operation: { id: "get:/api/ledger/issues/:issueId/work-notes/history", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

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
    const issueIds = new Set([sourceEntity, ...targetEntities]
      .map((entity) => relationshipEntityIssueId(db, entity))
      .filter((id): id is string => id !== null));
    for (const issueId of issueIds) {
      if (!enforceIssueProjectAccess(db, req, res, issueId, "write")) return;
    }
    try {
      const result = new LedgerStore(db).linkRelationshipEdges({
        source_entity: sourceEntity,
        target_entities: targetEntities,
        link_type: linkType as LedgerRelationshipType,
        provenance: provenance as LedgerRelationshipProvenance,
        note: typeof body.note === "string" ? body.note : null,
        actor: { actor_type: "mandible_user", author_display: "Mandible", attribution: attributionForRequest(db, req) },
        source: "mandible",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "failed to link relationship" });
    }
  }, { operation: { id: "post:/api/ledger/relationships", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

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
    const issueIds = new Set([sourceEntity, ...targetEntities]
      .map((entity) => relationshipEntityIssueId(db, entity))
      .filter((id): id is string => id !== null));
    for (const issueId of issueIds) {
      if (!enforceIssueProjectAccess(db, req, res, issueId, "write")) return;
    }
    try {
      const result = new LedgerStore(db).unlinkRelationshipEdges({
        source_entity: sourceEntity,
        target_entities: targetEntities,
        link_type: linkType as LedgerRelationshipType,
        actor: { actor_type: "mandible_user", author_display: "Mandible", attribution: attributionForRequest(db, req) },
        source: "mandible",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "failed to unlink relationship" });
    }
  }, { operation: { id: "post:/api/ledger/relationships/unlink", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

  server.get("/api/ledger/comments/:commentId/revisions", (req, res) => {
    const commentId = getParam(req, "commentId");
    if (!commentId) {
      sendJson(res, 400, { error: "missing commentId" });
      return;
    }
    const db = getDb();
    const owner = db.prepare("SELECT issue_id FROM ledger_comments WHERE id = ?")
      .get(commentId) as { issue_id: string } | undefined;
    if (!owner) {
      sendJson(res, 404, { error: "comment not found" });
      return;
    }
    if (!enforceIssueProjectAccess(db, req, res, owner.issue_id, "read")) return;
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
  }, { operation: { id: "get:/api/ledger/comments/:commentId/revisions", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { params: { commentId: entityRefs.comment } } });

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
  }, { operation: { id: "get:/api/ledger/body-revisions/:revisionId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { params: { revisionId: entityRefs.bodyRevision } } });

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
  }, { operation: { id: "get:/api/issues/:repoId/:issueId/ledger-detail", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // POST /api/issues/resolutions — record a commit that resolved an issue
  // Registered before /:repoId to avoid "resolutions" being treated as repoId.
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
    const operationalIssue = resolveOperationalIssueRef(db, issue_id, repo_id);
    if (!operationalIssue.ok && operationalIssue.error === "ambiguous") {
      sendJson(res, 403, { error: "ambiguous issue project", code: "ambiguous_project" });
      return;
    }
    if (operationalIssue.ok
      && !enforceIssueProjectAccess(db, req, res, operationalIssue.issue_id, "write")) return;
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
  }, { operation: { id: "post:/api/issues/resolutions", effects: ["ledger:write"], requestSchema: null, reportingCategory: "issues" }, fileRpc: "allow" });

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
    const requestedKind = body.kind === undefined
      ? undefined
      : enumValue(body.kind, LEDGER_ISSUE_KINDS);
    const requestedPriority = body.priority === undefined
      ? undefined
      : enumValue(body.priority, LEDGER_PRIORITIES);
    const root = typeof body.root === "string" && body.root.trim() ? body.root.trim() : repoRef;
    if (!title || !issueBody.trim()) {
      sendJson(res, 400, { error: "title and body are required" });
      return;
    }
    if (body.kind !== undefined && !requestedKind) {
      sendJson(res, 400, { error: "invalid kind" });
      return;
    }
    if (body.priority !== undefined && !requestedPriority) {
      sendJson(res, 400, { error: "invalid priority", accepted_priorities: LEDGER_PRIORITIES });
      return;
    }

    const db = getDb();
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
      if ((!resolved.ok && resolved.reason === "ambiguous")) {
        sendJson(res, 409, {
          error: `ambiguous project ref: ${explicitProject}`,
          candidates: resolved.candidates ?? [],
        });
        return;
      }
      if (!resolved.ok) {
        sendJson(res, 400, {
          error: `unknown project: ${explicitProject}`,
          suggestions: suggestProjectRefs(db, explicitProject),
        });
        return;
      }
      project = resolved.project;
    } else {
      const byRoot = resolveProjectRef(db, root);
      const byRef = byRoot.ok ? byRoot : resolveProjectRef(db, repoRef);
      project = byRef.ok ? byRef.project : null;
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
    try {
      requireProjectAccess(db, req, project.id, "write");
    } catch (error) {
      if (error instanceof PermissionError) {
        sendPermissionError(res, error);
        return;
      }
      throw error;
    }
    const caller = req.client_identity ? getUserById(db, req.client_identity.user_id) : null;
    if (caller?.kind === "agent"
      && (!requestedKind || !(LEDGER_CONCRETE_ISSUE_KINDS as readonly string[]).includes(requestedKind))) {
      sendJson(res, 400, {
        error: "agent issue creation requires an explicit concrete kind",
        accepted_kinds: LEDGER_CONCRETE_ISSUE_KINDS,
      });
      return;
    }
    const store = new LedgerStore(db);
    let issue;
    try {
      issue = store.createIssue({
        project_id: project.id,
        title,
        body: issueBody,
        labels,
        kind: requestedKind ?? kindFromLabels(labels),
        priority: requestedPriority ?? undefined,
        actor_type: "mandible_user",
        author_display: "Mandible",
        attribution: attributionForRequest(db, req),
        source: "mandible",
      });
    } catch (error) {
      if (sendSingletonKindConflict(res, error)) return;
      throw error;
    }
    sendLedgerIssueProjection(res, db, issue.id, markdownPolicy.warnings);
  }, { operation: { id: "post:/api/issues/:repoId", effects: ["ledger:write"], requestSchema: null, reportingCategory: "issues" }, fileRpc: { allowWhen: ({ params }) => !["migration", "reconcile", "scan"].includes(params.repoId ?? "") } });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return;
    const markdownPolicy = applyMarkdownBodyPolicy(res, db, message);
    if (!markdownPolicy.ok) return;
    try {
      new LedgerStore(db).addComment(resolved.issue_id, {
        body: message,
        actor_type: "mandible_user",
        author_display: "Mandible",
        attribution: attributionForRequest(db, req),
        source: "mandible",
        reopen: body?.reopen === true,
      });
    } catch (error) {
      if (sendSingletonKindConflict(res, error)) return;
      throw error;
    }
    sendLedgerIssueProjection(res, db, resolved.issue_id, markdownPolicy.warnings);
  }, { operation: { id: "post:/api/ledger/issues/:issueId/comments", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return;
    try {
      const checkpoint = new LedgerStore(db).addIssueCheckpoint(resolved.issue_id, {
        kind,
        payload,
        actor_type: "mandible_user",
        author_display: "Mandible",
        attribution: attributionForRequest(db, req),
        source: "mandible",
      });
      sendJson(res, 200, checkpointResponse(checkpoint));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid checkpoint" });
    }
  }, { operation: { id: "post:/api/ledger/issues/:issueId/checkpoints", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "read")) return;
    const kind = getQueryParam(req, "kind");
    const latest = getQueryParam(req, "latest");
    const checkpointId = getQueryParam(req, "id");
    const store = new LedgerStore(db);
    if (checkpointId) {
      const checkpoint = store.listIssueCheckpoints(resolved.issue_id, kind).find((candidate) => candidate.id === checkpointId);
      if (!checkpoint) {
        sendJson(res, 404, { error: "checkpoint not found" });
        return;
      }
      sendJson(res, 200, checkpointResponse(checkpoint));
      return;
    }
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
  }, { operation: { id: "get:/api/ledger/issues/:issueId/checkpoints", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow", refs: { query: { id: entityRefs.checkpoint } } });

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
    const owner = db.prepare("SELECT issue_id FROM ledger_comments WHERE id = ?")
      .get(commentId) as { issue_id: string } | undefined;
    if (!owner) {
      sendJson(res, 404, { error: "comment not found" });
      return;
    }
    if (!enforceIssueProjectAccess(db, req, res, owner.issue_id, "write")) return;
    const store = new LedgerStore(db);
    try {
      const comment = store.updateComment(commentId, patch, {
        actor_type: "mandible_user",
        author_display: "Mandible",
        attribution: attributionForRequest(db, req),
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
  }, { operation: { id: "patch:/api/ledger/comments/:commentId", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow",
    refs: { params: { commentId: entityRefs.comment }, body: { base_body_revision_id: entityRefs.bodyRevision, base_revision_id: entityRefs.bodyRevision } } });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return;

    let markdownWarnings: MarkdownBodyPolicyWarning[] = [];
    const patch: {
      title?: string;
      body?: string;
      work_notes?: string;
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
    if (typeof body.work_notes === "string") patch.work_notes = body.work_notes;
    const kind = enumValue(body.kind, LEDGER_ISSUE_KINDS);
    const priority = enumValue(body.priority, LEDGER_PRIORITIES);
    if (body.kind !== undefined && !kind) {
      sendJson(res, 400, { error: "invalid kind" });
      return;
    }
    if (body.priority !== undefined && !priority) {
      sendJson(res, 400, { error: "invalid priority", accepted_priorities: LEDGER_PRIORITIES });
      return;
    }
    if (kind) patch.kind = kind;
    if (priority) patch.priority = priority;

    const hasExpectedWorkNotesRevision = Object.prototype.hasOwnProperty.call(body, "expected_work_notes_revision");
    const expectedWorkNotesRevision = body.expected_work_notes_revision;
    if (hasExpectedWorkNotesRevision
      && expectedWorkNotesRevision !== null
      && typeof expectedWorkNotesRevision !== "string") {
      sendJson(res, 400, { error: "expected_work_notes_revision must be a revision id or null" });
      return;
    }

    const store = new LedgerStore(db);
    let lifecycle: { status: LedgerIssueStatus; resolution: LedgerIssueResolution | null } | null = null;
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
      const nextStatus = (status ?? store.getIssue(resolved.issue_id).status) as LedgerIssueStatus;
      const nextResolution = (body.resolution === undefined ? null : resolution) as LedgerIssueResolution | null;
      const lifecycleError = ledgerIssueLifecycleError(nextStatus, nextResolution);
      if (lifecycleError) {
        sendJson(res, 400, { error: lifecycleError });
        return;
      }
      lifecycle = { status: nextStatus, resolution: nextResolution };
    }

    try {
      // The content patch and the lifecycle change are separate store writes;
      // refuse a singleton-kind violation before either one lands.
      store.assertIssueKindTransition(resolved.issue_id, { kind: patch.kind, status: lifecycle?.status });
      if (Object.keys(patch).length > 0) {
        store.updateIssue(resolved.issue_id, patch, {
          actor_type: "mandible_user",
          author_display: "Mandible",
          attribution: attributionForRequest(db, req),
          base_body_revision_id: typeof body.base_body_revision_id === "string"
            ? body.base_body_revision_id
            : typeof body.base_revision_id === "string"
              ? body.base_revision_id
              : undefined,
          base_body_hash: typeof body.base_body_hash === "string" ? body.base_body_hash : undefined,
          base_work_notes_revision_id: hasExpectedWorkNotesRevision
            ? expectedWorkNotesRevision as string | null
            : undefined,
          base_work_notes_revision_provided: hasExpectedWorkNotesRevision,
        });
      }
      if (lifecycle) {
        store.setIssueStatus(
          resolved.issue_id,
          lifecycle.status,
          lifecycle.resolution,
          { actor_type: "mandible_user", author_display: "Mandible", attribution: attributionForRequest(db, req) },
          "mandible",
        );
      }
    } catch (error) {
      if (sendSingletonKindConflict(res, error)) return;
      if (isBodyRevisionConflict(error)) {
        sendJson(res, 409, { error: error instanceof Error ? error.message : "stale body revision" });
        return;
      }
      throw error;
    }
    sendLedgerIssueProjection(res, db, resolved.issue_id, markdownWarnings);
  }, { operation: { id: "patch:/api/ledger/issues/:issueId", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow", refs: { body: { base_body_revision_id: entityRefs.bodyRevision, base_revision_id: entityRefs.bodyRevision, expected_work_notes_revision: entityRefs.bodyRevision } } });

  server.post("/api/ledger/issues/:issueId/worker-status", (req, res) => {
    const issueRef = getParam(req, "issueId");
    if (!issueRef) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const body = getBody(req) ?? {};
    const requested = body.worker_status ?? body.status;
    const workerStatus = enumValue(requested, LEDGER_STORED_WORKER_STATUSES);
    if (!workerStatus) {
      sendJson(res, 400, { error: storedWorkerStatusError(String(requested ?? "")) });
      return;
    }
    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueRef);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return;
    new LedgerStore(db).setWorkerStatus(
      resolved.issue_id,
      workerStatus as LedgerStoredWorkerStatus,
      { actor_type: "mandible_user", author_display: "Mandible", attribution: attributionForRequest(db, req) },
      "mandible",
    );
    sendLedgerIssueProjection(res, db, resolved.issue_id);
  }, { operation: { id: "post:/api/ledger/issues/:issueId/worker-status", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return;
    new LedgerStore(db).addIssueBranch(
      resolved.issue_id,
      branch,
      role as LedgerIssueBranchRole,
      { actor_type: "mandible_user", author_display: "Mandible", attribution: attributionForRequest(db, req) },
      "mandible",
    );
    sendLedgerIssueProjection(res, db, resolved.issue_id);
  }, { operation: { id: "post:/api/ledger/issues/:issueId/branches", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

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
    if (!enforceIssueProjectAccess(db, req, res, resolved.issue_id, "write")) return;
    new LedgerStore(db).setLabel(resolved.issue_id, label, present, "mandible", {
      actor_type: "mandible_user",
      author_display: "Mandible",
      attribution: attributionForRequest(db, req),
    });
    sendLedgerIssueProjection(res, db, resolved.issue_id);
  }, { operation: { id: "post:/api/ledger/issues/:issueId/labels", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });

  // GET /api/issues/find/:issueId — search ledger-backed issues by ID prefix.
  // Registered before /:repoId/:issueId to avoid the literal "find" being treated as repoId.
  server.get("/api/issues/find/:issueId", (req, res) => {
    const issueId = getParam(req, "issueId");
    if (!issueId) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }
    const db = getDb();
    try {
      const result = findLedgerIssueAcrossRepos(db, workScanner, issueId);
      if (result.ok) {
        const ledgerIssueId = resolveContextLedgerIssueId(db, result.detail.id, result.detail.repo_id);
        if (ledgerIssueId
          && !enforceIssueProjectAccess(db, req, res, ledgerIssueId, "read")) return;
        sendJson(res, 200, result.detail);
        return;
      }
      sendJson(res, result.status, { error: result.error });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }, { operation: { id: "get:/api/issues/find/:issueId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // GET /api/issues/resolutions/:issueId — get resolutions for an issue
  // Bug: c934e60 — issue lifecycle tracking
  server.get("/api/issues/resolutions/:issueId", (req, res) => {
    const issueId = getParam(req, "issueId");
    if (!issueId) {
      sendJson(res, 400, { error: "missing issueId" });
      return;
    }

    const db = getDb();
    const resolved = resolveLedgerIssueId(db, issueId);
    if (!resolved.ok && resolved.status === 409) {
      sendJson(res, 403, { error: "ambiguous issue project", code: "ambiguous_project" });
      return;
    }
    if (resolved.ok
      && !enforceIssueProjectAccess(db, req, res, resolved.issue_id, "read")) return;
    const rows = db.prepare(
      `SELECT commit_sha, repo_id, resolved_at
       FROM issue_resolutions
       WHERE issue_id = ?
       ORDER BY resolved_at ASC`
    ).all(issueId);

    sendJson(res, 200, rows);
  }, { operation: { id: "get:/api/issues/resolutions/:issueId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // GET /api/issues/:repoId/:issueId — issue detail with comments
  server.get("/api/issues/:repoId/:issueId", (req, res) => {
    const repoIdParam = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoIdParam || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const db = getDb();
    const result = resolveIssueDetailForRoute(
      db,
      workScanner,
      repoIdParam,
      issueId,
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return;
    }
    const ledgerIssueId = resolveContextLedgerIssueId(
      db,
      result.resolved.issue.id,
      result.resolved.repoId,
    );
    if (ledgerIssueId && !enforceIssueProjectAccess(db, req, res, ledgerIssueId, "read")) return;
    sendJson(res, 200, result.resolved.issue);
  }, { operation: { id: "get:/api/issues/:repoId/:issueId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

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
    const resolvedIssue = resolveIssueDetailForRoute(
      db,
      workScanner,
      repoIdParam,
      issueIdParam,
    );
    if (!resolvedIssue.ok) {
      sendJson(res, resolvedIssue.status, { error: resolvedIssue.error });
      return;
    }
    const { repoId, issue } = resolvedIssue.resolved;
    const ledgerIssueId = resolveContextLedgerIssueId(db, issue.id, repoId);
    if (ledgerIssueId && !enforceIssueProjectAccess(db, req, res, ledgerIssueId, "read")) return;

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
      const liveness = computeWorkUnitLiveness(db, wu, deps?.sessionManager);

      workUnit = {
        branch: wu.branch,
        state: wu.state,
        continuation: wu.continuation,
        assigned_session_id: wu.assigned_session_id,
        ledger_issue_id: wu.ledger_issue_id,
        liveness,
      };
    }

    // 3. Linked sessions via ledger links.
    const sessions = ledgerIssueId
      ? (db.prepare(
        `SELECT session_id FROM ledger_session_issue_links
         WHERE issue_id = ?
         GROUP BY session_id
         ORDER BY MIN(created_at) ASC`
      ).all(ledgerIssueId) as Array<{ session_id: string }>).map((row) => {
        const summary = summarizeSessionKey(db, row.session_id);
        return { ...summary, has_conversation: summary.conversation_id !== null };
      })
      : [];

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
  }, { operation: { id: "get:/api/issues/:repoId/:issueId/context", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // GET /api/issues/:repoId/:issueId/sessions — get linked sessions for an issue
  server.get("/api/issues/:repoId/:issueId/sessions", (req, res) => {
    const repoIdParam = getParam(req, "repoId");
    const issueId = getParam(req, "issueId");
    if (!repoIdParam || !issueId) {
      sendJson(res, 400, { error: "missing repoId or issueId" });
      return;
    }
    const db = getDb();
    const resolvedIssue = resolveIssueDetailForRoute(
      db,
      workScanner,
      repoIdParam,
      issueId,
    );
    if (!resolvedIssue.ok) {
      sendJson(res, resolvedIssue.status, { error: resolvedIssue.error });
      return;
    }
    const { repoId, issue } = resolvedIssue.resolved;
    const ledgerIssueId = resolveContextLedgerIssueId(db, issue.id, repoId);
    const links = ledgerIssueId
      ? db.prepare(
        `SELECT DISTINCT session_id, MIN(created_at) AS created_at
         FROM ledger_session_issue_links
         WHERE issue_id = ?
         GROUP BY session_id
         ORDER BY created_at ASC`
      ).all(ledgerIssueId) as Array<{ session_id: string; created_at: number }>
      : [];
    sendJson(res, 200, links.map((link) => ({
      session_id: link.session_id,
      issue_id: issue.id,
      repo_id: repoId,
      created_at: link.created_at,
      ledger_issue_id: ledgerIssueId,
    })));
  }, { operation: { id: "get:/api/issues/:repoId/:issueId/sessions", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Resume the explicitly selected assignment; this action never transfers custody.
  server.post("/api/issues/:repoId/:issueId/spawn", operatorOnlyManagedSessionRoute(async (req, res) => {
    const db = getDb();
    const resolved = resolveIssueDetailForRoute(db, workScanner, getParam(req, "repoId") ?? "", getParam(req, "issueId") ?? "");
    if (!resolved.ok) return sendJson(res, resolved.status, { error: resolved.error });
    const { repoId, issue } = resolved.resolved;
    const ledgerIssueId = resolveContextLedgerIssueId(db, issue.id, repoId);
    if (!ledgerIssueId) return sendJson(res, 404, { error: "issue_not_found" });
    if (!enforceIssueProjectAccess(db, req, res, ledgerIssueId, "write")) return;
    const body = getBody(req);
    if (typeof body?.work_unit_id !== "string" || !Number.isInteger(body.expected_custody_generation)) {
      return sendJson(res, 400, { error: "exact_work_unit_required", message: "Select the assigned work unit and its current custody generation." });
    }
    const readUnit = () => db.prepare("SELECT * FROM work_units WHERE id = ? AND repo_id = ? AND (ledger_issue_id = ? OR issue_id = ?)")
      .get(body.work_unit_id, repoId, ledgerIssueId, issue.id) as Record<string, unknown> | undefined;
    const row = readUnit();
    if (!row || !["open", "committed"].includes(String(row.state))) return sendJson(res, 409, { error: "work_unit_unavailable" });
    if (row.custody_generation !== body.expected_custody_generation) return sendJson(res, 409, { error: "custody_generation_conflict" });
    const assignment = typeof row.assigned_session_id === "string" ? sessionAliasResolver(db, row.assigned_session_id) : null;
    const nativeId = assignment?.provider_session_id;
    if (!nativeId) return sendJson(res, 422, { error: "assigned_conversation_unavailable", message: "This work unit has no exact assigned native conversation." });
    const conversations = db.prepare("SELECT id, source, cwd FROM conversations WHERE session_id = ? AND parent_conversation_id IS NULL").all(nativeId) as { id: string; source: string; cwd: string | null }[];
    if (conversations.length !== 1) return sendJson(res, 409, { error: "assigned_conversation_ambiguous" });
    const conversation = conversations[0];
    const normalizeProvider = (value: unknown) => value === "claude" || value === "claude_code" ? "claude_code" : value;
    if (normalizeProvider(assignment.provider) !== conversation.source || row.provider && normalizeProvider(row.provider) !== conversation.source) {
      return sendJson(res, 409, { error: "assigned_provider_conflict" });
    }
    const repo = workScanner.getRepos().find(value => value.id === repoId);
    const checkout = repo && typeof row.branch === "string" ? workScanner.getBranches(repo.root).find(value => value.branch === row.branch)?.worktree_path : null;
    if (!checkout || !existsSync(checkout)) return sendJson(res, 409, { error: "assigned_checkout_unavailable", message: "Restore the assigned branch checkout before resuming." });
    const control = deps?.conversationControl;
    if (!control) return sendJson(res, 503, { error: "conversation_controller_unavailable" });
    const snapshot = control.getSnapshot(conversation.id);
    if (!snapshot.ok) return sendJson(res, 422, snapshot);
    if (snapshot.value.ownership.kind !== "mandible") {
      const before = JSON.stringify(row);
      const acquired = await control.resume({ conversation_id: conversation.id, expected_revision: snapshot.value.revision,
        expected_generation: snapshot.value.ownership.generation, cwd: checkout });
      if (!acquired.ok) return sendJson(res, 409, acquired);
      if (JSON.stringify(readUnit()) !== before) {
        const stopped = await control.stop(conversation.id, acquired.value.ownership.generation);
        return sendJson(res, 409, { error: "assignment_changed_during_resume", stopped });
      }
    } else {
      if (conversation.cwd !== checkout) return sendJson(res, 409, { error: "assigned_controller_checkout_conflict" });
      if (!await control.ownsController(conversation.id, snapshot.value.ownership.generation)) return sendJson(res, 409, { error: "assigned_controller_unavailable" });
      if (JSON.stringify(readUnit()) !== JSON.stringify(row)) return sendJson(res, 409, { error: "assignment_changed_during_resume" });
    }
    sendJson(res, 200, { conversation_id: conversation.id, work_unit_id: row.id, continuation: row.continuation,
      branch: row.branch, cwd: checkout, custody_generation: row.custody_generation });
  }), { operation: { id: "post:/api/issues/:repoId/:issueId/spawn", effects: ["ledger:write", "files:production", "process:external"], requestSchema: null, reportingCategory: "issues" }, fileRpc: "deny" });

}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || !value.trim()) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}
