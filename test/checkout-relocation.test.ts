import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/sse", () => ({ broadcast: vi.fn() }));

import type { Db } from "../src/db.js";
import { checkoutPathCoverage } from "../src/checkout-relocation.js";
import { getArtifactCurrentSource } from "../src/artifact-source.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { registerWorkRoutes } from "../src/routes/work.js";
import { Router } from "../src/server.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { WorkScanner } from "../src/work-scanner.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";

let db: Db;
let dir: string;
let previousArtifactDir: string | undefined;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "checkout-relocation-")));
  previousArtifactDir = process.env.MANDIBLE_ARTIFACT_DIR;
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(dir, "cas");
  db = createMigratedDb({ setGlobal: true });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (previousArtifactDir === undefined) delete process.env.MANDIBLE_ARTIFACT_DIR;
  else process.env.MANDIBLE_ARTIFACT_DIR = previousArtifactDir;
});

function snapshot(): unknown[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
}

/** A repo at `old` with a worktree checkout, branches, trash custody and a local artifact, plus an unrelated sibling. */
function fixture() {
  const old = path.join(dir, "old", "repo");
  const sibling = `${old}-sibling`;
  const worktree = path.join(old, "worktrees", "feature");
  const configPath = path.join(dir, "config", "repos.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ repos: [old, sibling] }, null, 2));
  // Ingested before the checkout was registered, so its source is a local path rather than repo-relative.
  const note = path.join(old, "_artifacts", "note.md");
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, "note\n");
  const artifactId = recordArtifactVersion(db, { source_kind: "local_only", path: note }).series.id.replace("artifact-series:", "artifact:");
  const project = addProject(db, { project_key: "repo" });
  const main = addOrUpdateCheckout(db, project.id, { root: old, work_repo_id: "repo" }).checkout;
  const linked = addOrUpdateCheckout(db, project.id, { root: worktree, work_repo_id: "feature" }).checkout;
  const other = addProject(db, { project_key: "sibling" });
  addOrUpdateCheckout(db, other.id, { root: sibling, work_repo_id: "sibling" });
  const repo = db.prepare("INSERT INTO work_repos (id, root, name) VALUES (?, ?, ?)");
  repo.run("repo", old, "repo");
  repo.run("sibling", sibling, "sibling");
  const branch = db.prepare("INSERT INTO branches (repo_root, branch, is_worktree, worktree_path) VALUES (?, ?, ?, ?)");
  branch.run(old, "main", 0, null);
  branch.run(old, "feature", 1, worktree);
  branch.run(sibling, "main", 0, null);
  db.prepare(
    `INSERT INTO trash_entries (id, project_id, checkout_id, repo_root, branch, reason, actor,
       snapshot_ref, snapshot_oid, original_oid, retention_days, created_at, expires_at)
     VALUES ('trash-1', ?, ?, ?, 'old-branch', 'manual', 'test', 'refs/mandible/trash/trash-1', ?, ?, 30, 1, 2)`,
  ).run(project.id, main.id, old, "a".repeat(40), "b".repeat(40));
  db.prepare("INSERT INTO push_history (id, repo_id, repo_root, scope, status, started_at) VALUES ('push-1', 'repo', ?, 'current', 'completed', 1)")
    .run(old);
  const scanner = new WorkScanner({ db, config_path: configPath });
  return { old, sibling, worktree, configPath, project, main, linked, artifactId, scanner };
}

it("classifies every stored path column", () => {
  expect(checkoutPathCoverage(db)).toEqual([]);
});

it("moves every root and path under the old root in one step, and a repeat changes nothing", async () => {
  const f = fixture();
  const operator = setupOperator(db, { display_name: "Operator" });
  const router = authenticatedTestRouter(operator);
  registerWorkRoutes(router, f.scanner);
  const next = path.join(dir, "dev", "repo");
  const relocate = (old_root: string, new_root: string) =>
    router.invoke({ method: "POST", url: "/api/projects/checkouts/relocate", body: { old_root, new_root } });

  const moved = await relocate(f.old, `${next}/`);
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toMatchObject({ status: "relocated", old_root: f.old, new_root: next });

  const checkouts = db.prepare("SELECT id, root, work_repo_id FROM ledger_project_checkouts ORDER BY root").all();
  expect(checkouts).toEqual([
    { id: f.main.id, root: next, work_repo_id: "repo" },
    { id: f.linked.id, root: path.join(next, "worktrees", "feature"), work_repo_id: "feature" },
    expect.objectContaining({ root: f.sibling }),
  ]);
  expect(db.prepare("SELECT id, root FROM work_repos ORDER BY id").all())
    .toEqual([{ id: "repo", root: next }, { id: "sibling", root: f.sibling }]);
  expect(db.prepare("SELECT repo_root, branch, worktree_path FROM branches ORDER BY repo_root, branch").all()).toEqual([
    { repo_root: next, branch: "feature", worktree_path: path.join(next, "worktrees", "feature") },
    { repo_root: next, branch: "main", worktree_path: null },
    { repo_root: f.sibling, branch: "main", worktree_path: null },
  ]);
  const trash = db.prepare("SELECT t.repo_root, c.root FROM trash_entries t JOIN ledger_project_checkouts c ON c.id = t.checkout_id").get();
  expect(trash).toEqual({ repo_root: next, root: next });
  expect(getArtifactCurrentSource(db, f.artifactId)).toMatchObject({
    source: { kind: "local", path: path.join(next, "_artifacts", "note.md") }, revision: 2,
  });
  expect(db.prepare("SELECT repo_root FROM push_history").get()).toEqual({ repo_root: f.old });
  expect(JSON.parse(fs.readFileSync(f.configPath, "utf8"))).toEqual({ repos: [next, f.sibling] });
  expect(f.scanner.getRepoById("repo")?.root).toBe(next);
  expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_events WHERE event_type = 'checkout.updated'").get()).toEqual({ n: 2 });

  const before = snapshot();
  const config = fs.readFileSync(f.configPath, "utf8");
  const repeat = await relocate(f.old, next);
  expect(repeat.status).toBe(200);
  expect(repeat.body).toMatchObject({ status: "unchanged" });
  expect(snapshot()).toEqual(before);
  expect(fs.readFileSync(f.configPath, "utf8")).toBe(config);
});

