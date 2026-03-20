import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * Register all Mandible tools on the given MCP server.
 *
 * The sessionId parameter is the Mandible session ID for this channel
 * connection, discovered at startup from the environment or passed by
 * the spawning process.
 *
 * Bug: 0b454df — on first tool invocation, register the session with
 * Mandible (if not already registered at startup). Subsequent invocations
 * record tool usage for liveness tracking.
 */
export declare function registerTools(server: McpServer, sessionId: string | null): void;
