import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type { SessionRegistry } from "../registry.js";
import type { SessionManager } from "../session-manager.js";
import type { WorkUnit, WorkUnitState } from "../types.js";

// Bug: a247bc3 — work-unit CRUD for inbox workqueue
// Bug: 8a281b3 — liveness overlay, PATCH, GET /:id

interface ClaimInput {
  issue_id: string;
  repo_id: string;
  branch?: string | null;
  parent_branch?: string | null;
  kind?: string;
  assigned_session_id?: string | null;
}

interface ActivateInput {
  issue_id: string;
  repo_id: string;
  branch?: string | null;
  assigned_session_id?: string | null;
}

interface ReleaseInput {
  issue_id: string;
  repo_id: string;
}

interface PatchInput {
  state?: string;
  assigned_session_id?: string | null;
  continuation?: string | null;
  continuation_by?: string | null;
  continuation_at?: number | null;
  auth_request_id?: string | null;
}

// Bug: 8a281b3 — liveness data derived at query time, not stored
export interface WorkUnitLiveness {
  has_live_agent: boolean;
  agent_session_id: string | null;
  agent_status: string | null;
  is_processing: boolean;
  last_activity: number | null;
}

export interface WorkUnitWithLiveness extends WorkUnit {
  liveness: WorkUnitLiveness;
}

function readBody<T>(req: RequestLike): T {
  return (req.body ?? {}) as T;
}

function sendJson(res: ResponseLike, code: number, payload: unknown): void {
  res.status(code).json(payload);
}

function mapRow(row: Record<string, unknown>): WorkUnit {
  return {
    id: String(row.id ?? ""),
    issue_id: String(row.issue_id ?? ""),
    repo_id: String(row.repo_id ?? ""),
    branch: typeof row.branch === "string" ? row.branch : null,
    parent_branch: typeof row.parent_branch === "string" ? row.parent_branch : null,
    kind: (row.kind as WorkUnit["kind"]) ?? "solo",
    state: (row.state as WorkUnit["state"]) ?? "open",
    assigned_session_id: typeof row.assigned_session_id === "string" ? row.assigned_session_id : null,
    continuation: typeof row.continuation === "string" ? row.continuation : null,
    continuation_by: typeof row.continuation_by === "string" ? row.continuation_by : null,
    continuation_at: typeof row.continuation_at === "number" ? row.continuation_at : null,
    created_at: Number(row.created_at ?? 0),
    activated_at: typeof row.activated_at === "number" ? row.activated_at : null,
    last_commit_at: typeof row.last_commit_at === "number" ? row.last_commit_at : null,
    resolved_at: typeof row.resolved_at === "number" ? row.resolved_at : null,
    auth_request_id: typeof row.auth_request_id === "string" ? row.auth_request_id : null,
  };
}

const VALID_STATES: Set<string> = new Set(["open", "committed", "resolved", "abandoned"]);

/**
 * Compute liveness overlay for a work unit by joining to sessions and console_sessions.
 * Bug: 8a281b3 — liveness is derived at query time, never stored.
 */
