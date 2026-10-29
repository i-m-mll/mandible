// @vitest-environment node
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { systemAction } from "../src/identity/resolver.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { Router } from "../src/server.js";
import { createUser, SYSTEM_USER_ID } from "../src/users/store.js";

let root = ""; let db: Db; let auth: ClientAuthenticator; let router: Router;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-gate-"));
  db = openDb(path.join(root, "mandible.db")); setDb(db);
  auth = new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") });
  router = new Router({ clientAuth: auth });
  router.post("/api/issues/test-write", (req, res) => res.json({ identity: req.client_identity ?? null }), { localCliCredential: {"mode":"omit"}, operation: { id: "fixture:post:/api/issues/test-write", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "allow" });
  router.get("/api/read", (req, res) => res.json({ identity: req.client_identity ?? null }), { localCliCredential: {"mode":"omit"}, operation: { id: "fixture:get:/api/read", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function fileRpc(token?: string) {
  const transport = new FileRpcTransport({ router, dir: path.join(root, "rpc") });
  fs.mkdirSync(transport.dir, { recursive: true });
  fs.writeFileSync(path.join(transport.dir, "one.request.json"), JSON.stringify({
    id: "one", method: "POST", path: "/api/issues/test-write", body: {}, ...(token ? { capability_token: token } : {}),
  }));
  await transport.processOnce();
  return JSON.parse(fs.readFileSync(path.join(transport.dir, "one.response.json"), "utf8")) as { status: number; body: unknown };
}

describe("strict client-auth boundary", () => {
  it("rejects anonymous reads and writes coherently", async () => {
    expect((await router.invoke({ method: "GET", url: "/api/read", transport: "http" })).status).toBe(401);
    expect((await router.invoke({ method: "POST", url: "/api/issues/test-write", body: {}, transport: "http" })).status).toBe(401);
  });

  it("resolves a durable bearer to its exact user", async () => {
    const user = createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" });
    const issued = auth.mintApiToken(user.id);
    const response = await router.invoke({ method: "POST", url: "/api/issues/test-write", body: {}, credential: issued.token, transport: "http" });
    expect(response).toMatchObject({ status: 200, body: { identity: { user_id: user.id, source: "http_bearer" } } });
  });

  it("rejects anonymous file RPC and accepts an explicit capability", async () => {
    expect((await fileRpc()).status).toBe(401);
    const user = createUser(db, { slug: "agent-y", kind: "agent", display_name: "Agent Y" });
    const issued = auth.mintApiToken(user.id);
    expect((await fileRpc(issued.token)).status).toBe(200);
  });
});

describe("operator bootstrap ledger boundary", () => {
  it("rejects a tokenless HTTP write while no operator exists (issue a64d2de)", async () => {
    expect(db.prepare("SELECT id, kind FROM users").all()).toEqual([{ id: SYSTEM_USER_ID, kind: "system" }]);
    const project = resolveProjectForCheckout(db, { root, name: "mandible", workRepoId: "mandible" }).project;
    const issueId = new LedgerStore(db).createIssue({
      project_id: project.id,
      title: "Bootstrap boundary",
      attribution: systemAction(),
    }).id;
    const logger = vi.fn();
    const bootstrap = new Router({ logger });
    registerUserRoutes(bootstrap);
    registerIssueRoutes(bootstrap, { getRepos: () => [], getRepoById: () => undefined, getBranches: () => [] } as never, undefined, inlineLedgerReader());

    const written = await bootstrap.invoke({
      method: "POST",
      url: `/api/ledger/issues/${issueId}/comments`,
      body: { message: "Tokenless HTTP comment." },
      transport: "http",
    });

    expect(written.status).toBe(401);
    expect(logger).not.toHaveBeenCalledWith("error", "route_handler_error", expect.anything());
    expect(db.prepare("SELECT 1 FROM ledger_comments WHERE issue_id = ?").get(issueId)).toBeUndefined();
  });
});
