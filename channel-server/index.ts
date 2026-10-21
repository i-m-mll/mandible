#!/usr/bin/env bun
// Bug: 1d652d5 — MCP channel server entry point
//
// This server runs as a stdio subprocess spawned by Claude Code when
// configured with `--channels server:mandible`. It bridges Mandible's
// event system and API to Claude Code via the MCP protocol.
//
// Architecture: STATELESS — all state lives in the Mandible daemon, reached at
// the base URL resolved by channel-server/base-url.ts (MANDIBLE_BASE /
// MANDIBLE_PORT, default http://127.0.0.1:29420). This process is a thin
// adapter that:
//   1. Exposes Mandible operations as MCP tools
//   2. Forwards Mandible SSE events as MCP notifications
//   3. Communicates over stdio (stdin/stdout JSON-RPC)

import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import {
  buildAuthChannelEvent,
  createNotificationBridge,
  sendChannelNotification,
} from "./notifications.js";
import * as client from "./client.js";
import type { UndeliveredAuthResult } from "./types.js";

const INSTRUCTIONS = `You are connected to Mandible, a local agent control plane. Mandible tracks your work via issues, branches, and work units.

When you receive a Mandible notification:
- A "Mandible auth request ..." channel event (delivered immediately, like a fresh user prompt): An auth request you submitted has been approved or rejected. The event meta carries request_id, head_branch, status, outcome, and exit_code. Proceed accordingly — the delivery has been recorded and the item will not surface again on your inbox.
- inbox_item: A work item needs attention — a continuation from a previous session, an unassigned issue, or a work-unit update. Use mandible_check_inbox for details.
- work_assigned: A work unit has been assigned to your session. Read the issue description and begin work.
- work_updated: A work unit's state has changed. Check if it affects your current work.

Available tools:
- mandible_check_inbox: Check your inbox for pending items (continuations, auth results, work units needing attention)
- mandible_report_status: Report your current work status to Mandible (for visibility in the dashboard)
- mandible_submit_auth: Submit an auth request for a protected-branch merge
- mandible_get_issues: List open issues available for work
- mandible_request_work: Request a work-unit assignment from Mandible`;

/**
 * MANDIBLE_SESSION_ID names the session of the process `mandible wrap` exec'd,
 * and every descendant inherits it. Claude spawns this server directly, so the
 * variable is this Claude's own only while its row is absent, unbound, or bound
 * to our parent pid; a nested run's server treats an inherited one as unset.
 * When the daemon cannot be asked, the variable is kept: a server started during
 * a daemon restart is far likelier to belong to the wrapped process itself.
 */
async function ownManagedSessionId(): Promise<string | null> {
  const managed = process.env.MANDIBLE_SESSION_ID;
  if (!managed) return null;
  try {
    const ownerPid = await client.sessionOwnerPid(managed);
    return ownerPid == null || ownerPid === process.ppid ? managed : null;
  } catch (error) {
    process.stderr.write(`Warning: could not confirm Mandible session ${managed} belongs to this process: ${error}\n`);
    return managed;
  }
}

