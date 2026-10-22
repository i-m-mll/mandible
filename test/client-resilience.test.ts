import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const API_SH = path.join(process.cwd(), "cli", "api.sh");
const servers: http.Server[] = [];
const tempRoots: string[] = [];

function runBash(
  script: string,
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", script], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CLI client resilience", () => {
  it("classifies only known transient statuses as retryable and bounds backoff", async () => {
    const result = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "api_http_retryable_status 000; printf '000=%s\\n' $?",
      "api_http_retryable_status 500; printf '500=%s\\n' $?",
      "api_http_retryable_status 503; printf '503=%s\\n' $?",
      "api_http_retryable_status 429; printf '429=%s\\n' $?",
      "api_http_retryable_status 404; printf '404=%s\\n' $?",
      "printf 'delay=%s\\n' \"$(api_http_retry_delay_ms 12)\"",
    ].join("\n"), {
      MANDIBLE_HTTP_RETRY_BASE_MS: "10",
      MANDIBLE_HTTP_RETRY_MAX_MS: "40",
      MANDIBLE_HTTP_RETRY_JITTER_MS: "0",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("000=0\n500=1\n503=0\n429=0\n404=1\ndelay=40\n");
  });

  it("retries transient read responses but not deterministic client failures", async () => {
    let flakyRequests = 0;
    let missingRequests = 0;
    let emptyMissingRequests = 0;
    const port = await listen((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/flaky") {
        flakyRequests += 1;
        if (flakyRequests < 3) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "busy" }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
        return;
      }
      if (req.url === "/empty-404") {
        emptyMissingRequests += 1;
        res.statusCode = 404;
        res.end();
        return;
      }
      missingRequests += 1;
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "missing" }));
    });
    const env = {
      MANDIBLE_BASE: `http://127.0.0.1:${port}`,
      MANDIBLE_HTTP_RETRIES: "2",
      MANDIBLE_HTTP_RETRY_BASE_MS: "1",
      MANDIBLE_HTTP_RETRY_MAX_MS: "2",
      MANDIBLE_HTTP_RETRY_JITTER_MS: "0",
    };

    const flaky = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "response=$(mktemp)",
      "code=$(api_capture GET /flaky '' \"$response\")",
      "printf '%s\\n' \"$code\"",
      "cat \"$response\"",
      "rm -f \"$response\"",
    ].join("\n"), env);
    const missing = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "response=$(mktemp)",
      "code=$(api_capture GET /missing '' \"$response\")",
      "printf '%s\\n' \"$code\"",
      "cat \"$response\"",
      "rm -f \"$response\"",
    ].join("\n"), env);
    const emptyMissing = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "response=$(mktemp)",
      "code=$(api_capture GET /empty-404 '' \"$response\")",
      "printf '%s\\n' \"$code\"",
      "cat \"$response\"",
      "rm -f \"$response\"",
    ].join("\n"), env);

    expect(flaky.status).toBe(0);
    expect(flakyRequests).toBe(3);
    expect(flaky.stdout).toBe("200\n{\"ok\":true}");
    expect(flaky.stderr.match(/transient failure/g)).toHaveLength(2);
    expect(missing.status).toBe(0);
    expect(missingRequests).toBe(1);
    expect(missing.stdout).toBe("404\n{\"error\":\"missing\"}");
    expect(missing.stderr).toBe("");
    expect(emptyMissing.status).toBe(0);
    expect(emptyMissingRequests).toBe(1);
    expect(emptyMissing.stdout).toBe("404\n");
    expect(emptyMissing.stderr).toBe("");
  });

  it("never returns a 2xx body that curl abandoned mid-transfer", async () => {
    let requests = 0;
    const port = await listen((req, res) => {
      requests += 1;
      res.setHeader("Content-Type", "application/json");
      if (requests === 1) {
        res.write("{\"projects\":[{\"name\":\"abc");
        return;
      }
      res.end(JSON.stringify({ projects: [{ name: "abc" }] }));
    });
    const result = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "response=$(mktemp)",
      "code=$(api_capture GET /api/projects '' \"$response\")",
      "printf '%s\\n' \"$code\"",
      "cat \"$response\"",
      "rm -f \"$response\"",
    ].join("\n"), {
      MANDIBLE_BASE: `http://127.0.0.1:${port}`,
      MANDIBLE_HTTP_TIMEOUT: "0.3",
      MANDIBLE_HTTP_RETRIES: "1",
      MANDIBLE_HTTP_RETRY_BASE_MS: "1",
      MANDIBLE_HTTP_RETRY_MAX_MS: "1",
      MANDIBLE_HTTP_RETRY_JITTER_MS: "0",
    });

    expect(requests).toBe(2);
    expect(result.stdout).toBe("200\n{\"projects\":[{\"name\":\"abc\"}]}");
    expect(result.stderr).toContain("status=000, curl=28");
  });

  it("does not retry deterministic server failures and reports their structured body", async () => {
    let failedRequests = 0;
    const port = await listen((_req, res) => {
      failedRequests += 1;
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "operator_not_configured",
        message: "Run mandible user setup --agents --json",
      }));
    });

    const result = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "api_get /deterministic",
      "exit $?",
    ].join("\n"), {
      MANDIBLE_BASE: `http://127.0.0.1:${port}`,
      MANDIBLE_HTTP_RETRIES: "2",
      MANDIBLE_HTTP_RETRY_BASE_MS: "1",
      MANDIBLE_HTTP_RETRY_MAX_MS: "1",
      MANDIBLE_HTTP_RETRY_JITTER_MS: "0",
    });

    expect(result.status).toBe(22);
    expect(failedRequests).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("status=500");
    expect(result.stderr).toContain('"error":"operator_not_configured"');
    expect(result.stderr).toContain("Run mandible user setup --agents --json");
    expect(result.stderr).not.toContain("transient failure");
    expect(result.stderr).not.toContain("busy or timed out");
  });

  it("distinguishes a reachable not-ready daemon from an unreachable daemon", async () => {
    const busyPort = await listen((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok", ready: false }));
      }
      // Leave /slow open until curl reaches its bounded timeout.
    });
    const busy = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "response=$(mktemp)",
      "api_capture GET /slow '' \"$response\"",
      "rm -f \"$response\"",
    ].join("\n"), {
      MANDIBLE_BASE: `http://127.0.0.1:${busyPort}`,
      MANDIBLE_HTTP_RETRIES: "0",
      MANDIBLE_HTTP_TIMEOUT: "0.1",
      MANDIBLE_HEALTH_TIMEOUT: "1",
    });
    expect(busy.stdout).toBe("000");
    expect(busy.stderr).toContain("reachable but busy or not ready");

    const unavailablePort = await listen((_req, res) => res.end());
    const unavailableServer = servers.pop()!;
    await new Promise<void>((resolve) => unavailableServer.close(() => resolve()));
    const down = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "response=$(mktemp)",
      "api_capture GET /missing '' \"$response\"",
      "rm -f \"$response\"",
    ].join("\n"), {
      MANDIBLE_BASE: `http://127.0.0.1:${unavailablePort}`,
      MANDIBLE_HTTP_RETRIES: "0",
      MANDIBLE_HTTP_TIMEOUT: "0.1",
      MANDIBLE_HEALTH_TIMEOUT: "0.1",
    });
    expect(down.stdout).toBe("000");
    expect(down.stderr).toContain("daemon is down or unreachable");
  });

  it("keeps timed-out mutation ids pending and reports an unknown outcome", async () => {
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-timeout-"));
    tempRoots.push(spool);
    const result = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "response=$(mktemp)",
      "code=$(api_file_rpc_exchange POST /api/test '{}' \"$response\")",
      "printf '%s\\n' \"$code\"",
      "cat \"$response\"",
      "rm -f \"$response\"",
    ].join("\n"), {
      MANDIBLE_BASE: `file://${spool}`,
      MANDIBLE_FILE_RPC_TIMEOUT: "-1",
      MANDIBLE_FILE_RPC_LATE_RESPONSE_GRACE: "-1",
      MANDIBLE_FILE_RPC_HEALTH_BASE: "http://127.0.0.1:1",
      MANDIBLE_HEALTH_TIMEOUT: "0.1",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe("000");
    const body = JSON.parse(result.stdout.split("\n").slice(1).join("\n"));
    expect(body).toMatchObject({
      error: "file_rpc_timeout",
      outcome: "unknown",
      daemon_state: "down_unreachable",
    });
    expect(body.request_id).toMatch(/^cli-/);
    expect(result.stderr).toContain("Do not replay blindly");
    expect(fs.existsSync(path.join(spool, `${body.request_id}.request.json`))).toBe(true);
  });

  it("accepts a late file-RPC response during the stable-id grace window", async () => {
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-late-"));
    tempRoots.push(spool);
    const timer = setInterval(() => {
      const requestFile = fs.readdirSync(spool).find((file) => file.endsWith(".request.json"));
      if (!requestFile) return;
      const request = JSON.parse(fs.readFileSync(path.join(spool, requestFile), "utf8"));
      fs.writeFileSync(
        path.join(spool, `${request.id}.response.json`),
        JSON.stringify({ id: request.id, status: 201, body: { created: true } }),
      );
      clearInterval(timer);
    }, 10);

    const result = await runBash([
      `source ${JSON.stringify(API_SH)}`,
      "response=$(mktemp)",
      "code=$(api_file_rpc_exchange POST /api/test '{}' \"$response\")",
      "printf '%s\\n' \"$code\"",
      "cat \"$response\"",
      "rm -f \"$response\"",
    ].join("\n"), {
      MANDIBLE_BASE: `file://${spool}`,
      MANDIBLE_FILE_RPC_TIMEOUT: "-1",
      MANDIBLE_FILE_RPC_LATE_RESPONSE_GRACE: "2",
    });
    clearInterval(timer);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("201\n{\"created\":true}\n");
    expect(result.stderr).toBe("");
  });
});
