import http from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAmbientProviderIdentity } from "../src/ambient-provider-identity.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import { Router } from "../src/server.js";

let db: Db;
let router: Router;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  router = new Router();
  registerWorkUnitRoutes(router, {} as never, {} as never);
});

afterEach(() => {
  db.close();
});

describe("work unit routes", () => {
  it("reuses an existing issue/repo/branch claim and normalizes blank session ids", async () => {
    const first = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        assigned_session_id: "",
      },
    });

    expect(first.status).toBe(201);
    const firstBody = first.body as { id: string };
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = ?").get(firstBody.id))
      .toEqual({ assigned_session_id: null });

    const second = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        assigned_session_id: "  session-1  ",
      },
    });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id: firstBody.id, existing: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_units").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = ?").get(firstBody.id))
      .toEqual({ assigned_session_id: "session-1" });
  });

  it("persists explicit ambient identity from claim, activate, and patch requests", async () => {
    const identity = resolveAmbientProviderIdentity({ CODEX_THREAD_ID: "thread-claim" });
    const claim = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      ambient_identity: identity,
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
      },
    });

    expect(claim.status).toBe(201);
    const claimBody = claim.body as { id: string };
    expect(
      db.prepare("SELECT provider, provider_session_id FROM work_units WHERE id = ?").get(claimBody.id),
    ).toEqual({ provider: "codex", provider_session_id: "thread-claim" });

    await router.invoke({
      method: "POST",
      url: "/api/work-units/activate",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
        ambient_identity: { provider: "codex", provider_session_id: "thread-activate" },
      },
    });
    expect(
      db.prepare("SELECT state, provider, provider_session_id FROM work_units WHERE id = ?").get(claimBody.id),
    ).toEqual({ state: "committed", provider: "codex", provider_session_id: "thread-activate" });

    const patch = await router.invoke({
      method: "PATCH",
      url: `/api/work-units/${claimBody.id}`,
      body: {
        provider: "codex",
        provider_session_id: "thread-patch",
      },
    });
    expect(patch.status).toBe(200);
    expect(
      db.prepare("SELECT provider, provider_session_id FROM work_units WHERE id = ?").get(claimBody.id),
    ).toEqual({ provider: "codex", provider_session_id: "thread-patch" });
  });

  it("persists explicit ambient identity from release requests", async () => {
    const claim = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123-demo",
      },
    });
    expect(claim.status).toBe(201);
    const claimBody = claim.body as { id: string };

    const release = await router.invoke({
      method: "POST",
      url: "/api/work-units/release",
      ambient_identity: { provider: "codex", provider_session_id: "thread-release" },
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
      },
    });

    expect(release.status).toBe(200);
    expect(release.body).toMatchObject({ ok: true, released: 1 });
    expect(
      db.prepare("SELECT state, assigned_session_id, provider, provider_session_id FROM work_units WHERE id = ?").get(claimBody.id),
    ).toEqual({
      state: "open",
      assigned_session_id: null,
      provider: "codex",
      provider_session_id: "thread-release",
    });
  });

  it("persists explicit ambient identity from HTTP headers", async () => {
    const server = http.createServer((req, res) => {
      void router.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/work-units/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mandible-Ambient-Provider": "codex",
          "X-Mandible-Ambient-Provider-Session-Id": "thread-header",
        },
        body: JSON.stringify({
          issue_id: "header123",
          repo_id: "mandible",
          branch: "feature/header123",
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { id: string };
      expect(
        db.prepare("SELECT provider, provider_session_id FROM work_units WHERE id = ?").get(body.id),
      ).toEqual({ provider: "codex", provider_session_id: "thread-header" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("does not read daemon process CODEX_THREAD_ID without explicit request identity", async () => {
    const original = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "daemon-thread";
    try {
      const response = await router.invoke({
        method: "POST",
        url: "/api/work-units/claim",
        body: {
          issue_id: "noenv",
          repo_id: "mandible",
          branch: "feature/noenv",
        },
      });

      expect(response.status).toBe(201);
      const body = response.body as { id: string };
      expect(
        db.prepare("SELECT provider, provider_session_id FROM work_units WHERE id = ?").get(body.id),
      ).toEqual({ provider: null, provider_session_id: null });
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_THREAD_ID;
      } else {
        process.env.CODEX_THREAD_ID = original;
      }
    }
  });

  it("normalizes blank session ids written directly to the table", () => {
    db.prepare(
      `INSERT INTO work_units (id, issue_id, repo_id, branch, kind, state, assigned_session_id, created_at)
       VALUES ('wu-direct', 'abc123', 'mandible', 'feature/direct', 'solo', 'open', '   ', 1)`
    ).run();

    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-direct'").get())
      .toEqual({ assigned_session_id: null });

    db.prepare("UPDATE work_units SET assigned_session_id = '' WHERE id = 'wu-direct'").run();

    expect(db.prepare("SELECT assigned_session_id FROM work_units WHERE id = 'wu-direct'").get())
      .toEqual({ assigned_session_id: null });
  });

  it("adds provider identity columns and index to partial legacy work_units tables", () => {
    const legacyDb = new Database(":memory:");
    try {
      legacyDb.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta (key, value) VALUES ('schema_version', '80');
        CREATE TABLE work_units (
          id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          repo_id TEXT NOT NULL,
          state TEXT NOT NULL,
          assigned_session_id TEXT
        );
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          algorithm TEXT NOT NULL DEFAULT 'sha256',
          content_hash TEXT NOT NULL,
          uri TEXT NOT NULL,
          media_type TEXT,
          role TEXT,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          provider_id TEXT,
          manifest_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          pinned INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          custody_mode TEXT NOT NULL DEFAULT 'managed'
            CHECK(custody_mode IN ('link','copy','managed','external')),
          home_repo_id TEXT,
          repo_locator_json TEXT NOT NULL DEFAULT '{}',
          availability TEXT NOT NULL DEFAULT 'unchecked'
            CHECK(availability IN ('present','missing','stale','unchecked','remote_only','pinned')),
          retention_json TEXT NOT NULL DEFAULT '{}',
          reference_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE(algorithm, content_hash)
        );
        CREATE TABLE artifact_aliases (
          id TEXT PRIMARY KEY,
          artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          scheme TEXT NOT NULL,
          alias TEXT NOT NULL,
          normalized_ref TEXT NOT NULL,
          locator_json TEXT NOT NULL DEFAULT '{}',
          resolution_status TEXT NOT NULL DEFAULT 'resolved'
            CHECK(resolution_status IN ('resolved','unresolved','ambiguous','unsupported')),
          source TEXT NOT NULL DEFAULT 'artifact_registry',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE artifact_links (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          link_type TEXT NOT NULL DEFAULT 'references',
          role TEXT,
          repo_id TEXT,
          provider_id TEXT,
          source TEXT NOT NULL DEFAULT 'artifact_registry',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      migrate(legacyDb);
      const columns = new Set(
        (legacyDb.prepare("PRAGMA table_info(work_units)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      expect(columns.has("provider")).toBe(true);
      expect(columns.has("provider_session_id")).toBe(true);
      expect(
        legacyDb.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_units_provider_session'",
        ).get(),
      ).toBeTruthy();
    } finally {
      legacyDb.close();
    }
  });
});