it("refuses an occupied destination and nested roots, and reports unknown roots, without writing", async () => {
  const f = fixture();
  const operator = setupOperator(db, { display_name: "Operator" });
  const router = authenticatedTestRouter(operator);
  registerWorkRoutes(router, f.scanner);
  const relocate = (body: Record<string, unknown>) =>
    router.invoke({ method: "POST", url: "/api/projects/checkouts/relocate", body });
  const before = snapshot();
  const config = fs.readFileSync(f.configPath, "utf8");

  const occupied = await relocate({ old_root: f.old, new_root: f.sibling });
  expect(occupied.status).toBe(409);
  expect(occupied.body).toMatchObject({
    code: "destination_occupied",
    occupants: expect.arrayContaining([{ key: "ledger_project_checkouts.root", value: f.sibling }]),
  });
  expect((await relocate({ old_root: f.old, new_root: f.worktree })).body).toMatchObject({ code: "nested_roots" });
  expect((await relocate({ old_root: "relative", new_root: f.old })).status).toBe(400);
  const unknown = await relocate({ old_root: path.join(dir, "nowhere"), new_root: path.join(dir, "elsewhere") });
  expect(unknown.status).toBe(200);
  expect(unknown.body).toMatchObject({ status: "not_found" });

  db.exec("CREATE TABLE future_checkouts (id TEXT PRIMARY KEY, mirror_root TEXT)");
  const uncovered = await relocate({ old_root: f.old, new_root: path.join(dir, "dev", "repo") });
  expect(uncovered.body).toMatchObject({ code: "schema_coverage", unclassified: ["unclassified path column: future_checkouts.mirror_root"] });
  db.exec("DROP TABLE future_checkouts");

  expect(snapshot()).toEqual(before);
  expect(fs.readFileSync(f.configPath, "utf8")).toBe(config);
});

it("reports each status through the CLI, exiting nonzero only for a refusal", async () => {
  const f = fixture();
  const operator = setupOperator(db, { display_name: "Operator" });
  const auth = new ClientAuthenticator(db, { secretsDir: path.join(dir, "credentials") });
  const token = auth.mintApiToken(operator.id).token;
  const router = new Router({ clientAuth: auth });
  registerWorkRoutes(router, f.scanner);
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/instance") {
      const operations = router.operationCatalog("test");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ instance: { role: "main", operational_mutations: "allow",
        instance_id: operations.runtime.instance_id, backend_generation: operations.runtime.backend_generation }, operations }));
      return;
    }
    if (!await router.handle(req, res)) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  const run = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("zsh", [path.resolve("bin/mandible"), "project", "relocate-checkout", ...args, "--json"], {
      cwd: dir, timeout: 15_000,
      env: { ...process.env, MANDIBLE_BASE: `http://127.0.0.1:${port}`, MANDIBLE_TOKEN: token, MANDIBLE_NO_KEYCHAIN_TOKEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  try {
    const next = path.join(dir, "dev", "repo");
    const relative = path.relative(dir, f.old);
    for (const [args, code, status] of [
      [[f.old, f.sibling], 1, undefined],
      [[relative, next], 0, "relocated"],
      [[relative, next], 0, "unchanged"],
      [[path.join(dir, "nowhere"), path.join(dir, "elsewhere")], 0, "not_found"],
    ] as const) {
      const result = await run(...args);
      expect(result.code, result.stderr).toBe(code);
      const body = JSON.parse(result.stdout);
      if (status) expect(body.status).toBe(status);
      else expect(body.code).toBe("destination_occupied");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
