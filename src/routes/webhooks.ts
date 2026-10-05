import { DOMAIN_EVENTS } from "../contracts.js";
/**
 * Webhook ingestion routes.
 * Bug: 9f66ad9 — accept structured events from external systems (CI, monitoring,
 * GitHub) and route them to the appropriate agent session.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { broadcast } from "../sse.js";
import { getChannelRegistry } from "../channel-registry.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { ClientAuthzError, requireOperator } from "../client-auth/authz.js";
import type { SessionManager } from "../session-manager.js";
import type { WebhookEvent, WebhookEventRow } from "../types.js";
import { sendJson } from "./http.js";

// --- Rate limiter ---

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60;  // per source per window

const rateLimitMap = new Map<string, RateLimitEntry>();

// Periodic cleanup to prevent unbounded memory growth
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60_000;
let rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = null;

function startRateLimitCleanup(): void {
  if (rateLimitCleanupTimer) return;
  rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
        rateLimitMap.delete(key);
      }
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL_MS);
  if (typeof rateLimitCleanupTimer === "object" && "unref" in rateLimitCleanupTimer) {
    rateLimitCleanupTimer.unref();
  }
}

/**
 * Check rate limit for a source. Returns true if the request is allowed.
 */
function checkRateLimit(source: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(source);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(source, { count: 1, windowStart: now });
    return true;
  }

  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX_REQUESTS;
}

// --- Prompt formatting ---

function formatWebhookAsPrompt(event: WebhookEvent): string {
  const header = `[Webhook: ${event.source}/${event.event_type}]`;
  const title = event.title || "External event received";
  const dataStr = typeof event.data === "string"
    ? event.data
    : JSON.stringify(event.data, null, 2);

  return `${header}\n${title}\n\n${dataStr}`;
}

// --- Routing logic ---

interface RouteResult {
  status: "delivered" | "queued";
  delivered_to: string | null;
  message: string;
}

const ROUTE_FORBIDDEN = Symbol("webhook_operator_route_forbidden");
type RouteAttempt = RouteResult | null | typeof ROUTE_FORBIDDEN;

function requireOperatorForCredentialBearingSession(
  sessionManager: SessionManager,
  req: RequestLike,
  res: ResponseLike,
  sessionId: string,
): boolean {
  const db = getDb();
  const classifier = (sessionManager as SessionManager & {
    isCredentialBearing?: (id: string) => boolean;
  }).isCredentialBearing;
  const backend = sessionManager.get(sessionId);
  const credentialBearing = typeof classifier === "function"
    ? classifier.call(sessionManager, sessionId)
    : backend?.meta.is_operator === true;
  if (!credentialBearing) return true;
  try {
    requireOperator(db, req);
    return true;
  } catch (error) {
    if (error instanceof ClientAuthzError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return false;
    }
    throw error;
  }
}

function tryRouteToConsoleSession(
  sessionManager: SessionManager,
  sessionId: string,
  event: WebhookEvent,
  req: RequestLike,
  res: ResponseLike,
): RouteAttempt {
  if (!requireOperatorForCredentialBearingSession(sessionManager, req, res, sessionId)) {
    return ROUTE_FORBIDDEN;
  }
  const backend = sessionManager.get(sessionId);
  if (!backend) return null;

  if (backend.meta.status !== "running") {
    return null;
  }

  backend.sendPrompt(formatWebhookAsPrompt(event));
  return {
    status: "delivered",
    delivered_to: sessionId,
    message: `Webhook delivered to console session ${sessionId}`,
  };
}

