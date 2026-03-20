import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
export declare function createNotificationBridge(mcpServer: Server): NotificationBridge;
