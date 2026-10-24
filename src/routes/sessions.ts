import { getDb } from "../db.js";
import { entityRefs, resolveId, resolveSessionRef } from "../entity-refs.js";
import { navigateToSession } from "../navigate.js";
import {
  readPidStarts,
  SessionRegistry,
  syncPinnedPanesTsv,
  type ChildSessionInput,
  type SessionInput,
  type SessionListOptions,
  type SessionUpdate,
} from "../registry.js";
import {
  getChannelRegistry,
  getChannelConnectedSessionsFromDb,
} from "../channel-registry.js";
import { linkSessionToLedgerIssue } from "../ledger/operational-links.js";
import type { WorkScanner } from "../work-scanner.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import type { SessionStatus } from "../types.js";
import { checkSessionIdentity } from "../identity/session-mismatch.js";
import type { Db } from "../db.js";
import {
  resolveSessionAlias,
  sessionAliasIds,
  sessionLinkKey,
  type SessionAliasResolution,
} from "../session-liveness.js";
import {
  SESSION_DESCENDANT_COUNT_LIMIT,
  SESSION_DESCENDANT_DEPTH_LIMIT,
  sessionConversationsSql,
  sessionDescendants,
  sessionFamilyAliasIds,
  summarizeResolvedSession,
} from "../session-summary.js";
import { readBody, sendJson } from "./http.js";
import { effectiveWorkerStatusSql } from "../ledger/issue-work-state.js";

function parseStatus(value: string | undefined): SessionStatus | undefined {
  if (value === "active" || value === "ended" || value === "dead") {
    return value;
  }
  return undefined;
}

function resolveCanonicalRepoId(
  workScanner: WorkScanner | undefined,
  repoId: string,
  repoName?: string | null,
  _issueId?: string,
): string {
  if (!workScanner) return repoId;
  const direct = workScanner.getRepoById(repoId);
  if (direct?.exists) return direct.id;
  const byName = repoName ? workScanner.getRepoById(repoName) : null;
  if (byName?.exists) return byName.id;
  // Stripped-dot basename fallback: handles ".dotfiles" → "dotfiles"
  const stripped = repoId.replace(/^\.+/, '');
  if (stripped !== repoId) {
    const db = getDb();
    const row = db.prepare(
      "SELECT id FROM work_repos WHERE id = ? OR name = ? LIMIT 1"
    ).get(stripped, stripped) as { id: string } | undefined;
    if (row) return row.id;
  }
  return repoId;
}

const OVERVIEW_CONVERSATIONS_LIMIT = 20;

function sessionOverview(db: Db, resolution: SessionAliasResolution): Record<string, unknown> {
  const session = summarizeResolvedSession(db, resolution);
  const children = sessionDescendants(db, session.id);
  const own = sessionAliasIds(resolution);
  const ownPlaceholders = own.map(() => "?").join(", ");
  const family = sessionFamilyAliasIds(resolution, children.items);
  const familyPlaceholders = family.map(() => "?").join(", ");

  const linkedIssues = db.prepare(`
    SELECT l.issue_id, l.link_type, l.source, MIN(l.created_at) AS created_at, MAX(l.last_seen_at) AS last_seen_at,
           i.short_id, i.title, i.status, ${effectiveWorkerStatusSql("i")} AS worker_status, i.kind
    FROM ledger_session_issue_links l
    JOIN ledger_issues i ON i.id = l.issue_id
    WHERE l.session_id IN (${ownPlaceholders})
    GROUP BY l.issue_id, l.link_type
    ORDER BY COALESCE(MAX(l.last_seen_at), MIN(l.created_at)) DESC
  `).all(...own);

  const workUnits = db.prepare(`
    SELECT id, issue_id, ledger_issue_id, repo_id, branch, parent_branch, kind,
           state, assigned_session_id, provider, provider_session_id, worker_provider_session_id,
           created_at, activated_at, last_commit_at, resolved_at, auth_request_id
    FROM work_units
    WHERE assigned_session_id IN (${familyPlaceholders})
       OR provider_session_id IN (${familyPlaceholders})
       OR worker_provider_session_id IN (${familyPlaceholders})
    ORDER BY created_at DESC
  `).all(...family, ...family, ...family);

  const conversations = db.prepare(`
    SELECT c.id, c.source, c.title, c.session_id, c.started_at, c.ended_at, c.block_count,
           c.model, c.branch, c.cwd, c.updated_at
    FROM conversations c
    WHERE ${sessionConversationsSql("c", "?1")}
    ORDER BY c.started_at DESC
    LIMIT ${OVERVIEW_CONVERSATIONS_LIMIT}
  `).all(session.id);

  return {
    as_of: Date.now(),
    status: "resolved",
    session,
    children: {
      items: children.items,
      truncated: children.truncated,
      depth_limit: SESSION_DESCENDANT_DEPTH_LIMIT,
      count_limit: SESSION_DESCENDANT_COUNT_LIMIT,
    },
    linked_issues: { items: linkedIssues },
    work_units: { includes_descendants: true, items: workUnits },
    conversations: { limit: OVERVIEW_CONVERSATIONS_LIMIT, items: conversations },
  };
}

