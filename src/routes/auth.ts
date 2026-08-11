import { AuthQueue, AuthQueueError } from "../auth-queue.js";
import { AuthActionValidationError } from "../auth-actions.js";
import { AuthAutoApproveManager } from "../auth-auto-approve.js";
import {
  computeAuthMergeReviewMetadata,
  isAuthMergeCommand,
  normalizeExistingPath,
  repoRootFromGitCommonDir,
  resolveAuthMergeExecutionContext,
} from "../auth-context.js";
import { getDaemonLogger } from "../daemon-log.js";
import { getDb, resolvePrefix } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type { AuthMergeCheckInput } from "../auth-queue.js";
import type { AuthRequestInput, AuthRequestType } from "../types.js";
import {
  resolveProviderSessionAttributionResult,
  resolveSessionIdAttributionResult,
} from "../identity/resolver.js";
import {
  AttributionReadResolver,
  authAttributionReadFields,
} from "../identity/read-projection.js";
import { ClientAuthzError, requireOperator } from "../client-auth/authz.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readBody } from "./http.js";
import { globalCapabilityRoute } from "../permissions/routes.js";

const authRouteLog = getDaemonLogger();

export function registerAuthRoutes(
  app: RouteRegistrar,
  queue?: AuthQueue,
  autoApprove?: AuthAutoApproveManager,
): AuthQueue {
  const autoApproveManager = autoApprove ?? new AuthAutoApproveManager();
  const authQueue = queue ?? new AuthQueue({ autoApprover: autoApproveManager });
  app.post("/api/auth/check", (req, res) => {
    const payload = parseAuthCheckPayload(readBody<Record<string, unknown>>(req));
    if (!payload) {
      res.status(400).json({ error: "Invalid auth check payload." });
      return;
    }
    const report = authQueue.checkMergeIndependence(resolveAuthCheckPayload(payload));
    res.status(200).json({ check: report });
  }, { fileRpc: "allow" });

  app.post("/api/auth/request", async (req, res) => {
    const payload = parseAuthRequestPayload(readBody<Record<string, unknown>>(req));
    if (!payload) {
      res.status(400).json({ error: "Invalid auth request payload." });
      return;
    }
    const requester = resolveAuthRequester(req, payload);
    if (!requester.ok) {
      res.status(requester.status).json({ error: requester.error, code: requester.code });
      return;
    }

    const isAuthMerge = isAuthMergeCommand(payload);
    if (isAuthMerge) {
      try {
        const resolved = resolveAuthMergeExecutionContext(getDb(), payload);
        payload.cwd = resolved.executionCwd;
        payload.target_repo_root = resolved.targetRepoRoot;
        payload.repo = payload.repo ?? resolved.repoName ?? path.basename(resolved.targetRepoRoot);
        payload.base_branch = resolved.baseBranch;
        payload.head_branch = resolved.headBranch;
        payload.merge_head_sha = payload.merge_head_sha ?? resolved.headSha;
        const needsCounts =
          payload.files_changed === undefined ||
          payload.additions === undefined ||
          payload.deletions === undefined;
        const needsDiffSummary = payload.diff_summary == null;
        const needsCommitMessage = payload.commit_message == null;
        const metadata = await computeAuthMergeReviewMetadata(
          resolved.targetRepoRoot,
          resolved.baseBranch,
          resolved.headBranch,
          {
            counts: needsCounts,
            diffSummary: needsDiffSummary,
            commitMessage: needsCommitMessage,
          }
        );
        payload.files_changed = payload.files_changed ?? metadata.filesChanged;
        payload.additions = payload.additions ?? metadata.additions;
        payload.deletions = payload.deletions ?? metadata.deletions;
        if (payload.diff_summary == null) {
          payload.diff_summary = metadata.diffSummary;
        }
        if (payload.commit_message == null) {
          payload.commit_message = metadata.commitMessage;
        }
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "Invalid auth merge execution context."
        });
        return;
      }
    }

    const cwdRepoRoot = payload.cwd ? repoRootFromGitCommonDir(payload.cwd) : null;
    if (!payload.target_repo_root && cwdRepoRoot) {
      payload.target_repo_root = cwdRepoRoot;
    }

    // Bug: 76ea6c6 — fallback for repo name from cwd if missing
    // Bug: b011e5b — if repo looks like a branch name, derive from cwd.
    // Bug: 32a2800 — worktree cwd basenames can be branch names; derive from the
    // Git common dir when possible so `worktrees/develop` records repo `feedbax`.
    const repo = payload.repo;
    const looksLikeBranch =
      repo && repo.includes("/") && !repo.match(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/);
    if (!repo || looksLikeBranch) {
      payload.repo = cwdRepoRoot
        ? path.basename(cwdRepoRoot)
        : payload.cwd
          ? path.basename(payload.cwd)
          : payload.repo;
    }

    // Auth merge gate: verify Mandible issue references in non-merge commits.
    if (isAuthMerge) {
      const gateError = verifyMandibleIssueReferences(payload);
      if (gateError) {
        res.status(400).json({ error: gateError });
        return;
      }
    }

    // Bug: 16985e8 — detect duplicate submissions. Return 409 with the existing
    // request_id so the agent can PUT to update it rather than creating a new one.
    const duplicate = authQueue.findDuplicate(payload);
    if (duplicate) {
      res.status(409).json({
        error: "Duplicate auth request — a pending or approved request for this branch already exists.",
        request_id: duplicate.id,
        status: duplicate.status
      });
      return;
    }

    try {
      const request = authQueue.submit(payload, requester.userId);
      res.status(201).json({ request_id: request.id });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "allow" });

  app.get("/api/auth/request/:id", (req, res) => {
    // Issue f59b5bd — getRequest already resolves unambiguous short prefixes
    // (Bug: caa157e), so short-form deep links land here directly.
    const request = authQueue.getRequest(req.params.id);
    if (!request) {
      // Bug: caa157e — distinguish ambiguous prefix from not-found
      const resolved = resolvePrefix(getDb(), "auth_requests", "id", req.params.id);
      if (!resolved.ok && resolved.error === "ambiguous") {
        res.status(409).json({
          error: `Ambiguous prefix '${req.params.id}' — matches ${resolved.count} requests. Use a longer prefix.`
        });
        return;
      }
      res.status(404).json({ error: "Auth request not found." });
      return;
    }

    // Bug: 0b83252 — resolve dependency status to avoid a second round-trip from the UI
    let dependsOnStatus: string | null = null;
    if (request.depends_on_id) {
      const dep = authQueue.getRequest(request.depends_on_id);
      dependsOnStatus = dep ? dep.status : null;
    }

    // Bug: 929c6d0 — include error_output: tail of executor output for failed requests
    const errorOutput = (request.exit_code != null && request.exit_code !== 0 && request.output)
      ? tailLines(request.output, 20)
      : null;

    res.json({
      request_id: request.id,
      type: request.type,
      status: request.status,
      // Bug: 2cddba2 — deep-linked requests outside the loaded queue/history
      // lists render the detail pane from this payload, so it carries the
      // header title and lifecycle timestamps too.
      title: request.title,
      created_at: request.created_at,
      last_executed_at: request.last_executed_at,
      resolved_at: request.resolved_at,
      output: request.output,
      exit_code: request.exit_code,
      error: request.error,
      error_output: errorOutput,
      repo: request.repo ?? null,
      base_branch: request.base_branch ?? null,
      head_branch: request.head_branch ?? null,
      merge_preflight_base_sha: request.merge_preflight_base_sha ?? null,
      merge_preflight_queue_fingerprint: request.merge_preflight_queue_fingerprint ?? null,
      files_changed: request.files_changed ?? 0,
      additions: request.additions ?? 0,
      deletions: request.deletions ?? 0,
      diff_summary: request.diff_summary ?? null,
      commit_message: request.commit_message ?? null,
      spec_content: request.spec_content ?? null,
      post_merge_handoff: request.post_merge_handoff ?? null,
      issue_references: request.issue_references ?? null,
      issue_closures: request.issue_closures ?? null,
      issue_ids: request.issue_ids ?? null,
      issues: request.issues ?? null,
      depends_on_id: request.depends_on_id ?? null,
      depends_on_status: dependsOnStatus,
      execution_mode: request.execution_mode,
      approval_source: request.approval_source,
      approval_lease_id: request.approval_lease_id,
      requested_by_user_id: request.requested_by_user_id,
      approved_by_user_id: request.approved_by_user_id,
      execution_evidence_id: request.execution_evidence_id,
      signature_verification: authQueue.getSignatureVerification(request.id),
      ...authAttributionReadFields(new AttributionReadResolver(getDb()), request),
      action_count: authQueue.countActions(request.id),
      actions: authQueue.listActions(request.id),
      // Bug: 4e32923 — include scoping fields omitted from the original response literal
      target_session_id: request.target_session_id ?? null,
      delivered_at: request.delivered_at ?? null
    });
  }, { fileRpc: "allow" });

  app.get("/api/auth/request/:id/actions", (req, res) => {
    try {
      res.json({ actions: authQueue.listActions(req.params.id) });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "allow" });

  app.post("/api/auth/request/:id/actions", (req, res) => {
    try {
      const action = authQueue.addAction(req.params.id, readBody<Record<string, unknown>>(req));
      res.status(201).json({ action });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "allow" });

  app.put("/api/auth/request/:id/actions/:actionId", (req, res) => {
    try {
      const action = authQueue.updateAction(
        req.params.id,
        req.params.actionId,
        readBody<Record<string, unknown>>(req),
      );
      res.status(200).json({ action });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "allow" });

  app.delete("/api/auth/request/:id/actions/:actionId", (req, res) => {
    try {
      const action = authQueue.deleteAction(req.params.id, req.params.actionId);
      res.status(200).json({ action_id: action.id, deleted: true });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "allow" });

  app.post("/api/auth/request/:id/actions/:actionId/veto", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.vetoed !== "boolean") {
      res.status(400).json({ error: "vetoed boolean is required" });
      return;
    }
    try {
      const action = authQueue.setActionVeto(req.params.id, req.params.actionId, body.vetoed);
      res.status(200).json({ action });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.put("/api/auth/request/:id", (req, res) => {
    const result = parseAuthRequestUpdatePayload(readBody<Record<string, unknown>>(req));
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    try {
      const updated = authQueue.update(req.params.id, result.payload);
      res.status(200).json({ request_id: updated.id, ...updated });
    } catch (error) {
      if (isHttpError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.delete("/api/auth/request/:id", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.reason !== "string" || !body.reason.trim()) {
      res.status(400).json({ error: "reason is required" });
      return;
    }
    try {
      authQueue.delete(req.params.id, body.reason);
      res.status(200).json({ request_id: req.params.id, deleted: true });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/request/:id/replay-codex-archives", async (req, res) => {
    try {
      // Issue 75f52ac — archiving is now async (off-loop codex CLI spawn).
      const result = await authQueue.replayCodexThreadArchives(req.params.id);
      res.status(200).json(result);
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "allow" });

  app.get("/api/auth/queue", (req, res) => {
    const query = req.query ?? {};
    // Bug: dd21c1e — optional ?type=X filter
    const typeFilter = typeof query.type === "string" && VALID_AUTH_REQUEST_TYPES.includes(query.type as AuthRequestType)
      ? (query.type as AuthRequestType)
      : undefined;
    let requests = authQueue.listActive();
    if (typeFilter) {
      requests = requests.filter((r) => r.type === typeFilter);
    }
    // Bug: 0b83252 — resolve depends_on_status for each request with a dependency
    const attributionResolver = new AttributionReadResolver(getDb());
    const enriched = requests.map((r) => {
      const dep = r.depends_on_id ? authQueue.getRequest(r.depends_on_id) : null;
      return {
        ...r,
        depends_on_status: dep ? dep.status : null,
        action_count: authQueue.countActions(r.id),
        ...authAttributionReadFields(attributionResolver, r),
      };
    });
    res.json({ requests: enriched });
  }, { fileRpc: "allow" });

  app.get("/api/auth/history", (req, res) => {
    const query = req.query ?? {};
    // Bug: dd21c1e — optional ?type=X filter
    const typeFilter = typeof query.type === "string" && VALID_AUTH_REQUEST_TYPES.includes(query.type as AuthRequestType)
      ? (query.type as AuthRequestType)
      : undefined;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
    const limit =
      limitRaw != null && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 200)
        : 50;
    // Bug: 0de95bf — list projection omits diff/spec/output body blobs and
    // resolves action counts in one batched query; the detail route serves the
    // full body on selection.
    let requests = authQueue.listHistorySummaries(limit);
    if (typeFilter) {
      requests = requests.filter((r) => r.type === typeFilter);
    }
    // action_count is already resolved in one batched query by
    // listHistorySummaries (0de95bf); only fold in main's user-attribution fields.
    const attributionResolver = new AttributionReadResolver(getDb());
    res.json({
      requests: requests.map((r) => ({
        ...r,
        ...authAttributionReadFields(attributionResolver, r),
      })),
    });
  }, { fileRpc: "deny" });

  app.post("/api/auth/request/:id/approve", globalCapabilityRoute("approve_auth", (req, res) => {
    try {
      const identity = req.client_identity!;
      const request = authQueue.approve(req.params.id, undefined, identity.user_id);
      res.status(202).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { authenticated: true }), { fileRpc: "deny" });

  app.post("/api/auth/request/:id/reject", (req, res) => {
    try {
      const body = readBody<Record<string, unknown>>(req);
      const reason =
        typeof body.reason === "string" && body.reason.trim().length > 0
          ? body.reason
          : undefined;
      const request = authQueue.reject(req.params.id, reason);
      res.json({ request_id: request.id, status: request.status, error: request.error });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/request/:id/skip", (req, res) => {
    try {
      const request = authQueue.skip(req.params.id);
      res.json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/request/:id/retry", (req, res) => {
    try {
      const request = authQueue.retry(req.params.id);
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/request/:id/requeue", (req, res) => {
    try {
      const request = authQueue.requeue(req.params.id);
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/request/:id/dismiss", (req, res) => {
    try {
      const request = authQueue.dismiss(req.params.id);
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/request/:id/output", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.chunk !== "string") {
      res.status(400).json({ error: "Invalid output payload." });
      return;
    }
    try {
      authQueue.appendOutput(req.params.id, body.chunk);
      res.status(202).json({ request_id: req.params.id, ok: true });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/request/:id/result", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.exit_code !== "number" || typeof body.output !== "string") {
      res.status(400).json({ error: "Invalid result payload." });
      return;
    }
    const errorText = typeof body.error === "string" ? body.error : undefined;
    try {
      const request = authQueue.setResult(
        req.params.id,
        body.exit_code,
        body.output,
        errorText
      );
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.get("/api/auth/auto-approve", (_req, res) => {
    res.json(autoApproveManager.getStatus());
  }, { fileRpc: "deny" });

  app.post("/api/auth/auto-approve/setup", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    try {
      requireOperator(getDb(), req);
      const status = await autoApproveManager.setupDelegatedSigning({
        name: typeof body.name === "string" ? body.name : undefined,
        email: typeof body.email === "string" ? body.email : undefined,
        ageRecipient: typeof body.age_recipient === "string" ? body.age_recipient : undefined,
        overwrite: body.overwrite === true,
      });
      res.status(201).json(status);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/auto-approve/enable", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    const duration =
      typeof body.duration_minutes === "number" ? body.duration_minutes : undefined;
    try {
      requireOperator(getDb(), req);
      const status = await autoApproveManager.enable(duration);
      const approval = autoApproveManager.getActiveApprovalContext();
      const approved = approval ? authQueue.autoApprovePending(approval) : [];
      res.status(202).json({ ...status, approved_request_ids: approved.map((r) => r.id) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }, { fileRpc: "deny" });

  app.post("/api/auth/auto-approve/disable", (req, res) => {
    try {
      requireOperator(getDb(), req);
      res.json(autoApproveManager.disable());
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  app.delete("/api/auth/auto-approve/signing", async (req, res) => {
    try {
      requireOperator(getDb(), req);
      res.json(await autoApproveManager.removeDelegatedSigning());
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { fileRpc: "deny" });

  return authQueue;
}

function resolveAuthRequester(
  req: RequestLike,
  payload: AuthRequestInput,
): { ok: true; userId: string } | { ok: false; status: number; code: string; error: string } {
  const authenticatedUserId = req.client_identity?.user_id ?? null;
  const ambientIdentity = req.ambient_identity ?? null;
  const sessionResolution = payload.session_id
    ? ambientIdentity
      ? payload.session_id === ambientIdentity.provider_session_id
        ? resolveProviderSessionAttributionResult(getDb(), ambientIdentity.provider)
        : { status: "conflict" as const }
      : resolveSessionIdAttributionResult(getDb(), payload.session_id)
    : { status: "no_match" as const };
  if (sessionResolution.status === "conflict") {
    return {
      ok: false,
      status: 403,
      code: "requester_session_conflict",
      error: "Auth request session claims resolve to conflicting users.",
    };
  }
  const sessionAttribution = sessionResolution.status === "resolved"
    ? sessionResolution.attribution
    : null;
  if (
    authenticatedUserId &&
    sessionAttribution &&
    authenticatedUserId !== sessionAttribution.user_id
  ) {
    return {
      ok: false,
      status: 403,
      code: "requester_identity_mismatch",
      error: "Authenticated client and session binding resolve to different users.",
    };
  }
  const userId = authenticatedUserId ?? sessionAttribution?.user_id ?? null;
  if (!userId) {
    return {
      ok: false,
      status: 401,
      code: "requester_identity_required",
      error: "Auth request submission requires an authenticated client or an unambiguous session binding.",
    };
  }
  return { ok: true, userId };
}

// Bug: dd21c1e — valid auth request types for input validation
const VALID_AUTH_REQUEST_TYPES: AuthRequestType[] = [
  "merge", "commit", "force-push", "branch-delete", "config-change", "preset-promote", "data-delete"
];

function parseAuthRequestPayload(body: Record<string, unknown>): AuthRequestInput | null {
  if (typeof body.command !== "string" || typeof body.title !== "string") {
    return null;
  }

  // Bug: dd21c1e — parse type, default to 'merge'
  const type: AuthRequestType | undefined =
    typeof body.type === "string" && VALID_AUTH_REQUEST_TYPES.includes(body.type as AuthRequestType)
      ? (body.type as AuthRequestType)
      : undefined;

  const executionMode =
    body.execution_mode === "remote" || body.execution_mode === "daemon"
      ? body.execution_mode
      : undefined;

  const filesChanged =
    typeof body.files_changed === "number" && Number.isFinite(body.files_changed)
      ? body.files_changed
      : undefined;

  const additions =
    typeof body.additions === "number" && Number.isFinite(body.additions)
      ? body.additions
      : undefined;

  const deletions =
    typeof body.deletions === "number" && Number.isFinite(body.deletions)
      ? body.deletions
      : undefined;

  return {
    session_id: typeof body.session_id === "string" ? body.session_id : null,
    type,
    command: body.command,
    title: body.title,
    cwd: typeof body.cwd === "string" ? body.cwd : null,
    diff_summary: typeof body.diff_summary === "string" ? body.diff_summary : null,
    commit_message: typeof body.commit_message === "string" ? body.commit_message : null,
    spec_content: typeof body.spec_content === "string" ? body.spec_content : null,
    repo: typeof body.repo === "string" ? body.repo : undefined,
    base_branch: typeof body.base_branch === "string" ? body.base_branch : undefined,
    head_branch: typeof body.head_branch === "string" ? body.head_branch : undefined,
    merge_head_sha: typeof body.merge_head_sha === "string" ? body.merge_head_sha : null,
    files_changed: filesChanged,
    additions,
    deletions,
    post_merge_handoff: typeof body.post_merge_handoff === "string" ? body.post_merge_handoff : (body.post_merge_handoff === null ? null : undefined),
    issue_references: parseStringArray(body.issue_references),
    issue_closures: parseStringArray(body.issue_closures),
    issues: parseStringArray(body.issues),
    depends_on_id: typeof body.depends_on_id === "string" ? body.depends_on_id : (body.depends_on_id === null ? null : undefined),
    execution_mode: executionMode,
    // Bug: 4e32923 — accept scoping fields from the CLI; null/missing means
    // legacy behaviour (broadcast on resolution, no tier-1 ownership).
    target_session_id: typeof body.target_session_id === "string" ? body.target_session_id : null,
    target_repo_root: typeof body.target_repo_root === "string" ? body.target_repo_root : null,
    // Bug: 6d7411b — conversation_id for cross-resume matching
    conversation_id: typeof body.conversation_id === "string" ? body.conversation_id : null,
    actions: body.actions === undefined ? undefined : body.actions as AuthRequestInput["actions"]
  };
}

function parseAuthCheckPayload(body: Record<string, unknown>): AuthMergeCheckInput | null {
  return {
    repo: typeof body.repo === "string" ? body.repo : null,
    base_branch: typeof body.base_branch === "string" ? body.base_branch : null,
    head_branch: typeof body.head_branch === "string" ? body.head_branch : null,
    cwd: typeof body.cwd === "string" ? body.cwd : null,
    request_id: typeof body.request_id === "string" ? body.request_id : null,
  };
}

function resolveAuthCheckPayload(payload: AuthMergeCheckInput): AuthMergeCheckInput {
  const resolved = { ...payload };
  if (!resolved.cwd && resolved.repo) {
    resolved.cwd = registeredAuthCheckRepoRoot(resolved.repo);
  }
  if (resolved.cwd && !resolved.base_branch) {
    resolved.base_branch = detectProtectedBranch(resolved.cwd);
  }
  return resolved;
}

function registeredAuthCheckRepoRoot(repoRef: string): string | null {
  const normalizedRef = normalizeExistingPath(repoRef);
  try {
    const rows = getDb()
      .prepare(
        "SELECT id, root, name FROM work_repos WHERE dir_exists = 1 AND excluded = 0"
      )
      .all() as Array<{ id: string; root: string; name: string }>;
    for (const row of rows) {
      const normalizedRoot = normalizeExistingPath(row.root);
      if (!normalizedRoot) {
        continue;
      }
      if (
        row.id === repoRef ||
        row.name === repoRef ||
        row.root === repoRef ||
        normalizedRoot === normalizedRef ||
        path.basename(normalizedRoot) === repoRef
      ) {
        return normalizedRoot;
      }
    }
  } catch (error) {
    authRouteLog("error", "auth_check_repo_resolution_failed", {
      subsystem: "auth",
      repo_ref: repoRef,
      error: String(error),
    });
  }
  return null;
}

function detectProtectedBranch(cwd: string): string | null {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/develop"], {
      cwd,
      stdio: "ignore",
      timeout: 5000
    });
    return "develop";
  } catch {
    return "main";
  }
}

// Bug: 297677f — parse a string array field (for issues)
function parseStringArray(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.length > 0 ? value as string[] : null;
  }
  return undefined;
}

type ParseUpdateResult =
  | { ok: true; payload: Partial<AuthRequestInput> & { status?: "pending" } }
  | { ok: false; error: string };

// Bug: 58d93ee — return typed result instead of null so callers receive
// a descriptive error message rather than a generic 400
function parseAuthRequestUpdatePayload(
  body: Record<string, unknown>
): ParseUpdateResult {
  const payload: Partial<AuthRequestInput> & { status?: "pending" } = {};
  const hasKey = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

  if (hasKey("status")) {
    if (body.status !== "pending") {
      return { ok: false, error: "Invalid status — only 'pending' is accepted (use the retry flow to reset a failed request)" };
    }
    payload.status = "pending";
  }

  // Bug: dd21c1e — allow updating type
  if (hasKey("type")) {
    if (typeof body.type !== "string" || !VALID_AUTH_REQUEST_TYPES.includes(body.type as AuthRequestType)) {
      return { ok: false, error: `Invalid 'type' — must be one of: ${VALID_AUTH_REQUEST_TYPES.join(", ")}` };
    }
    payload.type = body.type as AuthRequestType;
  }

  if (hasKey("title")) {
    if (typeof body.title !== "string") {
      return { ok: false, error: "Invalid 'title' — must be a string" };
    }
    payload.title = body.title;
  }

  if (hasKey("command")) {
    // Bug: 58d93ee — explicit error when caller tries to set command to null
    if (body.command === null) {
      return { ok: false, error: "Invalid 'command' — cannot be set to null; provide a non-empty command string" };
    }
    if (typeof body.command !== "string") {
      return { ok: false, error: "Invalid 'command' — must be a string" };
    }
    payload.command = body.command;
  }

  if (hasKey("cwd")) {
    if (body.cwd === null || typeof body.cwd === "string") {
      payload.cwd = body.cwd as string | null;
    } else {
      return { ok: false, error: "Invalid 'cwd' — must be a string or null" };
    }
  }

  if (hasKey("diff_summary")) {
    if (body.diff_summary === null || typeof body.diff_summary === "string") {
      payload.diff_summary = body.diff_summary as string | null;
    } else {
      return { ok: false, error: "Invalid 'diff_summary' — must be a string or null" };
    }
  }

  if (hasKey("commit_message")) {
    if (body.commit_message === null || typeof body.commit_message === "string") {
      payload.commit_message = body.commit_message as string | null;
    } else {
      return { ok: false, error: "Invalid 'commit_message' — must be a string or null" };
    }
  }

  if (hasKey("spec_content")) {
    if (body.spec_content === null || typeof body.spec_content === "string") {
      payload.spec_content = body.spec_content as string | null;
    } else {
      return { ok: false, error: "Invalid 'spec_content' — must be a string or null" };
    }
  }

  if (hasKey("repo")) {
    if (typeof body.repo !== "string") {
      return { ok: false, error: "Invalid 'repo' — must be a string" };
    }
    payload.repo = body.repo;
  }

  if (hasKey("base_branch")) {
    if (typeof body.base_branch !== "string") {
      return { ok: false, error: "Invalid 'base_branch' — must be a string" };
    }
    payload.base_branch = body.base_branch;
  }

  if (hasKey("head_branch")) {
    if (typeof body.head_branch !== "string") {
      return { ok: false, error: "Invalid 'head_branch' — must be a string" };
    }
    payload.head_branch = body.head_branch;
  }

  if (hasKey("merge_head_sha")) {
    if (body.merge_head_sha === null || typeof body.merge_head_sha === "string") {
      payload.merge_head_sha = body.merge_head_sha as string | null;
    } else {
      return { ok: false, error: "Invalid 'merge_head_sha' — must be a string or null" };
    }
  }

  if (hasKey("files_changed")) {
    if (typeof body.files_changed !== "number" || !Number.isFinite(body.files_changed)) {
      return { ok: false, error: "Invalid 'files_changed' — must be a finite number" };
    }
    payload.files_changed = body.files_changed;
  }

  if (hasKey("additions")) {
    if (typeof body.additions !== "number" || !Number.isFinite(body.additions)) {
      return { ok: false, error: "Invalid 'additions' — must be a finite number" };
    }
    payload.additions = body.additions;
  }

  if (hasKey("deletions")) {
    if (typeof body.deletions !== "number" || !Number.isFinite(body.deletions)) {
      return { ok: false, error: "Invalid 'deletions' — must be a finite number" };
    }
    payload.deletions = body.deletions;
  }

  if (hasKey("post_merge_handoff")) {
    if (body.post_merge_handoff === null || typeof body.post_merge_handoff === "string") {
      payload.post_merge_handoff = body.post_merge_handoff as string | null;
    } else {
      return { ok: false, error: "Invalid 'post_merge_handoff' — must be a string or null" };
    }
  }

  if (hasKey("issue_references")) {
    const parsed = parseStringArray(body.issue_references);
    if (parsed === undefined) {
      return { ok: false, error: "Invalid 'issue_references' — must be an array of strings or null" };
    }
    payload.issue_references = parsed;
  }

  if (hasKey("issue_closures")) {
    const parsed = parseStringArray(body.issue_closures);
    if (parsed === undefined) {
      return { ok: false, error: "Invalid 'issue_closures' — must be an array of strings or null" };
    }
    payload.issue_closures = parsed;
  }

  // Bug: 297677f — legacy issues: array of issue IDs to close on merge
  if (hasKey("issues")) {
    const parsed = parseStringArray(body.issues);
    if (parsed === undefined) {
      return { ok: false, error: "Invalid 'issues' — must be an array of strings or null" };
    }
    payload.issues = parsed;
  }

  if (hasKey("depends_on_id")) {
    if (body.depends_on_id === null || typeof body.depends_on_id === "string") {
      payload.depends_on_id = body.depends_on_id as string | null;
    } else {
      return { ok: false, error: "Invalid 'depends_on_id' — must be a string or null" };
    }
  }

  return { ok: true, payload };
}

function isHttpError(error: unknown): error is { status: number; message: string } {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function handleQueueError(error: unknown, res: ResponseLike): void {
  if (error instanceof ClientAuthzError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof AuthActionValidationError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof AuthQueueError) {
    if (error.code === "not_found") {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error.code === "invalid_status") {
      res.status(409).json({ error: error.message, status: error.status });
      return;
    }
    // Bug: 58d93ee — surface invalid_command as 422 Unprocessable Entity so
    // callers (including the dashboard) receive the specific error message
    if (error.code === "invalid_command") {
      res.status(422).json({ error: error.message });
      return;
    }
    if (error.code === "merge_conflict") {
      res.status(409).json({ error: error.message, check: error.details });
      return;
    }
    if (error.code === "merge_check_failed") {
      res.status(422).json({ error: error.message, check: error.details });
      return;
    }
  }

  res.status(500).json({ error: "Unexpected auth queue error." });
}

// Bug: 929c6d0 — extract the last N lines from a string for error output summaries.
function tailLines(text: string, n: number): string | null {
  if (!text || !text.trim()) return null;
  const lines = text.split("\n");
  const tail = lines.slice(-n);
  const result = tail.join("\n").trim();
  return result || null;
}

const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

function validateAuthGateBranch(field: "base_branch" | "head_branch", value: string): string | null {
  if (
    !value ||
    !SAFE_BRANCH_NAME.test(value) ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".")
  ) {
    return `Invalid '${field}' for auth merge verification; manual review required.`;
  }
  return null;
}

function verifyMandibleIssueReferences(
  payload: AuthRequestInput
): string | null {
  const { cwd, head_branch, base_branch } = payload;
  if (!cwd || !head_branch || !base_branch) {
    return "Auth merge verification requires server-resolved cwd, base_branch, and head_branch; raw-route submissions must include target_repo_root or cwd.";
  }

  const baseError = validateAuthGateBranch("base_branch", base_branch);
  if (baseError) return baseError;
  const headError = validateAuthGateBranch("head_branch", head_branch);
  if (headError) return headError;

  const repoRoot = repoRootFromGitCommonDir(cwd);
  if (!repoRoot) {
    return "Invalid 'cwd' for auth merge verification; manual review required.";
  }

  try {
    const output = execFileSync(
      "git",
      ["log", "--no-merges", "--format=%H", `${base_branch}..${head_branch}`],
      { cwd, encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!output) {
      return null;
    }

    const commits = output.split("\n").filter(Boolean);
    const missing: string[] = [];

    for (const sha of commits) {
      if (!FULL_GIT_SHA.test(sha)) {
        return "Auth merge verification returned an invalid commit id; manual review required.";
      }

      const body = execFileSync("git", ["log", "-1", "--format=%B", sha], {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!body.split("\n").some((line: string) => line.startsWith("Mandible-Issue:"))) {
        const oneline = execFileSync("git", ["log", "-1", "--oneline", sha], {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        missing.push(oneline);
      }
    }

    if (missing.length > 0) {
      return (
        `${missing.length} commit(s) missing Mandible-Issue references:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        "\n\nUse Mandible-Issue: <issue-ref> trailers for work-tracking commits."
      );
    }

    return null;
  } catch (err) {
    authRouteLog("error", "auth_issue_reference_verification_failed", {
      subsystem: "auth",
      error: String(err),
    });
    return "Mandible issue reference verification failed; manual review required.";
  }
}
