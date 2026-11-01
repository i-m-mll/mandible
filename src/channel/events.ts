import type { MandibleSSEEvent } from "./types.js";
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
  onDelivered: (requestId: string) => void = () => {},
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
