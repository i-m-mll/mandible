import { spawn } from "node:child_process";
// Maximum time to wait for a single auth command (10 minutes).
// Merges requiring YubiKey touch typically complete in seconds; 10 min
// is generous enough for slow git operations while preventing infinite hangs.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Strip agent-key signing overrides from the environment.
 *
 * When Claude Code is running, CLAUDECODE=1 triggers GIT_CONFIG_COUNT/KEY/VALUE
 * env vars that override git's signing key to the agent key. Auth-merge commands
 * MUST use the user's YubiKey (from git config), so we strip these variables to
 * prevent the agent key from silently signing protected-branch merges.
 */
function cleanEnvForAuth(env) {
    const cleaned = { ...env };
    delete cleaned.CLAUDECODE;
    // Strip all GIT_CONFIG_COUNT / GIT_CONFIG_KEY_* / GIT_CONFIG_VALUE_* overrides
    delete cleaned.GIT_CONFIG_COUNT;
    for (const key of Object.keys(cleaned)) {
        if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) {
            delete cleaned[key];
        }
    }
    cleaned.AUTH_MERGE_AUTO_CONFIRM = "1";
    return cleaned;
}
export async function executeAuthCommand(options) {
    const now = options.now ?? (() => Date.now());
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started_at = now();
    return await new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let output = "";
        let settled = false;
        // Bug: 297677f — expose the auth request ID so the merge script can query
        // the API for issues and other request-specific metadata.
        const childEnv = { ...cleanEnvForAuth(process.env), ...(options.env ?? {}) };
        childEnv.MANDIBLE_AUTH_REQUEST_ID = options.request_id;
        const child = spawn("bash", ["-c", options.command], {
            cwd: options.cwd ?? undefined,
            stdio: ["ignore", "pipe", "pipe"],
            env: childEnv
        });
        // Emit a synthetic start line so the UI isn't blank during execution
        options.onOutput?.({
            request_id: options.request_id,
            stream: "stdout",
            text: "Executing merge command…\n",
            timestamp: now()
        });
        // Bug: f690657 — enforce a maximum execution time so stuck merges (e.g.
        // YubiKey not present, git hanging on network) do not block the queue
        // or hold the daemon indefinitely.
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
            }, 5000);
            reject(new Error(`Auth command timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
        const handleChunk = (stream, data) => {
            const text = data.toString("utf8");
            if (stream === "stdout") {
                stdout += text;
            }
            else {
                stderr += text;
            }
            output += text;
            options.onOutput?.({
                request_id: options.request_id,
                stream,
                text,
                timestamp: now()
            });
        };
        child.stdout?.on("data", (data) => handleChunk("stdout", data));
        child.stderr?.on("data", (data) => handleChunk("stderr", data));
        child.on("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({
                exit_code: typeof code === "number" ? code : null,
                signal: signal ?? null,
                stdout,
                stderr,
                output,
                started_at,
                finished_at: now()
            });
        });
    });
}