function tryRouteByIssue(
  sessionManager: SessionManager,
  issueId: string,
  event: WebhookEvent,
  req: RequestLike,
  res: ResponseLike,
): RouteAttempt {
  const db = getDb();

  // Look up work unit for this issue
  const workUnit = db
    .prepare(
      `SELECT assigned_session_id FROM work_units
       WHERE issue_id LIKE ? AND state IN ('open', 'committed')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(`${issueId}%`) as { assigned_session_id: string | null } | undefined;

  if (!workUnit?.assigned_session_id) return null;

  // The assigned_session_id may be a console session ID — try routing to it
  return tryRouteToConsoleSession(
    sessionManager,
    workUnit.assigned_session_id,
    event,
    req,
    res,
  );
}

function tryRouteByBranch(
  sessionManager: SessionManager,
  branch: string,
  event: WebhookEvent,
  req: RequestLike,
  res: ResponseLike,
): RouteAttempt {
  // First check console sessions (managed by SessionManager)
  for (const backend of sessionManager.getAll()) {
    if (
      backend.meta.status === "running" &&
      backend.meta.cwd
    ) {
      // Console sessions don't directly store branch, but we can check
      // the mandible session which may have branch info
      if (backend.meta.mandible_session_id) {
        const db = getDb();
        const session = db
          .prepare("SELECT branch FROM sessions WHERE id = ? AND branch = ?")
          .get(backend.meta.mandible_session_id, branch) as { branch: string } | undefined;
        if (session) {
          return tryRouteToConsoleSession(sessionManager, backend.id, event, req, res);
        }
      }
    }
  }

  // Bug: 0b454df — check channel-connected sessions on this branch.
  // Channel sessions can receive webhooks via MCP notifications the next
  // time they call mandible_check_inbox, so we queue the event but record
  // the target session for targeted delivery.
  const channelRegistry = getChannelRegistry();
  const channelSessions = channelRegistry.getByBranch(branch);
  if (channelSessions.length > 0) {
    // Channel sessions receive webhook data through their next inbox check.
    // We mark it as "queued" with the channel session as the intended target
    // so the inbox endpoint can include it.
    return null; // Will be queued and surfaced via inbox/check_inbox
  }

  // Then check tracked sessions (third-class: external agents)
  const db = getDb();
  const trackedSession = db
    .prepare(
      `SELECT id FROM sessions
       WHERE branch = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(branch) as { id: string } | undefined;

  if (trackedSession) {
    // Found an active tracked session on the branch, but we can't send
    // prompts to third-class sessions — queue as inbox item instead
    return null;
  }

  return null;
}

function queueWebhookEvent(
  event: WebhookEvent,
  id: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO webhook_events
       (id, source, event_type, title, data_json, target_session, target_issue,
        target_branch, priority, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    event.source,
    event.event_type,
    event.title ?? null,
    JSON.stringify(event.data),
    event.target_session ?? null,
    event.target_issue ?? null,
    event.target_branch ?? null,
    event.priority ?? "normal",
    Date.now(),
  );
}

function markDelivered(id: string, deliveredTo: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE webhook_events SET status = 'delivered', delivered_at = ?, delivered_to = ?
     WHERE id = ?`
  ).run(Date.now(), deliveredTo, id);
}

// --- Route registration ---

export function registerWebhookRoutes(
  server: RouteRegistrar,
  sessionManager: SessionManager,
): void {

  startRateLimitCleanup();

  // POST /api/webhooks/ingest — accept and route a webhook event
  server.post("/api/webhooks/ingest", (req, res) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "request body required" });
      return;
    }

    const source = typeof body.source === "string" ? body.source : null;
    const event_type = typeof body.event_type === "string" ? body.event_type : null;

    if (!source || !event_type) {
      sendJson(res, 400, { error: "source and event_type are required" });
      return;
    }

    // Rate limit check
    if (!checkRateLimit(source)) {
      sendJson(res, 429, {
        error: "rate_limit_exceeded",
        message: `Rate limit exceeded for source '${source}'. Max ${RATE_LIMIT_MAX_REQUESTS} requests per minute.`,
      });
      return;
    }

    const event: WebhookEvent = {
      source,
      event_type,
      data: body.data ?? null,
      target_session: typeof body.target_session === "string" ? body.target_session : undefined,
      target_issue: typeof body.target_issue === "string" ? body.target_issue : undefined,
      target_branch: typeof body.target_branch === "string" ? body.target_branch : undefined,
      priority: (body.priority === "low" || body.priority === "high") ? body.priority : "normal",
      title: typeof body.title === "string" ? body.title : undefined,
    };

    const id = randomUUID();
    let result: RouteAttempt = null;

    // Routing priority: target_session > target_issue > target_branch > queue
    if (event.target_session) {
      result = tryRouteToConsoleSession(sessionManager, event.target_session, event, req, res);
      if (result === ROUTE_FORBIDDEN) return;
    }

    if (!result && event.target_issue) {
      result = tryRouteByIssue(sessionManager, event.target_issue, event, req, res);
      if (result === ROUTE_FORBIDDEN) return;
    }

    if (!result && event.target_branch) {
      result = tryRouteByBranch(
        sessionManager,
        event.target_branch,
        event,
        req,
        res,
      );
      if (result === ROUTE_FORBIDDEN) return;
    }

    if (result) {
      // Store and mark as delivered
      queueWebhookEvent(event, id);
      if (result.delivered_to) {
        markDelivered(id, result.delivered_to);
      }

      broadcast(DOMAIN_EVENTS.WEBHOOK_RECEIVED, {
        id,
        source: event.source,
        event_type: event.event_type,
        title: event.title ?? null,
        routed_to: result.delivered_to,
        status: "delivered" as const,
      });

      sendJson(res, 200, {
        id,
        status: "delivered",
        delivered_to: result.delivered_to,
        message: result.message,
      });
    } else {
      // No active session can receive — queue for manual dispatch
      queueWebhookEvent(event, id);

      broadcast(DOMAIN_EVENTS.WEBHOOK_RECEIVED, {
        id,
        source: event.source,
        event_type: event.event_type,
        title: event.title ?? null,
        routed_to: null,
        status: "queued" as const,
      });

      sendJson(res, 200, {
        id,
        status: "queued",
        delivered_to: null,
        message: "Webhook queued — no active session for target",
      });
    }
  }, { operation: { id: "post:/api/webhooks/ingest", effects: ["network:publish"], requestSchema: null, reportingCategory: "webhooks" }, fileRpc: "deny" });

  // GET /api/webhooks — list webhook events with optional status filter
  server.get("/api/webhooks", (req, res) => {
    const db = getDb();
    const status = req.query.status as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? "50", 10) || 50, 1), 200);

    let rows: WebhookEventRow[];
    if (status && ["pending", "delivered", "dismissed"].includes(status)) {
      rows = db
        .prepare(
          `SELECT * FROM webhook_events WHERE status = ?
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(status, limit) as WebhookEventRow[];
    } else {
      rows = db
        .prepare(
          `SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT ?`
        )
        .all(limit) as WebhookEventRow[];
    }

    sendJson(res, 200, {
      events: rows.map((row) => ({
        id: row.id,
        source: row.source,
        event_type: row.event_type,
        title: row.title,
        data: JSON.parse(row.data_json),
        target_issue: row.target_issue,
        target_branch: row.target_branch,
        priority: row.priority,
        status: row.status,
        created_at: row.created_at,
        delivered_at: row.delivered_at,
        delivered_to: row.delivered_to,
      })),
      total: rows.length,
    });
  }, { operation: { id: "get:/api/webhooks", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // POST /api/webhooks/:id/deliver — manually deliver a queued webhook to a session
  server.post("/api/webhooks/:id/deliver", (req, res) => {
    const db = getDb();
    const webhookId = req.params.id;
    const body = req.body as Record<string, unknown> | null;
    const targetSessionId = typeof body?.target_session === "string" ? body.target_session : null;

    if (!targetSessionId) {
      sendJson(res, 400, { error: "target_session is required" });
      return;
    }

    const row = db
      .prepare("SELECT * FROM webhook_events WHERE id = ?")
      .get(webhookId) as WebhookEventRow | undefined;

    if (!row) {
      sendJson(res, 404, { error: "webhook event not found" });
      return;
    }

    if (row.status !== "pending") {
      sendJson(res, 409, {
        error: "webhook_already_processed",
        message: `Webhook is already ${row.status}`,
      });
      return;
    }

    const event: WebhookEvent = {
      source: row.source,
      event_type: row.event_type,
      data: JSON.parse(row.data_json),
      title: row.title ?? undefined,
      priority: row.priority as WebhookEvent["priority"],
    };

    const result = tryRouteToConsoleSession(
      sessionManager,
      targetSessionId,
      event,
      req,
      res,
    );
    if (result === ROUTE_FORBIDDEN) return;
    if (!result) {
      sendJson(res, 422, {
        error: "delivery_failed",
        message: `Console session ${targetSessionId} not found or not running`,
      });
      return;
    }

    markDelivered(webhookId, targetSessionId);

    broadcast(DOMAIN_EVENTS.WEBHOOK_DELIVERED, {
      id: webhookId,
      delivered_to: targetSessionId,
    });

    sendJson(res, 200, {
      id: webhookId,
      status: "delivered",
      delivered_to: targetSessionId,
      message: result.message,
    });
  }, { operation: { id: "post:/api/webhooks/:id/deliver", effects: ["network:publish"], requestSchema: null, reportingCategory: "webhooks" }, fileRpc: "deny" });

  // POST /api/webhooks/:id/dismiss — dismiss a queued webhook
  server.post("/api/webhooks/:id/dismiss", (req, res) => {
    const db = getDb();
    const webhookId = req.params.id;

    const result = db
      .prepare(
        "UPDATE webhook_events SET status = 'dismissed' WHERE id = ? AND status = 'pending'"
      )
      .run(webhookId);

    if (result.changes === 0) {
      sendJson(res, 404, { error: "webhook event not found or already processed" });
      return;
    }

    broadcast(DOMAIN_EVENTS.WEBHOOK_DISMISSED, { id: webhookId });
    sendJson(res, 200, { ok: true, id: webhookId });
  }, { operation: { id: "post:/api/webhooks/:id/dismiss", effects: ["ledger:write"], requestSchema: null, reportingCategory: "webhooks" }, fileRpc: "deny" });
}
