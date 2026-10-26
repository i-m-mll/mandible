import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.ts";
import { observeStableSourceAliasExtent } from "../src/conversations/source-observer.ts";
import { planRoute, readFixtures, restoreSweepSnapshot, sourceIsIndexed } from "../scripts/route-cost-sweep.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-cost-fixtures-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("selects idle fixtures using ingestion's exact source facts and rejects new appends", async () => {
  const root = tempRoot();
  const source = path.join(root, "source.jsonl");
  fs.writeFileSync(source, "indexed body\n");
  const oldTime = Date.now() / 1_000 - 7_200 + 0.123456;
  fs.utimesSync(source, oldTime, oldTime);
  const observed = await observeStableSourceAliasExtent({
    id: "alias", sourceId: "source", rootKind: "provider", rootPath: root,
    relativePath: "source.jsonl", path: source, aliasKind: "provider", availability: "available",
  });
  const fixture = {
    source_path: source, byte_length: observed.byteLength,
    byte_offset: observed.byteLength, file_mtime_ms: observed.fileMtimeMs,
  };
  expect(sourceIsIndexed(fixture)).toBe(true);
  fs.utimesSync(source, new Date(), new Date());
  const recent = await observeStableSourceAliasExtent({
    id: "alias", sourceId: "source", rootKind: "provider", rootPath: root,
    relativePath: "source.jsonl", path: source, aliasKind: "provider", availability: "available",
  });
  expect(sourceIsIndexed({ ...fixture, file_mtime_ms: recent.fileMtimeMs })).toBe(false);
  fs.appendFileSync(source, "append\n");
  fs.utimesSync(source, oldTime, oldTime);
  expect(sourceIsIndexed(fixture)).toBe(false);
});

it("restores seeded databases before confirmations, including absent caches and writer locks", () => {
  const root = tempRoot();
  const seed = path.join(root, "seed");
  const conversations = path.join(root, "conversations");
  fs.mkdirSync(seed);
  const ledgerSeed = path.join(root, "ledger-seed.db");
  const ledger = path.join(root, "mandible.db");
  const create = (file: string, value: string) => {
    const db = new SqliteDatabase(file);
    try {
      db.exec("CREATE TABLE fixture (value TEXT)");
      db.prepare("INSERT INTO fixture VALUES (?)").run(value);
    } finally { db.close(); }
  };
  const read = (file: string) => {
    const db = new SqliteDatabase(file, { readonly: true });
    try { return db.prepare("SELECT value FROM fixture").get(); }
    finally { db.close(); }
  };
  create(ledgerSeed, "seeded ledger");
  create(path.join(seed, "structure.db"), "seeded structure");
  create(path.join(seed, "search-cache.db"), "seeded search");
  fs.mkdirSync(conversations);
  for (const name of ["structure.db", "search-cache.db"]) create(path.join(conversations, name), "warmed cache");
  fs.writeFileSync(path.join(conversations, "search-cache.db.writer-lock"), "previous daemon");
  fs.writeFileSync(`${ledger}-wal`, "previous daemon");
  restoreSweepSnapshot(ledgerSeed, ledger, seed, conversations);
  expect(read(ledger)).toEqual({ value: "seeded ledger" });
  expect(read(path.join(conversations, "structure.db"))).toEqual({ value: "seeded structure" });
  expect(read(path.join(conversations, "search-cache.db"))).toEqual({ value: "seeded search" });
  expect(fs.existsSync(`${ledger}-wal`)).toBe(false);
  const lock = new SqliteDatabase(path.join(conversations, "search-cache.db.writer-lock"));
  try { lock.exec("BEGIN EXCLUSIVE"); } finally { lock.close(); }
  fs.rmSync(path.join(seed, "search-cache.db"));
  restoreSweepSnapshot(ledgerSeed, ledger, seed, conversations);
  expect(fs.existsSync(path.join(conversations, "search-cache.db"))).toBe(false);
});


