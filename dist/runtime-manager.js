import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
const execFileAsync = promisify(execFile);
const REPO_URL = "git@github.com:i-m-mll/mandible.git";
/**
 * Compute the platform-specific Zone 2 runtime path.
 *
 * - macOS: ~/Library/Application Support/Mandible/runtime/
 * - Linux: ~/.local/share/mandible/runtime/
 * - Windows: %APPDATA%/Mandible/runtime/
 */
function computeZone2Path() {
    const home = os.homedir();
    switch (process.platform) {
        case "darwin":
            return path.join(home, "Library", "Application Support", "Mandible", "runtime");
        case "win32":
            return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Mandible", "runtime");
        default:
            // Linux and other Unix
            return path.join(home, ".local", "share", "mandible", "runtime");
    }
}
function currentEntryDir() {
    return path.dirname(fileURLToPath(import.meta.url));
}
export class RuntimeManager {
    zone2;
    constructor() {
        this.zone2 = computeZone2Path();
    }
    /**
     * Detect the current install mode based on the running process path.
     */
    installMode() {
        const entryDir = currentEntryDir();
        const repoRoot = path.resolve(entryDir, "..");
        // dev: repo root has .git AND src-tauri/
        if (fs.existsSync(path.join(repoRoot, ".git")) &&
            fs.existsSync(path.join(repoRoot, "src-tauri"))) {
            return "dev";
        }
        // release-zone2: zone2 path exists and has dist/index.js
        if (this.isZone2Available()) {
            return "release-zone2";
        }
        // release-bundled: running from a Tauri bundle (path contains Resources or resources)
        const normalized = entryDir.replace(/\\/g, "/");
        if (/[/\\](Resources|resources)[/\\]/i.test(normalized)) {
            return "release-bundled";
        }
        // npm-global: running from a global node_modules install
        if (normalized.includes("node_modules")) {
            return "npm-global";
        }
        // fallback
        return "dev";
    }
    /**
     * Return the Zone 2 runtime path, or null if not applicable.
     */
    getZone2Path() {
        return this.zone2;
    }
    /**
     * Check whether the Zone 2 runtime has been bootstrapped.
     */
    isZone2Available() {
        return fs.existsSync(path.join(this.zone2, "dist", "index.js"));
    }
    /**
     * Bootstrap Zone 2 by cloning the repo (shallow, main branch).
     * Then install dependencies and build.
     */
    async bootstrapZone2() {
        if (this.isZone2Available()) {
            return;
        }
        // Ensure parent directory exists
        const parent = path.dirname(this.zone2);
        fs.mkdirSync(parent, { recursive: true });
        // Clone shallow
        await execFileAsync("git", [
            "clone",
            "--depth", "1",
            "--branch", "main",
            REPO_URL,
            this.zone2,
        ], { timeout: 120_000 });
        // Install and build
        await execFileAsync("npm", ["install"], {
            cwd: this.zone2,
            timeout: 120_000,
        });
        await execFileAsync("npm", ["run", "build"], {
            cwd: this.zone2,
            timeout: 120_000,
        });
    }
    /**
     * Get comprehensive runtime status.
     */
    async getStatus() {
        const mode = this.installMode();
        const available = this.isZone2Available();
        let commit = null;
        let branch = null;
        let patchCount = 0;
        if (available) {
            try {
                const { stdout: commitOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.zone2 });
                commit = commitOut.trim();
            }
            catch {
                // non-fatal
            }
            try {
                const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.zone2 });
                branch = branchOut.trim();
            }
            catch {
                // non-fatal
            }
            try {
                const { stdout: logOut } = await execFileAsync("git", ["log", "main..HEAD", "--oneline"], { cwd: this.zone2 });
                const lines = logOut.trim().split("\n").filter(Boolean);
                patchCount = lines.length;
            }
            catch {
                // non-fatal — may fail if HEAD is main
            }
        }
        return {
            installMode: mode,
            zone2Path: this.zone2,
            available,
            commit,
            branch,
            patchCount,
        };
    }
    /**
     * List local patches (commits ahead of main).
     */
    async listPatches() {
        if (!this.isZone2Available()) {
            return [];
        }
        const db = getDb();
        const rows = db.prepare("SELECT * FROM runtime_patches ORDER BY applied_at DESC").all();
        return rows;
    }
    /**
     * Check if upstream has updates.
     */
    async checkForUpdates() {
        if (!this.isZone2Available()) {
            return { available: false, behindBy: 0 };
        }
        try {
            await execFileAsync("git", ["fetch", "origin", "main"], {
                cwd: this.zone2,
                timeout: 30_000,
            });
            const { stdout } = await execFileAsync("git", ["rev-list", "--count", "HEAD..origin/main"], { cwd: this.zone2 });
            const behindBy = parseInt(stdout.trim(), 10) || 0;
            return { available: behindBy > 0, behindBy };
        }
        catch {
            return { available: false, behindBy: 0 };
        }
    }
    /**
     * Apply upstream updates: fetch, rebase, install, rebuild.
     */
    async applyUpdate() {
        if (!this.isZone2Available()) {
            throw new Error("Zone 2 runtime is not available");
        }
        await execFileAsync("git", ["fetch", "origin", "main"], {
            cwd: this.zone2,
            timeout: 30_000,
        });
        await execFileAsync("git", ["rebase", "origin/main"], {
            cwd: this.zone2,
            timeout: 60_000,
        });
        await execFileAsync("npm", ["install"], {
            cwd: this.zone2,
            timeout: 120_000,
        });
        await execFileAsync("npm", ["run", "build"], {
            cwd: this.zone2,
            timeout: 120_000,
        });
        // Record upstream update patch
        try {
            const { stdout: commitOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.zone2 });
            this.recordPatch({
                commit_hash: commitOut.trim(),
                source: "upstream_update",
                diff_summary: "Applied upstream update via rebase",
            });
        }
        catch {
            // non-fatal
        }
    }
    /**
     * Rollback the last patch: git revert HEAD + rebuild.
     */
    async rollbackLastPatch() {
        if (!this.isZone2Available()) {
            throw new Error("Zone 2 runtime is not available");
        }
        // Get current HEAD before revert
        const { stdout: beforeHash } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.zone2 });
        await execFileAsync("git", ["revert", "HEAD", "--no-edit"], {
            cwd: this.zone2,
            timeout: 30_000,
        });
        await execFileAsync("npm", ["run", "build"], {
            cwd: this.zone2,
            timeout: 120_000,
        });
        // Mark reverted in DB
        const db = getDb();
        const now = Date.now();
        db.prepare("UPDATE runtime_patches SET reverted_at = ? WHERE commit_hash = ? AND reverted_at IS NULL").run(now, beforeHash.trim());
    }
    /**
     * Reset to upstream main: discard all local patches, rebuild.
     */
    async resetToUpstream() {
        if (!this.isZone2Available()) {
            throw new Error("Zone 2 runtime is not available");
        }
        await execFileAsync("git", ["fetch", "origin", "main"], {
            cwd: this.zone2,
            timeout: 30_000,
        });
        await execFileAsync("git", ["checkout", "main"], {
            cwd: this.zone2,
            timeout: 10_000,
        });
        await execFileAsync("git", ["reset", "--hard", "origin/main"], {
            cwd: this.zone2,
            timeout: 10_000,
        });
        await execFileAsync("npm", ["install"], {
            cwd: this.zone2,
            timeout: 120_000,
        });
        await execFileAsync("npm", ["run", "build"], {
            cwd: this.zone2,
            timeout: 120_000,
        });
        // Mark all unreverted patches as reverted
        const db = getDb();
        const now = Date.now();
        db.prepare("UPDATE runtime_patches SET reverted_at = ? WHERE reverted_at IS NULL").run(now);
    }
    /**
     * Record a patch in the runtime_patches audit table.
     */
    recordPatch(patch) {
        const db = getDb();
        const id = randomUUID();
        const now = Date.now();
        db.prepare(`INSERT INTO runtime_patches (id, fingerprint, commit_hash, parent_hash, diff_summary, diff_stat, applied_at, source, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, patch.fingerprint ?? null, patch.commit_hash, patch.parent_hash ?? null, patch.diff_summary ?? null, patch.diff_stat ?? null, now, patch.source, patch.session_id ?? null);
    }
}
// Module-level singleton for convenience
let _instance = null;
export function getRuntimeManager() {
    if (!_instance) {
        _instance = new RuntimeManager();
    }
    return _instance;
}
