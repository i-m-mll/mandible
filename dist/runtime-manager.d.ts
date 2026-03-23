export type InstallMode = "dev" | "release-zone2" | "release-bundled" | "npm-global";
export type RuntimeStatus = {
    installMode: InstallMode;
    zone2Path: string | null;
    available: boolean;
    commit: string | null;
    branch: string | null;
    patchCount: number;
};
export type RuntimePatch = {
    id: string;
    fingerprint: string | null;
    commit_hash: string;
    parent_hash: string | null;
    diff_summary: string | null;
    diff_stat: string | null;
    applied_at: number;
    reverted_at: number | null;
    source: string;
    session_id: string | null;
    submitted: number;
    submission_url: string | null;
};
export type RuntimePatchInput = {
    fingerprint?: string;
    commit_hash: string;
    parent_hash?: string;
    diff_summary?: string;
    diff_stat?: string;
    source: "agent" | "known_fix" | "manual" | "upstream_update";
    session_id?: string;
};
export declare class RuntimeManager {
    private zone2;
    constructor();
    /**
     * Detect the current install mode based on the running process path.
     */
    installMode(): InstallMode;
    /**
     * Return the Zone 2 runtime path, or null if not applicable.
     */
    getZone2Path(): string | null;
    /**
     * Check whether the Zone 2 runtime has been bootstrapped.
     */
    isZone2Available(): boolean;
    /**
     * Bootstrap Zone 2 by cloning the repo (shallow, main branch).
     * Then install dependencies and build.
     */
    bootstrapZone2(): Promise<void>;
    /**
     * Get comprehensive runtime status.
     */
    getStatus(): Promise<RuntimeStatus>;
    /**
     * List local patches (commits ahead of main).
     */
    listPatches(): Promise<RuntimePatch[]>;
    /**
     * Check if upstream has updates.
     */
    checkForUpdates(): Promise<{
        available: boolean;
        behindBy: number;
    }>;
    /**
     * Apply upstream updates: fetch, rebase, install, rebuild.
     */
    applyUpdate(): Promise<void>;
    /**
     * Rollback the last patch: git revert HEAD + rebuild.
     */
    rollbackLastPatch(): Promise<void>;
    /**
     * Reset to upstream main: discard all local patches, rebuild.
     */
    resetToUpstream(): Promise<void>;
    /**
     * Record a patch in the runtime_patches audit table.
     */
    recordPatch(patch: RuntimePatchInput): void;
}
export declare function getRuntimeManager(): RuntimeManager;
