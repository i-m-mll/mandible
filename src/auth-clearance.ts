import { createHash, randomUUID } from "node:crypto";

import type SqliteDatabase from "./sqlite.js";

import { isAuthMergeCommand, resolveAuthMergeExecutionContext } from "./auth-context.js";
import type { Db } from "./db.js";
import { LedgerStore } from "./ledger/store.js";
import { resolveProjectRef, type RegistryProject } from "./ledger/project-registry.js";
import type { AuthRequest } from "./types.js";
import { getOperator, listCredentials, resolveUser } from "./users/store.js";
import type { AuthApprovalContext, DelegatedSignerBorrow } from "./delegated-signing-resource.js";
import { DelegatedSigningResource } from "./delegated-signing-resource.js";
import { canonicalJson } from "./canonical-json.js";
import { resolveId } from "./entity-refs.js";
import { AuthorityLifecycle } from "./authority-lifecycle.js";

const DEFAULT_DURATION_MINUTES = 60;
const DEFAULT_MAX_USES = 1;
const MAX_DURATION_MINUTES = 24 * 60;

export interface AuthClearance {
  id: string;
  issuer_user_id: string;
  grantee_user_id: string;
  grantee_credential_id: string;
  project_id: string;
  base_branch: string;
  issue_id: string | null;
  head_branch: string | null;
  action: "merge";
  issued_at: number;
  expires_at: number;
  max_uses: number;
  consumed_uses: number;
  revoked_at: number | null;
  revoked_by_user_id: string | null;
  runtime_epoch: string;
  signing_lease_id: string;
  created_from_request_id: string | null;
}

export interface AuthClearanceUse {
  id: string;
  clearance_id: string;
  auth_request_id: string;
  use_ordinal: number;
  evidence_id: string;
  requester_user_id: string;
  requester_evidence_method: "api_token" | "credential_signature";
  requester_credential_id: string;
  signing_lease_id: string;
  request_snapshot_json: string;
  request_snapshot_digest: string;
  consumed_at: number;
}

export interface IssueClearanceInput {
  requestId?: string | null;
  grantee: string;
  granteeCredentialId?: string | null;
  project?: string | null;
  baseBranch?: string | null;
  issueRef?: string | null;
  headBranch?: string | null;
  action?: "merge";
  durationMinutes?: number;
  maxUses?: number;
}

export interface ClearanceConsumption {
  clearance: AuthClearance;
  use: AuthClearanceUse;
  approval: AuthApprovalContext;
  settle: DelegatedSignerBorrow["settle"];
}

export class AuthClearanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AuthClearanceError";
  }
}

export class AuthClearanceManager {
  private readonly lifecycle = new AuthorityLifecycle();
  private closing: Promise<void> | null = null;
  private readonly db: Db;
  private readonly now: () => number;

  constructor(
    db: InstanceType<typeof SqliteDatabase>,
    private readonly signer: DelegatedSigningResource,
    private readonly runtimeEpoch: string,
    options: { now?: () => number } = {},
  ) {
    this.db = db;
    this.now = options.now ?? (() => Date.now());
  }

  signingStatus() {
    this.lifecycle.assertOpen();
    return this.signer.status();
  }

  setupSigning(options: Parameters<DelegatedSigningResource["setup"]>[0]) {
    return this.lifecycle.run(() => this.signer.setup(options));
  }

  removeSigning() {
    return this.lifecycle.run(() => this.signer.remove());
  }

  close(): Promise<void> {
    this.lifecycle.stopAdmission();
    if (this.closing) return this.closing;
    this.closing = this.lifecycle.join().then(() => this.signer.close());
    void this.closing.catch(() => { this.closing = null; });
    return this.closing;
  }

  async issue(input: IssueClearanceInput, issuerUserId: string): Promise<AuthClearance> {
    return this.lifecycle.run(() => this.issueAdmitted(input, issuerUserId));
  }

