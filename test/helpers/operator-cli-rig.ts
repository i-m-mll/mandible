import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { expect } from "vitest";
import { ClientAuthenticator } from "../../src/client-auth/authenticator.js";
import { setDb } from "../../src/db.js";
import { inlineLedgerReader } from "../../src/ledger-reads/index.js";
import { registerAuthRoutes } from "../../src/routes/auth.js";
import { registerIssueRoutes } from "../../src/routes/issues.js";
import { registerWorkUnitRoutes } from "../../src/routes/work-units.js";
import { Router } from "../../src/server.js";
import { SseManager, setSseManager } from "../../src/sse.js";
import { createLedgerProject } from "./auth-queue-fixtures.js";
import { rig, type Rig } from "./approval-gate-rig.js";

const markerEnv = /^(CLAUDE|CODEX_|GEMINI_|MANDIBLE_(MANAGED_|SESSION_|EXECUTION_CONTEXT$|AGENT_REF$))/;

export interface CliRun {
  child: ChildProcess;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/**
 * The approval rig served over HTTP by the real auth, issue and work-unit
 * routes and a real SSE manager, with the operator's CLI spawned against it.
 */
export interface OperatorCliRig {
  r: Rig;
  auth: ClientAuthenticator;
  base: string;
  posts: (suffix: string) => number;
  /** Delay every new SSE subscription until `gate` settles. */
  holdSubscription: (gate: () => Promise<unknown>) => void;
  resolvedBroadcast: (id: string) => Promise<void>;
  mandible: (args: string[], options?: { cwd?: string; env?: Record<string, string> }) => CliRun;
  close: () => Promise<void>;
}

export async function operatorCliRig(): Promise<OperatorCliRig> {
  const r = rig();
  setDb(r.db);
  createLedgerProject(r.db, fs.realpathSync(r.repo));
  const sse = new SseManager();
  setSseManager(sse);
  const resolved = new Set<string>();
  sse.observeEvents((event) => {
    if (event.type === "auth:resolved") resolved.add((event.data as { request_id: string }).request_id);
  });
  const auth = new ClientAuthenticator(r.db, { secretsDir: fs.mkdtempSync(path.join(os.tmpdir(), "operator-cli-credentials-")) });
  const token = auth.mintApiToken(r.operatorId).token;
  const router = new Router({ clientAuth: auth });
  const reader = inlineLedgerReader(() => r.db);
  registerAuthRoutes(router, r.queue, reader);
  registerIssueRoutes(router, { getRepos: () => [], getRepoById: () => undefined, getBranches: () => [] } as never, undefined, reader);
  registerWorkUnitRoutes(router, {} as never, undefined, { authQueue: r.queue });
  const posts = new Map<string, number>();
  let gate: (() => Promise<unknown>) | null = null;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/instance") {
      const operations = router.operationCatalog("test");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ instance: { role: "main", operational_mutations: "allow",
        instance_id: operations.runtime.instance_id, backend_generation: operations.runtime.backend_generation }, operations }));
      return;
    }
    if (req.url === "/api/events/subscribe") {
      if (gate) await gate();
      sse.addClient(req, res, ["auth:"]);
      return;
    }
    if (req.method === "POST") {
      const suffix = req.url!.split("?")[0]!.split("/").pop()!;
      posts.set(suffix, (posts.get(suffix) ?? 0) + 1);
    }
    if (!await router.handle(req, res)) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const operatorEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !markerEnv.test(key)));
  const cli = path.join(process.cwd(), "bin/mandible");
  return {
    r, auth, base,
    posts: (suffix) => posts.get(suffix) ?? 0,
    holdSubscription: (next) => { gate = next; },
    resolvedBroadcast: (id) => expect.poll(() => resolved.has(id), { timeout: 15_000 }).toBe(true),
    mandible(args, options = {}) {
      const child = spawn("zsh", [cli, ...args], {
        cwd: options.cwd ?? process.cwd(), timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
        env: { ...operatorEnv, MANDIBLE_BASE: base, MANDIBLE_TOKEN: token, MANDIBLE_NO_KEYCHAIN_TOKEN: "1", ...options.env },
      });
      let stdout = "", stderr = "";
      child.stdout!.on("data", (data) => { stdout += data; });
      child.stderr!.on("data", (data) => { stderr += data; });
      const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
      return { child, done };
    },
    async close() {
      sse.closeAll();
      setSseManager(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await r.dispose();
    },
  };
}
