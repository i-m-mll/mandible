import { DOMAIN_EVENTS, type AuthResolvedPayload, type ChannelEvent } from "../contracts.js";

export interface ChannelEventPayload {
  content: string;
  meta?: Record<string, string>;
}

type AuthResolvedPresentation = Pick<AuthResolvedPayload,
  "request_id" | "status" | "title" | "head_branch" | "exit_code"> &
  Partial<Pick<AuthResolvedPayload, "outcome" | "failure_reason" | "error" | "error_output">>;

/** Only the owning session receives an immediate prompt and delivery acknowledgement. */
export function dispatchEvent(
  event: ChannelEvent,
  ownSessionId: string | null,
  sendNotification: (category: string, message: string) => void,
  sendChannelEvent: (payload: ChannelEventPayload) => void,
  onDelivered: (requestId: string) => void = () => {},
  ownConversationId: string | null = null,
): void {
  const data = event.data;
  const passive = () => sendNotification("auth_resolved", formatAuthResolved(data));
  if (data.target_session_id == null) {
    passive();
  } else if (ownSessionId != null && data.target_session_id === ownSessionId) {
    sendChannelEvent(buildAuthChannelEvent(data));
    onDelivered(data.request_id);
  } else if (ownConversationId != null && data.conversation_id === ownConversationId) {
    sendNotification("auth_resolved", `${formatAuthResolved(data)} — this was submitted by a previous session of this conversation. Use mandible_check_inbox if relevant to your current work.`);
  } else if (ownSessionId == null) {
    passive();
  }
}

export function buildAuthChannelEvent(
  d: AuthResolvedPresentation,
): ChannelEventPayload {
  const { request_id: requestId, status, title, head_branch: branch, exit_code: exitCode } = d;
  const outcome = d.outcome ?? null;
  const errorText = d.error ?? "";
  const errorOutput = d.error_output ?? "";

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
    event_type: DOMAIN_EVENTS.AUTH_RESOLVED,
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

function formatAuthResolved(d: AuthResolvedPayload): string {
  const parts: string[] = [`Auth request ${d.status}`];
  if (d.title) parts.push(`"${d.title}"`);
  if (d.head_branch) parts.push(`for branch ${d.head_branch}`);
  if (d.exit_code !== null) parts.push(`(exit code: ${d.exit_code})`);
  if (d.error) parts.push(`Error: ${d.error}`);
  return parts.join(" — ");
}
