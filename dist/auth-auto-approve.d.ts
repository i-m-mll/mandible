import type Database from "better-sqlite3";
import type { SseEvent } from "./types.js";
export declare const AUTO_APPROVE_DURATION_SETTING = "auth_auto_approve_duration_minutes";
export interface AuthApprovalContext {
    source: "auto_lease";
    leaseId: string;
    env: NodeJS.ProcessEnv;
}
export interface AuthAutoApprover {
    getActiveApprovalContext(): AuthApprovalContext | null;
}
export interface DelegatedSigningStatus {
    provider: string;
    configured: boolean;
    public_key: string | null;
    public_key_path: string;
    encrypted_passphrase_path: string;
    recipient_path: string;
    missing_tools: string[];
}
export interface AuthAutoApproveStatus {
    enabled: boolean;
    lease_id: string | null;
    enabled_until: number | null;
    remaining_ms: number;
    duration_minutes: number;
    signing: DelegatedSigningStatus;
}
export interface SetupDelegatedSigningOptions {
    name?: string;
    email?: string;
    ageRecipient?: string;
    overwrite?: boolean;
}
export interface AuthAutoApproveOptions {
    db?: InstanceType<typeof Database>;
    now?: () => number;
    broadcast?: (event: SseEvent) => void;
    configDir?: string;
}
export declare class AuthAutoApproveManager implements AuthAutoApprover {
    private readonly db;
    private readonly now;
    private readonly broadcast;
    private readonly configDir;
    private activeLease;
    constructor(options?: AuthAutoApproveOptions);
    getStatus(): AuthAutoApproveStatus;
    getActiveApprovalContext(): AuthApprovalContext | null;
    setupDelegatedSigning(options?: SetupDelegatedSigningOptions): Promise<DelegatedSigningStatus>;
    enable(durationMinutes?: number): Promise<AuthAutoApproveStatus>;
    disable(reason?: string): AuthAutoApproveStatus;
    getDurationMinutes(): number;
    private normalizeDurationMinutes;
    private getDelegatedSigningStatus;
    private paths;
    private getMissingTools;
    private ensureSettings;
    private resolveSingleAgeRecipient;
    private expireIfNeeded;
    private broadcastStatus;
}