// Bug: caa157e — resolve session ID prefix, returning resolved ID or sending error response
function resolveSessionId(id: string, res: ResponseLike): string | null {
  const resolved = resolveId(getDb(), "session_row", id);
  if (resolved.ok) {
    return resolved.id;
  }
  if (resolved.error === "ambiguous") {
    sendJson(res, 409, {
      error: `Ambiguous prefix '${id}' names more than one session (${resolved.matches.join(", ")}); pass a longer prefix.`
    });
  } else {
    sendJson(res, 404, { error: "Session not found" });
  }
  return null;
}

export function registerSessionRoutes(
  server: RouteRegistrar,
  registry: SessionRegistry = new SessionRegistry(getDb()),
  workScanner?: WorkScanner,
): void {
  server.post("/api/sessions/register", async (req, res) => {
    const payload = readBody<SessionInput>(req);
    if (!payload.id || !payload.app) {
      sendJson(res, 400, { error: "Missing id or app" });
      return;
    }
    // A pid without its start time is read here, off the event loop, so the
    // registered process identity can tell a reused pid from the original.
    let pidStart = payload.pid_start;
    if (payload.pid && !pidStart) {
      const observation = await readPidStarts([payload.pid]);
      pidStart = observation.ok ? observation.starts.get(payload.pid) ?? null : null;
    }
    const session = registry.registerSession({ ...payload, pid_start: pidStart });
    // Issue 499c148 — the row now exists, so its bindings can be compared with
    // the authenticated client. The warning rides the registration response so
    // the connecting agent learns about a misconfigured token immediately
    // instead of at end-of-day auth submission.
    const identityWarning = checkSessionIdentity(getDb(), session.id, req.client_identity);
    sendJson(res, 200, { ...session, identity_warning: identityWarning });
  }, { operation: { id: "post:/api/sessions/register", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "allow" });

  server.patch("/api/sessions/:id", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const payload = readBody<SessionUpdate & { pinned?: number }>(req);
    const updated = registry.updateSession(id, payload);
    if (!updated) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    // Bug: 568eca7 — sync pinned-panes.tsv for backward compat with reaper
    if (payload.pinned !== undefined && updated.nav_pane_id) {
      syncPinnedPanesTsv(updated.nav_pane_id, Boolean(payload.pinned));
    }
    sendJson(res, 200, updated);
  }, { operation: { id: "patch:/api/sessions/:id", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "allow" });

  server.patch("/api/sessions/:id/end", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const payload = readBody<{ status?: SessionStatus }>(req);
    const status = payload.status ?? "ended";
    const ended = registry.endSession(id, status);
    if (!ended) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, ended);
  }, { operation: { id: "patch:/api/sessions/:id/end", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "allow" });

  server.post("/api/sessions/:id/children", (req, res) => {
    const parentId = req.params.id;
    if (!parentId) {
      sendJson(res, 400, { error: "Missing parent id" });
      return;
    }
    const payload = readBody<ChildSessionInput>(req);
    const child = registry.registerChildSession(parentId, payload);
    if (!child) {
      sendJson(res, 404, { error: "Parent not found" });
      return;
    }
    sendJson(res, 200, child);
  }, { operation: { id: "post:/api/sessions/:id/children", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  server.patch("/api/sessions/:id/children/:childId", (req, res) => {
    const parentId = req.params.id;
    const childId = req.params.childId;
    if (!parentId || !childId) {
      sendJson(res, 400, { error: "Missing parent or child id" });
      return;
    }
    const payload = readBody<{ status?: SessionStatus }>(req);
    const status = payload.status ?? "ended";
    const updated = registry.updateChildStatus(parentId, childId, status);
    if (!updated) {
      sendJson(res, 404, { error: "Child not found" });
      return;
    }
    sendJson(res, 200, updated);
  }, { operation: { id: "patch:/api/sessions/:id/children/:childId", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  server.get("/api/sessions", (req, res) => {
    const query = req.query ?? {};
    const options: SessionListOptions = {
      status: parseStatus(query.status),
      app: query.app,
    };
    if (query.parent_id === "null") {
      options.parent_id = null;
    } else if (query.parent_id) {
      options.parent_id = query.parent_id;
    }
    // Bounded default with explicit history escape hatch (issue 21502ff).
    if (query.scope === "all" || query.all === "1" || query.all === "true") {
      options.scope = "all";
    }
    if (query.cursor) {
      options.cursor = query.cursor;
    }
    if (query.limit !== undefined) {
      const parsedLimit = Number(query.limit);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        options.limit = Math.floor(parsedLimit);
      }
    }

    // Bounded/paginated listing (issue 21502ff). listSessionsPage → mapWithLiveness
    // → toSession already populates each session's user-attribution `owner`
    // (main), so no separate owner remap is needed here.
    const page = registry.listSessionsPage(options);
    const sessions = page.sessions;
    const meta = {
      total: page.total,
      returned: page.returned,
      nextCursor: page.nextCursor,
      scope: page.scope,
      limit: page.limit,
    };

    sendJson(res, 200, { sessions, ...meta });
  }, { operation: { id: "get:/api/sessions", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Bug: 568eca7 — lightweight endpoint returning just pinned session IDs
  server.get("/api/sessions/pinned", (_req, res) => {
    const ids = registry.getPinnedSessionIds();
    sendJson(res, 200, { ids });
  }, { operation: { id: "get:/api/sessions/pinned", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Bug: 0b454df — list channel-connected sessions
  server.get("/api/sessions/channel-connected", (_req, res) => {
    const channelRegistry = getChannelRegistry();
    const inMemory = channelRegistry.getAll();

    // Merge in-memory state with DB-persisted state for resilience
    const dbSessions = getChannelConnectedSessionsFromDb();

    const combined = dbSessions.map((dbRow) => {
      const live = inMemory.find((s) => s.session_id === dbRow.id);
      return {
        ...dbRow,
        is_alive: live ? channelRegistry.isAlive(dbRow.id) : false,
        tools_called: live?.tools_called ?? [],
        last_tool_call_in_memory: live?.last_tool_call ?? null,
      };
    });

    // Add any in-memory sessions not yet in DB (transient race)
    for (const live of inMemory) {
      if (!dbSessions.some((d) => d.id === live.session_id)) {
        combined.push({
          id: live.session_id,
          app: "claude",
          status: "active",
          branch: live.branch,
          cwd: live.cwd,
          channel_connected_at: live.connected_at,
          channel_last_tool_call: live.last_tool_call,
          is_alive: channelRegistry.isAlive(live.session_id),
          tools_called: live.tools_called,
          last_tool_call_in_memory: live.last_tool_call,
          identity_mismatch: null,
        });
      }
    }

    sendJson(res, 200, { sessions: combined });
  }, { operation: { id: "get:/api/sessions/channel-connected", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Bug: 0b454df — record a channel tool call for liveness tracking
  server.post("/api/sessions/:id/channel-tool-call", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;

    // Bug: 7ab2f3e — Accept optional tool_input/tool_output for event bridge
    const body = readBody<{ tool_name?: string; tool_input?: unknown; tool_output?: unknown }>(req);
    const toolName = body.tool_name ?? "unknown";

    const channelRegistry = getChannelRegistry();

    // Get current session branch/cwd from DB
    const session = registry.getSession(id);
    channelRegistry.register(id, session?.cwd ?? null, session?.branch ?? null);
    channelRegistry.recordToolCall(id, toolName, body.tool_input, body.tool_output);

    // Issue 499c148 — channel sessions reach the daemon here on every tool call,
    // so a token swapped mid-session is caught without waiting for a re-register.
    const identityWarning = checkSessionIdentity(getDb(), id, req.client_identity);
    sendJson(res, 200, { ok: true, identity_warning: identityWarning });
  }, { operation: { id: "post:/api/sessions/:id/channel-tool-call", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  server.get("/api/sessions/by-pid/:pid", (req, res) => {
    const pidStr = req.params.pid;
    const pid = Number(pidStr);
    if (!pidStr || !Number.isInteger(pid) || pid <= 0) {
      sendJson(res, 400, { error: "Invalid PID" });
      return;
    }
    const session = registry.getSessionByPid(pid);
    if (!session) {
      sendJson(res, 404, { error: "No active session for PID" });
      return;
    }
    sendJson(res, 200, session);
  }, { operation: { id: "get:/api/sessions/by-pid/:pid", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/sessions/:id", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const session = registry.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, session);
  }, { operation: { id: "get:/api/sessions/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/sessions/:id/tree", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const tree = registry.getSessionTree(id);
    if (!tree) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, tree);
  }, { operation: { id: "get:/api/sessions/:id/tree", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // The Session Overview for any session alias or alias prefix: the session,
  // its descendants, linked issues, work units and recent conversations. A
  // prefix naming several sessions answers with the candidates.
  server.get("/api/sessions/:id/overview", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const db = getDb();
    const resolved = resolveSessionRef(db, rawId);
    if (resolved.status === "not_found") {
      sendJson(res, 404, { error: "Session not found", code: "session_not_found" });
    } else if (resolved.status === "ambiguous") {
      sendJson(res, 200, {
        as_of: Date.now(),
        status: "ambiguous",
        truncated: resolved.truncated,
        candidates: resolved.candidates.map((resolution) => summarizeResolvedSession(db, resolution)),
      });
    } else {
      sendJson(res, 200, sessionOverview(db, resolved.resolution));
    }
  }, { operation: { id: "get:/api/sessions/:id/overview", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.post("/api/sessions/:id/navigate", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const session = registry.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    const result = navigateToSession(session);
    sendJson(res, result.ok ? 200 : 500, result);
  }, { operation: { id: "post:/api/sessions/:id/navigate", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  // Bug: 14e1e63 — write Reaper Notice before killing so it appears before pane-loop restarts
  server.post("/api/sessions/:id/kill", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const session = registry.getSession(id);
    if (!session || !session.pid) {
      sendJson(res, 404, { error: "Session not found or missing pid" });
      return;
    }

    // Write Reaper Notice before killing so it appears before pane-loop restarts
    const pid = session.pid;
    const app = session.app || "claude";
    try {
      const { execFileSync, spawnSync } = require("child_process") as typeof import("child_process");
      const tty = execFileSync("ps", ["-p", String(pid), "-o", "tty="], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
      if (tty && tty !== "?") {
        const reapNotice = process.env.HOME
          ? `${process.env.HOME}/.dotfiles/bin/reap-notice`
          : "reap-notice";
        spawnSync(reapNotice, [
          "--app", app,
          "--pid", String(pid),
          "--tty", tty,
          "--source", "mandible",
        ], { timeout: 2000 });
      }
    } catch {
      // Non-fatal: notice failure should not block the kill
    }

    const ok = registry.killSession(id);
    if (!ok) {
      sendJson(res, 404, { error: "Session not found or missing pid" });
      return;
    }
    sendJson(res, 200, { ok: true });
  }, { operation: { id: "post:/api/sessions/:id/kill", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  // POST /api/sessions/:id/issues — link a session to an issue. The session is
  // any alias resolveSessionAlias resolves; the link is keyed on
  // sessionLinkKey and never creates a sessions row (issue 2043af5).
  server.post("/api/sessions/:id/issues", (req, res) => {
    const rawSessionId = req.params.id;
    if (!rawSessionId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const body = readBody<{ issue_id?: string; repo_id?: string; repo_name?: string }>(req);
    if (!body.issue_id || !body.repo_id) {
      sendJson(res, 400, { error: "Missing issue_id or repo_id" });
      return;
    }
    const db = getDb();
    const resolution = resolveSessionAlias(db, rawSessionId);
    if (!resolution) {
      sendJson(res, 409, {
        error: "Mandible has no session row, console session, or ingested provider transcript for this id yet.",
        code: "provider_session_not_ingested",
        provider_session_id: rawSessionId,
        retryable: true,
      });
      return;
    }
    const sessionId = sessionLinkKey(resolution);
    const canonicalRepoId = resolveCanonicalRepoId(workScanner, body.repo_id, body.repo_name, body.issue_id);
    const now = Date.now();
    const link = linkSessionToLedgerIssue(db, {
      session_id: sessionId,
      issue_ref: body.issue_id,
      repo_ref: canonicalRepoId,
      now,
    });
    if (!link.ok) {
      if (link.error === "ambiguous") {
        sendJson(res, 409, {
          error: `Issue ref '${body.issue_id}' matches several ledger issues in repo '${canonicalRepoId}'.`,
          code: "issue_ambiguous",
          matches: link.matches ?? [],
        });
      } else if (link.error === "not_found") {
        sendJson(res, 404, {
          error: `No ledger issue matches '${body.issue_id}' in repo '${canonicalRepoId}'.`,
          code: "issue_not_found",
        });
      } else {
        sendJson(res, 503, { error: "The issue ledger is unavailable.", code: "ledger_unavailable" });
      }
      return;
    }

    // Issue 499c148 — linking a session to an issue is an authenticated client
    // claiming that session's work, so it is a natural second checkpoint.
    const identityWarning = resolution.mandible_session_id
      ? checkSessionIdentity(db, resolution.mandible_session_id, req.client_identity)
      : null;

    sendJson(res, 200, {
      session_id: sessionId,
      issue_id: body.issue_id,
      repo_id: canonicalRepoId,
      created_at: now,
      ledger_issue_id: link.issue_id,
      identity_warning: identityWarning,
    });
  }, { operation: { id: "post:/api/sessions/:id/issues", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "allow",
    refs: { params: { id: entityRefs.session } } });

  // GET /api/sessions/:id/issues — the issues linked to a session under any of
  // its aliases.
  server.get("/api/sessions/:id/issues", (req, res) => {
    const rawSessionId = req.params.id;
    if (!rawSessionId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const db = getDb();
    const resolution = resolveSessionAlias(db, rawSessionId);
    if (!resolution) {
      sendJson(res, 404, { error: "Session not found", code: "session_not_found" });
      return;
    }
    const aliases = sessionAliasIds(resolution);
    const links = db.prepare(
      `SELECT l.session_id, i.short_id AS issue_id, COALESCE(NULLIF(p.project_key, ''), p.id) AS repo_id,
              l.issue_id AS ledger_issue_id, l.created_at
       FROM ledger_session_issue_links l
       JOIN ledger_issues i ON i.id = l.issue_id
       JOIN ledger_projects p ON p.id = i.project_id
       WHERE l.session_id IN (${aliases.map(() => "?").join(", ")})
       ORDER BY l.created_at ASC`
    ).all(...aliases);
    sendJson(res, 200, links);
  }, { operation: { id: "get:/api/sessions/:id/issues", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow",
    refs: { params: { id: entityRefs.session } } });

}
