/**
 * Auth hooks — configurable post-auth-action hooks.
 *
 * Replaces the hardcoded build_dist_if_src_changed / restart_mandible_if_dist_changed
 * logic that was previously in auth-merge.sh. Hooks are stored in the auth_hooks
 * table and executed after successful auth actions (merge, commit, etc.).
 *
 * Bug: 4afab83
 */
import type { Db } from "./db.js";
import type { AuthHook, AuthHookExecutionResult, AuthHookInput, AuthRequest, AuthRequestType } from "./types.js";
export type { AuthHookExecutionResult };
export declare class AuthHookManager {
    private readonly db;
    constructor(db?: Db);
    private ensureSchema;
    /**
     * Find all enabled hooks matching a given repo name and auth type.
     * Matching rules:
     * - repo_pattern "*" matches all repos
     * - Otherwise, exact match against the repo name
     * - auth_type must match exactly
     */
    findMatchingHooks(repoName: string | undefined, authType: AuthRequestType): AuthHook[];
    /**
     * Execute all matching hooks for a completed auth request.
     * Returns results for each hook execution.
     *
     * Hooks run sequentially in position order. If a hook fails,
     * subsequent hooks still run (fail-open policy — the merge already succeeded).
     */
    executeHooks(request: AuthRequest, onOutput?: (hookLabel: string, text: string) => void): Promise<AuthHookExecutionResult[]>;
    private executeOneHook;
    list(): AuthHook[];
    get(id: string): AuthHook | null;
    create(input: AuthHookInput): AuthHook;
    update(id: string, fields: Partial<AuthHookInput> & {
        enabled?: boolean;
    }): AuthHook | null;
    delete(id: string): boolean;
}
