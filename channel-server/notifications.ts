// Bug: 1d652d5 — SSE listener that bridges Mandible events to MCP notifications
// Bug: 4e32923 — scoped delivery: forward auth:resolved / auth:completed only
// when the event's target_session_id matches this channel's MANDIBLE_SESSION_ID
// (or is null, meaning legacy/unscoped). On a match we also POST to
// /api/inbox/delivered/<id> so the row drops out of the owner's tier-1 inbox.
//
// Auth events (auth:resolved / auth:completed) are delivered as Claude Code
// **channel events** — `notifications/claude/channel` — which the agent
// processes as if a prompt was typed at the terminal, triggering an immediate
// turn. Other event types (inbox:updated, work_unit:*) remain logging messages
// and surface only on the next user prompt. The channel-event method and
// `experimental: { 'claude/channel': {} }` capability are the canonical pattern
// used by the first-party Discord / Telegram / fakechat plugins shipped with
// claude-plugins-official.
//
// Connects to Mandible's SSE endpoint (GET /api/events) and translates
// relevant event types into MCP notifications.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import http from "node:http";
import https from "node:https";
import type { MandibleSSEEvent } from "./types.js";
import { resolveBaseUrl, resolveTransport } from "./base-url.js";
import { channelTransportHeaders } from "./client.js";

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface NotificationBridge {
  start(): void;
  stop(): void;
}

/**
 * POST /api/inbox/delivered/<id> — best-effort fire-and-forget. The endpoint
 * is idempotent so a missed call only means the row will keep surfacing on
 * the owner's tier-1 inbox until escalation or manual ack.
 * Bug: 4e32923
 */
export function markDelivered(requestId: string): void {
  if (!requestId) return;
  const url = new URL(`/api/inbox/delivered/${encodeURIComponent(requestId)}`, resolveBaseUrl());
  const transport = resolveTransport();
  let headers: Record<string, string>;
  try { headers = channelTransportHeaders(transport.kind); }
  catch (error) {
    process.stderr.write(`Mandible channel delivery needs a durable credential: ${String(error)}\n`);
    return;
  }
  const req = (transport.kind === "http" && url.protocol === "https:" ? https : http).request(
    {
      method: "POST",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      ...(transport.kind === "socket" ? { socketPath: transport.socketPath } : {}),
      headers: { "Content-Length": "0", ...headers },
    },
    (res) => {
      // Drain to free the socket; status codes are advisory only.
      res.resume();
    },
  );
  req.on("error", () => {
    // Daemon down or transient: idempotent endpoint means we'll be re-notified
    // on reconnect (or the item escalates to tier 2 after the grace window).
  });
  req.end();
}

/** Bug: 4e32923 — payload shape for a Claude Code channel event. */
export interface ChannelEventPayload {
  content: string;
  meta?: Record<string, string>;
}

/**
 * Bug: 4e32923 — pure event-dispatch function extracted so unit tests can
 * drive it without standing up an SSE connection or a real MCP server.
 *
 * Behaviour:
 *   - `auth:resolved` / `auth:completed`: filter by `target_session_id`, then
 *     route through `sendChannelEvent` so Claude Code wakes the agent
 *     immediately (channel events are processed like an inbound prompt, not
 *     passive context). Filter rules (in priority order):
 *     - null → passive log only (legacy / unscoped — Bug: 210ffa1)
 *     - matches ownSessionId → forward via channel event + markDelivered
 *     - conversation_id matches ownConversationId (session mismatch) →
 *       passive log only, no markDelivered (Bug: 66865dd, refines 6d7411b)
 *     - ownSessionId itself null → passive log only (Bug: 210ffa1)
 *     - otherwise → drop
 *   - `inbox:updated` / `console:inbox:badge` / `work_unit:*` → forward via
 *     `sendNotification` as a logging message (passive — surfaces on the next
 *     user prompt). These do not need an immediate-turn wake-up.
 *
 * @param event — raw SSE event payload from Mandible.
 * @param ownSessionId — this channel's Mandible session id.
 * @param sendNotification — callback that forwards a (category, message) pair
 *   as an MCP logging message (production wraps `server.sendLoggingMessage`).
 *   Used for passive context (inbox / work-unit updates).
 * @param sendChannelEvent — callback that forwards a channel-event payload via
 *   `notifications/claude/channel` (production wraps `server.notification`).
 *   Used for auth resolutions so the agent turns immediately. If omitted (e.g.
 *   in legacy callers / tests not exercising this path), auth events fall back
 *   to `sendNotification` so behaviour matches pre-channel-event delivery.
 * @param onDelivered — callback fired when an auth:resolved event matches and
 *   delivery should be recorded. Defaults to the live HTTP POST. Tests inject
 *   a spy to capture the request_id.
 */
