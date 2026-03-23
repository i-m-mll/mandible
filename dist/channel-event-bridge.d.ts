import type { AgenticBackend } from "./agentic-backend.js";
import type { Logger } from "./types.js";
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
export declare function bridgeChannelEvents(backend: AgenticBackend, mandibleSessionId: string, logger: Logger, timeoutMs?: number): ChannelBridgeHandle;
