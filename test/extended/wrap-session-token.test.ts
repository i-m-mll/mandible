// Issue 0b989d1 — the shell half of the session-token exchange.
//
// `cli/wrap.sh` reads the agent's long-lived keychain PAT and exports only a
// session-scoped token in its place. The property that must not regress is the
// fail-open one: the exchange is a hardening, so a daemon that is down, slow,
// or erroring must leave the agent running with the PAT exactly as before. The
// keychain seam is stubbed via MANDIBLE_SECURITY_BIN (the same override
// test/secret-store-cli.test.ts uses), so nothing here touches a real keychain.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_DIR = path.join(process.cwd(), "cli");
const WRAP = path.join(CLI_DIR, "wrap.sh");
const PAT = "mandible_pat_keychain-long-lived";
const EPHEMERAL = `mandible_pat_${"E".repeat(43)}`;

let tempDir = "";
let securityStub = "";
let tokenOut = "";
let server: http.Server | null = null;
let baseUrl = "";
let exchangeRequests: Array<{ auth: string | undefined; body: string }> = [];
let exchangeStatus = 201;
let exchangeBody: string = JSON.stringify({ token: EPHEMERAL });
let whoamiBody = {
  authenticated: true,
  user: { id: "claude-code", slug: "claude-code", kind: "agent" },
};

/** A keychain stub that answers the shared resolver's account and secret reads. */
function writeSecurityStub(): void {
  securityStub = path.join(tempDir, "security");
  fs.writeFileSync(
    securityStub,
    `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "find-generic-password" ]; then
  case " $* " in
    *" -w "*) printf '%s' ${JSON.stringify(PAT)} ;;
    *) printf '    "acct"<blob>="claude-code"\n    "svce"<blob>="mandible-agent-claude"\n' ;;
  esac
  exit 0
fi
exit 44
`,
    { mode: 0o755 },
  );
}

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        if (req.url === "/api/client-auth/whoami") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(whoamiBody));
          return;
        }
        if (req.url === "/api/client-auth/session-token") {
          exchangeRequests.push({
            auth: req.headers.authorization as string | undefined,
            body: raw,
          });
          res.writeHead(exchangeStatus, { "Content-Type": "application/json" });
          res.end(exchangeBody);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("stub server did not expose a port"));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

/**
 * Run wrap.sh to completion. Deliberately async (never spawnSync): the stub
 * daemon lives in this process, and a synchronous spawn would block the event
 * loop so the exchange could never be answered.
 */
function runShell(
  args: string[],
  env: Record<string, string>,
  stderr: number | "ignore" = "ignore",
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", args, {
      stdio: ["ignore", "ignore", stderr],
      env: {
        ...process.env,
        HOME: tempDir,
        MANDIBLE_CLI_DIR: CLI_DIR,
        MANDIBLE_BASE: baseUrl,
        MANDIBLE_SECURITY_BIN: securityStub,
        MANDIBLE_TEST_TOKEN_OUT: tokenOut,
        MANDIBLE_TOKEN: "",
        CODEX_THREAD_ID: "",
        CODEX_SESSION_ID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "",
        GEMINI_SESSION_ID: "",
        ...env,
      },
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

/** Run wrap.sh and report the MANDIBLE_TOKEN the wrapped command inherited. */
async function runWrap(env: Record<string, string> = {}): Promise<string> {
  fs.rmSync(tokenOut, { force: true });
  const code = await runShell(
    [
      WRAP,
      "--app",
      "claude",
      "--id",
      "wrap-test-session",
      "--",
      "bash",
      "-c",
      'printf "%s" "${MANDIBLE_TOKEN:-}" > "$MANDIBLE_TEST_TOKEN_OUT"',
    ],
    env,
  );
  expect(code).toBe(0);
  return fs.existsSync(tokenOut) ? fs.readFileSync(tokenOut, "utf8") : "";
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-wrap-token-"));
  tokenOut = path.join(tempDir, "token-out");
  exchangeRequests = [];
  exchangeStatus = 201;
  exchangeBody = JSON.stringify({ token: EPHEMERAL });
  whoamiBody = {
    authenticated: true,
    user: { id: "claude-code", slug: "claude-code", kind: "agent" },
  };
  writeSecurityStub();
  await startServer();
});

afterEach(() => {
  server?.close();
  server = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("cli/wrap.sh session-token exchange", () => {
  it("exports the exchanged token instead of the keychain PAT", async () => {
    expect(await runWrap()).toBe(EPHEMERAL);
    expect(exchangeRequests).toHaveLength(1);
    // The exchange authenticates with the PAT and names the session being launched.
    expect(exchangeRequests[0].auth).toBe(`Bearer ${PAT}`);
    expect(JSON.parse(exchangeRequests[0].body)).toEqual({
      session_id: "wrap-test-session",
    });
  });

  it("preserves a verified inherited token without session exchange", async () => {
    const inherited = "inherited-agent-token";
    expect(await runWrap({ MANDIBLE_TOKEN: inherited })).toBe(inherited);
    expect(exchangeRequests).toHaveLength(0);
  });

  it("removes a rejected inherited token without Keychain fallback", async () => {
    whoamiBody = {
      authenticated: true,
      user: { id: "human", slug: "mll", kind: "human" },
    };
    expect(await runWrap({ MANDIBLE_TOKEN: "inherited-human-token" })).toBe("");
    expect(exchangeRequests).toHaveLength(0);
  });

  it("never echoes a verified inherited token under xtrace", async () => {
    const inherited = "inherited-agent-token";
    const traceLog = path.join(tempDir, "inherited-trace.log");
    const fd = fs.openSync(traceLog, "w");
    const code = await runShell(
      ["-x", WRAP, "--app", "claude", "--id", "wrap-test-session", "--", "true"],
      { MANDIBLE_TOKEN: inherited },
      fd,
    );
    fs.closeSync(fd);

    expect(code).toBe(0);
    expect(fs.readFileSync(traceLog, "utf8")).not.toContain(inherited);
  });

  it("falls back to the PAT when the daemon is unreachable", async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    // A closed loopback port is the down-daemon case; agents must still launch.
    expect(await runWrap()).toBe(PAT);
  });

  it("falls back to the PAT when the exchange errors", async () => {
    exchangeStatus = 500;
    exchangeBody = JSON.stringify({ error: "boom" });
    expect(await runWrap()).toBe(PAT);
  });

  it("falls back to the PAT when the response carries no token", async () => {
    exchangeBody = JSON.stringify({ expires_at: 1 });
    expect(await runWrap()).toBe(PAT);
  });

  it("falls back to the PAT when the response token has an invalid shape", async () => {
    exchangeBody = JSON.stringify({ token: "garbage" });
    expect(await runWrap()).toBe(PAT);
  });

  it("never echoes either token under xtrace", async () => {
    const traceLog = path.join(tempDir, "trace.log");
    const fd = fs.openSync(traceLog, "w");
    const code = await runShell(
      ["-x", WRAP, "--app", "claude", "--id", "wrap-test-session", "--", "true"],
      {},
      fd,
    );
    fs.closeSync(fd);
    expect(code).toBe(0);
    const trace = fs.readFileSync(traceLog, "utf8");
    expect(trace).not.toContain(PAT);
    expect(trace).not.toContain(EPHEMERAL);
  });
});
