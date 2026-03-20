// Bug: 1d652d5 — SSE listener that bridges Mandible events to MCP notifications
//
// Connects to Mandible's SSE endpoint (GET /api/events) and translates
// relevant event types into MCP logging messages that Claude Code receives
// as channel notifications.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import http from "node:http";
import type { MandibleSSEEvent } from "./types.js";

const MANDIBLE_BASE = "http://localhost:19420";
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface NotificationBridge {
  start(): void;
  stop(): void;
}

/**
 * Creates an SSE listener that bridges Mandible events to MCP notifications.
 *
 * We use raw http.get() rather than EventSource because Node.js does not have
 * a built-in EventSource and adding a polyfill dependency is unnecessary for
 * this simple chunked-transfer use case.
 */
export function createNotificationBridge(
  mcpServer: Server,
): NotificationBridge {
  let running = false;
  let currentReq: http.ClientRequest | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = RECONNECT_DELAY_MS;

  function connect(): void {
    if (!running) return;

    const url = new URL("/api/events", MANDIBLE_BASE);

    currentReq = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        scheduleReconnect();
        return;
      }

      // Reset backoff on successful connection
      reconnectDelay = RECONNECT_DELAY_MS;

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
    const { type, data } = event;

    // Route specific Mandible event types to MCP notifications
    if (type === "auth:resolved" || type === "auth:completed") {
      sendNotification("auth_resolved", formatAuthResolved(data));
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
