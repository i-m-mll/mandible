// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const api = path.resolve("cli/api.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function runShell(command: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-u", "-c", command], { env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr += part; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("CLI private local transport", () => {
  it("ignores stale inherited bearer for ordinary reads and uses durable Keychain material only on listed gates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-socket-client-")); roots.push(root);
    const socket = path.join(root, "daemon.sock");
    const manifest = path.join(root, "routes.json");
    fs.writeFileSync(manifest, JSON.stringify([
      { method: "POST", path: "/api/auth/request" },
      { method: "POST", path: "/api/users/setup", credential_optional: true },
      { method: "POST", path: "/api/briefing-groups", body_nonempty: "sharing_reason" },
    ]));
    const seen: Array<{ method: string; auth?: string; managed?: string; provider?: string; session?: string; managedApp?: string; managedSession?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method!, auth: req.headers.authorization,
        managed: req.headers["x-mandible-managed-client"] as string | undefined,
        provider: req.headers["x-mandible-ambient-provider"] as string | undefined,
        session: req.headers["x-mandible-ambient-provider-session-id"] as string | undefined,
        managedApp: req.headers["x-mandible-managed-app"] as string | undefined,
        managedSession: req.headers["x-mandible-managed-session-id"] as string | undefined });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const env = { ...process.env, HOME: root, API_HELPER: api,
        MANDIBLE_BASE: "https://app.mandible.localhost:19420", MANDIBLE_SOCKET: socket,
        MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE: manifest, MANDIBLE_TOKEN: "stale-token",
        CODEX_THREAD_ID: "task-123", CODEX_SESSION_ID: "task-123" };
      const read = await runShell('source "$API_HELPER"; out=$(api_temp_file); api_http_exchange GET /api/health "" "$out"', env);
      expect(read.code, read.stderr).toBe(0);
      expect(read.stdout).toBe("200");
      expect(seen[0]).toEqual({ method: "GET", auth: undefined, managed: "1", provider: "codex", session: "task-123",
        managedApp: undefined, managedSession: undefined });
      const gated = await runShell('source "$API_HELPER"; secret_account_for_service() { printf codex; }; secret_get() { printf durable-token; }; out=$(api_temp_file); api_http_exchange POST /api/auth/request "{}" "$out"', env);
      expect(gated.code, gated.stderr).toBe(0);
      expect(gated.stdout).toBe("200");
      expect(seen[1]?.auth).toBe("Bearer durable-token");
      const missing = await runShell('source "$API_HELPER"; secret_account_for_service() { return 1; }; out=$(api_temp_file); api_http_exchange POST /api/auth/request "{}" "$out"', env);
      expect(missing.stdout, missing.stderr).toBe("401");
      expect(seen).toHaveLength(2);
      const bootstrap = await runShell('source "$API_HELPER"; api_keychain_operator_token() { :; }; out=$(api_temp_file); api_http_exchange POST /api/users/setup "{}" "$out"', {
        ...env, CODEX_THREAD_ID: "", CODEX_SESSION_ID: "",
      });
      expect(bootstrap.code, bootstrap.stderr).toBe(0);
      expect(bootstrap.stdout).toBe("200");
      expect(seen[2]?.auth).toBeUndefined();
      const briefing = await runShell('source "$API_HELPER"; out=$(api_temp_file); api_http_exchange POST /api/briefing-groups "{}" "$out"', env);
      expect(briefing.code, briefing.stderr).toBe(0);
      expect(briefing.stdout).toBe("200");
      expect(seen[3]?.auth).toBeUndefined();
      const wrapper = await runShell('source "$API_HELPER"; out=$(api_temp_file); api_http_exchange GET /api/health "" "$out"', {
        ...env, CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", MANDIBLE_MANAGED_CLIENT: "1",
        MANDIBLE_MANAGED_APP: "claude", MANDIBLE_SESSION_ID: "wrapper-123",
      });
      expect(wrapper.code, wrapper.stderr).toBe(0);
      expect(wrapper.stdout).toBe("200");
      expect(seen[4]).toMatchObject({ managed: "1", provider: undefined, session: undefined,
        managedApp: "claude", managedSession: "wrapper-123" });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