export function dispatchEvent(
  event: MandibleSSEEvent,
  ownSessionId: string | null,
  sendNotification: (category: string, message: string) => void,
  sendChannelEvent?: (payload: ChannelEventPayload) => void,
  onDelivered: (requestId: string) => void = markDelivered,
  // Bug: 6d7411b — conversation_id persists across Claude Code resumes.
  // When target_session_id doesn't match (session was restarted), fall back
  // to matching on conversation_id so auth results still reach the right agent.
  ownConversationId: string | null = null,
): void {
  const { type, data } = event;

  if (type === "auth:resolved" || type === "auth:completed") {
    const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const target = payload.target_session_id;
    const targetSessionId = typeof target === "string" ? target : null;
    const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
    // Bug: 6d7411b — read conversation_id from the event data for secondary matching.
    const eventConversationId = typeof payload.conversation_id === "string" ? payload.conversation_id : null;

    // Bug: 4e32923 — auth resolutions get channel-event delivery so the agent
    // wakes immediately. Fall back to sendNotification when no channel-event
    // sender is wired (tests / legacy callers / capability not yet negotiated).
    const deliverAuth = (): void => {
      if (sendChannelEvent) {
        sendChannelEvent(buildAuthChannelEvent(type, data));
      } else {
        sendNotification("auth_resolved", formatAuthResolved(data));
      }
    };

    if (targetSessionId == null) {
      // Bug: 210ffa1 — legacy / unscoped row: passive log only (no agent wake-up).
      // Now that auth requests reliably include target_session_id, unscoped
      // events should not wake every running session.
      sendNotification("auth_resolved", formatAuthResolved(data));
    } else if (ownSessionId != null && targetSessionId === ownSessionId) {
      // Owner match: forward AND record delivery so the owner's tier-1
      // inbox empties without requiring a manual ack.
      deliverAuth();
      onDelivered(requestId);
    } else if (
      // Bug: 66865dd — conversation_id match with session_id mismatch: passive
      // log only (no channel event wake-up, no markDelivered). The same
      // conversation can be resumed in two sessions doing different work — a
      // full channel event would be noisy and confusing. Leave the item in
      // inbox for the original session; just inform this session passively.
      // Refines 6d7411b which originally treated this as a full owner match.
      ownConversationId != null &&
      eventConversationId != null &&
      eventConversationId === ownConversationId
    ) {
      sendNotification("auth_resolved", formatConversationIdMatch(data));
    } else if (ownSessionId == null) {
      // Bug: 210ffa1 — we don't know our own session id: passive log only.
      // Without a session id we can't confirm ownership, so don't wake the
      // agent with a channel event.
      sendNotification("auth_resolved", formatAuthResolved(data));
    }
    // else: mismatch, drop entirely (intended target is a different session).
  } else if (
    type === "console:inbox:badge" ||
    type === "inbox:updated"
  ) {
    sendNotification("inbox_item", formatInboxUpdate(data));
  } else if (type === "work_unit:assigned") {
    sendNotification("work_assigned", formatWorkAssigned(data));
  } else if (type === "work_unit:updated") {
    sendNotification("work_updated", formatWorkUpdated(data));
  }
  // Other event types (session:*, daemon:*, etc.) are not forwarded
}

