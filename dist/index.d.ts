import type http from "node:http";
import { type Db } from "./db.js";
import { SseManager } from "./sse.js";
export interface DaemonHandle {
    port: number;
    server: http.Server;
    db: Db;
    sse: SseManager;
    close: () => Promise<void>;
}
export interface StartOptions {
    port?: number;
    dbPath?: string;
    pidFilePath?: string;
    handleSignals?: boolean;
}
export declare function startDaemon(options?: StartOptions): Promise<DaemonHandle>;
