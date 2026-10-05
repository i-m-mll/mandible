import { randomUUID } from "node:crypto";
import {
  normalizeAmbientProviderIdentity,
  providerSessionEnvBindingValues,
  type AmbientProviderIdentity,
} from "../ambient-provider-identity.js";
import { getDb } from "../db.js";
import { linkWorkUnitToLedgerIssue, resolveOperationalIssueRef } from "../ledger/operational-links.js";
import { getLedgerIssueWorkMetadata } from "../ledger/issue-detail.js";
import { normalizeProjectRepoId } from "../ledger/project-registry.js";
import type { RequestLike, RouteRegistrar } from "../server.js";
import type { SessionRegistry } from "../registry.js";
import type { SessionManager } from "../session-manager.js";
import type { Logger } from "../types.js";
import { resolveSessionOwnerUserId } from "../session-ownership.js";
import { readBody, sendJson } from "./http.js";
import { isOperator } from "../client-auth/authz.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import { PermissionError, requireProjectAccess } from "../permissions/store.js";
import {
  mapWorkUnitRow as mapRow,
  normalizeWorkUnitSessionId,
  enrichWithLiveness,
  type WorkUnitLiveness,
  type WorkUnitWithLiveness,
} from "../work-unit-utils.js";

// Bug: a247bc3 — work-unit CRUD for inbox workqueue
// Bug: 8a281b3 — liveness overlay, PATCH, GET /:id
// Bug: f3dbb3e — shared liveness computation extracted to work-unit-utils.ts

// Re-export for backward compat (other modules may import from here)
export type { WorkUnitLiveness, WorkUnitWithLiveness };

interface ClaimInput {
  issue_id: string;
  repo_id: string;
  branch?: string | null;
  parent_branch?: string | null;
  kind?: string;
  assigned_session_id?: string | null;
  provider?: string | null;
  provider_session_id?: string | null;
  ambient_identity?: unknown;
}

interface ActivateInput {
  issue_id: string;
  repo_id: string;
  branch?: string | null;
  assigned_session_id?: string | null;
  provider?: string | null;
  provider_session_id?: string | null;
  ambient_identity?: unknown;
  worker_owner?: boolean;
}

interface ReleaseInput {
  issue_id: string;
  repo_id: string;
  provider?: string | null;
  provider_session_id?: string | null;
  ambient_identity?: unknown;
}

interface PatchInput {
  state?: string;
  assigned_session_id?: string | null;
  continuation?: string | null;
  continuation_by?: string | null;
  continuation_at?: number | null;
  auth_request_id?: string | null;
  provider?: string | null;
  provider_session_id?: string | null;
  ambient_identity?: unknown;
}

interface CustodyAssumeInput {
  expected_generation?: number;
  reason?: string;
  parent_role_checkpoint_id?: string | null;
}

const VALID_STATES: Set<string> = new Set(["open", "committed", "resolved", "abandoned"]);

type ExistingWorkUnit = {
  id: string;
  state: string;
  branch: string | null;
  ledger_issue_id: string | null;
  assigned_session_id: string | null;
};

/**
 * Link a new work unit to its ledger issue.
 *
 * The outcome is reported rather than collapsed to `string | null`. A null
 * `ledger_issue_id` in a 201 response used to mean any of "linked to nothing",
 * "the ref did not resolve", and "the write threw" — so `mandible work-unit
 * claim` reported success on a work unit that never reached the ledger. The
 * work unit itself is real either way, so the response stays 201; it now says
 * what happened to the link.
 */
type LedgerLinkOutcome =
  | { status: "linked"; issue_id: string }
  | { status: "unresolved"; error: string }
  | { status: "failed"; error: string };

