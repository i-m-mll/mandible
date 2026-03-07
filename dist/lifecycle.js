import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "mandible");
const DEFAULT_PID_FILE = path.join(DEFAULT_CACHE_DIR, "daemon.pid");
export function getPidFilePath() {
    return process.env.MANDIBLE_PID_FILE ?? DEFAULT_PID_FILE;
}
export function writePidFile(pid = process.pid, pidFilePath = getPidFilePath()) {
    ensureDir(path.dirname(pidFilePath));
    fs.writeFileSync(pidFilePath, String(pid));
}
export function removePidFile(pidFilePath = getPidFilePath()) {
    if (fs.existsSync(pidFilePath)) {
        fs.unlinkSync(pidFilePath);
    }
}
export function readPidFile(pidFilePath = getPidFilePath()) {
    if (!fs.existsSync(pidFilePath)) {
        return null;
    }
    const raw = fs.readFileSync(pidFilePath, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : null;
}
export async function checkHealth(port) {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            path: "/api/health",
            method: "GET",
            timeout: 500
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    resolve(null);
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}
export async function waitForHealth(port, timeoutMs = 3000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const health = await checkHealth(port);
        if (health) {
            return health;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
}
export async function autoStartDaemon(options) {
    const { port, dbPath, pidFilePath, entryPath } = options;
    const existing = await checkHealth(port);
    if (existing) {
        return { status: "already_running" };
    }
    const entry = entryPath ?? resolveEntryPath();
    const child = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
        cwd: path.dirname(path.dirname(entry)),
        env: {
            ...process.env,
            MANDIBLE_PORT: String(port),
            ...(dbPath ? { MANDIBLE_DB: dbPath } : {}),
            ...(pidFilePath ? { MANDIBLE_PID_FILE: pidFilePath } : {})
        }
    });
    child.unref();
    await waitForHealth(port);
    return { status: "started", pid: child.pid ?? undefined };
}
export function stopDaemon(pidFilePath = getPidFilePath()) {
    const pid = readPidFile(pidFilePath);
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, "SIGTERM");
        return true;
    }
    catch {
        return false;
    }
}
function resolveEntryPath() {
    if (process.env.MANDIBLE_ENTRY) {
        return process.env.MANDIBLE_ENTRY;
    }
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(currentDir, "..");
    const distEntry = path.join(rootDir, "dist", "index.js");
    if (fs.existsSync(distEntry)) {
        return distEntry;
    }
    throw new Error("dist/index.js not found; run the build first or set MANDIBLE_ENTRY");
}
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
