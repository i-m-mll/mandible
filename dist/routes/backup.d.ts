import type { RouteRegistrar } from "../server.js";
export type BackupStatus = {
    enabled: boolean;
    interval_hours: number;
    last_run_at: number | null;
    last_size_bytes: number | null;
    last_error: string | null;
};
export declare function startBackupScheduler(): void;
export declare function stopBackupScheduler(): void;
export declare function registerBackupRoutes(server: RouteRegistrar): void;