/**
 * Bug: 4e32923 — send a Claude Code channel event via the low-level MCP
 * `notification()` API. The `notifications/claude/channel` method is the
 * canonical channel-event entry point (matched by Discord, Telegram, and
 * fakechat reference plugins in claude-plugins-official). Claude Code wakes
 * the agent and processes `content` as if it had been typed at the terminal.
 *
 * Requires the server to advertise `experimental: { 'claude/channel': {} }`
 * in its capabilities — see `channel-server/index.ts`. Without that, Claude
 * Code may ignore the notification (the server-side `assertNotificationCapability`
 * does NOT gate this method, so the call still goes out; only the client's
 * dispatcher cares).
 */
export function sendChannelNotification(mcpServer: Server, payload: ChannelEventPayload): void {
  mcpServer
    .notification({
      method: "notifications/claude/channel",
      params: {
        content: payload.content,
        ...(payload.meta ? { meta: payload.meta } : {}),
      },
    })
    .catch(() => {
      // Client may not be connected yet, or the channel capability may not
      // have been negotiated — fire-and-forget like the logging path.
    });
}

/**
 * Creates an SSE listener that bridges Mandible events to MCP notifications.
 *
 * We use raw http.get() rather than EventSource because Node.js does not have
 * a built-in EventSource and adding a polyfill dependency is unnecessary for
 * this simple chunked-transfer use case.
 *
 * @param mcpServer — MCP server instance for sending notifications.
 * @param ownSessionId — this channel's Mandible session id, used to filter
 *   auth:resolved events. Captured at startup from MANDIBLE_SESSION_ID. If
 *   null, the bridge falls back to legacy broadcast behaviour (every event
 *   is forwarded), which is the right thing for unscoped daemons.
 * @param ownConversationId — Bug: 6d7411b — this channel's conversation id
 *   (CLAUDE_CODE_SESSION_ID), used as a secondary matching criterion when
 *   target_session_id doesn't match the current session (e.g. after a
 *   Claude Code resume that regenerates the session id).
 * @param onReconnect — Bug: 03d6cb0 — optional callback invoked on each
 *   successful SSE reconnect. Used to replay undelivered auth results that
 *   were broadcast while the connection was down (e.g. during a self-rebuild).
 */