it("skips only routes depending on a missing fixture and preserves its root reason", () => {
  const ledger = path.join(tempRoot(), "mandible.db");
  const db = new SqliteDatabase(ledger);
  try {
    db.exec(`
      CREATE TABLE ledger_projects (id TEXT, project_key TEXT, display_name TEXT);
      CREATE TABLE ledger_issues (id TEXT, short_id TEXT, project_id TEXT);
      CREATE TABLE ledger_comments (issue_id TEXT);
      CREATE TABLE ledger_project_checkouts (project_id TEXT, work_repo_id TEXT, root TEXT);
      CREATE TABLE branches (branch TEXT, repo_root TEXT, is_worktree INTEGER, updated_at TEXT);
      INSERT INTO ledger_projects VALUES ('project', 'project-key', 'Project');
      INSERT INTO ledger_issues VALUES ('issue', 'short', 'project');
      INSERT INTO ledger_comments VALUES ('issue');
    `);
    const plan = (method: string, routePath: string, fixtures = readFixtures(ledger)) => planRoute({
      method, path: routePath, operationId: "fixture-test", operationalMutationCategory: null, effects: [],
    }, new Set(), fixtures);
    const dependent = [
      ["GET", "/api/work/repos/:id/branches"],
      ["GET", "/api/work/repos/:id/branch/:name"],
      ["GET", "/api/issues/:repoId/:issueId/context"],
      ["PUT", "/api/work/repos/:id"],
    ];
    const fixtures = readFixtures(ledger);
    for (const [method, routePath] of dependent) {
      expect(plan(method, routePath, fixtures)).toEqual({ kind: "skip", reason: "no checkout in the ledger" });
    }
    expect(plan("GET", "/api/ledger/issues/:issueId/body/revisions", fixtures)).toEqual({
      kind: "exercise", requests: [{ label: "/api/ledger/issues/issue/body/revisions", url: "/api/ledger/issues/issue/body/revisions" }],
    });
    expect(plan("GET", "/api/projects/:ref", fixtures)).toEqual({
      kind: "exercise", requests: [{ label: "/api/projects/project-key", url: "/api/projects/project-key" }],
    });
    expect(plan("GET", "/api/health", fixtures)).toEqual({
      kind: "exercise", requests: [{ label: "/api/health", url: "/api/health" }],
    });
    expect(plan("GET", "/api/unclassified/:id", fixtures).kind).toBe("unclassified");

    db.exec("DELETE FROM ledger_projects");
    const emptyProject = readFixtures(ledger);
    for (const [method, routePath] of [...dependent, ["GET", "/api/ledger/issues/:issueId/body/revisions"]]) {
      expect(plan(method, routePath, emptyProject)).toEqual({ kind: "skip", reason: "no project in the ledger" });
    }
    expect(plan("GET", "/api/health", emptyProject).kind).toBe("exercise");
    db.exec("DROP TABLE ledger_projects");
    expect(() => plan("GET", "/api/projects/:ref")).toThrow();
  } finally {
    db.close();
  }
});


it("requires usable settings, destination routes, and enough distinct per-pass entities", () => {
  const ledger = path.join(tempRoot(), "mandible.db");
  const db = new SqliteDatabase(ledger);
  const plan = (method: string, routePath: string, fixtures = readFixtures(ledger)) => planRoute({
    method, path: routePath, operationId: "fixture-test", operationalMutationCategory: null, effects: [],
  }, new Set(), fixtures);
  try {
    db.exec(`
      CREATE TABLE settings (key TEXT, value TEXT);
      INSERT INTO settings VALUES ('user.operator_id', 'operator');
      INSERT INTO settings VALUES (' CLIENT_AUTH.secret ', 'secret');
      INSERT INTO settings VALUES ('console_pinned_sessions', 'private');
      CREATE TABLE auth_requests (id TEXT, delivered_at TEXT, acknowledged_by TEXT, status TEXT, updated_at INTEGER);
      CREATE TABLE webhook_events (id TEXT, status TEXT);
    `);
    expect(plan("GET", "/api/settings/:key")).toEqual({ kind: "skip", reason: "no generic settings keys in the ledger" });
    db.exec("INSERT INTO settings VALUES ('theme', 'x'), ('app_rail_order', 'xx'), ('managed_chat_defaults', 'xxx')");
    const settings = plan("GET", "/api/settings/:key");
    expect(settings.kind).toBe("exercise");
    if (settings.kind === "exercise") expect(settings.requests.map((request) => request.url)).toEqual([
      "/api/settings/managed_chat_defaults", "/api/settings/app_rail_order", "/api/settings/theme",
    ]);

    const fixtures = readFixtures(ledger);
    fixtures.routeManifest = { schema: "mandible-briefing-destination-routes@3", routes: [] };
    for (const routePath of ["/api/briefing-destination-routes/plan", "/api/briefing-destination-routes"]) {
      expect(plan("POST", routePath, fixtures)).toEqual({ kind: "skip", reason: "no briefing destination routes in the ledger" });
    }
    fixtures.routeManifest.routes.push({
      route_key: "report", logical_artifact_ref: "artifact", publication_mode: "published-report",
      heading: "Report", composer_kind: "deterministic",
      template: { version: 1, contribution_template: "{{body}}", slots: {} },
      limits: { max_contributions: 10, max_document_bytes: 10000, max_directives: 0 },
    });
    for (const routePath of ["/api/briefing-destination-routes/plan", "/api/briefing-destination-routes"]) {
      const result = plan("POST", routePath, fixtures);
      expect(result.kind).toBe("exercise");
      if (result.kind === "exercise") expect(result.requests[0].body).toBe(fixtures.routeManifest);
    }

    const perPass = [
      ["/api/inbox/delivered/:id", "undelivered auth results for all passes"],
      ["/api/inbox/:type/:id/ack", "unacknowledged auth results for all passes"],
      ["/api/webhooks/:id/dismiss", "pending webhook events for all passes"],
    ];
    for (let count = 0; count <= 2; count++) {
      for (const [routePath, label] of perPass) {
        const result = plan("POST", routePath);
        if (count < 2) {
          expect(result).toEqual({ kind: "skip", reason: `no ${label} in the ledger` });
        } else {
          expect(result.kind).toBe("exercise");
          if (result.kind === "exercise") {
            const url = result.requests[0].url;
            expect(typeof url).toBe("function");
            if (typeof url === "function") {
              expect(url(1)).toContain("entity-0");
              expect(url(2)).toContain("entity-1");
            }
          }
        }
      }
      db.prepare("INSERT INTO auth_requests VALUES (?, NULL, NULL, 'completed', ?)").run(`entity-${count}`, -count);
      db.prepare("INSERT INTO webhook_events VALUES (?, 'pending')").run(`entity-${count}`);
    }
  } finally {
    db.close();
  }
});