  private async issueAdmitted(input: IssueClearanceInput, issuerUserId: string): Promise<AuthClearance> {
    const now = this.now();
    const operator = getOperator(this.db);
    if (!operator || operator.status !== "active" || operator.id !== issuerUserId) {
      throw new AuthClearanceError("operator_required", "Only the configured active operator can issue a clearance.");
    }
    const request = input.requestId ? this.readRequest(input.requestId) : null;
    if (request) (await this.assertIssuableRequest(request));
    const project = request
      ? this.resolveRequestProject(request)
      : this.resolveExplicitProject(input.project);
    const baseBranch = (input.baseBranch ?? request?.base_branch ?? "").trim();
    this.assertProtectedBase(project, baseBranch);
    if (input.action != null && input.action !== "merge") {
      throw new AuthClearanceError("unsupported_action", "Clearance action is fixed to merge.");
    }
    const grantee = resolveUser(this.db, input.grantee);
    if (!grantee || grantee.kind !== "agent" || grantee.status !== "active") {
      throw new AuthClearanceError("invalid_grantee", "Clearance grantee must be an active durable agent user.");
    }
    const credentials = listCredentials(this.db, grantee.id).filter((credential) =>
      credential.type === "api_token" &&
      (!input.granteeCredentialId || credential.id === input.granteeCredentialId)
    );
    if (credentials.length !== 1) {
      throw new AuthClearanceError(
        "ambiguous_grantee_credential",
        "Select exactly one active durable API-token credential for the grantee.",
      );
    }
    const requestIssues = request ? this.requestIssueIds(request, project.id) : [];
    const inferredIssue = requestIssues.length === 1 ? requestIssues[0] : null;
    const issueId = input.issueRef
      ? this.resolveIssue(input.issueRef, project.id)
      : inferredIssue;
    const headBranch = (input.headBranch ?? request?.head_branch ?? null)?.trim() || null;
    if (!issueId && !headBranch) {
      throw new AuthClearanceError("scope_required", "Clearance requires an exact issue and/or exact head branch.");
    }
    if (request && headBranch && headBranch !== request.head_branch) {
      throw new AuthClearanceError("scope_mismatch", "Clearance head branch must match the selected request exactly.");
    }
    if (request && issueId && !requestIssues.includes(issueId)) {
      throw new AuthClearanceError("scope_mismatch", "Clearance issue must be carried by the selected request.");
    }
    const durationMinutes = boundedInteger(input.durationMinutes, DEFAULT_DURATION_MINUTES, 1, MAX_DURATION_MINUTES);
    const maxUses = boundedInteger(input.maxUses, DEFAULT_MAX_USES, 1, 100);
    const expiresAt = now + durationMinutes * 60_000;
    const approval = await this.signer.issueFresh(Math.ceil((expiresAt - now) / 1000));
    const id = randomUUID();
    try {
      this.db.prepare(
        `INSERT INTO auth_clearances (
          id, issuer_user_id, grantee_user_id, grantee_credential_id, project_id,
          base_branch, issue_id, head_branch, action, issued_at, expires_at,
          max_uses, runtime_epoch, signing_lease_id, created_from_request_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'merge', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, operator.id, grantee.id, credentials[0].id, project.id,
        baseBranch, issueId, headBranch, now, expiresAt, maxUses,
        this.runtimeEpoch, approval.leaseId, request?.id ?? null,
      );
    } catch (error) {
      try { await this.signer.release(approval); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Clearance issuance and signer cleanup failed."); }
      throw error;
    }
    return this.readClearance(id);
  }

  list(requestId?: string | null): AuthClearance[] {
    this.lifecycle.assertOpen();
    const rows = requestId
      ? this.db.prepare(
          `SELECT DISTINCT c.*,
             (SELECT COUNT(*) FROM auth_clearance_uses count_use WHERE count_use.clearance_id = c.id) AS consumed_uses
           FROM auth_clearances c
           LEFT JOIN auth_clearance_uses u ON u.clearance_id = c.id
           WHERE c.created_from_request_id = ? OR u.auth_request_id = ?
           ORDER BY c.issued_at DESC`,
        ).all(requestId, requestId)
      : this.db.prepare(
          `SELECT c.*,
             (SELECT COUNT(*) FROM auth_clearance_uses count_use WHERE count_use.clearance_id = c.id) AS consumed_uses
           FROM auth_clearances c ORDER BY c.issued_at DESC`,
        ).all();
    return rows as AuthClearance[];
  }

  show(id: string): AuthClearance {
    this.lifecycle.assertOpen();
    return this.readClearance(id);
  }

  private readClearance(id: string): AuthClearance {
    const resolved = resolveId(this.db, "auth_clearance", id);
    if (!resolved.ok && resolved.error === "ambiguous") throw new AuthClearanceError("ambiguous", `Clearance ref '${id}' is ambiguous.`);
    if (!resolved.ok) throw new AuthClearanceError("not_found", `No clearance matches '${id}'.`);
    return this.db.prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM auth_clearance_uses count_use WHERE count_use.clearance_id = c.id) AS consumed_uses
       FROM auth_clearances c WHERE c.id = ?`,
    ).get(resolved.id) as AuthClearance;
  }

  uses(clearanceId: string): AuthClearanceUse[] {
    const clearance = this.show(clearanceId);
    return this.db.prepare(
      "SELECT * FROM auth_clearance_uses WHERE clearance_id = ? ORDER BY use_ordinal",
    ).all(clearance.id) as AuthClearanceUse[];
  }

  async revoke(id: string, operatorUserId: string): Promise<AuthClearance> {
    return this.lifecycle.run(() => this.revokeAdmitted(id, operatorUserId));
  }

  private async revokeAdmitted(id: string, operatorUserId: string): Promise<AuthClearance> {
    const operator = getOperator(this.db);
    if (!operator || operator.status !== "active" || operator.id !== operatorUserId) {
      throw new AuthClearanceError("operator_required", "Only the configured active operator can revoke a clearance.");
    }
    const clearance = this.readClearance(id);
    if (clearance.revoked_at !== null) {
      await this.signer.drain(clearance.signing_lease_id, "clearance_revoked");
      return clearance;
    }
    this.db.prepare(
      `UPDATE auth_clearances SET revoked_at = COALESCE(revoked_at, ?),
       revoked_by_user_id = COALESCE(revoked_by_user_id, ?) WHERE id = ?`,
    ).run(this.now(), operator.id, clearance.id);
    await this.signer.drain(clearance.signing_lease_id, "clearance_revoked");
    return this.readClearance(clearance.id);
  }

  async consume(
    requestId: string,
    transition: (input: ClearanceConsumption) => undefined,
    observeBeforeCommit?: () => Promise<void>,
  ): Promise<ClearanceConsumption> {
    return this.lifecycle.run(() => this.consumeAdmitted(requestId, transition, observeBeforeCommit));
  }

  private async consumeAdmitted(
    requestId: string,
    transition: (input: ClearanceConsumption) => undefined,
    observeBeforeCommit?: () => Promise<void>,
  ): Promise<ClearanceConsumption> {
    const initialRequest = this.readRequest(requestId);
    const observed = canonicalJson(requestSnapshot(initialRequest));
    await this.assertConsumableRequest(initialRequest);
    await observeBeforeCommit?.();
    const initialMatches = this.matchingClearances(initialRequest, this.now());
    if (initialMatches.length !== 1) {
      throw new AuthClearanceError(
        initialMatches.length === 0 ? "no_matching_clearance" : "ambiguous_clearance",
        initialMatches.length === 0
          ? "No active unambiguous clearance matches this exact request and verified requester provenance."
          : "Multiple active clearances match this request; revoke or narrow them before execution.",
      );
    }
    let borrow: DelegatedSignerBorrow;
    try {
      borrow = await this.signer.borrow(initialMatches[0].signing_lease_id);
    } catch (error) {
      throw new AuthClearanceError(
        "runtime_invalidated",
        error instanceof Error ? error.message : "Clearance signer is unavailable.",
      );
    }
    const run = this.db.transaction(() => {
      const request = this.readRequest(requestId);
      if (canonicalJson(requestSnapshot(request)) !== observed) throw new AuthClearanceError("runtime_invalidated", "Request changed during clearance observation.");
      const now = this.now();
      const matches = this.matchingClearances(request, now);
      if (matches.length !== 1) {
        throw new AuthClearanceError(
          matches.length === 0 ? "no_matching_clearance" : "ambiguous_clearance",
          matches.length === 0
            ? "No active unambiguous clearance matches this exact request and verified requester provenance."
            : "Multiple active clearances match this request; revoke or narrow them before execution.",
        );
      }
      const clearance = matches[0];
      if (clearance.id !== initialMatches[0].id || borrow.approval.leaseId !== clearance.signing_lease_id) {
        throw new AuthClearanceError("runtime_invalidated", "Clearance signer or matching scope changed before consumption.");
      }
      const snapshot = requestSnapshot(request);
      const snapshotJson = canonicalJson(snapshot);
      const snapshotDigest = createHash("sha256").update(snapshotJson).digest("hex");
      const useId = randomUUID();
      const evidenceId = randomUUID();
      const signingLease = this.db.prepare(
        "SELECT credential_id FROM delegated_signing_leases WHERE id = ?",
      ).get(clearance.signing_lease_id) as { credential_id: string } | undefined;
      if (!signingLease) {
        throw new AuthClearanceError("runtime_invalidated", "Clearance signing lease is unavailable.");
      }
      const useCount = Number((this.db.prepare(
        "SELECT COUNT(*) AS count FROM auth_clearance_uses WHERE clearance_id = ?",
      ).get(clearance.id) as { count: number }).count);
      if (useCount >= clearance.max_uses) {
        throw new AuthClearanceError("clearance_exhausted", "Clearance has no remaining uses.");
      }
      const ordinal = useCount + 1;
      this.db.prepare(
        `INSERT INTO attribution_evidence
          (id, evidence_method, credential_id, lease_id, verified_at, details_json)
         VALUES (?, 'delegated_lease', ?, ?, ?, ?)`,
      ).run(
        evidenceId,
        signingLease.credential_id,
        clearance.signing_lease_id,
        now,
        canonicalJson({
          auth_request_id: request.id,
          authorizer_user_id: clearance.issuer_user_id,
          requester_user_id: request.requested_by_user_id,
          requester_credential_id: request.requester_credential_id,
          clearance_id: clearance.id,
          clearance_use_id: useId,
          approval_source: "clearance",
          runtime_epoch: this.runtimeEpoch,
          request_snapshot_digest: snapshotDigest,
        }),
      );
      this.db.prepare(
        `INSERT INTO auth_clearance_uses (
          id, clearance_id, auth_request_id, use_ordinal, evidence_id,
          requester_user_id, requester_evidence_method, requester_credential_id,
          signing_lease_id, request_snapshot_json, request_snapshot_digest, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        useId, clearance.id, request.id, ordinal, evidenceId,
        request.requested_by_user_id, request.requester_evidence_method,
        request.requester_credential_id, clearance.signing_lease_id,
        snapshotJson, snapshotDigest, now,
      );
      const result: ClearanceConsumption = {
        clearance: { ...clearance, consumed_uses: ordinal },
        use: {
          id: useId,
          clearance_id: clearance.id,
          auth_request_id: request.id,
          use_ordinal: ordinal,
          evidence_id: evidenceId,
          requester_user_id: request.requested_by_user_id!,
          requester_evidence_method: request.requester_evidence_method as "api_token" | "credential_signature",
          requester_credential_id: request.requester_credential_id!,
          signing_lease_id: clearance.signing_lease_id,
          request_snapshot_json: snapshotJson,
          request_snapshot_digest: snapshotDigest,
          consumed_at: now,
        },
        approval: { ...borrow.approval, source: "clearance" },
        settle: borrow.settle,
      };
      transition(result);
      return result;
    });
    let result: ClearanceConsumption;
    try {
      result = run.immediate();
    } catch (error) {
      try { await borrow.settle(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Clearance consumption and settlement failed."); }
      throw error;
    }
    if (result.use.use_ordinal >= result.clearance.max_uses) {
      this.signer.drainInBackground(result.clearance.signing_lease_id, "clearance_exhausted");
    }
    return result;
  }

  private matchingClearances(request: AuthRequest, now: number): AuthClearance[] {
    this.assertConsumableShape(request);
    const operator = getOperator(this.db);
    if (!operator || operator.status !== "active") return [];
    const project = this.resolveRequestProject(request);
    const issueIds = this.requestIssueIds(request, project.id);
    const rows = this.db.prepare(
      `SELECT c.* FROM auth_clearances c
       JOIN users issuer ON issuer.id = c.issuer_user_id AND issuer.kind = 'human' AND issuer.status = 'active'
       JOIN users grantee ON grantee.id = c.grantee_user_id AND grantee.kind = 'agent' AND grantee.status = 'active'
       JOIN user_credentials credential ON credential.id = c.grantee_credential_id
         AND credential.user_id = c.grantee_user_id AND credential.type = 'api_token' AND credential.status = 'active'
       JOIN delegated_signing_leases lease ON lease.id = c.signing_lease_id
         AND lease.owner_user_id = c.issuer_user_id AND lease.expires_at > ?
       JOIN user_credentials signing_credential ON signing_credential.id = lease.credential_id
         AND signing_credential.user_id = c.issuer_user_id
         AND signing_credential.type = 'delegated_ssh_key' AND signing_credential.status = 'active'
       JOIN delegated_signing_runtime_bindings binding ON binding.lease_id = lease.id
         AND binding.state = 'available' AND binding.retired_at IS NULL
       WHERE c.project_id = ? AND c.base_branch = ? AND c.action = 'merge'
         AND c.issuer_user_id = ?
         AND c.grantee_user_id = ? AND c.grantee_credential_id = ?
         AND c.revoked_at IS NULL AND c.expires_at > ?
         AND (SELECT COUNT(*) FROM auth_clearance_uses used WHERE used.clearance_id = c.id) < c.max_uses
       ORDER BY c.issued_at, c.id`,
    ).all(
      now, project.id, request.base_branch, operator.id, request.requested_by_user_id,
      request.requester_credential_id, now,
    ) as AuthClearance[];
    return rows.filter((clearance) => {
      if (clearance.head_branch && clearance.head_branch !== request.head_branch) return false;
      if (clearance.issue_id && !issueIds.includes(clearance.issue_id)) return false;
      return this.effectsAllowed(request, clearance);
    });
  }

  private effectsAllowed(request: AuthRequest, clearance: AuthClearance): boolean {
    const project = this.resolveRequestProject(request);
    const closures = (request.issue_closures ?? request.issues ?? []).map((ref) =>
      this.resolveIssue(ref, project.id)
    );
    const actions = this.db.prepare(
      "SELECT kind, target_issue_ref FROM auth_request_actions WHERE auth_request_id = ? AND state != 'vetoed'",
    ).all(request.id) as Array<{ kind: string; target_issue_ref: string }>;
    if (!clearance.issue_id) return closures.length === 0 && actions.length === 0;
    if (closures.some((id) => id !== clearance.issue_id)) return false;
    return actions.every((action) =>
      action.kind === "issue_close" && this.resolveIssue(action.target_issue_ref, project.id) === clearance.issue_id
    );
  }

  private async assertIssuableRequest(request: AuthRequest): Promise<void> {
    (await this.assertConsumableRequest(request));
    (await resolveAuthMergeExecutionContext(this.db, request));
  }

  private async assertConsumableRequest(request: AuthRequest): Promise<void> {
    this.assertConsumableShape(request);
    const context = await resolveAuthMergeExecutionContext(this.db, request);
    if (request.merge_head_sha && context.headSha !== request.merge_head_sha || request.merge_preflight_base_sha && context.baseSha !== request.merge_preflight_base_sha) throw new AuthClearanceError("runtime_invalidated", "Reviewed merge revisions changed during clearance observation.");
  }

  private assertConsumableShape(request: AuthRequest): void {
    if (request.status !== "pending" || request.type !== "merge" || request.execution_mode !== "daemon"
        || !isAuthMergeCommand(request)) {
      throw new AuthClearanceError(
        "unsupported_request",
        "Clearance applies only to a pending real daemon-mode protected merge request.",
      );
    }
    if (!request.requested_by_user_id || request.requester_evidence_method !== "api_token"
        || !request.requester_credential_id) {
      throw new AuthClearanceError(
        "requester_provenance_required",
        "Clearance requires requester provenance from an active durable API-token credential.",
      );
    }
  }

  private resolveExplicitProject(ref: string | null | undefined) {
    if (!ref?.trim()) {
      throw new AuthClearanceError("project_required", "Prospective clearance requires one canonical project.");
    }
    const resolved = resolveProjectRef(this.db, ref);
    if (!resolved.ok) {
      throw new AuthClearanceError(
        (!resolved.ok && resolved.reason === "ambiguous") ? "project_ambiguous" : "project_unresolved",
        `Project scope '${ref}' does not resolve to one canonical project.`,
      );
    }
    return resolved.project;
  }

  private assertProtectedBase(project: RegistryProject, baseBranch: string): void {
    if (!baseBranch || !project.checkouts.some((checkout) => checkout.default_branch === baseBranch)) {
      throw new AuthClearanceError(
        "protected_base_mismatch",
        "Clearance base must exactly match the canonical project's protected default branch.",
      );
    }
  }

  private resolveRequestProject(request: AuthRequest) {
    const refs = [request.target_repo_root, request.repo].filter((value): value is string => Boolean(value));
    for (const ref of refs) {
      const resolved = resolveProjectRef(this.db, ref);
      if (resolved.ok) return resolved.project;
      if ((!resolved.ok && resolved.reason === "ambiguous")) break;
    }
    throw new AuthClearanceError("project_unresolved", "Auth request does not resolve to one canonical project.");
  }

  private requestIssueIds(request: AuthRequest, projectId: string): string[] {
    const refs = [
      ...(request.issue_references ?? []),
      ...(request.issue_closures ?? request.issues ?? []),
    ];
    return [...new Set(refs.map((ref) => this.resolveIssue(ref, projectId)))];
  }

  private resolveIssue(ref: string, projectId: string): string {
    const result = new LedgerStore(this.db).resolveIssueRef(ref, { project_id: projectId });
    if (!result.ok || !result.id) {
      throw new AuthClearanceError(
        "error" in result && result.error === "ambiguous" ? "issue_ambiguous" : "issue_unresolved",
        `Issue scope '${ref}' does not resolve exactly in the clearance project.`,
      );
    }
    return result.id;
  }

  private readRequest(id: string): AuthRequest {
    const resolved = resolveId(this.db, "auth_request", id);
    if (!resolved.ok && resolved.error === "ambiguous") throw new AuthClearanceError("ambiguous", `Auth request ref '${id}' is ambiguous.`);
    if (!resolved.ok) throw new AuthClearanceError("request_not_found", `No auth request '${id}'.`);
    return mapRequest(this.db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(resolved.id) as Record<string, unknown>);
  }
}

function mapRequest(row: Record<string, unknown>): AuthRequest {
  const array = (value: unknown): string[] | null => {
    if (value == null) return null;
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : null;
  };
  return {
    ...(row as unknown as AuthRequest),
    id: String(row.id),
    status: String(row.status) as AuthRequest["status"],
    type: String(row.type) as AuthRequest["type"],
    command: String(row.command),
    execution_mode: String(row.execution_mode) as AuthRequest["execution_mode"],
    requested_by_user_id: row.requested_by_user_id == null ? null : String(row.requested_by_user_id),
    requester_evidence_method: row.requester_evidence_method == null ? null : String(row.requester_evidence_method),
    requester_credential_id: row.requester_credential_id == null ? null : String(row.requester_credential_id),
    issue_references: array(row.issue_references),
    issue_closures: array(row.issue_closures),
    issues: array(row.issues),
  };
}

function requestSnapshot(request: AuthRequest): Record<string, unknown> {
  return {
    id: request.id,
    requested_by_user_id: request.requested_by_user_id,
    requester_evidence_method: request.requester_evidence_method,
    requester_credential_id: request.requester_credential_id,
    type: request.type,
    command: request.command,
    cwd: request.cwd,
    repo: request.repo ?? null,
    base_branch: request.base_branch ?? null,
    head_branch: request.head_branch ?? null,
    merge_head_sha: request.merge_head_sha ?? null,
    issue_references: request.issue_references ?? null,
    issue_closures: request.issue_closures ?? request.issues ?? null,
    execution_mode: request.execution_mode,
  };
}


function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new AuthClearanceError("invalid_limit", `Expected an integer between ${min} and ${max}.`);
  }
  return resolved;
}
