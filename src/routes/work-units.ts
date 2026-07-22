import { randomUUID } from "node:crypto";
import {
  normalizeAmbientProviderIdentity,
  providerSessionEnvBindingValues,
  type AmbientProviderIdentity,
} from "../ambient-provider-identity.js";
import { getDb } from "../db.js";
import { linkWorkUnitToLedgerIssue, resolveOperationalIssueRef } from "../ledger/operational-links.js";
import type { RequestLike, RouteRegistrar } from "../server.js";
import type { SessionRegistry } from "../registry.js";
import type { SessionManager } from "../session-manager.js";
import type { Logger, WorkUnit, WorkUnitState } from "../types.js";
import { resolveSessionOwnerUserId } from "../session-ownership.js";
import { readBody, sendJson } from "./http.js";
import {
  mapWorkUnitRow as mapRow,
  normalizeWorkUnitSessionId,
  computeLiveness,
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

const VALID_STATES: Set<string> = new Set(["open", "committed", "resolved", "abandoned"]);

type ExistingWorkUnit = {
  id: string;
  state: string;
  branch: string | null;
  ledger_issue_id: string | null;
  assigned_session_id: string | null;
};

function linkLedgerIssue(
  db: ReturnType<typeof getDb>,
  workUnitId: string,
  issueId: string,
  repoId: string,
): string | null {
  try {
    const result = linkWorkUnitToLedgerIssue(db, {
      work_unit_id: workUnitId,
      issue_ref: issueId,
      repo_ref: repoId,
    });
    return result.ok ? result.issue_id : null;
  } catch {
    return null;
  }
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

    const assignedSessionId = normalizeWorkUnitSessionId(body.assigned_session_id);
    const ambientIdentity = workUnitAmbientIdentity(req, body);
    const existing = findExistingClaimWorkUnit(db, body.issue_id, body.repo_id, body.branch ?? null);

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
      if (updates.length > 0) {
        params.push(existing.id);
        db.prepare(`UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      }
      const ledgerIssueId = linkLedgerIssue(db, existing.id, body.issue_id, body.repo_id) ?? existing.ledger_issue_id;
      sendJson(res, 200, {
        id: existing.id,
        state: existing.state,
        existing: true,
        ledger_issue_id: ledgerIssueId,
      });
      return;
    }

    const id = randomUUID();
    const now = Date.now();
    const kind = body.kind && ["solo", "partition", "integration"].includes(body.kind)
      ? body.kind
      : "solo";
    const ownerUserId = resolveSessionOwnerUserId(
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
        provider, provider_session_id, created_at, owner_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`
    ).run(
      id,
      body.issue_id,
      body.repo_id,
      body.branch ?? null,
      body.parent_branch ?? null,
      kind,
      assignedSessionId,
      ambientIdentity?.provider ?? null,
      ambientIdentity?.provider_session_id ?? null,
      now,
      ownerUserId,
    );

    const ledgerIssueId = linkLedgerIssue(db, id, body.issue_id, body.repo_id);
    sendJson(res, 201, { id, ledger_issue_id: ledgerIssueId });
  }, { fileRpc: "allow" });

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

    const now = Date.now();
    const assignedSessionId = normalizeWorkUnitSessionId(body.assigned_session_id);
    const ambientIdentity = workUnitAmbientIdentity(req, body);

    const existing = findExistingActivateWorkUnit(db, body.issue_id, body.repo_id, body.branch ?? null);

    if (existing) {
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
      params.push(existing.id);

      db.prepare(
        `UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`
      ).run(...params);

      const ledgerIssueId = linkLedgerIssue(db, existing.id, body.issue_id, body.repo_id) ?? existing.ledger_issue_id;
      sendJson(res, 200, { id: existing.id, state: "committed", ledger_issue_id: ledgerIssueId });
    } else {
      // No existing work unit — create one in committed state (auto-claim)
      const id = randomUUID();
      const ownerUserId = resolveSessionOwnerUserId(
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
          owner_user_id
        ) VALUES (?, ?, ?, ?, 'solo', 'committed', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.issue_id,
        body.repo_id,
        body.branch ?? null,
        assignedSessionId,
        ambientIdentity?.provider ?? null,
        ambientIdentity?.provider_session_id ?? null,
        now,
        now,
        now,
        ownerUserId,
      );

      const ledgerIssueId = linkLedgerIssue(db, id, body.issue_id, body.repo_id);
      sendJson(res, 201, { id, state: "committed", ledger_issue_id: ledgerIssueId });
    }
  }, { fileRpc: "allow" });

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

    const lookup = buildWorkUnitLookup(db, body.issue_id, body.repo_id);
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
  }, { fileRpc: "allow" });

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
      params.push(req.query.repo_id);
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
  }, { fileRpc: "allow" });

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
  }, { fileRpc: "deny" });

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
  }, { fileRpc: "allow" });
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
           AND (branch = ? OR branch IS NULL)
           AND state IN ('open', 'committed')
         ORDER BY CASE WHEN branch = ? THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`
      )
      .get(...lookup.params, branch, branch) as ExistingWorkUnit | undefined;
    if (byBranch) return byBranch;
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
           AND (branch = ? OR branch IS NULL)
           AND state IN ('open', 'committed', 'abandoned')
         ORDER BY CASE WHEN branch = ? THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`
      )
      .get(...lookup.params, branch, branch) as ExistingWorkUnit | undefined;
    if (byBranch) return byBranch;
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
