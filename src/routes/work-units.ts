import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import type { SessionRegistry } from "../registry.js";
import type { SessionManager } from "../session-manager.js";
import type { WorkUnit, WorkUnitState } from "../types.js";
import {
  mapWorkUnitRow as mapRow,
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

const VALID_STATES: Set<string> = new Set(["open", "committed", "resolved", "abandoned"]);

function readBody<T>(req: RequestLike): T {
  return (req.body ?? {}) as T;
}

function sendJson(res: ResponseLike, code: number, payload: unknown): void {
  res.status(code).json(payload);
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
