import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { MandibleSSEEvent } from "./types.js";
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
export declare function markDelivered(requestId: string): void;
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
 *     passive context). Filter rules:
 *     - null → passive log only (legacy / unscoped — Bug: 210ffa1)
 *     - matches ownSessionId → forward via channel event + markDelivered
 *     - mismatch → drop
 *     - ownSessionId itself null → passive log only (Bug: 210ffa1)
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
export declare function dispatchEvent(event: MandibleSSEEvent, ownSessionId: string | null, sendNotification: (category: string, message: string) => void, sendChannelEvent?: (payload: ChannelEventPayload) => void, onDelivered?: (requestId: string) => void): void;
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
export declare function sendChannelNotification(mcpServer: Server, payload: ChannelEventPayload): void;
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
 */
export declare function createNotificationBridge(mcpServer: Server, ownSessionId?: string | null): NotificationBridge;
/**
 * Bug: 4e32923 — build the channel-event payload (content + meta) for an
 * auth resolution. The content string is what Claude Code injects as a
 * synthetic user message; the meta record carries machine-readable fields
 * (request_id, branch, status, exit_code, outcome) so the agent can act
 * without re-fetching. Meta values are coerced to strings per the
 * `notifications/claude/channel` schema.
 */
export declare function buildAuthChannelEvent(type: "auth:resolved" | "auth:completed", data: unknown): ChannelEventPayload;
