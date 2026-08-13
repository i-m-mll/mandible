/**
 * Auth hooks — configurable post-auth-action hooks.
 *
 * Replaces the hardcoded build_dist_if_src_changed / restart_mandible_if_dist_changed
 * logic that was previously in auth-merge.sh. Hooks are stored in the auth_hooks
 * table and executed after successful auth actions (merge, commit, etc.).
 *
 * Bug: 4afab83
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { getDb } from "./db.js";
import type { Db } from "./db.js";
import type {
  AuthHook,
  AuthHookExecutionResult,
  AuthHookInput,
  AuthRequest,
  AuthRequestType,
} from "./types.js";

export type { AuthHookExecutionResult };

// Most hooks should finish quickly. The built-in Mandible hook may perform a
// cold Rust/Tauri release build after native changes, so it gets a deliberate
// longer ceiling instead of being killed halfway through bundle production.
const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const MANDIBLE_REBUILD_HOOK_TIMEOUT_MS = 30 * 60 * 1000;

export function authHookTimeoutMs(hookId: string): number {
  return hookId === "builtin-mandible-rebuild"
    ? MANDIBLE_REBUILD_HOOK_TIMEOUT_MS
    : DEFAULT_HOOK_TIMEOUT_MS;
}

export class AuthHookManager {
  private readonly db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  /**
   * Find all enabled hooks matching a given repo name and auth type.
   * Matching rules:
   * - repo_pattern "*" matches all repos
   * - Otherwise, exact match against the repo name
   * - auth_type must match exactly
   */
  findMatchingHooks(repoName: string | undefined, authType: AuthRequestType): AuthHook[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_hooks
         WHERE enabled = 1
           AND auth_type = ?
           AND (repo_pattern = '*' OR repo_pattern = ?)
         ORDER BY position ASC, created_at ASC`
      )
      .all(authType, repoName ?? "") as Record<string, unknown>[];

    return rows.map(mapHookRow);
  }

  /**
   * Execute all matching hooks for a completed auth request.
   * Returns results for each hook execution.
   *
   * Hooks run sequentially in position order. If a hook fails,
   * subsequent hooks still run (fail-open policy — the merge already succeeded).
   */
  async executeHooks(
    request: AuthRequest,
    onOutput?: (hookLabel: string, text: string) => void,
  ): Promise<AuthHookExecutionResult[]> {
    const hooks = this.findMatchingHooks(request.repo, request.type);

    if (hooks.length === 0) {
      return [];
    }

    const results: AuthHookExecutionResult[] = [];

    for (const hook of hooks) {
      const result = await this.executeOneHook(hook, request, onOutput);
      results.push(result);
    }

    return results;
  }

  private async executeOneHook(
    hook: AuthHook,
    request: AuthRequest,
    onOutput?: (hookLabel: string, text: string) => void,
  ): Promise<AuthHookExecutionResult> {
    const startedAt = Date.now();
    const cwd = request.cwd ?? undefined;
    const timeoutMs = authHookTimeoutMs(hook.id);

    return new Promise<AuthHookExecutionResult>((resolve) => {
      let output = "";
      let settled = false;

      const child = spawn("bash", ["-c", hook.command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          MANDIBLE_AUTH_REQUEST_ID: request.id,
          MANDIBLE_AUTH_TYPE: request.type,
          MANDIBLE_AUTH_REPO: request.repo ?? "",
          MANDIBLE_AUTH_BRANCH: request.head_branch ?? "",
          MANDIBLE_AUTH_BASE_BRANCH: request.base_branch ?? "",
          MANDIBLE_HOOK_ID: hook.id,
          MANDIBLE_HOOK_LABEL: hook.label,
        },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 5000);
        resolve({
          hook_id: hook.id,
          label: hook.label,
          exit_code: null,
          output: output + "\n[hook timed out after " + (timeoutMs / 1000) + "s]",
          duration_ms: Date.now() - startedAt,
        });
      }, timeoutMs);

      const handleChunk = (data: Buffer): void => {
        const text = data.toString("utf8");
        output += text;
        onOutput?.(hook.label, text);
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          hook_id: hook.id,
          label: hook.label,
          exit_code: 1,
          output: output + "\n[hook error: " + error.message + "]",
          duration_ms: Date.now() - startedAt,
        });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          hook_id: hook.id,
          label: hook.label,
          exit_code: typeof code === "number" ? code : 1,
          output,
          duration_ms: Date.now() - startedAt,
        });
      });
    });
  }

  // --- CRUD ---

  list(): AuthHook[] {
    const rows = this.db
      .prepare("SELECT * FROM auth_hooks ORDER BY position ASC, created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapHookRow);
  }

  get(id: string): AuthHook | null {
    const row = this.db
      .prepare("SELECT * FROM auth_hooks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapHookRow(row) : null;
  }

  create(input: AuthHookInput): AuthHook {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO auth_hooks (id, repo_pattern, auth_type, command, label, enabled, builtin, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        id,
        input.repo_pattern,
        input.auth_type,
        input.command,
        input.label,
        input.enabled !== false ? 1 : 0,
        input.position ?? 100,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, fields: Partial<AuthHookInput> & { enabled?: boolean }): AuthHook | null {
    const existing = this.get(id);
    if (!existing) return null;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (fields.repo_pattern !== undefined) {
      updates.push("repo_pattern = ?");
      values.push(fields.repo_pattern);
    }
    if (fields.auth_type !== undefined) {
      updates.push("auth_type = ?");
      values.push(fields.auth_type);
    }
    if (fields.command !== undefined) {
      updates.push("command = ?");
      values.push(fields.command);
    }
    if (fields.label !== undefined) {
      updates.push("label = ?");
      values.push(fields.label);
    }
    if (fields.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(fields.enabled ? 1 : 0);
    }
    if (fields.position !== undefined) {
      updates.push("position = ?");
      values.push(fields.position);
    }

    if (updates.length === 0) return existing;

    updates.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    this.db
      .prepare(`UPDATE auth_hooks SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.get(id);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    if (existing.builtin) {
      throw new Error("Cannot delete built-in hooks. Disable them instead.");
    }
    this.db.prepare("DELETE FROM auth_hooks WHERE id = ?").run(id);
    return true;
  }
}

function mapHookRow(row: Record<string, unknown>): AuthHook {
  return {
    id: String(row.id),
    repo_pattern: String(row.repo_pattern ?? "*"),
    auth_type: String(row.auth_type ?? "merge") as AuthRequestType,
    command: String(row.command ?? ""),
    label: String(row.label ?? ""),
    enabled: row.enabled === 1 || row.enabled === true,
    builtin: row.builtin === 1 || row.builtin === true,
    position: typeof row.position === "number" ? row.position : 0,
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}
