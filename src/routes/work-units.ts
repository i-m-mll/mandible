import { serializeAssignmentTarget, assignmentTargetForSession, parseAssignmentTarget, resolveAssignmentTarget } from "../work-unit-assignment.js";
import { mutateWorkUnit } from "../work-unit-history.js";
import { actorHolder, custodyGate, responsibilityActor, sessionResponsibilityActor, type CustodyOwner, type ResponsibilityActor, type ResponsibilityHolder } from "../responsibility.js";
import { randomUUID } from "node:crypto";
import {
  normalizeAmbientProviderIdentity,
  exactAgentRef,
  providerSessionEnvBindingValues,
  type AmbientProviderIdentity,
} from "../ambient-provider-identity.js";
import { getDb } from "../db.js";
import { linkWorkUnitToLedgerIssue, resolveOperationalIssueRef } from "../ledger/operational-links.js";
import { getLedgerIssueWorkMetadata } from "../ledger/issue-detail.js";
import { normalizeProjectRepoId } from "../ledger/project-registry.js";
import type { RequestLike, RouteRegistrar } from "../server.js";
import type { SessionManager } from "../session-manager.js";
import type { Logger } from "../types.js";
import { resolveSessionOwnerUserId } from "../session-ownership.js";
import { readBody, sendJson } from "./http.js";
import { attributionForRequest } from "../client-auth/authz.js";
import { LedgerStore } from "../ledger/store.js";
import { branchTip } from "../landed-issues.js";
import { checkoutRootsForRef } from "../repo-identity.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import {
  mapWorkUnitRow as mapRow,
  normalizeWorkUnitSessionId,
  workUnitViews,
} from "../work-unit-utils.js";
import type { AuthQueue } from "../auth-queue.js";
import type { ProviderTaskLivenessReader } from "../session-liveness.js";
import type { WorkUnit } from "../contracts.js";
import {
  classifyHolderLiveness,
  CustodyGenerationConflict,
  describeCustodyHolder,
  freshHolderReader,
  holderLabel,
  takeoverCommand,
  transferWorkUnitCustody,
  type CustodyAuthorityPath,
  type CustodyHolder,
  type HolderLiveness,
} from "../work-unit-custody.js";
import { entityRefs, shortRef } from "../entity-refs.js";

// Bug: a247bc3 — work-unit CRUD
// Bug: 8a281b3 — liveness overlay, PATCH, GET /:id
// Bug: f3dbb3e — shared liveness computation extracted to work-unit-utils.ts

interface ClaimInput {
  issue_id: string;
  repo_id: string;
  branch?: string | null;
  parent_branch?: string | null;
  kind?: string;
  expected_generation?: number;
  parent_role_checkpoint_id?: string;
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
  id?: string;
  issue_id?: string;
  repo_id?: string;
  branch?: string;
  expected_generation?: number;
  reason?: string;
}

interface ReleaseIssueInput {
  issue_id: string;
  repo_id: string;
  reason?: string;
  work_units: Array<{ id: string; expected_generation: number }>;
}

interface PatchInput {
  expected_generation?: number;
  reason?: string;
  state?: string;
  assigned_session_id?: string | null;
  auth_request_id?: string | null;
  provider?: string | null;
  provider_session_id?: string | null;
  ambient_identity?: unknown;
}

interface CustodyAssumeInput {
  expected_generation?: number;
  reason?: string;
  parent_role_checkpoint_id?: string | null;
  target_session_id?: string | null;
}

