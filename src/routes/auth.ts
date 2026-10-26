import type { LedgerReader } from "../ledger-reads/index.js";
import { parseProtectedRootDirtyAction } from "../auth-protected-root-dirty-action.js";
import { AUTH_REQUEST_TYPES } from "../contracts.js";
import { AuthQueue, AuthQueueError, publicationBlockerFor } from "../auth-queue.js";
import { AuthActionValidationError } from "../auth-actions.js";
import { listAuthExecutionAttempts } from "../auth-lifecycle.js";
import { mergeChangeMessageRequirement, authDescriptionRequirement } from "../auth-change-message.js";
import { AuthAutoApproveManager } from "../auth-auto-approve.js";
import { AuthClearanceError, AuthClearanceManager } from "../auth-clearance.js";
import { DelegatedSigningResource } from "../delegated-signing-resource.js";
import {
  computeAuthMergeReviewMetadata,
  describeGitFailure,
  isAuthMergeCommand,
  normalizeExistingPath,
  normalizeLegacySingleSourceMergeCommand,
  probeRepoRootFromGitCommonDir,
  resolveAuthMergeExecutionContext,
} from "../auth-context.js";
import { getDaemonLogger } from "../daemon-log.js";
import type { Db } from "../db.js";
import { resolveId } from "../entity-refs.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type { AuthMergeCheckInput } from "../auth-queue.js";
import type { AuthLifecycleActor, AuthRequest, AuthRequestInput, AuthRequestType } from "../types.js";
import { resolveProviderSessionAttributionResult, resolveSessionIdAttributionResult } from "../identity/resolver.js";
import {
  AttributionReadResolver,
  authAttributionReadFields,
} from "../identity/read-projection.js";
import { ClientAuthzError, requireProtectedOperator as requireOperator } from "../client-auth/authz.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readBody } from "./http.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import { PermissionError, requireProjectAccess } from "../permissions/store.js";
import {
  isPersistentIabPreviewBranch,
  PERSISTENT_IAB_PREVIEW_DELIVERY_ERROR,
} from "../auth-preview-policy.js";

const authRouteLog = getDaemonLogger();

function rejectTokenlessSocketExecution(req: RequestLike, res: ResponseLike): boolean {
  if (req.client_identity?.method !== "local_socket") return false;
  res.status(401).json({
    error: "Auth execution updates require an authenticated durable client credential.",
    code: "durable_credential_required",
  });
  return true;
}

/**
 * Every handler reads and writes the queue's database. Registration never
 * resolves the process-wide singleton, so routes bound to an explicit database
 * cannot reach another one (issue e9cd064).
 */