export function createNotificationBridge(
  mcpServer: Server,
  ownSessionId: string | null = null,
  ownConversationId: string | null = null,
  onReconnect?: () => void,
): NotificationBridge {
  let running = false;
  let currentReq: http.ClientRequest | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = RECONNECT_DELAY_MS;
  // Bug: 03d6cb0 — track whether this is the first connection (startup)
  // vs a reconnection. The startup catch-up runs separately in index.ts;
  // the onReconnect callback only fires on subsequent reconnects.
  let hasConnectedBefore = false;

  function connect(): void {
    if (!running) return;

    const url = new URL("/api/events", resolveBaseUrl());

    const transport = resolveTransport();
    let headers: Record<string, string>;
    try { headers = channelTransportHeaders(transport.kind); }
    catch (error) {
      process.stderr.write(`Mandible channel events need a durable credential: ${String(error)}\n`);
      scheduleReconnect();
      return;
    }
    currentReq = (transport.kind === "http" && url.protocol === "https:" ? https : http).get({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      ...(transport.kind === "socket" ? { socketPath: transport.socketPath } : {}),
      headers,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        scheduleReconnect();
        return;
      }

      // Reset backoff on successful connection
      reconnectDelay = RECONNECT_DELAY_MS;

      // Bug: 03d6cb0 — on reconnect (not first connect), run catch-up
      // to replay any auth results missed during the connection gap.
      if (hasConnectedBefore && onReconnect) {
        try {
          onReconnect();
        } catch {
          // Best effort — don't let catch-up failures break the SSE stream
        }
      }
      hasConnectedBefore = true;

      let buffer = "";

      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;

        // SSE protocol: events are separated by double newlines
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          // Parse SSE frame: look for "data:" lines, skip comments (": ...")
          const dataLines: string[] = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("data: ")) {
              dataLines.push(line.slice(6));
            }
            // Skip comment lines (heartbeats) and event/id/retry fields
          }

          if (dataLines.length === 0) continue;

          try {
            const event = JSON.parse(
              dataLines.join("\n"),
            ) as MandibleSSEEvent;
            handleEvent(event);
          } catch {
            // Malformed JSON — skip
          }
        }
      });

      res.on("end", () => {
        scheduleReconnect();
      });

      res.on("error", () => {
        scheduleReconnect();
      });
    });

    currentReq.on("error", () => {
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (!running) return;
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);

    // Exponential backoff with ceiling
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  function handleEvent(event: MandibleSSEEvent): void {
    // Bug: 4e32923 — delegate to the pure dispatchEvent helper so the filter
    // logic is unit-testable without standing up an SSE / MCP transport. Auth
    // events flow through `sendChannelEvent` (notifications/claude/channel) so
    // Claude Code wakes the agent immediately; non-auth events stay on the
    // passive logging path.
    dispatchEvent(event, ownSessionId, sendNotification, sendChannelEvent, markDelivered, ownConversationId);
  }

  function sendChannelEvent(payload: ChannelEventPayload): void {
    sendChannelNotification(mcpServer, payload);
  }

  function sendNotification(category: string, message: string): void {
    // Use MCP logging messages as the notification channel.
    // Claude Code treats logging messages from channel servers as
    // notifications that surface in the agent's context.
    mcpServer
      .sendLoggingMessage({
        level: "info",
        logger: `mandible/${category}`,
        data: message,
      })
      .catch(() => {
        // Client may not be connected yet — ignore
      });
  }

  return {
    start() {
      running = true;
      connect();
    },
    stop() {
      running = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentReq) {
        currentReq.destroy();
        currentReq = null;
      }
    },
  };
}

// --- Event formatters ---

/**
 * Bug: 4e32923 — build the channel-event payload (content + meta) for an
 * auth resolution. The content string is what Claude Code injects as a
 * synthetic user message; the meta record carries machine-readable fields
 * (request_id, branch, status, exit_code, outcome) so the agent can act
 * without re-fetching. Meta values are coerced to strings per the
 * `notifications/claude/channel` schema.
 */
export function buildAuthChannelEvent(
  type: "auth:resolved" | "auth:completed",
  data: unknown,
): ChannelEventPayload {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const requestId = typeof d.request_id === "string" ? d.request_id : "";
  const status = typeof d.status === "string" ? d.status : "unknown";
  const title = typeof d.title === "string" ? d.title : "";
  const branch = typeof d.head_branch === "string" ? d.head_branch : "";
  const exitCode = typeof d.exit_code === "number" ? d.exit_code : null;
  const outcome = typeof d.outcome === "string" ? d.outcome : null;
  const errorText = typeof d.error === "string" ? d.error : "";
  // Bug: 929c6d0 — error_output carries the tail of executor stdout/stderr
  // so the agent can diagnose failed auth requests without a follow-up fetch.
  const errorOutput = typeof d.error_output === "string" ? d.error_output : "";

  const headlineParts: string[] = [`Mandible auth request ${status}`];
  if (branch) headlineParts.push(`for branch ${branch}`);
  if (title) headlineParts.push(`(${title})`);
  if (exitCode !== null) headlineParts.push(`exit ${exitCode}`);

  const lines: string[] = [headlineParts.join(" ")];
  if (typeof d.failure_reason === "string") lines.push(`Reason: ${d.failure_reason}`);
  if (errorText) lines.push(`Error: ${errorText}`);
  // Bug: 929c6d0 — include executor output when it differs from the error
  // message (error may be a brief summary, error_output is the raw tail).
  if (errorOutput && errorOutput !== errorText) {
    lines.push(`Output (last lines):\n${errorOutput}`);
  }
  lines.push(
    "Use mandible_check_inbox if you need additional details. Delivery has been recorded; the result will not surface again on this session's inbox.",
  );

  const meta: Record<string, string> = {
    source: "mandible",
    event_type: type,
    status,
  };
  if (requestId) meta.request_id = requestId;
  if (branch) meta.head_branch = branch;
  if (title) meta.title = title;
  if (outcome) meta.outcome = outcome;
  if (exitCode !== null) meta.exit_code = String(exitCode);
  if (errorOutput) meta.error_output = errorOutput;

  return { content: lines.join("\n"), meta };
}