function computeLiveness(
  workUnit: WorkUnit,
  sessionRegistry: SessionRegistry,
  sessionManager: SessionManager,
): WorkUnitLiveness {
  const db = getDb();
  const noLiveness: WorkUnitLiveness = {
    has_live_agent: false,
    agent_session_id: null,
    agent_status: null,
    is_processing: false,
    last_activity: null,
  };

  if (!workUnit.branch) {
    return noLiveness;
  }

  // Find the most recent active/idle session on this branch
  const sessionRow = db
    .prepare(
      `SELECT id, status, last_active FROM sessions
       WHERE branch = ? AND status IN ('active', 'idle')
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(workUnit.branch) as { id: string; status: string; last_active: string | null } | undefined;

  if (!sessionRow) {
    return noLiveness;
  }

  // Check SDK processing state via console_sessions
  let isProcessing = false;
  const consoleRow = db
    .prepare(
      `SELECT id FROM console_sessions
       WHERE mandible_session_id = ? AND status = 'running'
       LIMIT 1`
    )
    .get(sessionRow.id) as { id: string } | undefined;

  if (consoleRow) {
    const backend = sessionManager.get(consoleRow.id);
    if (backend && "isProcessing" in backend && typeof backend.isProcessing === "boolean") {
      isProcessing = backend.isProcessing;
    }
  }

  const lastActive = sessionRow.last_active ? new Date(sessionRow.last_active).getTime() : null;

  return {
    has_live_agent: true,
    agent_session_id: sessionRow.id,
    agent_status: sessionRow.status,
    is_processing: isProcessing,
    last_activity: lastActive,
  };
}

function enrichWithLiveness(
  workUnit: WorkUnit,
  sessionRegistry: SessionRegistry,
  sessionManager: SessionManager,
): WorkUnitWithLiveness {
  return {
    ...workUnit,
    liveness: computeLiveness(workUnit, sessionRegistry, sessionManager),
  };
}

export function registerWorkUnitRoutes(
  server: RouteRegistrar,
  sessionRegistry: SessionRegistry,
  sessionManager: SessionManager,
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

    // Check for existing open/committed work unit for this issue+repo
    const existing = db
      .prepare(
        "SELECT id, state FROM work_units WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed')"
      )
      .get(body.issue_id, body.repo_id) as { id: string; state: string } | undefined;

    if (existing) {
      sendJson(res, 200, { id: existing.id, state: existing.state, existing: true });
      return;
    }

    const id = randomUUID();
    const now = Date.now();
    const kind = body.kind && ["solo", "partition", "integration"].includes(body.kind)
      ? body.kind
      : "solo";

    db.prepare(
      `INSERT INTO work_units (id, issue_id, repo_id, branch, parent_branch, kind, state, assigned_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      id,
      body.issue_id,
      body.repo_id,
      body.branch ?? null,
      body.parent_branch ?? null,
      kind,
      body.assigned_session_id ?? null,
      now,
    );

    sendJson(res, 201, { id });
  });

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

    // Find existing open work unit for this issue+repo
    const existing = db
      .prepare(
        "SELECT id, state FROM work_units WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed') ORDER BY created_at DESC LIMIT 1"
      )
      .get(body.issue_id, body.repo_id) as { id: string; state: string } | undefined;

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
      if (body.assigned_session_id) {
        updates.push("assigned_session_id = ?");
        params.push(body.assigned_session_id);
      }
      params.push(existing.id);

      db.prepare(
        `UPDATE work_units SET ${updates.join(", ")} WHERE id = ?`
      ).run(...params);

      sendJson(res, 200, { id: existing.id, state: "committed" });
    } else {
      // No existing work unit — create one in committed state (auto-claim)
      const id = randomUUID();
      db.prepare(
        `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, assigned_session_id, created_at, activated_at, last_commit_at)
         VALUES (?, ?, ?, ?, 'solo', 'committed', ?, ?, ?, ?)`
      ).run(
        id,
        body.issue_id,
        body.repo_id,
        body.branch ?? null,
        body.assigned_session_id ?? null,
        now,
        now,
        now,
      );

      sendJson(res, 201, { id, state: "committed" });
    }
  });

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

    const result = db
      .prepare(
        "UPDATE work_units SET state = 'open', assigned_session_id = NULL WHERE issue_id = ? AND repo_id = ? AND state IN ('open', 'committed')"
      )
      .run(body.issue_id, body.repo_id);

    if (result.changes === 0) {
      sendJson(res, 404, { error: "No active work unit found for this issue and repo" });
      return;
    }

    sendJson(res, 200, { ok: true, released: result.changes });
  });

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
  });

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
  });

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
      params.push(body.assigned_session_id ?? null);
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
  });
}
