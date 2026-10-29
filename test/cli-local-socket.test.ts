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

async function runShell(command: string, env: NodeJS.ProcessEnv, shell = "bash"): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-u", "-c", command], { env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr += part; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("CLI private local transport", () => {
  it("uses the shipped manifest to require durable credentials on v2 create, revise and delivery retirement", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-shipped-routes-")); roots.push(root);
    const socket = path.join(root, "daemon.sock");
    const seen: Array<{ method: string | undefined; url: string | undefined; auth: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    try {
      const env = { ...process.env, HOME: root, API_HELPER: api, MANDIBLE_CLI_DIR: path.dirname(api),
        MANDIBLE_BASE: "https://app.mandible.localhost:19420", MANDIBLE_SOCKET: socket, MANDIBLE_TOKEN: "stale-token",
        CODEX_THREAD_ID: "task-123", CODEX_SESSION_ID: "task-123" };
      delete env.MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE;
      for (const [method, route] of [["POST", "/api/auth/v2/request"], ["PUT", "/api/auth/v2/request/request-123"],
        ["POST", "/api/auth/request/request-123/retire-delivery"]]) {
        const requestEnv = { ...env, REQUEST_METHOD: method, REQUEST_PATH: route };
        const gated = await runShell('source "$API_HELPER"; secret_account_for_service() { printf codex; }; secret_get() { printf durable-token; }; out=$(api_temp_file); api_http_exchange "$REQUEST_METHOD" "$REQUEST_PATH" "{}" "$out"', requestEnv);
        expect(gated.code, gated.stderr).toBe(0);
        expect(gated.stdout).toBe("200");
        expect(seen.at(-1)).toEqual({ method, url: route, auth: "Bearer durable-token" });
        const count = seen.length;
        const missing = await runShell('source "$API_HELPER"; secret_account_for_service() { return 1; }; out=$(api_temp_file); api_http_exchange "$REQUEST_METHOD" "$REQUEST_PATH" "{}" "$out"', requestEnv);
        expect(missing.stdout, missing.stderr).toBe("401");
        expect(seen).toHaveLength(count);
      }
      expect(seen).toHaveLength(3);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("ignores stale inherited bearer for ordinary reads and uses durable Keychain material only on listed gates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-socket-client-")); roots.push(root);
    const socket = path.join(root, "daemon.sock");
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
        MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE: path.join(path.dirname(api), "local-credential-routes.json"), MANDIBLE_TOKEN: "stale-token",
        CODEX_THREAD_ID: "task-123", CODEX_SESSION_ID: "task-123" };
      const read = await runShell('source "$API_HELPER"; out=$(api_temp_file); api_http_exchange GET /api/health "" "$out"', env);
      expect(read.code, read.stderr).toBe(0);
      expect(read.stdout).toBe("200");
      expect(seen[0]).toEqual({ method: "GET", auth: undefined, managed: "1", provider: "codex", session: "task-123",
        managedApp: undefined, managedSession: undefined });
      const gated = await runShell('source "$API_HELPER"; secret_account_for_service() { printf codex; }; secret_get() { printf durable-token; }; out=$(api_temp_file); api_http_exchange POST /api/auth/v2/request "{}" "$out"', env);
      expect(gated.code, gated.stderr).toBe(0);
      expect(gated.stdout).toBe("200");
      expect(seen[1]?.auth).toBe("Bearer durable-token");
      const missing = await runShell('source "$API_HELPER"; secret_account_for_service() { return 1; }; out=$(api_temp_file); api_http_exchange POST /api/auth/v2/request "{}" "$out"', env);
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
  it("resolves literal routes before credential policy and fails unknown or malformed classification before lookup or send", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-route-selection-")); roots.push(root);
    const socket = path.join(root, "daemon.sock"), lookups = path.join(root, "lookups");
    const seen: Array<{ url: string; auth?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url!, auth: req.headers.authorization });
      res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"handler_denied"}');
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    const env = { ...process.env, HOME: root, API_HELPER: api, MANDIBLE_CLI_DIR: path.dirname(api),
      MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE: path.join(path.dirname(api), "local-credential-routes.json"),
      MANDIBLE_BASE: "https://app.mandible.localhost:19420", MANDIBLE_SOCKET: socket, MANDIBLE_TOKEN: "stale-token",
      CODEX_THREAD_ID: "task-123", CODEX_SESSION_ID: "task-123", LOOKUPS: lookups };
    const request = (method: string, route: string, body = "", overrides = {}, shell = "bash") => runShell(
      'source "$API_HELPER"; secret_account_for_service() { printf lookup >> "$LOOKUPS"; printf codex; }; secret_get() { printf durable-token; }; api_keychain_operator_token() { printf lookup >> "$LOOKUPS"; printf operator-token; }; out=$(api_temp_file); api_http_exchange "$METHOD" "$ROUTE" "$BODY" "$out"',
      { ...env, METHOD: method, ROUTE: route, BODY: body, ...overrides }, shell);
    try {
      for (const route of ["/api/issues", "/api/users/operator", "/api/users/groups", "/api/users/grants", "/api/users"]) {
        const result = await request("GET", route); expect(result.stdout, result.stderr).toBe("403");
        expect(seen.at(-1)).toEqual({ url: route, auth: undefined });
      }
      expect(fs.existsSync(lookups)).toBe(false);
      const malformed = ["/api/unknown", "/api/users/%oops", "/api/users/%FF", "/api/users/%C0%AF", "/api/users/%E2%82",
        "/api/users/..", "/api/users/.", "/api/users/%2e%2E", "/api/users/.%2e", "/api/users/.\\operator", "/api/users/agent name", "/api/users/%00"];
      for (const shell of ["bash", "zsh"]) {
        const count = seen.length;
        const result = await runShell(
          'source "$API_HELPER"; secret_account_for_service() { printf lookup >> "$LOOKUPS"; printf codex; }; secret_get() { printf durable-token; }; api_keychain_operator_token() { printf lookup >> "$LOOKUPS"; printf operator-token; }; while IFS= read -r route; do out=$(api_temp_file); api_http_exchange GET "$route" "" "$out"; printf "\\n"; done <<< "$ROUTES"',
          { ...env, ROUTES: malformed.join("\n") }, shell);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual(malformed.map(() => "000"));
        expect(seen).toHaveLength(count);
        expect(fs.existsSync(lookups)).toBe(false);
      }
      for (const body of ['{}', '{"sharing_reason":""}', '{"sharing_reason":null}', '{"sharing_reason":3}']) {
        await request("POST", "/api/briefing-groups", body);
        expect(seen.at(-1)?.auth).toBeUndefined();
      }
      expect(fs.existsSync(lookups)).toBe(false);
      for (const body of ['{"sharing_reason":" "}', '{"sharing_reason":"intentional"}']) {
        const count = seen.length;
        expect((await request("POST", "/api/briefing-groups", body)).stdout).toBe("403");
        expect(seen).toHaveLength(count + 1);
        expect(seen.at(-1)?.auth).toBe("Bearer durable-token");
      }
      for (const [method, route] of [["GET", "/api/users/agent/access"], ["GET", "/api/briefing-destination-routes"],
        ["GET", "/api/briefing-destination-routes/destination"], ["POST", "/api/briefing-destination-routes/plan"],
        ["POST", "/api/briefing-destination-routes"], ["POST", "/api/briefing-groups/group/report-placement"],
        ["POST", "/api/briefings/briefing/report-rounds"]]) {
        await request(method, route, "{}");
        expect(seen.at(-1)?.auth).toBe("Bearer durable-token");
        if (route.startsWith("/api/briefing")) {
          await request(method, route, "{}", { CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", MANDIBLE_MANAGED_CLIENT: "",
            CLAUDE_CODE_SESSION_ID: "", CLAUDE_SESSION_ID: "", GEMINI_SESSION_ID: "", MANDIBLE_SESSION_ID: "", MANDIBLE_MANAGED_APP: "", CODEX_SANDBOX: "" });
          expect(seen.at(-1)?.auth).toBeUndefined();
        }
      }
      const humanMarkers = { CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", MANDIBLE_MANAGED_CLIENT: "", CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "", MANDIBLE_SESSION_ID: "", MANDIBLE_MANAGED_APP: "", GEMINI_SESSION_ID: "fixture" };
      const gemini = await request("GET", "/api/briefing-destination-routes", "", humanMarkers);
      expect(gemini.stdout, gemini.stderr).toBe("403");
      expect(seen.at(-1)?.auth).toBe("Bearer durable-token");
      for (const shell of ["bash", "zsh"]) {
        const unicode = await request("GET", "/api/users/%E2%82%AC", "", {}, shell);
        expect(unicode.stdout, unicode.stderr).toBe("403");
        expect(seen.at(-1)).toEqual({ url: "/api/users/%E2%82%AC", auth: "Bearer durable-token" });
      }
      fs.rmSync(lookups);
      const invalid = path.join(root, "invalid.json");
      fs.writeFileSync(invalid, JSON.stringify({ version: 1, routes: [{ method: "GET", path: "/api/users", localCliCredential: { mode: "guess" } }] }));
      const count = seen.length;
      expect((await request("GET", "/api/users", "", { MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE: invalid })).stdout).toBe("000");
      expect(seen).toHaveLength(count);
      expect(fs.existsSync(lookups)).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
