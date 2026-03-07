import type { IncomingMessage, ServerResponse } from "node:http";
import type { SSEEvent, SseEvent, StartupCommitInfo } from "./types.js";
export declare class SseManager {
    private clients;
    private heartbeatTimer;
    private startupCommit;
    /** Start periodic heartbeat comments to keep connections alive. */
    startHeartbeat(intervalMs?: number): void;
    addClient(req: IncomingMessage, res: ServerResponse, topics: string[]): void;
    setStartupCommit(info: StartupCommitInfo | null): void;
    broadcast(event: SSEEvent): void;
    closeAll(): void;
    count(): number;
    private maybeSendReloadEvent;
}
export declare function setSseManager(manager: SseManager): void;
export declare function broadcast(eventOrType: string | SseEvent, data?: unknown): void;
export type { SseEvent };
