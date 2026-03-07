/**
 * PTY Manager — manages terminal sessions backed by node-pty.
 * Bug: e980dd8
 */
import type { WebSocket } from "ws";
import type { Logger, ConsoleSession, ConsoleSessionInput } from "./types.js";
export declare class RingBuffer {
    private buf;
    private head;
    private size;
    constructor(capacity?: number);
    /** Append a string (UTF-8) to the ring buffer. */
    append(data: string): void;
    /**
     * Returns a contiguous Buffer containing current ring buffer contents
     * in chronological order. Handles wrap-around correctly.
     */
    snapshot(): Buffer;
    /** Reset the buffer. */
    clear(): void;
    /** Current number of bytes stored. */
    get byteLength(): number;
}
export declare class PtySession {
    readonly id: string;
    meta: ConsoleSession;
    private ptyProc;
    private ringBuffer;
    private wsClients;
    private lineBuffer;
    private onDataDisposable;
    private onExitDisposable;
    private logger;
    constructor(meta: ConsoleSession, logger: Logger);
    /** Start the PTY process. */
    start(): void;
    /** Stop the PTY process with an optional signal. */
    stop(signal?: string): void;
    /** Resize the PTY. */
    resize(cols: number, rows: number): void;
    /** Write raw input to the PTY. */
    write(data: string): void;
    /**
     * Add a WebSocket client. Replays ring buffer immediately, then sends
     * init metadata. Removes client on 'close'.
     *
     * If the session is no longer running (crashed or ended), sends a UTF-8
     * error banner to the terminal and closes the WebSocket with code 1001
     * rather than adding it to the active client set. This prevents the
     * "cursor but no output" zombie state after a Mandible restart.
     */
    addWsClient(ws: WebSocket): void;
    /** Remove a WebSocket client from the broadcast set. */
    removeWsClient(ws: WebSocket): void;
    /** Return a snapshot of the ring buffer for HTTP-based replay. */
    getBufferSnapshot(): Buffer;
    private handleData;
    private feedLineParser;
    private parseStreamJsonLine;
    private handleExit;
    private broadcastWsStatus;
    private dbUpdate;
}
export declare class PtyManager {
    private sessions;
    private logger;
    constructor(_db: unknown, logger: Logger);
    /**
     * Initialize from DB: reconcile running/stopped state after daemon restart.
     * All previously 'running' sessions are marked 'stopped' (their PTYs are
     * gone after restart). Operator sessions with auto_restart=1 are then
     * restarted, transitioning them back to 'running' via start().
     * This prevents the zombie terminal state where addWsClient() would accept
     * WS connections for dead sessions that produce no output.
     */
    init(): void;
    /** Create a new console session (does NOT start it). */
    create(input: ConsoleSessionInput): ConsoleSession;
    /** Get a PtySession by ID. */
    get(id: string): PtySession | undefined;
    /** Get all PtySessions. */
    getAll(): PtySession[];
    /** Start a session by ID. */
    start(id: string): void;
    /** Stop a session by ID. */
    stop(id: string, signal?: string): void;
    /** Stop and remove a session from DB and memory. */
    delete(id: string): void;
    /** Resize a session's PTY. */
    resize(id: string, cols: number, rows: number): void;
    /** Write input to a session's PTY. */
    write(id: string, data: string): void;
    /**
     * Add a WebSocket client to a session.
     * Returns false if session not found.
     */
    addWsClient(id: string, ws: WebSocket): boolean;
    /**
     * Start or create the Operator session.
     * - Reads console_operator_session_id from settings
     * - If empty: creates a new session with default operator config, saves ID
     * - If found: retrieves from sessions map
     * - Calls start() on the session
     */
    startOperator(): void;
    /** Kill all PTYs. Called during daemon shutdown. */
    close(): void;
}