function formatAuthResolved(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "An auth request has been resolved.";
  }
  const d = data as Record<string, unknown>;
  const status = String(d.status ?? "unknown");
  const title = d.title ? String(d.title) : "";
  const branch = d.head_branch ? String(d.head_branch) : "";
  const exitCode = typeof d.exit_code === "number" ? d.exit_code : null;

  const parts: string[] = [`Auth request ${status}`];
  if (title) parts.push(`"${title}"`);
  if (branch) parts.push(`for branch ${branch}`);
  if (exitCode !== null) parts.push(`(exit code: ${exitCode})`);
  if (d.error) parts.push(`Error: ${String(d.error)}`);

  return parts.join(" — ");
}

/**
 * Bug: 66865dd — format a passive notification for a conversation_id match
 * (session_id mismatch). Includes title, branch, status, and a qualifier
 * explaining this was submitted by a previous session of the same conversation.
 */
function formatConversationIdMatch(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "An auth request from a previous session of this conversation has been resolved. Use mandible_check_inbox if relevant to your current work.";
  }
  const d = data as Record<string, unknown>;
  const status = String(d.status ?? "unknown");
  const title = d.title ? String(d.title) : "";
  const branch = d.head_branch ? String(d.head_branch) : "";

  const parts: string[] = [`Auth request ${status}`];
  if (title) parts.push(`"${title}"`);
  if (branch) parts.push(`for branch ${branch}`);
  parts.push("— this was submitted by a previous session of this conversation. Use mandible_check_inbox if relevant to your current work.");

  return parts.join(" ");
}

function formatInboxUpdate(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "New inbox items are available. Use mandible_check_inbox for details.";
  }
  const d = data as Record<string, unknown>;
  const total = typeof d.total === "number" ? d.total : null;

  if (total !== null) {
    return `You have ${total} inbox item(s) needing attention. Use mandible_check_inbox for details.`;
  }
  return "New inbox items are available. Use mandible_check_inbox for details.";
}

function formatWorkAssigned(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "A work unit has been assigned to your session.";
  }
  const d = data as Record<string, unknown>;
  const issueId = d.issue_id ? String(d.issue_id) : "";
  const branch = d.branch ? String(d.branch) : "";

  const parts: string[] = ["Work unit assigned"];
  if (issueId) parts.push(`issue: ${issueId}`);
  if (branch) parts.push(`branch: ${branch}`);
  parts.push("Use mandible_check_inbox for full details.");

  return parts.join(" — ");
}

function formatWorkUpdated(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "A work unit has been updated.";
  }
  const d = data as Record<string, unknown>;
  const state = d.state ? String(d.state) : "";
  const issueId = d.issue_id ? String(d.issue_id) : "";

  const parts: string[] = ["Work unit updated"];
  if (issueId) parts.push(`issue: ${issueId}`);
  if (state) parts.push(`state: ${state}`);

  return parts.join(" — ");
}
