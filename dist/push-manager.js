import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { getDb } from "./db.js";
import { broadcast } from "./sse.js";
const REPO_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
// Bug: ea3102a — SSH ControlMaster approach: open one SSH connection per host
// (one YubiKey touch) and reuse for all subsequent git pushes via GIT_SSH_COMMAND.
function buildControlMasterEnv(socketPath, identityFile = null) {
    const gitSshCommandParts = [
        "ssh",
        "-o ControlMaster=auto",
        `-o ControlPath=${socketPath}-%h`,
        "-o ControlPersist=600",
        "-o StrictHostKeyChecking=accept-new",
    ];
    if (identityFile) {
        gitSshCommandParts.push(`-i ${identityFile}`);
        gitSshCommandParts.push("-o IdentitiesOnly=yes");
    }
    const gitSshCommand = gitSshCommandParts.join(" ");
    return {
        ...process.env,
        GIT_SSH_COMMAND: gitSshCommand,
    };
}
async function cleanupControlMaster(socketPath) {
    try {
        const dir = path.dirname(socketPath);
        const prefix = path.basename(socketPath) + "-";
        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (file.startsWith(prefix)) {
                try {
                    fs.rmSync(path.join(dir, file), { force: true });
                }
                catch {
                    // best effort
                }
            }
        }
    }
    catch {
        // best effort
    }
}
/**
 * Run a git command asynchronously using spawn, with a timeout.
 * Returns stdout on success, throws on failure or timeout.
 */
function runGitAsync(args, cwd, env, timeoutMs = REPO_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const binary = args[0] === "ssh" ? "ssh" : "git";
        const spawnArgs = args[0] === "ssh" ? args.slice(1) : args;
        const child = spawn(binary, spawnArgs, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGTERM");
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                }
                catch { /* already dead */ }
            }, 3_000);
            reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout?.on("data", (data) => { stdout += data.toString("utf8"); });
        child.stderr?.on("data", (data) => { stderr += data.toString("utf8"); });
        child.on("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
            }
            else {
                resolve(stdout.trimEnd());
            }
        });
    });
}
/**
 * Check whether a local git ref namespace exists (e.g. refs/bugs/, refs/notes/).
 */
