#!/usr/bin/env node
// Bug: 1d652d5 — MCP channel server entry point
//
// This server runs as a stdio subprocess spawned by Claude Code when
// configured with `--channels server:mandible`. It bridges Mandible's
// event system and API to Claude Code via the MCP protocol.
//
// Architecture: STATELESS — all state lives in the Mandible daemon at
// localhost:19420. This process is a thin adapter that:
//   1. Exposes Mandible operations as MCP tools
//   2. Forwards Mandible SSE events as MCP notifications
//   3. Communicates over stdio (stdin/stdout JSON-RPC)
import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { createNotificationBridge } from "./notifications.js";
import * as client from "./client.js";
const INSTRUCTIONS = `You are connected to Mandible, a local agent control plane. Mandible tracks your work via issues, branches, and work units.

When you receive a Mandible notification:
- auth_resolved: An auth request (protected-branch merge) has been approved or rejected. Check the result and proceed accordingly.
- inbox_item: A work item needs attention — a continuation from a previous session, an unassigned issue, or a work-unit update. Use mandible_check_inbox for details.
- work_assigned: A work unit has been assigned to your session. Read the issue description and begin work.
- work_updated: A work unit's state has changed. Check if it affects your current work.

Available tools:
- mandible_check_inbox: Check your inbox for pending items (continuations, auth results, work units needing attention)
- mandible_report_status: Report your current work status to Mandible (for visibility in the dashboard)
- mandible_submit_auth: Submit an auth request for a protected-branch merge
- mandible_get_issues: List open issues available for work
- mandible_request_work: Request a work-unit assignment from Mandible`;
async function main() {
    // Discover session ID from environment (set by Claude Code or the
    // spawning process)
    const sessionId = process.env.MANDIBLE_SESSION_ID ??
        process.env.SESSION_ID ??
        null;
    // Create the MCP server with channel capability
    const server = new McpServer({
        name: "mandible",
        version: "0.1.0",
    }, {
        capabilities: {
            tools: {},
            logging: {},
        },
        instructions: INSTRUCTIONS,
    });
    // Bug: 0b454df — detect environment for session registration
    const cwd = process.env.CLAUDE_CWD ?? process.cwd();
    let branch = null;
    try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
    }
    catch {
        // Not in a git repo — branch stays null
    }
    // Bug: 0b454df — register session with Mandible on startup so the
    // dashboard shows it immediately, not just on first tool call.
    if (sessionId) {
        try {
            await client.registerSession({
                id: sessionId,
                app: "claude-channel",
                status: "active",
                cwd,
                branch,
            });
        }
        catch {
            // Best effort — Mandible may not be running yet
            process.stderr.write("Warning: could not register channel session with Mandible\n");
        }
    }
    // Register tools
    registerTools(server, sessionId);
    // Set up the SSE → MCP notification bridge
    // Access the underlying Server instance for sendLoggingMessage
    const bridge = createNotificationBridge(server.server);
    // Connect via stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Start listening for Mandible events after MCP connection is established
    bridge.start();
    // Log to stderr (stdout is reserved for MCP protocol)
    process.stderr.write(`Mandible MCP channel server started${sessionId ? ` (session: ${sessionId.slice(0, 8)}...)` : ""}\n`);
    // Handle graceful shutdown
    const shutdown = () => {
        bridge.stop();
        server.close().catch(() => { });
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
});