export function registerAuthRoutes(
  app: RouteRegistrar,
  authQueue: AuthQueue,
  autoApproveManager: AuthAutoApproveManager,
  clearance: AuthClearanceManager | undefined,
  reader: LedgerReader,
): AuthQueue {
  const db = authQueue.db;
  const fallbackRuntimeEpoch = randomUUID();
  const clearanceManager = clearance ?? new AuthClearanceManager(
    db, new DelegatedSigningResource(autoApproveManager, {
      db, runtimeEpoch: fallbackRuntimeEpoch,
    }), fallbackRuntimeEpoch,
  );
  app.post("/api/auth/check", async (req, res) => {
    if (!authQueue.externalEffectsAllowed) {
      res.status(403).json({
        error: "Git merge preflight is unavailable in a copied auth preview.",
        code: "auth_preview_external_effect_forbidden",
      });
      return;
    }
    const payload = parseAuthCheckPayload(readBody<Record<string, unknown>>(req));
    if (!payload) {
      res.status(400).json({ error: "Invalid auth check payload." });
      return;
    }
    const report = (await authQueue.checkMergeIndependence(resolveAuthCheckPayload(db, payload)));
    res.status(200).json({ check: report });
  }, { operation: { id: "post:/api/auth/check", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/auth/request", async (req, res) => {
    if (rejectTokenlessSocketExecution(req, res)) return;
    const body = readBody<Record<string, unknown>>(req);
    if (Object.hasOwn(body, "spec_content")) {
      res.status(400).json({ error: SPEC_CONTENT_REFUSAL });
      return;
    }
    const dirtyAction = parseProtectedRootDirtyAction(body.protected_root_dirty_action);
    if (!dirtyAction.ok) {
      res.status(400).json({ error: dirtyAction.error });
      return;
    }
    const payload = parseAuthRequestPayload(body);
    if (!payload) {
      res.status(400).json({ error: "Invalid auth request payload." });
      return;
    }
    const descriptionError = authDescriptionRequirement(payload);
    if (descriptionError) {
      res.status(400).json({ error: descriptionError, code: (payload.type ?? "merge") === "merge" ? "change_message_required" : "description_required" });
      return;
    }
    if (payload.type === "custody-transfer") {
      res.status(400).json({ error: CUSTODY_TRANSFER_SUBMISSION_REFUSAL });
      return;
    }
    if (dirtyAction.action && (payload.type ?? "merge") !== "merge") {
      res.status(400).json({ error: "'protected_root_dirty_action' applies only to merge requests." });
      return;
    }
    payload.protected_root_dirty_action = dirtyAction.action;
    const isAuthMerge = isAuthMergeCommand(payload);
    if (isAuthMerge && !authQueue.externalEffectsAllowed) {
      res.status(403).json({
        error: "Merge request preparation is unavailable in a copied auth preview.",
        code: "auth_preview_external_effect_forbidden",
      });
      return;
    }
    const requester = resolveAuthRequester(db, req, payload, isAuthMerge);
    if (!requester.ok) {
      res.status(requester.status).json({ error: requester.error, code: requester.code });
      return;
    }

    if (isAuthMerge) {
      // Issue 4720024 — creation and atomic supersession of a merge request
      // both arrive here, before any Git work, and neither proceeds without a
      // canonical change message and its verification text.
      const missingMessage = mergeChangeMessageRequirement(payload);
      if (missingMessage) {
        res.status(400).json({ error: missingMessage, code: "change_message_required" });
        return;
      }
      try {
        // Issue 08a5f04 — legacy submitters (MCP channel server, raw API
        // clients) omit base_branch entirely; `mandible auth merge <branch>`
        // has always meant "into the detected protected branch". Resolve that
        // default here so execution-context resolution (which validates the
        // base as protected, existing, and behind the head) can run. All
        // fail-closed validation below applies to the defaulted value.
        if (!payload.base_branch && payload.cwd) {
          payload.base_branch = detectProtectedBranch(payload.cwd) ?? undefined;
        }
        const resolved = (await resolveAuthMergeExecutionContext(db, payload));
        payload.cwd = resolved.executionCwd;
        payload.target_repo_root = resolved.targetRepoRoot;
        payload.repo = payload.repo ?? resolved.repoName ?? path.basename(resolved.targetRepoRoot);
        payload.base_branch = resolved.baseBranch;
        payload.head_branch = resolved.headBranch;
        if (isPersistentIabPreviewBranch(resolved.headBranch)) {
          res.status(400).json({
            error: PERSISTENT_IAB_PREVIEW_DELIVERY_ERROR,
            code: "persistent_iab_preview_delivery_forbidden",
          });
          return;
        }
        payload.merge_head_sha = resolved.headSha;
        // Issue 08a5f04 — submission-time (never approval-time) normalization
        // of the legacy single-source command shape: the reviewed row must
        // already carry the canonical `mandible auth merge <head> --into
        // <base>` bytes that approve-time canonical enforcement accepts.
        // Non-matching shapes are stored as-is and refused at approval.
        const normalizedCommand = normalizeLegacySingleSourceMergeCommand(
          payload.command,
          resolved.headBranch,
          resolved.baseBranch,
        );
        if (normalizedCommand) {
          payload.command = normalizedCommand;
        }
        // Issue 7d64d8f — review metadata no longer includes a synthesized
        // commit message. A request either carries an agent-authored canonical
        // change message or carries none, in which case the merge keeps git's
        // own `fmt-merge-msg` default.
        const metadata = await computeAuthMergeReviewMetadata(
          resolved.targetRepoRoot,
          resolved.baseSha,
          resolved.headSha,
          {
            counts: true,
            diffSummary: true,
          }
        );
        if (!metadata.changeReport) {
          throw new Error("Auth change report collection returned no report.");
        }
        payload.change_report = metadata.changeReport;
        payload.files_changed = metadata.changeReport.totals.files;
        payload.additions = metadata.changeReport.totals.additions;
        payload.deletions = metadata.changeReport.totals.deletions;
        payload.diff_summary = metadata.diffSummary;
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "Invalid auth merge execution context."
        });
        return;
      }
    }

    // Issue 2205073 — this call site is deliberately best effort: it only
    // enriches optional metadata (target_repo_root backfill and the repo-name
    // fallback below) and never refuses work on the answer, so a failed probe
    // degrades to "no enrichment" rather than to a false claim about the cwd.
    // The failure is still logged with its kind, so a request that arrived
    // without a target_repo_root can be explained after the fact instead of
    // looking like the submitter simply omitted it.
    const cwdRootProbe = authQueue.externalEffectsAllowed && payload.cwd
      ? (await probeRepoRootFromGitCommonDir(payload.cwd))
      : null;
    if (cwdRootProbe?.failure && cwdRootProbe.failure.kind !== "exit") {
      authRouteLog("warn", "auth_cwd_repo_root_probe_failed", {
        subsystem: "auth",
        cwd: payload.cwd,
        failure_kind: cwdRootProbe.failure.kind,
        detail: describeGitFailure(cwdRootProbe.failure, "submission"),
      });
    }
    const cwdRepoRoot = cwdRootProbe?.root ?? null;
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
    if (isAuthMerge && !enforceAuthProjectWrite(db, req, res, payload.repo)) return;

    // Bug: 16985e8 — detect duplicate submissions. Return 409 with the existing
    // request_id so the agent can PUT to update it rather than creating a new one.
    //
    // Issue 608d1db — the 409 also carries the *stored* request's own identity
    // under `existing`. The refusal previously returned only an id, leaving the
    // CLI nothing to print but the caller's own arguments; a submitter then saw
    // its own title beside a foreign request's id and read the refusal as a
    // success. Reporting the stored title/repo/branches makes the mismatch that
    // caused the refusal visible at the point of refusal.
    try {
      const duplicate = payload.supersedes_request_id ? null : await authQueue.findDuplicate(payload);
      if (duplicate) {
        res.status(409).json({
          error:
            "Duplicate auth request — this repo already has a pending or approved request " +
            "for this branch. Nothing was queued.",
          request_id: duplicate.id,
          status: duplicate.status,
          existing: {
            id: duplicate.id,
            status: duplicate.status,
            title: duplicate.title,
            repo: duplicate.repo ?? null,
            head_branch: duplicate.head_branch ?? null,
            base_branch: duplicate.base_branch ?? null,
            created_at: duplicate.created_at,
          },
        });
        return;
      }

      payload.requester_evidence_method = requester.evidenceMethod;
      payload.requester_credential_id = requester.credentialId;
      payload.require_delivery_custody = isAuthMerge;
      const request = (await authQueue.submit(payload, requester.userId));
      res.status(201).json({
        request_id: request.id,
        files_changed: request.files_changed,
        additions: request.additions,
        deletions: request.deletions,
        publication_blocker: await authQueue.publicationBlockerForRequest(request),
      });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.get("/api/auth/request/:id", async (req, res) => {
    // Issue f59b5bd — getRequest already resolves unambiguous short prefixes
    // (Bug: caa157e), so short-form deep links land here directly.
    const request = (await authQueue.getRequest(req.params.id));
    if (!request) {
      // Bug: caa157e — distinguish ambiguous prefix from not-found
      const resolved = resolveId(db, "auth_request", req.params.id);
      if (!resolved.ok && resolved.error === "ambiguous") {
        res.status(409).json({
          error: `Ambiguous prefix '${req.params.id}' names more than one request (${resolved.matches.join(", ")}); pass a longer prefix.`
        });
        return;
      }
      res.status(404).json({ error: "Auth request not found." });
      return;
    }

    // Bug: 929c6d0 — include error_output: tail of executor output for failed requests
    const errorOutput = (request.status === "failed" && request.output)
      ? tailLines(request.output, 20)
      : null;

    // Issue f59b5bd (review R3) — serve the canonical full request record
    // (same projection the queue list spreads) instead of a hand-maintained
    // field allowlist that silently dropped session_id and every future
    // column. Computed fields ride on top of the spread.
    res.json({
      ...request,
      request_id: request.id,
      files_changed: request.files_changed ?? 0,
      additions: request.additions ?? 0,
      deletions: request.deletions ?? 0,
      dependency: authQueue.dependencyForRequest(request),
      error_output: errorOutput,
      signature_verification: authQueue.getSignatureVerification(request.id),
      // Issue 27241e6 — merged/convergence-complete vs pending vs failed.
      convergence: authQueue.convergenceForRequest(request.id),
      // Issue 7d83fe5 — runtime self-update acceptance of the current candidate.
      candidate_acceptance: authQueue.candidateAcceptanceForRequest(request),
      publication_blocker: await authQueue.publicationBlockerForRequest(request),
      // Issue 117ba80 — protected-base commits that are neither Mandible merges nor operator-signed.
      base_audit: authQueue.baseAuditForRequest(request.id),
      ...authAttributionReadFields(new AttributionReadResolver(db), request),
      action_count: authQueue.countActions(request.id),
      actions: authQueue.listActions(request.id),
      lifecycle_events: authQueue.listLifecycleEvents(request.id),
      execution_attempts: listAuthExecutionAttempts(db, request.id),
    });
  }, { operation: { id: "get:/api/auth/request/:id", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/auth/request/:id/actions", (req, res) => {
    try {
      res.json({ actions: authQueue.listActions(req.params.id) });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "get:/api/auth/request/:id/actions", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/auth/request/:id/actions", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    try {
      const current = (await authQueue.getRequest(req.params.id));
      if (!current) { res.status(404).json({ error: "Auth request not found." }); return; }
      const control = authMutationControl(db, req, res, current, body);
      if (!control) return;
      const action = authQueue.addAction(req.params.id, authActionPayload(body), control.actor,
        numberField(body.expected_revision), numberField(body.expected_custody_generation));
      res.status(201).json({ action });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/actions", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.put("/api/auth/request/:id/actions/:actionId", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    try {
      const current = (await authQueue.getRequest(req.params.id));
      if (!current) { res.status(404).json({ error: "Auth request not found." }); return; }
      const control = authMutationControl(db, req, res, current, body);
      if (!control) return;
      const action = authQueue.updateAction(
        req.params.id,
        req.params.actionId,
        authActionPayload(body),
        control.actor,
        numberField(body.expected_revision),
        numberField(body.expected_custody_generation),
      );
      res.status(200).json({ action });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "put:/api/auth/request/:id/actions/:actionId", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.delete("/api/auth/request/:id/actions/:actionId", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    try {
      const current = (await authQueue.getRequest(req.params.id));
      if (!current) { res.status(404).json({ error: "Auth request not found." }); return; }
      const control = authMutationControl(db, req, res, current, body);
      if (!control) return;
      const action = authQueue.deleteAction(req.params.id, req.params.actionId, control.actor,
        numberField(body.expected_revision), numberField(body.expected_custody_generation));
      res.status(200).json({ action_id: action.id, deleted: true });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "delete:/api/auth/request/:id/actions/:actionId", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.post("/api/auth/request/:id/actions/:actionId/veto", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.vetoed !== "boolean") {
      res.status(400).json({ error: "vetoed boolean is required" });
      return;
    }
    try {
      const current = (await authQueue.getRequest(req.params.id));
      if (!current) { res.status(404).json({ error: "Auth request not found." }); return; }
      const control = authMutationControl(db, req, res, current, body);
      if (!control) return;
      const action = authQueue.setActionVeto(req.params.id, req.params.actionId, body.vetoed,
        control.actor, numberField(body.expected_revision), numberField(body.expected_custody_generation));
      res.status(200).json({ action });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/actions/:actionId/veto", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.put("/api/auth/request/:id", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    const result = parseAuthRequestUpdatePayload(body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    try {
      const current = (await authQueue.getRequest(req.params.id));
      if (!current) {
        const resolved = resolveId(db, "auth_request", req.params.id);
        if (!resolved.ok && resolved.error === "ambiguous") {
          res.status(409).json({
            error: `Ambiguous prefix '${req.params.id}' names more than one request (${resolved.matches.join(", ")}); pass a longer prefix.`,
          });
          return;
        }
        res.status(404).json({ error: "Auth request not found." });
        return;
      }
      if (current.type === "custody-transfer" || result.payload.type === "custody-transfer") {
        res.status(400).json({ error: CUSTODY_TRANSFER_SUBMISSION_REFUSAL });
        return;
      }
      const control = authMutationControl(db, req, res, current, body, true);
      if (!control) return;
      // Issue 4720024 — a revision that touches a merge request's message must
      // leave a canonical change message with its verification text. Requests
      // submitted before the rule keep every other revision path.
      const touchesMessage = result.payload.commit_message !== undefined || result.payload.canonical_message !== undefined;
      if (touchesMessage && isAuthMergeCommand({ command: result.payload.command ?? current.command })) {
        const missingMessage = mergeChangeMessageRequirement({
          canonical_message: result.payload.canonical_message ?? current.commit_message_digest != null,
          commit_message: result.payload.commit_message !== undefined ? result.payload.commit_message : current.commit_message,
          verification: result.payload.verification,
        });
        if (missingMessage) {
          res.status(400).json({ error: missingMessage, code: "change_message_required" });
          return;
        }
      }
      const updated = (await authQueue.update(req.params.id, result.payload, control.actor,
        numberField(body.expected_revision), numberField(body.expected_custody_generation)));
      res.status(200).json({ request_id: updated.id, ...updated });
    } catch (error) {
      if (isHttpError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      handleQueueError(error, res);
    }
  }, { operation: { id: "put:/api/auth/request/:id", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.delete("/api/auth/request/:id", (_req, res) => {
    res.status(410).json({
      code: "auth_request_delete_removed",
      error: "Auth requests are immutable records. Pending requesters must use withdrawal.",
    });
  }, { operation: { id: "delete:/api/auth/request/:id", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/withdraw", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.reason !== "string" || !body.reason.trim()) {
      res.status(400).json({ error: "reason is required" });
      return;
    }
    const requester = resolveAuthRequester(db, req, { command: "withdraw", title: "withdraw" }, true);
    if (!requester.ok) {
      res.status(requester.status).json({ error: requester.error, code: requester.code });
      return;
    }
    try {
      const recovery = body.operator_recovery === true;
      if (recovery) requireOperator(db, req);
      const current = (await authQueue.getRequest(req.params.id));
      if (!current) {
        res.status(404).json({ error: "Auth request not found." });
        return;
      }
      if (!enforceAuthProjectWrite(db, req, res, current.repo)) return;
      const request = (await authQueue.withdraw(req.params.id, body.reason, {
        user_id: requester.userId,
        evidence_method: requester.evidenceMethod,
        credential_id: requester.credentialId,
        authority_path: recovery ? "operator_recovery" : "custodian",
      }, numberField(body.expected_revision), numberField(body.expected_custody_generation)));
      res.json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/withdraw", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.post("/api/auth/request/:id/candidate-snapshot-repair/inspect", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    try {
      const request = authQueue.getRequestReference(req.params.id);
      if (!request) throw new AuthQueueError("not_found", "Auth request not found.");
      const control = authMutationControl(db, req, res, request, body, true);
      if (!control?.actor) return;
      res.json((await authQueue.inspectPendingCandidateSnapshotRepair(request.id, control.actor)));
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/candidate-snapshot-repair/inspect", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.post("/api/auth/request/:id/candidate-snapshot-repair/apply", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    try {
      const request = authQueue.getRequestReference(req.params.id);
      if (!request) throw new AuthQueueError("not_found", "Auth request not found.");
      const control = authMutationControl(db, req, res, request, body, true);
      if (!control?.actor) return;
      const expectedDigest = body.expected_current_snapshot_sha256;
      if (typeof expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
        res.status(400).json({ error: "expected_current_snapshot_sha256 is required." });
        return;
      }
      const repaired = await authQueue.repairPendingCandidateSnapshot(
        request.id, control.actor, numberField(body.expected_revision) ?? NaN,
        numberField(body.expected_custody_generation) ?? NaN, expectedDigest,
      );
      res.json({ request_id: repaired.id, lifecycle: authQueue.listLifecycleEvents(repaired.id).at(-1) });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/candidate-snapshot-repair/apply", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  // Issue 27241e6 — convergence retry. This reruns the snapshotted hook
  // command for a merged request; it never reruns the merge, which is why it
  // does not need (and must not imply) a fresh merge authorization.
  app.post("/api/auth/request/:id/retry-convergence", async (req, res) => {
    try {
      if (rejectTokenlessSocketExecution(req, res)) return;
      const body = readBody<Record<string, unknown>>(req);
      const hookId = typeof body.hook_id === "string" && body.hook_id.trim()
        ? body.hook_id.trim()
        : undefined;
      if (body.mode !== undefined && body.mode !== 'retry' && body.mode !== 'verify-current') { res.status(400).json({ error: 'Unknown convergence mode.' }); return; }
      const request = authQueue.getRequestReference(req.params.id);
      if (!request) { res.status(404).json({ error: 'Auth request not found.' }); return; }
      const control = body.mode === 'verify-current' ? authMutationControl(db, req, res, request, body, true) : null;
      if (body.mode === 'verify-current' && !control?.actor) return;
      const convergence = await authQueue.retryHookConvergence(req.params.id, hookId,
        body.mode === 'verify-current' ? { mode: 'verify-current', actor: control!.actor! } : undefined);
      res.status(200).json({ request_id: req.params.id, convergence });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/retry-convergence", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  // Issue a09b4d2 — daemon-run candidate acceptance of the exact retained
  // candidate. Approval of a runtime self-update requires a passing record.
  app.post("/api/auth/request/:id/candidate-acceptance", async (req, res) => {
    try {
      const request = authQueue.getRequestReference(req.params.id);
      if (!request) { res.status(404).json({ error: "Auth request not found." }); return; }
      const requester = resolveAuthRequester(db, req, { command: "candidate-acceptance", title: "candidate-acceptance" });
      if (!requester.ok) { res.status(requester.status).json({ error: requester.error, code: requester.code }); return; }
      if (!enforceAuthProjectWrite(db, req, res, request.repo)) return;
      res.status(202).json({ request_id: request.id, acceptance: await authQueue.runCandidateAcceptance(request) });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/candidate-acceptance", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.get("/api/auth/request/:id/candidate-acceptance", (req, res) => {
    try {
      const request = authQueue.getRequestReference(req.params.id);
      if (!request) { res.status(404).json({ error: "Auth request not found." }); return; }
      res.json({ request_id: request.id, acceptance: authQueue.candidateAcceptanceForRequest(request) });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "get:/api/auth/request/:id/candidate-acceptance", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Issue a09b4d2 — the installation runtime handoff lock, and operator
  // retirement of a failed one. Retirement preserves the journal as evidence.
  app.get("/api/runtime-handoff/lock", (_req, res) => {
    res.json({ lock: authQueue.runtimeHandoffLock() });
  }, { operation: { id: "get:/api/runtime-handoff/lock", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.post("/api/runtime-handoff/retire", async (req, res) => {
    try {
      const operator = requireOperator(db, req);
      const body = readBody<Record<string, unknown>>(req);
      if (typeof body.binding_digest !== "string" || typeof body.reason !== "string" || !body.reason.trim()) {
        res.status(400).json({ error: "binding_digest and reason are required." });
        return;
      }
      const retirement = await authQueue.retireRuntimeHandoff({ bindingDigest: body.binding_digest, reason: body.reason }, {
        user_id: operator.user_id, evidence_method: operator.method, credential_id: operator.credential_id ?? null, authority_path: "operator_recovery",
      });
      res.json({ retirement });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/runtime-handoff/retire", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/replay-codex-archives", async (req, res) => {
    try {
      if (rejectTokenlessSocketExecution(req, res)) return;
      // Issue 75f52ac — archiving is now async (off-loop codex CLI spawn).
      const result = await authQueue.replayCodexThreadArchives(req.params.id);
      res.status(200).json(result);
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/replay-codex-archives", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "allow" });

  app.get("/api/auth/queue", async (req, res) => {
    const query = req.query ?? {};
    // Bug: dd21c1e — optional ?type=X filter
    const typeFilter = typeof query.type === "string" && AUTH_REQUEST_TYPES.includes(query.type as AuthRequestType)
      ? (query.type as AuthRequestType)
      : undefined;
    let requests = (await authQueue.listActive());
    if (typeFilter) {
      requests = requests.filter((r) => r.type === typeFilter);
    }
    const attributionResolver = new AttributionReadResolver(db);
    const publicationBlockers = await authQueue.publicationBlockersForRequests(requests);
    const enriched = requests.map((r) => {
      return {
        ...r,
        dependency: authQueue.dependencyForRequest(r),
        action_count: authQueue.countActions(r.id),
        // Issue 27241e6 — the queue row shows merged vs live, not just merged.
        convergence: authQueue.convergenceForRequest(r.id),
        candidate_acceptance: authQueue.candidateAcceptanceForRequest(r),
        publication_blocker: publicationBlockers.get(r.id) ?? null,
        base_audit: authQueue.baseAuditForRequest(r.id),
        execution_attempts: listAuthExecutionAttempts(db, r.id),
        ...authAttributionReadFields(attributionResolver, r),
      };
    });
    res.json({ requests: enriched });
  }, { operation: { id: "get:/api/auth/queue", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  app.get("/api/auth/history", async (req, res) => {
    const query = req.query ?? {};
    // Bug: dd21c1e — optional ?type=X filter
    const typeFilter = typeof query.type === "string" && AUTH_REQUEST_TYPES.includes(query.type as AuthRequestType)
      ? (query.type as AuthRequestType)
      : undefined;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
    const limit =
      limitRaw != null && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 200)
        : 50;
    const rows = await reader.run("auth_history", { limit, type: typeFilter });
    const inspectOwnership = rows.some(row => row.selfUpdates && row.acceptance.applies);
    const blocker = rows.some(row => row.selfUpdates) ? await authQueue.publicationObservation(inspectOwnership) : null;
    res.json({
      requests: rows.map(({ request, selfUpdates, acceptance }) => ({
        ...request,
        publication_blocker: publicationBlockerFor({ selfUpdates, changesBuildInputs: acceptance.applies }, blocker),
        candidate_acceptance: authQueue.candidateAcceptanceForRequest(request, acceptance),
      })),
    });
  }, { operation: { id: "get:/api/auth/history", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/approve", globalCapabilityRoute("approve_auth", async (req, res) => {
    try {
      const identity = req.client_identity!;
      const request = await authQueue.approveWithOperatorProof(req.params.id, identity.user_id);
      res.status(202).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { authenticated: true }), { operation: { id: "post:/api/auth/request/:id/approve", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/cancel-proof", globalCapabilityRoute("approve_auth", (req, res) => {
    try {
      authQueue.cancelOperatorProof(req.params.id, req.client_identity!.user_id);
      res.status(200).json({ cancelled: true });
    } catch (error) { handleQueueError(error, res); }
  }, { authenticated: true }), { operation: { id: "post:/api/auth/request/:id/cancel-proof", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/reject", globalCapabilityRoute("approve_auth", async (req, res) => {
    try {
      const body = readBody<Record<string, unknown>>(req);
      const reason =
        typeof body.reason === "string" && body.reason.trim().length > 0
          ? body.reason
          : undefined;
      const identity = req.client_identity!;
      const request = (await authQueue.reject(req.params.id, reason, {
        user_id: identity.user_id,
        evidence_method: identity.method,
        credential_id: identity.credential_id,
      }));
      res.json({ request_id: request.id, status: request.status, error: request.error });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { authenticated: true }), { operation: { id: "post:/api/auth/request/:id/reject", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/skip", async (req, res) => {
    try {
      if (rejectTokenlessSocketExecution(req, res)) return;
      const request = (await authQueue.skip(req.params.id));
      res.json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/skip", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/retry", async (req, res) => {
    try {
      if (rejectTokenlessSocketExecution(req, res)) return;
      const request = (await authQueue.retry(req.params.id));
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/retry", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/requeue", async (req, res) => {
    try {
      if (rejectTokenlessSocketExecution(req, res)) return;
      const request = (await authQueue.requeue(req.params.id));
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/requeue", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/dismiss", (_req, res) => {
    res.status(410).json({
      code: "auth_request_dismiss_removed",
      error: "Dismiss is not an auth lifecycle outcome. Pending requesters may withdraw; operators may reject.",
    });
  }, { operation: { id: "post:/api/auth/request/:id/dismiss", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/output", async (req, res) => {
    if (rejectTokenlessSocketExecution(req, res)) return;
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.chunk !== "string") {
      res.status(400).json({ error: "Invalid output payload." });
      return;
    }
    try {
      // Issue 22ace1c — report the canonical id the append landed on.
      const appended = (await authQueue.appendOutput(req.params.id, body.chunk));
      res.status(202).json({ request_id: appended.id, ok: true });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/output", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/result", async (req, res) => {
    if (rejectTokenlessSocketExecution(req, res)) return;
    const body = readBody<Record<string, unknown>>(req);
    if (typeof body.exit_code !== "number" || typeof body.output !== "string") {
      res.status(400).json({ error: "Invalid result payload." });
      return;
    }
    const errorText = typeof body.error === "string" ? body.error : undefined;
    try {
      const request = (await authQueue.setResult(
        req.params.id,
        body.exit_code,
        body.output,
        errorText
      ));
      res.status(200).json({ request_id: request.id, status: request.status });
    } catch (error) {
      handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/result", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.get("/api/auth/clearances", (req, res) => {
    try {
      requireOperator(db, req);
      const requestId = typeof req.query.request_id === "string" ? req.query.request_id : null;
      res.json({ clearances: clearanceManager.list(requestId) });
    } catch (error) {
      handleClearanceError(error, res);
    }
  }, { operation: { id: "get:/api/auth/clearances", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "deny",
    refs: { query: { request_id: (ref) => resolveId(db, "auth_request", ref) } } });

  // Keep this static path ahead of /:id so "signing" is never interpreted as
  // a clearance reference by order-sensitive HTTP routers.
  app.get("/api/auth/clearances/signing", (req, res) => {
    try {
      requireOperator(db, req);
      res.json(clearanceManager.signingStatus());
    } catch (error) {
      handleClearanceError(error, res);
    }
  }, { operation: { id: "get:/api/auth/clearances/signing", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.get("/api/auth/clearances/:id", (req, res) => {
    try {
      requireOperator(db, req);
      const clearance = clearanceManager.show(req.params.id);
      res.json({ clearance, uses: clearanceManager.uses(clearance.id) });
    } catch (error) {
      handleClearanceError(error, res);
    }
  }, { operation: { id: "get:/api/auth/clearances/:id", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  app.post("/api/auth/clearances", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    try {
      if (body.action !== undefined && body.action !== "merge") {
        throw new AuthClearanceError("unsupported_action", "Clearance action is fixed to merge.");
      }
      const operator = requireOperator(db, req);
      const clearance = await clearanceManager.issue({
        requestId: typeof body.request_id === "string" ? body.request_id : null,
        grantee: String(body.grantee ?? ""),
        granteeCredentialId: typeof body.grantee_credential_id === "string" ? body.grantee_credential_id : null,
        project: typeof body.project === "string" ? body.project : null,
        baseBranch: typeof body.base === "string" ? body.base : null,
        issueRef: typeof body.issue === "string" ? body.issue : null,
        headBranch: typeof body.head === "string" ? body.head : null,
        action: "merge",
        durationMinutes: typeof body.duration_minutes === "number" ? body.duration_minutes : undefined,
        maxUses: typeof body.max_uses === "number" ? body.max_uses : undefined,
      }, operator.user_id);
      res.status(201).json({ clearance });
    } catch (error) {
      handleClearanceError(error, res);
    }
  }, { operation: { id: "post:/api/auth/clearances", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/clearances/:id/revoke", async (req, res) => {
    try {
      const operator = requireOperator(db, req);
      res.json({ clearance: await clearanceManager.revoke(req.params.id, operator.user_id) });
    } catch (error) {
      handleClearanceError(error, res);
    }
  }, { operation: { id: "post:/api/auth/clearances/:id/revoke", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/request/:id/clearance/execute", async (req, res) => {
    try {
      const identity = req.client_identity;
      const request = (await authQueue.getRequest(req.params.id));
      const custody = request?.custody_work_unit_id
        ? db.prepare(`
            SELECT wu.owner_user_id, wu.owner_credential_id, uc.status AS credential_status
            FROM work_units wu
            LEFT JOIN user_credentials uc ON uc.id = wu.owner_credential_id
            WHERE wu.id = ? AND wu.auth_request_id = ?
          `).get(request.custody_work_unit_id, request.id) as {
            owner_user_id: string | null;
            owner_credential_id: string | null;
            credential_status: string | null;
          } | undefined
        : undefined;
      if (!identity || identity.method !== "api_token" || !identity.credential_id || !request
          || custody?.owner_user_id !== identity.user_id
          || custody.owner_credential_id !== identity.credential_id
          || custody.credential_status !== "active") {
        res.status(403).json({ error: "Verified delivery-work-unit custodian does not match this auth request." });
        return;
      }
      const executing = (await authQueue.approveWithClearance(request.id));
      res.status(202).json({ request_id: executing.id, status: executing.status, clearance_use_id: executing.clearance_use_id });
    } catch (error) {
      if (error instanceof AuthClearanceError) handleClearanceError(error, res);
      else handleQueueError(error, res);
    }
  }, { operation: { id: "post:/api/auth/request/:id/clearance/execute", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.post("/api/auth/clearances/signing/setup", async (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    try {
      requireOperator(db, req);
      const status = await clearanceManager.setupSigning({
        name: typeof body.name === "string" ? body.name : undefined,
        email: typeof body.email === "string" ? body.email : undefined,
        ageRecipient: typeof body.age_recipient === "string" ? body.age_recipient : undefined,
        overwrite: body.overwrite === true,
      });
      res.status(201).json(status);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }, { operation: { id: "post:/api/auth/clearances/signing/setup", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  app.delete("/api/auth/clearances/signing", async (req, res) => {
    try {
      requireOperator(db, req);
      res.json(await clearanceManager.removeSigning());
    } catch (error) {
      handleClearanceError(error, res);
    }
  }, { operation: { id: "delete:/api/auth/clearances/signing", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  return authQueue;
}

function resolveAuthRequester(
  db: Db,
  req: RequestLike,
  payload: Pick<AuthRequestInput, "command" | "title" | "session_id">,
  requireDurable = false,
): { ok: true; userId: string; evidenceMethod: string; credentialId: string | null }
  | { ok: false; status: number; code: string; error: string } {
  const identity = req.client_identity;
  if (identity?.method === "api_token" && identity.credential_id) {
    return { ok: true, userId: identity.user_id, evidenceMethod: "api_token", credentialId: identity.credential_id };
  }
  if (requireDurable) {
    return {
      ok: false,
      status: 401,
      code: "durable_credential_required",
      error: "Auth request lifecycle mutations require an authenticated durable client credential.",
    };
  }
  const ambientIdentity = req.ambient_identity ?? null;
  const sessionResolution = payload.session_id
    ? ambientIdentity
      ? payload.session_id === ambientIdentity.provider_session_id
        ? resolveProviderSessionAttributionResult(db, ambientIdentity.provider)
        : { status: "conflict" as const }
      : resolveSessionIdAttributionResult(db, payload.session_id)
    : { status: "no_match" as const };
  if (sessionResolution.status === "conflict") {
    return { ok: false, status: 403, code: "requester_session_conflict", error: "Auth request session claims resolve to conflicting users." };
  }
  const attribution = sessionResolution.status === "resolved" ? sessionResolution.attribution : null;
  if (!attribution) {
    return { ok: false, status: 401, code: "requester_identity_required", error: "Auth request submission requires an authenticated client or an unambiguous session binding." };
  }
  return {
    ok: true,
    userId: attribution.user_id,
    evidenceMethod: "session_claim",
    credentialId: null,
  };
}

// Issue 8ae6b5f — requests no longer carry a spec. The canonical change
// message states intent, and a substantial design is a tracked artifact linked
// to the request's issue. Stored specs on older requests stay readable.
// Issue 72b00f8 — a custody-transfer request is created only by
// `work-unit custody-assume --request-approval`, which binds its exact unit,
// generation, and requesting credential. Its reviewed bytes are never revised.
const CUSTODY_TRANSFER_SUBMISSION_REFUSAL =
  "Custody-transfer requests come only from `mandible work-unit custody-assume --request-approval` and cannot be revised.";

const SPEC_CONTENT_REFUSAL =
  "'spec_content' is no longer accepted. Put intent in the change message (post-merge steps under Caveats) and link a substantial design to the issue as an artifact.";

function parseAuthRequestPayload(body: Record<string, unknown>): AuthRequestInput | null {
  if (body.space_publication_id !== undefined && (typeof body.space_publication_id !== "string" || !body.space_publication_id.trim())) return null;
  if (typeof body.command !== "string" || typeof body.title !== "string") {
    return null;
  }

  // Bug: dd21c1e — parse type, default to 'merge'
  const type: AuthRequestType | undefined =
    typeof body.type === "string" && AUTH_REQUEST_TYPES.includes(body.type as AuthRequestType)
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
    space_publication_id: typeof body.space_publication_id === "string" ? body.space_publication_id : undefined,
    session_id: typeof body.session_id === "string" ? body.session_id : null,
    type,
    command: body.command,
    title: body.title,
    cwd: typeof body.cwd === "string" ? body.cwd : null,
    diff_summary: typeof body.diff_summary === "string" ? body.diff_summary : null,
    commit_message: typeof body.commit_message === "string" ? body.commit_message : "",
    // Issue 7d64d8f — the submitter declares an agent-authored canonical change
    // message; the queue canonicalizes it and binds it to a digest.
    canonical_message: body.canonical_message === true,
    verification: typeof body.verification === "string" ? body.verification : null,
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
    actions: body.actions === undefined ? undefined : body.actions as AuthRequestInput["actions"],
    supersedes_request_id: typeof body.supersedes_request_id === "string" ? body.supersedes_request_id : null,
    superseded_action_dispositions: Array.isArray(body.superseded_action_dispositions)
      ? body.superseded_action_dispositions as AuthRequestInput["superseded_action_dispositions"]
      : undefined,
    expected_revision: numberField(body.expected_revision),
    expected_custody_generation: numberField(body.expected_custody_generation),
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function enforceAuthProjectWrite(db: Db, req: RequestLike, res: ResponseLike, repo: string | undefined): boolean {
  const resolved = repo ? resolveProjectRef(db, repo) : { ok: false as const };
  if (!resolved.ok) {
    res.status(409).json({ error: "Auth request project identity is missing or ambiguous." });
    return false;
  }
  try {
    requireProjectAccess(db, req, resolved.project.id, "write");
    return true;
  } catch (error) {
    if (error instanceof PermissionError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return false;
    }
    throw error;
  }
}

function authMutationControl(
  db: Db,
  req: RequestLike,
  res: ResponseLike,
  request: AuthRequest,
  body: Record<string, unknown>,
  requireGoverned = false,
): { actor: AuthLifecycleActor | undefined } | null {
  if (rejectTokenlessSocketExecution(req, res)) return null;
  const governed = requireGoverned || Boolean(request.custody_work_unit_id) || isAuthMergeCommand(request);
  if (!governed) return { actor: undefined };
  const requester = resolveAuthRequester(db, req, { command: "mutate", title: "mutate" }, true);
  if (!requester.ok) {
    res.status(requester.status).json({ error: requester.error, code: requester.code });
    return null;
  }
  const recovery = body.operator_recovery === true;
  if (recovery) {
    try {
      requireOperator(db, req);
    } catch (error) {
      if (error instanceof ClientAuthzError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return null;
      }
      throw error;
    }
  }
  if (request.repo) {
    if (!enforceAuthProjectWrite(db, req, res, request.repo)) return null;
  } else if (!recovery) {
    res.status(409).json({ error: "Unbound legacy auth requests require operator recovery." });
    return null;
  }
  return { actor: {
    user_id: requester.userId,
    evidence_method: requester.evidenceMethod,
    credential_id: requester.credentialId,
    authority_path: recovery ? "operator_recovery" : "custodian",
  } };
}

function authActionPayload(body: Record<string, unknown>): Record<string, unknown> {
  const { expected_revision: _revision, expected_custody_generation: _generation,
    operator_recovery: _recovery, ...payload } = body;
  return payload;
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

function resolveAuthCheckPayload(db: Db, payload: AuthMergeCheckInput): AuthMergeCheckInput {
  const resolved = { ...payload };
  if (!resolved.cwd && resolved.repo) {
    resolved.cwd = registeredAuthCheckRepoRoot(db, resolved.repo);
  }
  if (resolved.cwd && !resolved.base_branch) {
    resolved.base_branch = detectProtectedBranch(resolved.cwd);
  }
  return resolved;
}

function registeredAuthCheckRepoRoot(db: Db, repoRef: string): string | null {
  const normalizedRef = normalizeExistingPath(repoRef);
  try {
    const rows = db
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
  if (Object.hasOwn(body, "space_publication_id")) return { ok: false, error: "Publication identity is immutable; submit an exact successor or prepare a new publication." };
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
    if (typeof body.type !== "string" || !AUTH_REQUEST_TYPES.includes(body.type as AuthRequestType)) {
      return { ok: false, error: `Invalid 'type' — must be one of: ${AUTH_REQUEST_TYPES.join(", ")}` };
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
    if (typeof body.commit_message === "string") {
      payload.commit_message = body.commit_message;
    } else {
      return { ok: false, error: "Invalid Description ('commit_message') — must be a nonblank string" };
    }
  }

  // Issue 7d64d8f — an update may promote free-form review text to a canonical
  // change message, or (with false) demote it back, while the request is still
  // pending. The queue owns canonicalization and the digest either way.
  if (hasKey("canonical_message")) {
    if (typeof body.canonical_message !== "boolean") {
      return { ok: false, error: "Invalid 'canonical_message' — must be a boolean" };
    }
    payload.canonical_message = body.canonical_message;
  }

  if (hasKey("verification")) {
    if (body.verification === null || typeof body.verification === "string") {
      payload.verification = body.verification as string | null;
    } else {
      return { ok: false, error: "Invalid 'verification' — must be a string or null" };
    }
  }

  if (hasKey("spec_content")) return { ok: false, error: SPEC_CONTENT_REFUSAL };

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
    if (error.code === "requester_control_required" || error.code === "custody_required" ||
        error.code === "operator_recovery_required") {
      res.status(403).json({ error: error.message, code: error.code });
      return;
    }
    if (error.code === "custody_conflict" || error.code === "lifecycle_conflict" ||
        error.code === "lifecycle_precondition_required" || error.code === "recovery_refused") {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    if (error.code === "action_disposition_required" || error.code === "target_mismatch") {
      res.status(422).json({ error: error.message, code: error.code });
      return;
    }
  } else if (isHttpError(error)) {
    // The queue's validation refusals (for example a malformed canonical
    // change message) carry their own status and actionable text.
    res.status(error.status).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: "Unexpected auth queue error." });
}

function handleClearanceError(error: unknown, res: ResponseLike): void {
  if (error instanceof ClientAuthzError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof AuthClearanceError) {
    const status = error.code === "not_found" || error.code === "request_not_found"
      ? 404
      : error.code.includes("ambiguous") || error.code.endsWith("_mismatch")
        ? 409
        : error.code === "operator_required"
          ? 403
          : 422;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

// Bug: 929c6d0 — extract the last N lines from a string for error output summaries.
function tailLines(text: string, n: number): string | null {
  if (!text || !text.trim()) return null;
  const lines = text.split("\n");
  const tail = lines.slice(-n);
  const result = tail.join("\n").trim();
  return result || null;
}