/** Issue 72b00f8 — the narrow auth-queue surface custody approval needs. */
export interface WorkUnitRouteOptions {
  authQueue?: Pick<AuthQueue, "submit" | "raiseNotice">;
  /** Codex thread-writer lock reader for holder liveness; tests inject it. */
  readCodexTaskLiveness?: ProviderTaskLivenessReader;
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

/**
 * A work unit exists to deliver one ledger issue. Refuse, before anything is
 * written, a ref that names no issue or several, rather than creating a unit
 * that auth submission can never bind.
 */
function refuseUnresolvedIssue(
  db: ReturnType<typeof getDb>,
  res: unknown,
  issueRef: string,
  repoId: string,
): boolean {
  const resolved = resolveOperationalIssueRef(db, issueRef, repoId);
  if (resolved.ok || resolved.error === "unavailable") return false;
  if (resolved.error === "ambiguous") {
    sendJson(res, 409, {
      error: "issue_ref_ambiguous",
      message: `Issue ref ${issueRef} matches several ledger issues${resolved.matches ? ` (${resolved.matches.join(", ")})` : ""}; pass a longer id or <project>/<id>.`,
    });
  } else {
    sendJson(res, 404, {
      error: "issue_not_found",
      message: `Issue ref ${issueRef} names no ledger issue; claim against an existing issue id or <project>/<id>.`,
    });
  }
  return true;
}

export function registerWorkUnitRoutes(
  server: RouteRegistrar,
  sessionManager: SessionManager,
  logger: Logger = () => undefined,
  options: WorkUnitRouteOptions = {},
): void {
  const db = getDb();
  const raise_notice = options.authQueue ? (requestId: string) => options.authQueue!.raiseNotice(requestId) : null;
  /**
   * The Codex reader for this request's holder decisions, over lock scans made
   * for it. Taken before the handler reads anything else, so the decision and
   * any write that follows it run in one synchronous turn.
   */
  const holderReader = (unitIds: readonly string[]): Promise<ProviderTaskLivenessReader> => {
    if (options.readCodexTaskLiveness) return Promise.resolve(options.readCodexTaskLiveness);
    const units = unitIds.flatMap((id) => {
      const row = db.prepare("SELECT * FROM work_units WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? [mapRow(row)] : [];
    });
    return freshHolderReader(db, units, sessionManager);
  };

  // POST /api/work-units/claim — create a new work unit (state=open)
  server.post("/api/work-units/claim", async (req, res) => {
    const body = readBody<ClaimInput>(req);

    if (!body.issue_id || typeof body.issue_id !== "string") {
      sendJson(res, 400, { error: "Missing or invalid issue_id" });
      return;
    }
    if (!body.repo_id || typeof body.repo_id !== "string") {
      sendJson(res, 400, { error: "Missing or invalid repo_id" });
      return;
    }

    if (body.kind !== undefined && !["solo", "partition", "integration"].includes(body.kind)) {
      sendJson(res, 400, { error: "kind must be solo, partition or integration." });
      return;
    }
    const repoId = normalizeProjectRepoId(db, body.repo_id);
    if (refuseUnresolvedIssue(db, res, body.issue_id, repoId)) return;
    const assignedSessionId = normalizeWorkUnitSessionId(body.assigned_session_id);
    const ambientIdentity = workUnitAmbientIdentity(req, body);
    if (ambientIdentity && !exactAgentRef(ambientIdentity)) { sendJson(res, 409, { code: "agent_identity_required", error: "Exact executing agent identity is required for custody." }); return; }
    const now = Date.now();
    const match = findExistingWorkUnit(db, body.issue_id, repoId, body.branch ?? null);
    if (match.status === "ambiguous") {
      sendJson(res, 409, { error: "Multiple work units match; specify a unique branch or repair duplicate assignments." });
      return;
    }
    const existing = match.work_unit;

    if (existing) {
      const current = db.prepare("SELECT * FROM work_units WHERE id = ?").get(existing.id) as CustodyRow & { kind: string; ledger_issue_id: string | null };
      const changingKind = body.kind !== undefined && body.kind !== current.kind;
      const ancestry = current as typeof current & { parent_branch: string | null };
      const changingParent = body.parent_branch != null && body.parent_branch !== ancestry.parent_branch;
      if (changingParent && (ancestry.parent_branch || current.auth_request_id)) {
        sendJson(res, 409, { error: current.auth_request_id ? "Auth-bound work-unit ancestry cannot change." : "Existing parent branch conflicts with the requested parent." });
        return;
      }
      let passedOver: ResponsibilityHolder | null = null;
      if (changingKind || body.expected_generation !== undefined) {
        const mutation = custodyMutation(db, req, current, body.expected_generation);
        if (!mutation.ok) { sendJson(res, mutation.status, mutation.refusal); return; }
        passedOver = mutation.passed_over;
      }
      if (changingKind) {
        if (current.auth_request_id || current.kind === "integration") {
          sendJson(res, 409, { error: current.auth_request_id
            ? "Auth-bound work-unit kind cannot change."
            : "Integration work units cannot be downgraded; their custody guards remain in force." });
          return;
        }
        if (!current.ledger_issue_id) {
          sendJson(res, 409, { error: "Kind correction requires a work unit linked to a ledger issue." });
          return;
        }
        if (body.kind === "integration") {
          const issue = db.prepare("SELECT kind FROM ledger_issues WHERE id = ?").get(current.ledger_issue_id) as { kind: string } | undefined;
          const checkpoint = new LedgerStore(db).getLatestIssueCheckpoint(current.ledger_issue_id, "parent-role");
          const payload = checkpoint ? JSON.parse(checkpoint.payload_json) as Record<string, unknown> : null;
          const actor = responsibilityActor(req);
          const refusal = issue?.kind !== "umbrella"
            ? "Integration promotion requires a work unit on an umbrella issue."
            : !body.parent_role_checkpoint_id
              ? "Integration promotion requires --parent-role-checkpoint: run issue parent-role assume and pass the checkpoint it prints."
              : !checkpoint
                ? "This umbrella has no parent-role checkpoint; run issue parent-role assume first."
                : checkpoint.id !== body.parent_role_checkpoint_id
                  ? `Checkpoint ${shortRef(db, "checkpoint", body.parent_role_checkpoint_id)} is not this umbrella's latest parent-role checkpoint (${shortRef(db, "checkpoint", checkpoint.id)}); pass the latest one.`
                  : !custodyGate(db, checkpointOwner(payload), actor).allowed
                    ? "The latest parent-role checkpoint was recorded by another responsible session; run issue parent-role assume with this actor."
                    : null;
          if (refusal) {
            sendJson(res, 403, { error: refusal });
            return;
          }
        }
      }
      const updates: string[] = [];
      const params: unknown[] = [];
      if (changingKind) {
        updates.push("kind = ?");
        params.push(body.kind);
      }
      if (!existing.branch && body.branch) {
        updates.push("branch = ?");
        params.push(body.branch);
      }
      if (changingParent) {
        updates.push("parent_branch = ?");
        params.push(body.parent_branch);
      }
      if ("assigned_session_id" in body) {
        updates.push("assignment_target_json = ?");
        params.push(assignedSessionId ? serializeAssignmentTarget(assignmentTargetForSession(db, assignedSessionId, ambientIdentity)) : null);
      } else if (!(current as unknown as Record<string, unknown>).assignment_target_json && !existing.assigned_session_id && ambientIdentity) {
        updates.push("assignment_target_json = ?");
        params.push(serializeAssignmentTarget(assignmentTargetForSession(db, null, ambientIdentity)));
      }
      if ("assigned_session_id" in body && existing.assigned_session_id !== assignedSessionId) {
        updates.push("assigned_session_id = ?");
        params.push(assignedSessionId);
      }
      if (ambientIdentity) {
        updates.push("execution_identity_json = ?");
        params.push(JSON.stringify(ambientIdentity));
      }
      const actor = responsibilityActor(req);
      // Issue 72b00f8 — a claim that re-records the session or credential on a
      // held unit obeys the holder rule. The holder's own handoff
      // (`claim --session <worker>`) passes because the caller is the holder.
      const unit = mapRow(current as unknown as Record<string, unknown>);
      const refusal = holderRefusal(db, unit, actor);
      if (refusal) { sendJson(res, 409, refusal); return; }
      passedOver ??= heldPassedOver(db, unit, actor);
      const custody = assignInitialCustody(db, existing.id, actor);
      if (!custody.ok) {
        sendJson(res, 409, { error: custody.error, code: "work_unit_custody_conflict" });
        return;
      }
      const corrected = db.transaction(() => {
        if (updates.length > 0) {
          const guard = changingKind
            ? " AND custody_generation = ? AND owner_user_id IS ? AND responsibility_session_id IS ? AND kind = ? AND auth_request_id IS NULL"
            : "";
          const changed = mutateWorkUnit(db, existing.id, () => db.prepare(`UPDATE work_units SET ${updates.join(", ")} WHERE id = ?${guard}`)
            .run(...params, existing.id, ...(changingKind ? [body.expected_generation, current.owner_user_id, current.responsibility_session_id, current.kind] : [])), attributionForRequest(db, req), operatorOverride(passedOver));
          if (changed.changes !== 1) return false;
        }
        if (changingKind) {
          new LedgerStore(db).addIssueCheckpoint(current.ledger_issue_id!, {
            kind: "work-unit-kind",
            payload: {
              work_unit_id: current.id, prior_kind: current.kind, kind: body.kind,
              custody_generation: current.custody_generation,
              authenticated_user_id: current.owner_user_id, responsibility_session_id: current.responsibility_session_id,
              parent_role_checkpoint_id: body.kind === "integration" ? body.parent_role_checkpoint_id : null,
            },
            actor_type: "mandible_user", author_display: req.client_identity!.slug,
            attribution: attributionForRequest(db, req), source: "mandible", created_at: now,
          });
        }
        return true;
      })();
      if (!corrected) {
        sendJson(res, 409, { error: "Work-unit kind or custody changed; refresh and retry.", code: "work_unit_custody_conflict" });
        return;
      }
      const ledgerLink = linkLedgerIssue(db, existing.id, body.issue_id, repoId);
      const updated = db.prepare("SELECT kind, custody_generation FROM work_units WHERE id = ?")
        .get(existing.id) as { kind: string; custody_generation: number };
      sendJson(res, 200, {
        id: existing.id,
        state: existing.state,
        kind: updated.kind,
        custody_generation: updated.custody_generation,
        existing: true,
        ...passedOverReply(db, passedOver),
        ...ledgerLinkFieldsForExisting(ledgerLink, existing.ledger_issue_id),
        ...ledgerIssueMetadataFields(db, ledgerLink, existing.ledger_issue_id),
      });
      return;
    }

    if (body.expected_generation !== undefined || body.parent_role_checkpoint_id !== undefined) {
      sendJson(res, 404, { error: "Kind correction requires an existing exact work unit; claim new work without correction guards." });
      return;
    }
    const id = randomUUID();
    const kind = body.kind ?? "solo";
    const actor = responsibilityActor(req);
    const ownerUserId = actor?.user_id ?? resolveSessionOwnerUserId(
      db,
      {
        provider_session_envs: ambientIdentity
          ? providerSessionEnvBindingValues(ambientIdentity.provider)
          : [],
      },
      logger,
      { source: "work_unit", entity_id: id },
    );

    mutateWorkUnit(db, id, () => db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, parent_branch, kind, state, assigned_session_id,
        execution_identity_json, created_at, owner_user_id, responsibility_session_id, custody_generation, assignment_target_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      body.issue_id,
      repoId,
      body.branch ?? null,
      body.parent_branch ?? null,
      kind,
      assignedSessionId,
      ambientIdentity ? JSON.stringify(ambientIdentity) : null,
      now,
      ownerUserId,
      null,
      0,
      "assigned_session_id" in body && !assignedSessionId ? null : serializeAssignmentTarget(assignmentTargetForSession(db, assignedSessionId, ambientIdentity)),
    ));
    if (actor) assignInitialCustody(db, id, actor);

    const ledgerLink = linkLedgerIssue(db, id, body.issue_id, repoId);
    sendJson(res, 201, {
      id,
      kind,
      custody_generation: actor ? 1 : 0,
      ...ledgerLinkFields(ledgerLink),
      ...ledgerIssueMetadataFields(db, ledgerLink),
    });
  }, { operation: { id: "post:/api/work-units/claim", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow",
    refs: { body: { parent_role_checkpoint_id: entityRefs.checkpoint, assigned_session_id: entityRefs.session } } });

  // POST /api/work-units/activate — mark as committed, update timestamps
  server.post("/api/work-units/activate", async (req, res) => {
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
    if (ambientIdentity && !exactAgentRef(ambientIdentity)) { sendJson(res, 409, { code: "agent_identity_required", error: "Exact executing agent identity is required for custody." }); return; }
    if (body.worker_owner !== undefined && typeof body.worker_owner !== "boolean") {
      sendJson(res, 400, { error: "worker_owner must be a boolean" });
      return;
    }
    if (refuseUnresolvedIssue(db, res, body.issue_id, repoId)) return;

    const match = findExistingWorkUnit(db, body.issue_id, repoId, body.branch ?? null);
    if (match.status === "ambiguous") {
      sendJson(res, 409, { error: "Multiple work units match; specify a unique branch or repair duplicate assignments." });
      return;
    }
    const existing = match.work_unit;

    if (existing) {
      const actor = responsibilityActor(req);
      // Issue 72b00f8 — activation re-records the session, so it obeys the
      // holder rule and never takes a unit over implicitly.
      const unit = mapRow(db.prepare("SELECT * FROM work_units WHERE id = ?").get(existing.id) as Record<string, unknown>);
      const refusal = holderRefusal(db, unit, actor);
      if (refusal) { sendJson(res, 409, refusal); return; }
      const passedOver = heldPassedOver(db, unit, actor);
      const custody = assignInitialCustody(db, existing.id, actor);
      if (!custody.ok) {
        sendJson(res, 409, { error: custody.error, code: "work_unit_custody_conflict" });
        return;
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
        updates.push("assignment_target_json = ?");
        params.push(assignedSessionId ? serializeAssignmentTarget(assignmentTargetForSession(db, assignedSessionId, ambientIdentity)) : null);
      } else if (ambientIdentity) {
        const row = db.prepare("SELECT * FROM work_units WHERE id = ?").get(existing.id) as Record<string, unknown>;
        const holder = assignmentTargetForSession(db, existing.assigned_session_id,
          normalizeAmbientProviderIdentity(typeof row.execution_identity_json === "string" ? JSON.parse(row.execution_identity_json) : null));
        const identity = resolveAssignmentTarget(db, holder);
        const ambient = assignmentTargetForSession(db, null, ambientIdentity);
        if (!parseAssignmentTarget(row.assignment_target_json) && identity && ambient?.kind === "native"
          && identity.agent_ref === ambient.agent_ref) {
          updates.push("assignment_target_json = ?");
          params.push(JSON.stringify(ambient));
        }
      }
      if ("assigned_session_id" in body) {
        updates.push("assigned_session_id = ?");
        params.push(assignedSessionId);
      }
      if (ambientIdentity) {
        updates.push("execution_identity_json = ?");
        params.push(JSON.stringify(ambientIdentity));
      }
      params.push(existing.id);

      mutateWorkUnit(db, existing.id, () => db.prepare(
        `UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`
      ).run(...params), attributionForRequest(db, req), operatorOverride(passedOver));

      const ledgerLink = linkLedgerIssue(db, existing.id, body.issue_id, repoId);
      sendJson(res, 200, {
        ...passedOverReply(db, passedOver),
        id: existing.id,
        state: "committed",
        ...ledgerLinkFieldsForExisting(ledgerLink, existing.ledger_issue_id),
        ...ledgerIssueMetadataFields(db, ledgerLink, existing.ledger_issue_id),
      });
    } else {
      // No existing work unit — create one in committed state (auto-claim)
      const id = randomUUID();
      const actor = responsibilityActor(req);
      const ownerUserId = actor?.user_id ?? resolveSessionOwnerUserId(
        db,
        {
          provider_session_envs: ambientIdentity
            ? providerSessionEnvBindingValues(ambientIdentity.provider)
            : [],
        },
        logger,
        { source: "work_unit", entity_id: id },
      );
      mutateWorkUnit(db, id, () => db.prepare(
        `INSERT INTO work_units (
          id, issue_id, repo_id, branch, kind, state, assigned_session_id,
          execution_identity_json, created_at, activated_at, last_commit_at,
          owner_user_id, worker_provider_session_id, responsibility_session_id, custody_generation, assignment_target_json
        ) VALUES (?, ?, ?, ?, 'solo', 'committed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.issue_id,
        repoId,
        body.branch ?? null,
        assignedSessionId,
        ambientIdentity ? JSON.stringify(ambientIdentity) : null,
        now,
        now,
        now,
        ownerUserId,
        null,
        null,
        0,
        "assigned_session_id" in body && !assignedSessionId ? null : serializeAssignmentTarget(assignmentTargetForSession(db, assignedSessionId, ambientIdentity)),
      ));
      if (actor) assignInitialCustody(db, id, actor);

      const ledgerLink = linkLedgerIssue(db, id, body.issue_id, repoId);
      sendJson(res, 201, {
        id,
        state: "committed",
        ...ledgerLinkFields(ledgerLink),
        ...ledgerIssueMetadataFields(db, ledgerLink),
      });
    }
  }, { operation: { id: "post:/api/work-units/activate", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow",
    refs: { body: { assigned_session_id: entityRefs.session } } });

  server.post("/api/work-units/release", (req, res) => {
    const body = readBody<ReleaseInput>(req);
    if ([body.id, body.issue_id, body.repo_id, body.branch].some(value => value !== undefined && (typeof value !== "string" || !value.trim())) ||
        (!body.id && (!body.repo_id || !body.branch)) ||
        (body.id && (body.repo_id || body.branch || body.issue_id))) {
      sendJson(res, 400, { error: "Select --id or an explicit repository and branch." });
      return;
    }
    const rows = body.id
      ? db.prepare("SELECT * FROM work_units WHERE id = ?").all(body.id)
      : db.prepare(`SELECT * FROM work_units WHERE repo_id = ? AND branch = ?
          AND state IN ('open', 'committed', 'abandoned')`)
        .all(normalizeProjectRepoId(db, body.repo_id!), body.branch);
    if (rows.length !== 1) {
      sendJson(res, rows.length ? 409 : 404, { error: rows.length
        ? "Multiple work units match; select an exact ID." : "Work unit not found." });
      return;
    }
    const row = rows[0] as CustodyRow;
    if (body.issue_id) {
      const lookup = buildWorkUnitLookup(db, body.issue_id, row.repo_id);
      if (!db.prepare(`SELECT 1 FROM work_units WHERE id = ? AND ${lookup.identity}`).get(row.id, ...lookup.params)) {
        sendJson(res, 409, { error: "Work unit does not belong to the requested issue." });
        return;
      }
    }
    const mutation = custodyMutation(db, req, row, body.expected_generation);
    if (!mutation.ok) { sendJson(res, mutation.status, mutation.refusal); return; }
    if (row.state === 'resolved') {
      sendJson(res, 409, { error: "Resolved work cannot be released." });
      return;
    }
    if (!body.reason?.trim()) { sendJson(res, 400, { error: "reason is required" }); return; }
    transferWorkUnitCustody(db, { unit: mapRow(rows[0] as Record<string, unknown>), expected_generation: body.expected_generation!,
      new_user_id: null, new_session_id: null, authority_path: "handoff", reason: body.reason.trim(), comment_attribution: attributionForRequest(db, req), raise_notice });
    sendJson(res, 200, { ...passedOverReply(db, mutation.passed_over), ok: true, id: row.id, released: 1 });
  }, { operation: { id: "post:/api/work-units/release", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow",
    refs: { body: { id: entityRefs.workUnit } } });

  server.post("/api/work-units/release-issue", (req, res) => {
    const body = readBody<ReleaseIssueInput>(req);
    if (typeof body.issue_id !== "string" || !body.issue_id || typeof body.repo_id !== "string" || !body.repo_id || !Array.isArray(body.work_units) ||
        body.work_units.some(unit => !unit || typeof unit.id !== "string" || !unit.id || !Number.isInteger(unit.expected_generation))) {
      sendJson(res, 400, { error: "Explicit issue, repository and work_units snapshot are required." });
      return;
    }
    const lookup = buildWorkUnitLookup(db, body.issue_id, normalizeProjectRepoId(db, body.repo_id));
    const rows = db.prepare(`SELECT * FROM work_units WHERE ${lookup.identity}
      AND state IN ('open', 'committed')`).all(...lookup.params) as CustodyRow[];
    if (rows.length !== body.work_units.length || new Set(body.work_units.map(x => x.id)).size !== rows.length ||
        rows.some(row => !body.work_units.some(x => x.id === row.id))) {
      sendJson(res, 409, { error: "Issue work-unit set changed; refresh the explicit snapshot." });
      return;
    }
    for (const row of rows) {
      const mutation = custodyMutation(db, req, row,
        body.work_units.find(x => x.id === row.id)!.expected_generation);
      if (!mutation.ok) { sendJson(res, mutation.status, mutation.refusal); return; }
    }
    if (!body.reason?.trim()) { sendJson(res, 400, { error: "reason is required" }); return; }
    db.transaction(() => {
      for (const row of rows) transferWorkUnitCustody(db, { unit: mapRow(row as unknown as Record<string, unknown>), expected_generation: row.custody_generation,
        new_user_id: null, new_session_id: null, authority_path: "handoff", reason: body.reason!.trim(), comment_attribution: attributionForRequest(db, req), raise_notice });
    })();
    sendJson(res, 200, { ok: true, released: rows.length });
  }, { operation: { id: "post:/api/work-units/release-issue", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow" });

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

    sendJson(res, 200, { work_units: workUnitViews(rows.map(mapRow), sessionManager) });
  }, { operation: { id: "get:/api/work-units", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  // Issue 72b00f8 — read-only custody answer for commit wrappers. Registered
  // before GET /api/work-units/:id so the literal path is not read as an id.
  server.get("/api/work-units/custody-check", async (req, res) => {
    const actor = responsibilityActor(req);
    const repoParam = typeof req.query.repo_id === "string" ? req.query.repo_id.trim() : "";
    const branch = typeof req.query.branch === "string" ? req.query.branch.trim() : "";
    const issueParam = typeof req.query.issue_id === "string" ? req.query.issue_id.trim() : "";
    if (!repoParam || !branch) {
      sendJson(res, 400, { error: "repo_id and branch are required." });
      return;
    }
    const repoId = normalizeProjectRepoId(db, repoParam);
    let rows: Record<string, unknown>[];
    if (issueParam) {
      const match = findExistingWorkUnit(db, issueParam, repoId, branch);
      if (match.status === "ambiguous") {
        sendJson(res, 409, { error: "Multiple work units match; specify a unique branch or repair duplicate assignments." });
        return;
      }
      rows = match.work_unit ? [db.prepare("SELECT * FROM work_units WHERE id = ?").get(match.work_unit.id) as Record<string, unknown>] : [];
    } else {
      rows = db.prepare("SELECT * FROM work_units WHERE repo_id = ? AND branch = ? AND state IN ('open', 'committed')")
        .all(repoId, branch) as Record<string, unknown>[];
      if (rows.length > 1) {
        sendJson(res, 409, { error: "Multiple work units match; pass --issue or repair duplicate assignments." });
        return;
      }
    }
    const unit = rows[0] ? mapRow(rows[0]) : null;
    const readCodexTask = await holderReader(unit ? [unit.id] : []);
    sendJson(res, 200, custodyCheck(db, unit, actor, sessionManager, readCodexTask));
  }, { operation: { id: "get:/api/work-units/custody-check", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.post("/api/work-units/:id/custody/assume", async (req, res) => {
    const actor = responsibilityActor(req);
    const body = readBody<CustodyAssumeInput>(req);
    if (!Number.isInteger(body.expected_generation) || !body.reason?.trim()) {
      sendJson(res, 400, { error: "expected_generation and a non-empty reason are required" });
      return;
    }
    const row = db.prepare("SELECT * FROM work_units WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
    if (!row) {
      sendJson(res, 404, { error: "Work unit not found" });
      return;
    }
    const unit = mapRow(row);
    const project = resolveProjectRef(db, unit.repo_id);
    if (!project.ok) {
      sendJson(res, 409, { error: "Work-unit project identity is not unique." });
      return;
    }
    if (unit.custody_generation !== body.expected_generation) {
      sendJson(res, 409, { error: "Responsibility changed; refresh and retry.", code: "custody_generation_conflict" }); return;
    }
    let next = actorHolder(actor);
    let passedOver: ResponsibilityHolder | null = null;
    if (body.target_session_id) {
      const decision = custodyGate(db, unit, actor);
      if (!decision.allowed) {
        sendJson(res, 403, { error: "Only the responsible session may hand this unit to another session." }); return;
      }
      passedOver = decision.passed_over;
      const target = sessionResponsibilityActor(db, body.target_session_id);
      if (!target) { sendJson(res, 400, { error: "Successor session has no resolved user." }); return; }
      next = actorHolder(target);
    }
    const authorityPath: CustodyAuthorityPath = body.target_session_id ? "handoff" : "explicit_assumption";
    try {
      const transferred = transferWorkUnitCustody(db, {
        unit,
        expected_generation: body.expected_generation!,
        new_user_id: next.user_id,
        new_session_id: next.session_id,
        authority_path: authorityPath,
        reason: body.reason.trim(),
        comment_attribution: attributionForRequest(db, req),
        raise_notice,
      });
      sendJson(res, 200, { ...passedOverReply(db, passedOver), work_unit: transferred, authority_path: authorityPath });
    } catch (error) {
      if (error instanceof CustodyGenerationConflict) {
        sendJson(res, 409, { error: error.message, code: "custody_generation_conflict" });
        return;
      }
      throw error;
    }
  }, { operation: { id: "post:/api/work-units/:id/custody/assume", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow",
    refs: { params: { id: entityRefs.workUnit }, body: { parent_role_checkpoint_id: entityRefs.checkpoint, target_session_id: entityRefs.session } } });

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
    sendJson(res, 200, workUnitViews([workUnit], sessionManager)[0]);
  }, { operation: { id: "get:/api/work-units/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny",
    refs: { params: { id: entityRefs.workUnit } } });

  // PATCH /api/work-units/:id — update mutable fields
  // Bug: 8a281b3
  server.patch("/api/work-units/:id", async (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing work unit id" });
      return;
    }

    const body = readBody<PatchInput>(req);
    const before = db.prepare("SELECT repo_id, branch, state FROM work_units WHERE id = ?")
      .get(id) as { repo_id: string; branch: string | null; state: string } | undefined;
    // Issue 9395f25 — a unit resolved outside a merge request (wt merge, wt rm,
    // `work-unit resolve`) records its branch tip, which the target now contains.
    const landedCommit = body.state === "resolved" && before?.state !== "resolved" && before?.branch
      ? await branchTip(checkoutRootsForRef(db, before.repo_id), before.branch)
      : null;

    const existing = db
      .prepare("SELECT * FROM work_units WHERE id = ?")
      .get(id) as CustodyRow | undefined;

    if (!existing) {
      sendJson(res, 404, { error: "Work unit not found" });
      return;
    }

    if ((body.reason !== undefined && (typeof body.reason !== "string" || !body.reason.trim())) ||
        (body.state === "abandoned" && !body.reason?.trim())) {
      sendJson(res, 400, { error: "A non-empty reason is required to abandon work." }); return;
    }
    let passedOver: ResponsibilityHolder | null = null;
    {
      const mutation = custodyMutation(db, req, existing, body.expected_generation);
      if (!mutation.ok) { sendJson(res, mutation.status, mutation.refusal); return; }
      passedOver = mutation.passed_over;
      if (existing.auth_request_id && ((body.state !== undefined && body.state !== existing.state) ||
          ("auth_request_id" in body && body.auth_request_id !== existing.auth_request_id))) {
        sendJson(res, 409, { error: "Auth-bound delivery state is owned by the auth lifecycle." });
        return;
      }
    }

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
        if (landedCommit) {
          updates.push("landed_commit = ?");
          params.push(landedCommit);
        }
      }
    }

    if ("assigned_session_id" in body) {
      updates.push("assignment_target_json = ?");
      const assigned = normalizeWorkUnitSessionId(body.assigned_session_id);
      params.push(assigned ? serializeAssignmentTarget(assignmentTargetForSession(db, assigned, ambientIdentity)) : null);
      updates.push("assigned_session_id = ?");
      params.push(normalizeWorkUnitSessionId(body.assigned_session_id));
    }

    if ("auth_request_id" in body) {
      updates.push("auth_request_id = ?");
      params.push(body.auth_request_id ?? null);
    }

    if (ambientIdentity) {
      updates.push("execution_identity_json = ?");
      params.push(JSON.stringify(ambientIdentity));
    }

    if (updates.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }

    params.push(id);
    mutateWorkUnit(db, id, () => db.prepare(
      `UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`
    ).run(...params), attributionForRequest(db, req), body.reason || passedOver
      ? { ...(body.reason ? { reason: body.reason.trim() } : {}), ...operatorOverride(passedOver) } : undefined);

    const updatedRow = db
      .prepare("SELECT * FROM work_units WHERE id = ?")
      .get(id) as Record<string, unknown>;

    const workUnit = mapRow(updatedRow);
    sendJson(res, 200, { ...workUnitViews([workUnit], sessionManager)[0], ...passedOverReply(db, passedOver) });
  }, { operation: { id: "patch:/api/work-units/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work_units" }, fileRpc: "allow",
    refs: { params: { id: entityRefs.workUnit }, body: { auth_request_id: entityRefs.authRequest, assigned_session_id: entityRefs.session } } });
}

/**
 * Initial custody for the caller of a claim or activation. An unheld unit goes
 * to the caller; a held one stays with its holder when the gate allows the
 * caller, and the user never takes it over by acting.
 */
function assignInitialCustody(db: ReturnType<typeof getDb>, workUnitId: string, actor: ResponsibilityActor): { ok: true } | { ok: false; error: string } {
  const row = db.prepare("SELECT * FROM work_units WHERE id = ?").get(workUnitId) as CustodyRow;
  if (row.custody_generation > 0 && custodyGate(db, row, actor).allowed) return { ok: true };
  if (row.custody_generation > 0 || row.auth_request_id) return { ok: false, error: "Another session is responsible for this unit; only it, or a session it hands responsibility to, may change it." };
  const holder = actorHolder(actor);
  db.prepare(`UPDATE work_units SET owner_user_id = ?, responsibility_session_id = ?, custody_generation = 1 WHERE id = ? AND custody_generation = 0`)
    .run(holder.user_id, holder.session_id, workUnitId);
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

function findExistingWorkUnit(
  db: ReturnType<typeof getDb>, issueId: string, repoId: string,
  branch: string | null,
): { status: "matched"; work_unit: ExistingWorkUnit | undefined } | { status: "ambiguous" } {
  const lookup = buildWorkUnitLookup(db, issueId, repoId);
  const candidates = db.prepare(`SELECT id, state, branch, ledger_issue_id, assigned_session_id
    FROM work_units WHERE ${lookup.identity} AND state IN ('open', 'committed')
      ${branch ? "AND (branch = ? OR (branch IS NULL AND auth_request_id IS NULL))" : ""}`)
    .all(...lookup.params, ...(branch ? [branch] : [])) as ExistingWorkUnit[];
  const exact = branch ? candidates.filter(row => row.branch === branch) : candidates;
  const matches = exact.length ? exact : candidates;
  return matches.length > 1 ? { status: "ambiguous" } : { status: "matched", work_unit: matches[0] };
}

function buildWorkUnitLookup(
  db: ReturnType<typeof getDb>,
  issueId: string,
  repoId: string,
): { identity: string; params: unknown[] } {
  const ledgerIssueId = resolveLedgerIssueId(db, issueId, repoId);
  return ledgerIssueId
    ? {
        identity: "(ledger_issue_id = ? OR issue_id = ?) AND repo_id = ?",
        params: [ledgerIssueId, issueId, repoId],
      }
    : {
        identity: "(issue_id = ? AND repo_id = ?)",
        params: [issueId, repoId],
      };
}

type CustodyRow = {
  id: string;
  repo_id: string;
  state: string;
  owner_user_id: string | null;
  responsibility_session_id: string | null;
  custody_generation: number;
  auth_request_id: string | null;
};

type CustodyMutation =
  | { ok: true; passed_over: ResponsibilityHolder | null }
  | { ok: false; status: number; refusal: { error: string; code: string } };

function custodyMutation(
  db: ReturnType<typeof getDb>, req: RequestLike, row: CustodyRow, expectedGeneration: unknown,
): CustodyMutation {
  if (!Number.isInteger(expectedGeneration) || expectedGeneration !== row.custody_generation) {
    return { ok: false, status: 409, refusal: { error: "Work-unit custody changed or expected_generation is missing; refresh and retry.", code: "custody_generation_conflict" } };
  }
  const decision = custodyGate(db, row, responsibilityActor(req));
  if (!decision.allowed) {
    return { ok: false, status: 403, refusal: { error: "Only the current responsible user and session may change delivery state.", code: "work_unit_custody_conflict" } };
  }
  return { ok: true, passed_over: decision.passed_over };
}

/** Ordinary writes by an agent do not transfer responsibility; a held unit refuses a non-holding agent. */
function holderRefusal(db: ReturnType<typeof getDb>, unit: WorkUnit, actor: ResponsibilityActor): Record<string, unknown> | null {
  if (unit.custody_generation === 0 || custodyGate(db, unit, actor).allowed) return null;
  return { error: "Another session is responsible for this unit; ordinary writes do not transfer responsibility.",
    code: "responsibility_transfer_required", holder: describeCustodyHolder(db, unit.owner_user_id, unit.responsibility_session_id), takeover_command: takeoverCommand(db, unit) };
}

/** The holder of a held unit that the actor passes over by acting on it. */
function heldPassedOver(db: ReturnType<typeof getDb>, unit: WorkUnit, actor: ResponsibilityActor): ResponsibilityHolder | null {
  if (unit.custody_generation === 0) return null;
  const decision = custodyGate(db, unit, actor);
  return decision.allowed ? decision.passed_over : null;
}

/** The parent-role checkpoint's holder as a custody owner. */
function checkpointOwner(payload: Record<string, unknown> | null): CustodyOwner {
  return {
    owner_user_id: typeof payload?.authenticated_user_id === "string" ? payload.authenticated_user_id : null,
    responsibility_session_id: typeof payload?.responsibility_session_id === "string" ? payload.responsibility_session_id : null,
  };
}

/** The work-unit timeline payload recording that the user acted over a holder, who keeps custody. */
function operatorOverride(passedOver: ResponsibilityHolder | null): Record<string, unknown> | undefined {
  return passedOver ? { authority_path: "operator", custody_passed_over: passedOver } : undefined;
}

function passedOverReply(db: ReturnType<typeof getDb>, passedOver: ResponsibilityHolder | null): { custody_passed_over?: CustodyHolder } {
  return passedOver ? { custody_passed_over: describeCustodyHolder(db, passedOver.user_id, passedOver.session_id) } : {};
}

export type CustodyCheckOutcome = "clear" | "held" | "takeover_available";

/**
 * Issue 72b00f8 — whether the calling credential may commit on a branch's work
 * unit. `clear`: the caller holds the unit, or no credential holds it and the
 * caller may claim it. `held`: another responsible session holds it and its session is
 * live or of unknown liveness, so takeover needs the operator. `takeover_available`:
 * another responsible session holds it and its session has stopped.
 */
function custodyCheck(
  db: ReturnType<typeof getDb>,
  unit: WorkUnit | null,
  actor: ResponsibilityActor,
  sessionManager: SessionManager,
  readCodexTask: ProviderTaskLivenessReader,
): Record<string, unknown> {
  const unitFields = unit ? {
    id: unit.id, issue_id: unit.issue_id, ledger_issue_id: unit.ledger_issue_id, branch: unit.branch,
    kind: unit.kind, state: unit.state, custody_generation: unit.custody_generation,
  } : null;
  const answer = (outcome: CustodyCheckOutcome, message: string, extra: {
    holder?: CustodyHolder | null; holder_liveness?: HolderLiveness | null;
    takeover_command?: string | null; warning?: string | null;
  } = {}) => ({
    outcome,
    may_commit: outcome === "clear",
    message,
    work_unit: unitFields,
    holder: extra.holder ?? null,
    holder_liveness: extra.holder_liveness ?? null,
    takeover_command: extra.takeover_command ?? null,
    warning: extra.warning ?? null,
  });
  if (!unit) return answer("clear", "No work unit is registered for this branch; committing claims one.");
  const holder = describeCustodyHolder(db, unit.owner_user_id, unit.responsibility_session_id);
  const liveness = classifyHolderLiveness(db, unit, sessionManager, readCodexTask);
  const decision = unit.custody_generation === 0 ? { allowed: true as const, passed_over: null } : custodyGate(db, unit, actor);
  if (decision.allowed) return answer("clear", "You may work on this unit.", { holder, holder_liveness: liveness,
    warning: decision.passed_over ? `Held by ${holderLabel(holder)}; it keeps custody.` : null });
  return answer("takeover_available", "Explicitly assume responsibility before writing. Existing execution may still be running.",
    { holder, holder_liveness: liveness, takeover_command: takeoverCommand(db, unit) });
}