function linkLedgerIssue(
  db: ReturnType<typeof getDb>,
  workUnitId: string,
  issueId: string,
  repoId: string,
): LedgerLinkOutcome {
  try {
    const result = linkWorkUnitToLedgerIssue(db, {
      work_unit_id: workUnitId,
      issue_ref: issueId,
      repo_ref: repoId,
    });
    return result.ok
      ? { status: "linked", issue_id: result.issue_id }
      : { status: "unresolved", error: result.error };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Response fields for a link outcome, keeping `ledger_issue_id` shape-compatible. */
function ledgerLinkFields(outcome: LedgerLinkOutcome): Record<string, unknown> {
  return outcome.status === "linked"
    ? { ledger_issue_id: outcome.issue_id }
    : { ledger_issue_id: null, ledger_link_status: outcome.status, ledger_link_error: outcome.error };
}

/**
 * Same, for a reused work unit that may already carry a link. A prior link
 * stands when a fresh attempt does not succeed, but the failure is still
 * reported rather than hidden behind the older value.
 */
function ledgerLinkFieldsForExisting(
  outcome: LedgerLinkOutcome,
  existingIssueId: string | null,
): Record<string, unknown> {
  if (outcome.status === "linked") return { ledger_issue_id: outcome.issue_id };
  return {
    ledger_issue_id: existingIssueId,
    ledger_link_status: outcome.status,
    ledger_link_error: outcome.error,
  };
}

function ledgerIssueMetadataFields(
  db: ReturnType<typeof getDb>,
  outcome: LedgerLinkOutcome,
  fallbackIssueId: string | null = null,
): Record<string, unknown> {
  const issueId = outcome.status === "linked" ? outcome.issue_id : fallbackIssueId;
  if (!issueId) {
    return {
      work_notes: "",
      work_notes_revision: null,
      dependencies: [],
      dependency_warning: false,
    };
  }
  const metadata = getLedgerIssueWorkMetadata(db, issueId);
  return {
    work_notes: metadata.work_notes,
    work_notes_revision: metadata.work_notes_revision,
    dependencies: metadata.dependencies,
    dependency_warning: metadata.dependency_warning,
  };
}

function resolveLedgerIssueId(
  db: ReturnType<typeof getDb>,
  issueId: string,
  repoId: string,
): string | null {
  try {
    const result = resolveOperationalIssueRef(db, issueId, repoId);
    return result.ok ? result.issue_id : null;
  } catch {
    return null;
  }
}

export function registerWorkUnitRoutes(
  server: RouteRegistrar,
  sessionRegistry: SessionRegistry,
  sessionManager: SessionManager,
  logger: Logger = () => undefined,
): void {
  const db = getDb();

  // POST /api/work-units/claim — create a new work unit (state=open)
  server.post("/api/work-units/claim", (req, res) => {
    const body = readBody<ClaimInput>(req);

    if (!body.issue_id || typeof body.issue_id !== "string") {
      sendJson(res, 400, { error: "Missing or invalid issue_id" });
      return;
    }
    if (!body.repo_id || typeof body.repo_id !== "string") {
      sendJson(res, 400, { error: "Missing or invalid repo_id" });
      return;
    }

    const repoId = normalizeProjectRepoId(db, body.repo_id);
    const assignedSessionId = normalizeWorkUnitSessionId(body.assigned_session_id);
    const ambientIdentity = workUnitAmbientIdentity(req, body);
    const now = Date.now();
    const existing = findExistingClaimWorkUnit(db, body.issue_id, repoId, body.branch ?? null);

    if (existing) {
      const updates: string[] = [];
      const params: unknown[] = [];
      if (!existing.branch && body.branch) {
        updates.push("branch = ?", "parent_branch = COALESCE(parent_branch, ?)");
        params.push(body.branch, body.parent_branch ?? null);
      }
      if (assignedSessionId && existing.assigned_session_id !== assignedSessionId) {
        updates.push("assigned_session_id = ?");
        params.push(assignedSessionId);
      }
      if (ambientIdentity) {
        updates.push("provider = ?", "provider_session_id = ?");
        params.push(ambientIdentity.provider, ambientIdentity.provider_session_id);
      }
      const credential = durableCredential(req);
      if (credential) {
        const custody = assignInitialCustody(db, existing.id, credential.user_id, credential.credential_id, now);
        if (!custody.ok) {
          sendJson(res, 409, { error: custody.error, code: "work_unit_custody_conflict" });
          return;
        }
      }
      if (updates.length > 0) {
        params.push(existing.id);
        db.prepare(`UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      }
      const ledgerLink = linkLedgerIssue(db, existing.id, body.issue_id, repoId);
      sendJson(res, 200, {
        id: existing.id,
        state: existing.state,
        existing: true,
        ...ledgerLinkFieldsForExisting(ledgerLink, existing.ledger_issue_id),
        ...ledgerIssueMetadataFields(db, ledgerLink, existing.ledger_issue_id),
      });
      return;
    }

    const id = randomUUID();
    const kind = body.kind && ["solo", "partition", "integration"].includes(body.kind)
      ? body.kind
      : "solo";
    const credential = durableCredential(req);
    const ownerUserId = credential?.user_id ?? resolveSessionOwnerUserId(
      db,
      {
        provider_session_envs: ambientIdentity
          ? providerSessionEnvBindingValues(ambientIdentity.provider)
          : [],
      },
      logger,
      { source: "work_unit", entity_id: id },
    );

    db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, parent_branch, kind, state, assigned_session_id,
        provider, provider_session_id, created_at, owner_user_id, owner_credential_id, custody_generation
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      body.issue_id,
      repoId,
      body.branch ?? null,
      body.parent_branch ?? null,
      kind,
      assignedSessionId,
      ambientIdentity?.provider ?? null,
      ambientIdentity?.provider_session_id ?? null,
      now,
      ownerUserId,
      null,
      0,
    );
    if (credential) assignInitialCustody(db, id, credential.user_id, credential.credential_id, now);

    const ledgerLink = linkLedgerIssue(db, id, body.issue_id, repoId);
    sendJson(res, 201, {
      id,
      ...ledgerLinkFields(ledgerLink),
      ...ledgerIssueMetadataFields(db, ledgerLink),
    });
  }, { operation: { id: "post:/api/work-units/claim", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow" });

  // POST /api/work-units/activate — mark as committed, update timestamps
  server.post("/api/work-units/activate", (req, res) => {
    const body = readBody<ActivateInput>(req);

    if (!body.issue_id || typeof body.issue_id !== "string") {
      sendJson(res, 400, { error: "Missing or invalid issue_id" });
      return;
    }
    if (!body.repo_id || typeof body.repo_id !== "string") {
      sendJson(res, 400, { error: "Missing or invalid repo_id" });
      return;
    }

    const repoId = normalizeProjectRepoId(db, body.repo_id);
    const now = Date.now();
    const assignedSessionId = normalizeWorkUnitSessionId(body.assigned_session_id);
    const ambientIdentity = workUnitAmbientIdentity(req, body);
    if (body.worker_owner !== undefined && typeof body.worker_owner !== "boolean") {
      sendJson(res, 400, { error: "worker_owner must be a boolean" });
      return;
    }
    if (body.worker_owner === true && ambientIdentity?.provider !== "codex") {
      sendJson(res, 400, {
        error: "worker_owner requires an allowlisted ambient Codex provider identity",
      });
      return;
    }

    const existing = findExistingActivateWorkUnit(db, body.issue_id, repoId, body.branch ?? null);

    if (existing) {
      const credential = durableCredential(req);
      if (credential) {
        const custody = assignInitialCustody(db, existing.id, credential.user_id, credential.credential_id, now);
        if (!custody.ok) {
          sendJson(res, 409, { error: custody.error, code: "work_unit_custody_conflict" });
          return;
        }
      }
      // Update to committed state, update timestamps
      const updates: string[] = ["state = 'committed'", "last_commit_at = ?"];
      const params: unknown[] = [now];

      if (existing.state === "open") {
        updates.push("activated_at = ?");
        params.push(now);
      }
      if (body.branch) {
        updates.push("branch = ?");
        params.push(body.branch);
      }
      if ("assigned_session_id" in body) {
        updates.push("assigned_session_id = ?");
        params.push(assignedSessionId);
      }
      if (ambientIdentity) {
        updates.push("provider = ?", "provider_session_id = ?");
        params.push(ambientIdentity.provider, ambientIdentity.provider_session_id);
      }
      if (body.worker_owner === true) {
        updates.push("worker_provider_session_id = ?");
        params.push(ambientIdentity!.provider_session_id);
      }
      params.push(existing.id);

      db.prepare(
        `UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`
      ).run(...params);

      const ledgerLink = linkLedgerIssue(db, existing.id, body.issue_id, repoId);
      sendJson(res, 200, {
        id: existing.id,
        state: "committed",
        ...ledgerLinkFieldsForExisting(ledgerLink, existing.ledger_issue_id),
        ...ledgerIssueMetadataFields(db, ledgerLink, existing.ledger_issue_id),
      });
    } else {
      // No existing work unit — create one in committed state (auto-claim)
      const id = randomUUID();
      const credential = durableCredential(req);
      const ownerUserId = credential?.user_id ?? resolveSessionOwnerUserId(
        db,
        {
          provider_session_envs: ambientIdentity
            ? providerSessionEnvBindingValues(ambientIdentity.provider)
            : [],
        },
        logger,
        { source: "work_unit", entity_id: id },
      );
      db.prepare(
        `INSERT INTO work_units (
          id, issue_id, repo_id, branch, kind, state, assigned_session_id,
          provider, provider_session_id, created_at, activated_at, last_commit_at,
          owner_user_id, worker_provider_session_id, owner_credential_id, custody_generation
        ) VALUES (?, ?, ?, ?, 'solo', 'committed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.issue_id,
        repoId,
        body.branch ?? null,
        assignedSessionId,
        ambientIdentity?.provider ?? null,
        ambientIdentity?.provider_session_id ?? null,
        now,
        now,
        now,
        ownerUserId,
        body.worker_owner === true ? ambientIdentity!.provider_session_id : null,
        null,
        0,
      );
      if (credential) assignInitialCustody(db, id, credential.user_id, credential.credential_id, now);

      const ledgerLink = linkLedgerIssue(db, id, body.issue_id, repoId);
      sendJson(res, 201, {
        id,
        state: "committed",
        ...ledgerLinkFields(ledgerLink),
        ...ledgerIssueMetadataFields(db, ledgerLink),
      });
    }
  }, { operation: { id: "post:/api/work-units/activate", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow" });

  // POST /api/work-units/release — set state back to open (for abandoned worktrees)
  server.post("/api/work-units/release", (req, res) => {
    const body = readBody<ReleaseInput>(req);

    if (!body.issue_id || typeof body.issue_id !== "string") {
      sendJson(res, 400, { error: "Missing or invalid issue_id" });
      return;
    }
    if (!body.repo_id || typeof body.repo_id !== "string") {
      sendJson(res, 400, { error: "Missing or invalid repo_id" });
      return;
    }

    const repoId = normalizeProjectRepoId(db, body.repo_id);
    const lookup = buildWorkUnitLookup(db, body.issue_id, repoId);
    const ambientIdentity = workUnitAmbientIdentity(req, body);
    const updates = ["state = 'open'", "assigned_session_id = NULL"];
    const params: unknown[] = [];
    if (ambientIdentity) {
      updates.push("provider = ?", "provider_session_id = ?");
      params.push(ambientIdentity.provider, ambientIdentity.provider_session_id);
    }
    const result = db
      .prepare(
        `UPDATE work_units SET ${updates.join(", ")}
         WHERE ${lookup.identity} AND state IN ('open', 'committed')`
      )
      .run(...params, ...lookup.params);

    if (result.changes === 0) {
      sendJson(res, 404, { error: "No active work unit found for this issue and repo" });
      return;
    }

    sendJson(res, 200, { ok: true, released: result.changes });
  }, { operation: { id: "post:/api/work-units/release", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow" });

  // GET /api/work-units — list with optional filters, includes liveness overlay
  // Bug: 8a281b3 — liveness overlay on work-unit responses
  server.get("/api/work-units", (req, res) => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (req.query.state) {
      conditions.push("state = ?");
      params.push(req.query.state);
    }
    if (req.query.repo_id) {
      conditions.push("repo_id = ?");
      params.push(normalizeProjectRepoId(db, req.query.repo_id));
    }
    if (req.query.branch) {
      conditions.push("branch = ?");
      params.push(req.query.branch);
    }
    if (req.query.issue_id) {
      conditions.push("issue_id = ?");
      params.push(req.query.issue_id);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM work_units${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[];

    const workUnits = rows.map(mapRow);
    const enriched = workUnits.map((wu) =>
      enrichWithLiveness(wu, sessionRegistry, sessionManager)
    );

    sendJson(res, 200, { work_units: enriched });
  }, { operation: { id: "get:/api/work-units", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/work-units/:id/custody/assume", (req, res) => {
    const identity = durableCredential(req);
    if (!identity) {
      sendJson(res, 401, { error: "Work-unit custody requires an authenticated durable client credential." });
      return;
    }
    const body = readBody<CustodyAssumeInput>(req);
    if (!Number.isInteger(body.expected_generation) || !body.reason?.trim()) {
      sendJson(res, 400, { error: "expected_generation and a non-empty reason are required" });
      return;
    }
    const row = db.prepare("SELECT * FROM work_units WHERE id = ?").get(req.params.id) as
      (ExistingWorkUnit & { repo_id: string; kind: string; owner_user_id: string | null; owner_credential_id: string | null; custody_generation: number; auth_request_id: string | null }) | undefined;
    if (!row) {
      sendJson(res, 404, { error: "Work unit not found" });
      return;
    }
    const project = resolveProjectRef(db, row.repo_id);
    if (!project.ok || !project.project || project.ambiguous) {
      sendJson(res, 409, { error: "Work-unit project identity is not unique." });
      return;
    }
    try {
      requireProjectAccess(db, req, project.project.id, "write");
    } catch (error) {
      if (error instanceof PermissionError) {
        sendJson(res, error.status, { error: error.message, code: error.code });
        return;
      }
      throw error;
    }
    const credential = db.prepare("SELECT status, user_id FROM user_credentials WHERE id = ?")
      .get(identity.credential_id) as { status: string; user_id: string } | undefined;
    if (!credential || credential.status !== "active" || credential.user_id !== identity.user_id) {
      sendJson(res, 403, { error: "The authenticated credential is not active for this user." });
      return;
    }
    if (row.owner_user_id === identity.user_id && row.owner_credential_id === identity.credential_id) {
      sendJson(res, 200, { work_unit: mapRow(row as unknown as Record<string, unknown>), unchanged: true });
      return;
    }
    const operatorRecovery = isOperator(db, req.client_identity!);
    let checkpointId: string | null = null;
    if (!operatorRecovery) {
      if (row.kind !== "integration" || !row.ledger_issue_id || !body.parent_role_checkpoint_id) {
        sendJson(res, 403, { error: "Cross-credential solo custody recovery is operator-only." });
        return;
      }
      const checkpoint = db.prepare(
        `SELECT id, payload_json FROM ledger_issue_checkpoints
         WHERE id = ? AND issue_id = ? AND kind = 'parent-role'`,
      ).get(body.parent_role_checkpoint_id, row.ledger_issue_id) as { id: string; payload_json: string } | undefined;
      const payload = checkpoint ? JSON.parse(checkpoint.payload_json) as Record<string, unknown> : null;
      if (!checkpoint || payload?.authenticated_user_id !== identity.user_id ||
          payload?.authenticated_credential_id !== identity.credential_id) {
        sendJson(res, 403, { error: "Integration custody transfer requires the caller's audited parent-role checkpoint." });
        return;
      }
      checkpointId = checkpoint.id;
    }
    const nextGeneration = Number(row.custody_generation) + 1;
    const reason = body.reason.trim();
    try {
      db.transaction(() => {
        const changed = db.prepare(`UPDATE work_units
          SET owner_user_id = ?, owner_credential_id = ?, custody_generation = ?
          WHERE id = ? AND custody_generation = ? AND owner_user_id IS ? AND owner_credential_id IS ?`)
          .run(identity.user_id, identity.credential_id, nextGeneration, row.id,
            body.expected_generation, row.owner_user_id, row.owner_credential_id);
        if (changed.changes !== 1) throw new Error("custody_generation_conflict");
        db.prepare(`INSERT INTO work_unit_custody_events
          (id, work_unit_id, prior_user_id, prior_credential_id, new_user_id, new_credential_id,
           prior_generation, new_generation, authority_path, parent_role_checkpoint_id,
           operator_evidence_method, reason, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), row.id, row.owner_user_id, row.owner_credential_id,
            identity.user_id, identity.credential_id, row.custody_generation, nextGeneration,
            operatorRecovery ? "operator_recovery" : "parent_role_handoff", checkpointId,
            operatorRecovery ? req.client_identity!.source : null, reason, Date.now());
      })();
    } catch (error) {
      if (error instanceof Error && error.message === "custody_generation_conflict") {
        sendJson(res, 409, { error: "Work-unit custody changed; refresh and retry.", code: "custody_generation_conflict" });
        return;
      }
      throw error;
    }
    const updated = db.prepare("SELECT * FROM work_units WHERE id = ?").get(row.id) as Record<string, unknown>;
    sendJson(res, 200, { work_unit: mapRow(updated), authority_path: operatorRecovery ? "operator_recovery" : "parent_role_handoff" });
  }, { operation: { id: "post:/api/work-units/:id/custody/assume", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow" });

  // GET /api/work-units/:id — single work unit with liveness overlay
  // Bug: 8a281b3
  server.get("/api/work-units/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing work unit id" });
      return;
    }

    const row = db
      .prepare("SELECT * FROM work_units WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;

    if (!row) {
      sendJson(res, 404, { error: "Work unit not found" });
      return;
    }

    const workUnit = mapRow(row);
    sendJson(res, 200, enrichWithLiveness(workUnit, sessionRegistry, sessionManager));
  }, { operation: { id: "get:/api/work-units/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // PATCH /api/work-units/:id — update mutable fields
  // Bug: 8a281b3
  server.patch("/api/work-units/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing work unit id" });
      return;
    }

    const existing = db
      .prepare("SELECT id FROM work_units WHERE id = ?")
      .get(id) as { id: string } | undefined;

    if (!existing) {
      sendJson(res, 404, { error: "Work unit not found" });
      return;
    }

    const body = readBody<PatchInput>(req);
    const ambientIdentity = workUnitAmbientIdentity(req, body);
    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.state !== undefined) {
      if (!VALID_STATES.has(body.state)) {
        sendJson(res, 400, { error: `Invalid state: ${body.state}. Must be one of: ${[...VALID_STATES].join(", ")}` });
        return;
      }
      updates.push("state = ?");
      params.push(body.state);

      // Auto-set resolved_at when transitioning to resolved
      if (body.state === "resolved") {
        updates.push("resolved_at = ?");
        params.push(Date.now());
      }
    }

    if ("assigned_session_id" in body) {
      updates.push("assigned_session_id = ?");
      params.push(normalizeWorkUnitSessionId(body.assigned_session_id));
    }

    if ("continuation" in body) {
      updates.push("continuation = ?");
      params.push(body.continuation ?? null);
    }

    if ("continuation_by" in body) {
      updates.push("continuation_by = ?");
      params.push(body.continuation_by ?? null);
    }

    if ("continuation_at" in body) {
      updates.push("continuation_at = ?");
      params.push(body.continuation_at ?? null);
    }

    if ("auth_request_id" in body) {
      updates.push("auth_request_id = ?");
      params.push(body.auth_request_id ?? null);
    }

    if (ambientIdentity) {
      updates.push("provider = ?", "provider_session_id = ?");
      params.push(ambientIdentity.provider, ambientIdentity.provider_session_id);
    }

    if (updates.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }

    params.push(id);
    db.prepare(
      `UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`
    ).run(...params);

    const updatedRow = db
      .prepare("SELECT * FROM work_units WHERE id = ?")
      .get(id) as Record<string, unknown>;

    const workUnit = mapRow(updatedRow);
    sendJson(res, 200, enrichWithLiveness(workUnit, sessionRegistry, sessionManager));
  }, { operation: { id: "patch:/api/work-units/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow" });
}

function durableCredential(req: RequestLike): { user_id: string; credential_id: string } | null {
  const identity = req.client_identity;
  return identity?.method === "api_token" && identity.credential_id
    ? { user_id: identity.user_id, credential_id: identity.credential_id }
    : null;
}

function assignInitialCustody(
  db: ReturnType<typeof getDb>,
  workUnitId: string,
  userId: string,
  credentialId: string,
  now: number,
): { ok: true } | { ok: false; error: string } {
  const current = db.prepare(
    "SELECT owner_user_id, owner_credential_id, custody_generation, auth_request_id FROM work_units WHERE id = ?",
  ).get(workUnitId) as { owner_user_id: string | null; owner_credential_id: string | null; custody_generation: number; auth_request_id: string | null };
  if (current.owner_credential_id === credentialId && current.owner_user_id === userId) return { ok: true };
  if (current.owner_credential_id || current.auth_request_id) {
    return { ok: false, error: "Work unit already has durable custody; use an audited custody transfer." };
  }
  const next = Number(current.custody_generation) + 1;
  db.transaction(() => {
    const changed = db.prepare(`UPDATE work_units SET owner_user_id = ?, owner_credential_id = ?, custody_generation = ?
      WHERE id = ? AND owner_credential_id IS NULL AND auth_request_id IS NULL AND custody_generation = ?`)
      .run(userId, credentialId, next, workUnitId, current.custody_generation);
    if (changed.changes !== 1) throw new Error("work_unit_custody_conflict");
    db.prepare(`INSERT INTO work_unit_custody_events
      (id, work_unit_id, prior_user_id, prior_credential_id, new_user_id, new_credential_id,
       prior_generation, new_generation, authority_path, reason, occurred_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'initial_assignment', 'Authenticated work-unit activation.', ?)`)
      .run(randomUUID(), workUnitId, current.owner_user_id, userId, credentialId, current.custody_generation, next, now);
  })();
  return { ok: true };
}

function workUnitAmbientIdentity(
  req: RequestLike,
  body: { provider?: string | null; provider_session_id?: string | null; ambient_identity?: unknown },
): AmbientProviderIdentity | null {
  return req.ambient_identity ?? normalizeAmbientProviderIdentity(body.ambient_identity) ?? normalizeAmbientProviderIdentity({
    provider: body.provider,
    provider_session_id: body.provider_session_id,
  });
}

function findExistingClaimWorkUnit(
  db: ReturnType<typeof getDb>,
  issueId: string,
  repoId: string,
  branch: string | null,
): ExistingWorkUnit | undefined {
  const lookup = buildWorkUnitLookup(db, issueId, repoId);
  if (branch) {
    const byBranch = db
      .prepare(
        `SELECT id, state, branch, ledger_issue_id, assigned_session_id
         FROM work_units
         WHERE ${lookup.identity}
           AND (branch = ? OR (branch IS NULL AND auth_request_id IS NULL))
           AND state IN ('open', 'committed')
         ORDER BY CASE WHEN branch = ? THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`
      )
      .get(...lookup.params, branch, branch) as ExistingWorkUnit | undefined;
    return byBranch;
  }

  return db
    .prepare(
      `SELECT id, state, branch, ledger_issue_id, assigned_session_id
       FROM work_units
       WHERE ${lookup.identity}
         AND state IN ('open', 'committed')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(...lookup.params) as ExistingWorkUnit | undefined;
}

function findExistingActivateWorkUnit(
  db: ReturnType<typeof getDb>,
  issueId: string,
  repoId: string,
  branch: string | null,
): ExistingWorkUnit | undefined {
  const lookup = buildWorkUnitLookup(db, issueId, repoId);
  if (branch) {
    const byBranch = db
      .prepare(
        `SELECT id, state, branch, ledger_issue_id, assigned_session_id
         FROM work_units
         WHERE ${lookup.identity}
           AND (branch = ? OR (branch IS NULL AND auth_request_id IS NULL))
           AND state IN ('open', 'committed', 'abandoned')
         ORDER BY CASE WHEN branch = ? THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`
      )
      .get(...lookup.params, branch, branch) as ExistingWorkUnit | undefined;
    return byBranch;
  }

  return db
    .prepare(
      `SELECT id, state, branch, ledger_issue_id, assigned_session_id
       FROM work_units
       WHERE ${lookup.identity}
         AND state IN ('open', 'committed')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(...lookup.params) as ExistingWorkUnit | undefined;
}

function buildWorkUnitLookup(
  db: ReturnType<typeof getDb>,
  issueId: string,
  repoId: string,
): { identity: string; params: unknown[] } {
  const ledgerIssueId = resolveLedgerIssueId(db, issueId, repoId);
  return ledgerIssueId
    ? {
        identity: "(ledger_issue_id = ? OR (issue_id = ? AND repo_id = ?))",
        params: [ledgerIssueId, issueId, repoId],
      }
    : {
        identity: "(issue_id = ? AND repo_id = ?)",
        params: [issueId, repoId],
      };
}