function refsExist(repoRoot, refPrefix) {
    try {
        const gitDir = path.join(repoRoot, ".git");
        // Check packed-refs or loose refs
        const looseDir = path.join(gitDir, refPrefix);
        if (fs.existsSync(looseDir))
            return true;
        const packedRefsPath = path.join(gitDir, "packed-refs");
        if (fs.existsSync(packedRefsPath)) {
            const content = fs.readFileSync(packedRefsPath, "utf8");
            if (content.includes(refPrefix))
                return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
function getSetting(key, defaultValue) {
    try {
        const db = getDb();
        const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
        return row?.value ?? defaultValue;
    }
    catch {
        return defaultValue;
    }
}
/**
 * Extract the SSH hostname from a git remote URL.
 * Returns null for HTTPS URLs or unparseable URLs.
 *
 * Handles:
 *   git@github.com:user/repo.git       → github.com
 *   ssh://git@github.com/user/repo.git → github.com
 *   https://github.com/user/repo.git   → null (skip)
 */
function extractSshHost(remoteUrl) {
    const trimmed = remoteUrl.trim();
    // Skip HTTPS remotes
    if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
        return null;
    }
    // ssh:// scheme
    if (trimmed.startsWith("ssh://")) {
        try {
            const url = new URL(trimmed);
            return url.hostname || null;
        }
        catch {
            return null;
        }
    }
    // SCP-style: [user@]host:path
    const scpMatch = trimmed.match(/^(?:[^@/]+@)?([^:/]+):/);
    if (scpMatch) {
        return scpMatch[1];
    }
    return null;
}
/**
 * Pre-authenticate SSH ControlMaster connections to all unique SSH hosts
 * across the given repos. Broadcasts push:auth:pending before starting
 * and push:auth:complete after all hosts are authed.
 *
 * Returns early (no-op) if no SSH hosts are found.
 * Throws if pre-auth fails for any host.
 */
async function preAuthSshHosts(repos, socketPath, identityFile) {
    // Collect unique SSH hosts from all repo remotes
    const hosts = new Set();
    for (const repo of repos) {
        try {
            const remoteUrl = await runGitAsync(["remote", "get-url", "origin"], repo.root, process.env);
            const host = extractSshHost(remoteUrl);
            if (host) {
                hosts.add(host);
            }
        }
        catch {
            // No remote or remote fetch failed — skip this repo
        }
    }
    if (hosts.size === 0) {
        // All HTTPS or no remotes — nothing to pre-auth
        return;
    }
    const hostList = Array.from(hosts);
    broadcast({ type: "push:auth:pending", event: "push:auth:pending", data: { hosts: hostList } });
    for (const host of hostList) {
        const sshArgs = [
            "ssh",
            "-f",
            "-N",
            "-o", "ControlMaster=yes",
            "-o", `ControlPath=${socketPath}-${host}`,
            "-o", "ControlPersist=600",
            "-o", "StrictHostKeyChecking=accept-new",
        ];
        if (identityFile) {
            sshArgs.push("-i", identityFile, "-o", "IdentitiesOnly=yes");
        }
        sshArgs.push(host);
        // Use a longer timeout to allow time for YubiKey touch
        await runGitAsync(sshArgs, os.tmpdir(), process.env, 120_000);
    }
    broadcast({ type: "push:auth:complete", event: "push:auth:complete", data: {} });
}
async function pushRepo(repo, scope, gitSshEnv, scanner) {
    const result = {
        repoId: repo.id,
        repoName: repo.name,
        repoRoot: repo.root,
        branches_pushed: [],
        refs_pushed: [],
        skipped: false,
        error: null,
    };
    try {
        // 1. Check remote exists
        const remoteOutput = await runGitAsync(["remote"], repo.root, gitSshEnv);
        if (!remoteOutput.trim()) {
            result.skipped = true;
            return result;
        }
        // 2. Determine branches to push
        let branchesToPush = [];
        if (scope === "current") {
            // Push the default branch (or HEAD)
            const defaultBranch = repo.default_branch || "main";
            branchesToPush = [defaultBranch];
        }
        else {
            // scope === "all_ahead": all branches where ahead > 0
            const branches = scanner.getBranches(repo.root);
            branchesToPush = branches
                .filter((b) => b.ahead > 0 && b.has_upstream)
                .map((b) => b.branch);
        }
        // 3. Push branches (same-name assumption)
        const sameName = getSetting("push_same_name_upstream", "true") === "true";
        for (const branch of branchesToPush) {
            try {
                if (sameName) {
                    await runGitAsync(["push", "origin", branch], repo.root, gitSshEnv);
                }
                else {
                    await runGitAsync(["push", "origin", `${branch}:${branch}`], repo.root, gitSshEnv);
                }
                result.branches_pushed.push(branch);
            }
            catch (err) {
                // Continue on per-branch failure but note the error
                const msg = err instanceof Error ? err.message : String(err);
                result.error = result.error
                    ? `${result.error}; branch ${branch}: ${msg}`
                    : `branch ${branch}: ${msg}`;
            }
        }
        // 4. Push git-bug refs if they exist
        if (refsExist(repo.root, "refs/bugs/")) {
            try {
                await runGitAsync(["push", "origin", "refs/bugs/*:refs/bugs/*"], repo.root, gitSshEnv);
                result.refs_pushed.push("refs/bugs/*");
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                result.error = result.error
                    ? `${result.error}; refs/bugs: ${msg}`
                    : `refs/bugs: ${msg}`;
            }
        }
        // 5. Push git notes
        if (refsExist(repo.root, "refs/notes/")) {
            try {
                await runGitAsync(["push", "origin", "refs/notes/*:refs/notes/*"], repo.root, gitSshEnv);
                result.refs_pushed.push("refs/notes/*");
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                result.error = result.error
                    ? `${result.error}; refs/notes: ${msg}`
                    : `refs/notes: ${msg}`;
            }
        }
    }
    catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
    }
    return result;
}
// --- Push session state ---
let activePushSession = null;
export function getPushStatus() {
    if (!activePushSession) {
        return { active: false, session_id: null, started_at: null, repo_count: 0, completed_count: 0, done: true, error: null };
    }
    return {
        active: !activePushSession.done,
        session_id: activePushSession.id,
        started_at: activePushSession.startedAt,
        repo_count: activePushSession.repoCount,
        completed_count: activePushSession.completedRepos.length,
        done: activePushSession.done,
        error: activePushSession.error,
    };
}
function recordPushHistory(sessionId, scope, result, status) {
    try {
        const db = getDb();
        // Record one row per repo in the session
        for (const repo of result.repos) {
            const id = `${sessionId}-${repo.repoId}`;
            db.prepare(`
        INSERT OR REPLACE INTO push_history (id, repo_id, repo_root, scope, status, result_json, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, repo.repoId, repo.repoRoot, scope, repo.error ? "failed" : status, JSON.stringify(repo), new Date(result.started_at).getTime(), Date.now());
        }
    }
    catch (err) {
        console.error("[push-manager] failed to record push history:", err);
    }
}
/**
 * Start a push session for multiple repos. Runs asynchronously and broadcasts
 * SSE events as each repo completes.
 */
export function startPushSession(repos, scope, scanner) {
    if (activePushSession && !activePushSession.done) {
        throw new Error("A push session is already in progress");
    }
    const sessionId = `push-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    activePushSession = {
        id: sessionId,
        startedAt,
        repoCount: repos.length,
        completedRepos: [],
        done: false,
        error: null,
    };
    broadcast({ type: "push:started", event: "push:started", data: { session_id: sessionId, repo_count: repos.length } });
    // Run async push session
    void runPushSession(sessionId, repos, scope, scanner, startedAt);
    return { session_id: sessionId, started_at: startedAt };
}
async function runPushSession(sessionId, repos, scope, scanner, startedAt) {
    const socketPath = path.join(os.tmpdir(), `mandible-ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const sessionStart = Date.now();
    // Read identity setting (empty string = no override)
    const identityFile = getSetting("push_ssh_identity", "") || null;
    // Pre-auth: establish ControlMaster connections to all SSH hosts before any git push.
    // This ensures YubiKey touch happens once up front rather than silently using the agent key.
    try {
        await preAuthSshHosts(repos, socketPath, identityFile);
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (activePushSession) {
            activePushSession.error = errorMsg;
            activePushSession.done = true;
        }
        broadcast({ type: "push:error", event: "push:error", data: { error: `SSH pre-auth failed: ${errorMsg}` } });
        await cleanupControlMaster(socketPath);
        return;
    }
    const gitSshEnv = buildControlMasterEnv(socketPath, identityFile);
    try {
        for (const repo of repos) {
            // Check session timeout
            if (Date.now() - sessionStart > SESSION_TIMEOUT_MS) {
                const timeoutError = "Push session timed out (10min limit)";
                if (activePushSession) {
                    activePushSession.error = timeoutError;
                }
                broadcast({ type: "push:error", event: "push:error", data: { error: timeoutError } });
                break;
            }
            broadcast({ type: "push:repo:progress", event: "push:repo:progress", data: { repo_id: repo.id, repo_name: repo.name } });
            const result = await pushRepo(repo, scope, gitSshEnv, scanner);
            if (activePushSession) {
                activePushSession.completedRepos.push(result);
            }
            broadcast({ type: "push:repo:complete", event: "push:repo:complete", data: result });
        }
        // Trigger a single rescan after all repos complete to refresh ahead/behind counts.
        // Bug: ea3102a — after pushing, the ahead count should go to 0.
        // (Moved out of per-repo loop to eliminate inter-push spinner delay.)
        void scanner.scanAll().catch(() => { });
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (activePushSession) {
            activePushSession.error = errorMsg;
        }
        broadcast({ type: "push:error", event: "push:error", data: { error: errorMsg } });
    }
    finally {
        await cleanupControlMaster(socketPath);
        const durationMs = Date.now() - sessionStart;
        const sessionResult = {
            repos: activePushSession?.completedRepos ?? [],
            duration_ms: durationMs,
            started_at: startedAt,
        };
        if (activePushSession) {
            activePushSession.done = true;
        }
        recordPushHistory(sessionId, scope, sessionResult, activePushSession?.error ? "failed" : "completed");
        broadcast({ type: "push:complete", event: "push:complete", data: sessionResult });
    }
}
/**
 * Push a single repo synchronously (well, async but waits for completion).
 * Used by the single-repo push endpoint.
 */
export async function pushSingleRepo(repo, scope, scanner) {
    const socketPath = path.join(os.tmpdir(), `mandible-ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const gitSshEnv = buildControlMasterEnv(socketPath);
    try {
        const result = await pushRepo(repo, scope, gitSshEnv, scanner);
        // Trigger rescan after push
        try {
            await scanner.scanAll();
        }
        catch {
            // Non-fatal
        }
        return result;
    }
    finally {
        await cleanupControlMaster(socketPath);
    }
}
