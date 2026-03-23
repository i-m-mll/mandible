// Bug: 7ab2f3e — Channel event bridge: ChannelRegistry to PTYBackend stream
//
// Bridges ChannelRegistry events (connect, tool_call, notification, disconnect)
// into a PTYBackend's structured stream so they appear in the SSE broadcast
// to the UI alongside other ConsoleStreamEvents.
//
// Handles late registration: the channel session may not exist when the PTY
// backend is wired. A one-time listener waits for the matching session to
// connect (with a configurable timeout). Cleanup removes listeners and
// cancels pending timeouts when the backend stops.

import type { ChannelEvent } from "./channel-registry.js";
import { getChannelRegistry } from "./channel-registry.js";
import type { AgenticBackend } from "./agentic-backend.js";
import type { ConsoleStreamEvent, Logger } from "./types.js";

/** Default timeout for waiting for late channel registration (ms). */
const LATE_REGISTRATION_TIMEOUT_MS = 30_000;

/**
 * Convert a ChannelEvent into a ConsoleStreamEvent suitable for ingestion
 * by a PTYBackend. Uses the `system` type with a `channel_event` subtype
 * and a `source: 'channel_bridge'` marker for deduplication.
 */
function channelEventToStreamEvent(event: ChannelEvent): ConsoleStreamEvent {
  return {
    type: "system",
    subtype: "channel_event",
    source: "channel_bridge",
    timestamp: event.timestamp,
    channel_event_type: event.event_type,
    tool_name: event.tool_name,
    tool_input: event.tool_input,
    tool_output: event.tool_output,
    notification_type: event.notification_type,
    notification_content: event.notification_content,
    session_id: event.session_id,
  };
}

/**
 * Disposable handle returned by `bridgeChannelEvents`. Call `dispose()` to
 * stop bridging and clean up all listeners and timers.
 */
export interface ChannelBridgeHandle {
  /** Remove all listeners and cancel any pending late-registration timeout. */
  dispose(): void;
  /** True if currently actively bridging events. */
  readonly active: boolean;
}

/**
 * Bridge ChannelRegistry events for a specific mandible_session_id into a
 * backend's structured event stream.
 *
 * If the channel session is not yet registered (late registration), sets up
 * a one-time listener that activates the bridge when it appears. After
 * `timeoutMs`, logs a warning and gives up waiting.
 */
export function bridgeChannelEvents(
  backend: AgenticBackend,
  mandibleSessionId: string,
  logger: Logger,
  timeoutMs: number = LATE_REGISTRATION_TIMEOUT_MS,
): ChannelBridgeHandle {
  const registry = getChannelRegistry();
  let active = false;
  let disposed = false;
  let lateTimer: ReturnType<typeof setTimeout> | null = null;

  // The event handler that forwards matching channel events to the backend
  const onChannelEvent = (event: ChannelEvent): void => {
    if (event.session_id !== mandibleSessionId) return;
    const streamEvent = channelEventToStreamEvent(event);
    backend.ingestStructuredEvent(streamEvent);
  };

  // Start actively bridging
  function activate(): void {
    if (disposed || active) return;
    active = true;
    registry.on("channel_event", onChannelEvent);
    logger("info", "channel_bridge_active", {
      console_session_id: backend.id,
      mandible_session_id: mandibleSessionId,
    });
  }

  // Check if channel session already exists
  const existing = registry.get(mandibleSessionId);
  if (existing) {
    // Channel session already registered — bridge immediately
    activate();
  } else {
    // Late registration: wait for the channel session to appear
    logger("info", "channel_bridge_waiting", {
      console_session_id: backend.id,
      mandible_session_id: mandibleSessionId,
      timeout_ms: timeoutMs,
    });

    // Listen for connect events matching our session
    const onLateConnect = (event: ChannelEvent): void => {
      if (event.event_type !== "connect" || event.session_id !== mandibleSessionId) return;
      // Found our session — activate and stop waiting
      registry.removeListener("channel_event", onLateConnect);
      if (lateTimer) {
        clearTimeout(lateTimer);
        lateTimer = null;
      }
      activate();
    };

    registry.on("channel_event", onLateConnect);

    // Timeout: stop waiting after the specified duration
    lateTimer = setTimeout(() => {
      lateTimer = null;
      if (!active && !disposed) {
        registry.removeListener("channel_event", onLateConnect);
        logger("warn", "channel_bridge_timeout", {
          console_session_id: backend.id,
          mandible_session_id: mandibleSessionId,
          timeout_ms: timeoutMs,
        });
      }
    }, timeoutMs);

    // Unref so the timer doesn't prevent Node from exiting
    if (lateTimer && typeof lateTimer === "object" && "unref" in lateTimer) {
      (lateTimer as NodeJS.Timeout).unref();
    }
  }

  // Listen for backend stop/destroy to auto-dispose
  const onBackendStatus = (event: { kind: string }): void => {
    if (event.kind === "stopped" || event.kind === "exit") {
      handle.dispose();
    }
  };
  backend.on("status", onBackendStatus);

  const handle: ChannelBridgeHandle = {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      active = false;

      // Remove the active bridge listener
      registry.removeListener("channel_event", onChannelEvent);

      // Cancel any pending late-registration timeout
      if (lateTimer) {
        clearTimeout(lateTimer);
        lateTimer = null;
      }

      // Remove backend status listener
      backend.removeListener("status", onBackendStatus);

      logger("info", "channel_bridge_disposed", {
        console_session_id: backend.id,
        mandible_session_id: mandibleSessionId,
      });
    },
    get active() {
      return active;
    },
  };

  return handle;
}