async function main(): Promise<void> {
  const sessionId = (await ownManagedSessionId()) ?? process.env.SESSION_ID ?? null;

  // Bug: 6d7411b — CLAUDE_CODE_SESSION_ID is the conversation/chat ID that
  // persists across Claude Code resumes, unlike MANDIBLE_SESSION_ID which is
  // regenerated on each channel-server restart. Used as a secondary matching
  // criterion for auth event delivery.
  const conversationId = process.env.CLAUDE_CODE_SESSION_ID ?? null;

  // Create the MCP server with channel capability.
  // Bug: 4e32923 — advertise `experimental: { 'claude/channel': {} }` so
  // Claude Code accepts `notifications/claude/channel` events from this
  // server (channel-event delivery for auth resolutions). The capability
  // shape matches the first-party Discord / Telegram / fakechat plugins
  // in claude-plugins-official. Without this declaration Claude Code's
  // dispatcher would treat the notification as unsupported.
  const server = new McpServer(
    {
      name: "mandible",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        logging: {},
        experimental: {
          "claude/channel": {},
        },
      },
      instructions: INSTRUCTIONS,
    },
  );

  // Bug: 0b454df — detect environment for session registration
  const cwd = process.env.CLAUDE_CWD ?? process.cwd();
  let branch: string | null = null;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    // Not in a git repo — branch stays null
  }

  // Bug: 0b454df — register session with Mandible on startup so the
  // dashboard shows it immediately, not just on first tool call.
  if (sessionId) {
    try {
      const registration = await client.registerSession({
        id: sessionId,
        status: "active",
        cwd,
        branch,
        conversation_id: conversationId,
      });
      // Issue 499c148 — Mandible compares this session's bearer token against
      // its app binding at registration. A disagreement means every ledger
      // write is landing under the wrong user, so say so at startup instead of
      // letting it surface as a 403 at end-of-day auth submission.
      const warning = registration?.identity_warning as { message?: string } | null | undefined;
      if (warning?.message) {
        process.stderr.write(`Mandible identity warning: ${warning.message}\n`);
      }
    } catch {
      // Best effort — Mandible may not be running yet
      process.stderr.write("Warning: could not register channel session with Mandible\n");
    }
  }

  // Register tools
  registerTools(server, sessionId);

  // Set up the SSE → MCP notification bridge
  // Access the underlying Server instance for sendLoggingMessage
  // Bug: 4e32923 — pass own session id so the bridge filters auth:resolved
  // events to this session (or broadcasts legacy/unscoped rows).
  // Bug: 6d7411b — pass conversation id for secondary matching across resumes.
  // Bug: 03d6cb0 — pass onReconnect callback to catch up on auth results
  // missed during SSE connection gaps (e.g. daemon self-rebuild).
  const onReconnect = sessionId
    ? () => {
        runStartupCatchUp({
          sessionId,
          conversationId,
          mcpServer: server.server,
          fetchUndelivered: client.fetchUndeliveredAuthResults,
          markDelivered: client.markAuthDelivered,
          log: (msg) => process.stderr.write(msg),
        }).catch((err) => {
          process.stderr.write(`Warning: SSE reconnect catch-up failed: ${err}\n`);
        });
      }
    : undefined;
  const bridge = createNotificationBridge(server.server, sessionId, conversationId, onReconnect);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Bug: 4e32923 — startup catch-up. If a resumed session brings back a
  // MANDIBLE_SESSION_ID that owns auth_results which resolved while this
  // process was not running, replay them as channel events before
  // subscribing to live SSE. Errors are non-fatal; the worst case is that
  // those rows escalate to tier-2 on the next session start.
  if (sessionId) {
    await runStartupCatchUp({
      sessionId,
      conversationId,
      mcpServer: server.server,
      fetchUndelivered: client.fetchUndeliveredAuthResults,
      markDelivered: client.markAuthDelivered,
      log: (msg) => process.stderr.write(msg),
    });
  }

  // Start listening for Mandible events after MCP connection is established
  bridge.start();

  // Log to stderr (stdout is reserved for MCP protocol)
  process.stderr.write(
    `Mandible MCP channel server started${sessionId ? ` (session: ${sessionId.slice(0, 8)}...)` : ""}\n`,
  );

  // Handle graceful shutdown
  const shutdown = (): void => {
    bridge.stop();
    server.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Bug: 4e32923 — exported (with injectable deps) for unit testing. Walks the
 * list of undelivered auth_results owned by this session id, sends each as a
 * channel event, and POSTs delivery acknowledgement back to Mandible. Best
 * effort: any single failure (network, daemon down, missing row) is logged
 * and skipped — never propagated, so bridge startup is never blocked.
 */
export async function runStartupCatchUp(args: {
  sessionId: string;
  conversationId?: string | null;
  mcpServer: Server;
  fetchUndelivered: (sessionId: string, conversationId?: string | null) => Promise<UndeliveredAuthResult[]>;
  markDelivered: (requestId: string) => Promise<void>;
  log: (line: string) => void;
}): Promise<void> {
  const { sessionId, conversationId, mcpServer, fetchUndelivered, markDelivered, log } = args;
  let rows: UndeliveredAuthResult[];
  try {
    rows = await fetchUndelivered(sessionId, conversationId);
  } catch (err) {
    log(`Warning: channel-server startup catch-up fetch failed: ${err}\n`);
    return;
  }
  if (rows.length === 0) return;

  log(`channel-server startup catch-up: replaying ${rows.length} undelivered auth result(s)\n`);
  for (const row of rows) {
    const payload = buildAuthChannelEvent("auth:resolved", {
      request_id: row.id,
      status: row.status,
      head_branch: row.head_branch,
      title: row.title,
      exit_code: row.exit_code,
      // resolved_at omitted from the formatter's input — meta carries enough
      // for the agent to ground itself; the timestamp is implicit.
    });
    sendChannelNotification(mcpServer, payload);
    try {
      await markDelivered(row.id);
    } catch (err) {
      log(`Warning: failed to mark auth_request ${row.id} delivered: ${err}\n`);
      // Continue: the row will resurface on the next session start (still
      // tier 1 until the project grace window elapses).
    }
  }
}

// Bug: 4e32923 — only run main() when invoked as the CLI entrypoint, not when
// imported by tests. Module loading must remain side-effect-free so test files
// can exercise `runStartupCatchUp` without spawning a stdio MCP server.
const invokedAsCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
  });
}
