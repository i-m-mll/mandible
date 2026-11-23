import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import type { chooseProjectFolder } from "../src/project-folder-dialog.js";
import { registerWorkRoutes } from "../src/routes/work.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { WorkScanner } from "../src/work-scanner.js";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

it("adds only a folder selected by the local operator and leaves cancellation inert", async () => {
  const root = path.join(testRuntimeRoot, "project-folder");
  const repo = path.join(root, "selected-repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: 5000 });
  const db = createMigratedDb({ setGlobal: true });
  const operator = setupOperator(db, { slug: "operator" });
  const scanner = new WorkScanner({ db, repo_roots: [], config_path: path.join(root, "repos.json") });
  const instance = resolveInstanceInfo({ env: {} });
  const auth = new ClientAuthenticator(db, { instance, secretsDir: path.join(root, "auth") });
  const router = new Router({ clientAuth: auth, instance });
  const pickFolder = vi.fn<typeof chooseProjectFolder>()
    .mockResolvedValueOnce({ ok: true, path: null })
    .mockResolvedValueOnce({ ok: true, path: root })
    .mockResolvedValueOnce({ ok: true, path: repo });
  registerWorkRoutes(router, scanner, pickFolder);
  const server = http.createServer((req, res) => { void router.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const csrf = auth.localBrowserIdentity()!.csrf_token!;
    const post = (body: unknown, headers: Record<string, string>) => fetch(base + "/api/work/repos/add", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const browser = { origin: base, "x-mandible-csrf": csrf };
    const bearer = auth.mintApiToken(operator.id).token;

    expect((await post({}, { authorization: `Bearer ${bearer}` })).status).toBe(403);
    expect((await post({}, { origin: base })).status).toBe(403);
    expect((await post({ root: repo }, browser)).status).toBe(400);
    expect(pickFolder).not.toHaveBeenCalled();

    expect((await post({}, browser)).status).toBe(204);
    expect(scanner.getCachedRepos()).toEqual([]);
    expect(fs.existsSync(path.join(root, "repos.json"))).toBe(false);

    const invalid = await post({}, browser);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toContain("Not a git directory");
    expect(scanner.getCachedRepos()).toEqual([]);

    const added = await post({}, browser);
    expect(added.status).toBe(201);
    const registered = await added.json() as { id: string; root: string };
    expect(registered.root).toBe(repo);
    await scanner.refreshRepoAsync(registered.id);
    expect(scanner.getCachedRepos()).toEqual([expect.objectContaining({ root: repo })]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await scanner.stop();
    db.close();
  }
});
