import type { HealthResponse } from "./types.js";
export declare function getPidFilePath(): string;
export declare function writePidFile(pid?: number, pidFilePath?: string): void;
export declare function removePidFile(pidFilePath?: string): void;
export declare function readPidFile(pidFilePath?: string): number | null;
export declare function checkHealth(port: number): Promise<HealthResponse | null>;
export declare function waitForHealth(port: number, timeoutMs?: number, intervalMs?: number): Promise<HealthResponse | null>;
export interface AutoStartResult {
    status: "already_running" | "started";
    pid?: number;
}
export interface AutoStartOptions {
    port: number;
    dbPath?: string;
    pidFilePath?: string;
    entryPath?: string;
}
export declare function autoStartDaemon(options: AutoStartOptions): Promise<AutoStartResult>;
export declare function stopDaemon(pidFilePath?: string): boolean;
