/**
 * Spawn the real `mandible` CLI against a stub daemon.
 *
 * Two stubs cover the transports a CLI test needs: an HTTP stub that answers
 * the instance preflight and records every request, and a file-RPC spool
 * (`fileRpc`, built on `startFileRpcResponder`). Scratch space comes from
 * `scratchDir`, which lives under the test's isolated runtime root.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

import { MAIN_CLI_INSTANCE_RESPONSE } from "./cli-instance-response.js";
import {
  startFileRpcResponder,
  type FileRpcHandler,
  type FileRpcResponder,
  type FileRpcResponderOptions,
} from "./file-rpc-responder.js";
import { testRuntimeRoot } from "./runtime-isolation.js";

export const CLI = path.join(process.cwd(), "bin", "mandible");

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  cwd?: string;
  /** Merged over the inherited environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  input?: string;
  /** Executable to run instead of the CLI, e.g. `bash` with `["-c", script]`. */
  command?: string;
}

export function runCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(options.command ?? CLI, args, { cwd: options.cwd, env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

export function scratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join(testRuntimeRoot, `${prefix}-`));
}

export interface StubRequest {
  method: string;
  /** Path plus query, as the CLI sent it. */
  url: string;
  body: unknown;
}

export interface StubResponse {
  status?: number;
  body: unknown;
}

/** Return `undefined` for a 404. */
export type StubHandler = (request: StubRequest) => StubResponse | undefined;

export interface StubDaemon {
  /** Environment that points the CLI at this stub over HTTP. */
  env: Record<string, string>;
  /** Every request except the instance preflight, in arrival order. */
  requests: StubRequest[];
  close(): Promise<void>;
}

export function startStubDaemon(handler: StubHandler): Promise<StubDaemon> {
  const requests: StubRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const request = { method: req.method ?? "GET", url: req.url ?? "", body: raw ? JSON.parse(raw) : null };
    res.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/instance") {
      res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      return;
    }
    requests.push(request);
    const response = handler(request) ?? { status: 404, body: { error: "not found" } };
    res.statusCode = response.status ?? 200;
    res.end(JSON.stringify(response.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("stub daemon did not bind a TCP port");
      resolve({
        env: { MANDIBLE_BASE: `http://127.0.0.1:${address.port}`, MANDIBLE_PORT: String(address.port) },
        requests,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

export interface FileRpcStub {
  env: Record<string, string>;
  responder: FileRpcResponder;
}

/** Answer file-RPC requests in a fresh spool; stop it with `responder.stop()`. */
export function fileRpc(
  handler: FileRpcHandler,
  spoolDir = scratchDir("spool"),
  options: FileRpcResponderOptions = {},
): FileRpcStub {
  return {
    env: { MANDIBLE_BASE: `file://${spoolDir}`, MANDIBLE_FILE_RPC_TIMEOUT: "5" },
    responder: startFileRpcResponder(spoolDir, handler, options),
  };
}
