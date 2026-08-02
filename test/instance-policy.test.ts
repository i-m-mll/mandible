import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  allowsOperationalMutations,
  resolveInstanceInfo,
} from "../src/instance-policy.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import type { Db } from "../src/db.js";

describe("instance mutation policy", () => {
  it("uses the same policy decision for route and background mutations", () => {
    expect(allowsOperationalMutations(resolveInstanceInfo({ env: {} }))).toBe(true);
    expect(allowsOperationalMutations(resolveInstanceInfo({
      env: { MANDIBLE_INSTANCE_ROLE: "preview" },
    }))).toBe(false);
    expect(allowsOperationalMutations(resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_OPERATIONAL_MUTATIONS: "allow",
      },
    }))).toBe(true);
  });

  it("defaults to a main instance that accepts operational mutations", async () => {
    const router = new Router({
      instance: resolveInstanceInfo({ env: {}, dbPath: "/tmp/mandible-main.db" }),
    });
    registerUnsafeRoutes(router);

    for (const route of REPRESENTATIVE_UNSAFE_ROUTES) {
      const response = await router.invoke({ method: route.method, url: route.url, body: {} });
      expect(response.status, route.url).toBe(200);
      expect(response.body).toEqual({ ok: true, route: route.name });
    }
  });

  it("rejects auth mutations on preview instances with a clear JSON response", async () => {
    const router = previewRouter();
    router.post("/api/auth/request", (_req, res) => {
      res.status(201).json({ request_id: "req_preview" });
    }, { fileRpc: "allow" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: { command: "true", title: "preview" },
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: "instance_mutation_forbidden",
      category: "auth",
      instance_role: "preview",
      operational_mutations: "reject",
    });
  });

  it("rejects artifact external-open before the OS-open handler runs in previews", async () => {
    const router = previewRouter();
    let invoked = false;
    router.post("/api/artifacts/:id/open-externally", (_req, res) => {
      invoked = true;
      res.status(200).json({ ok: true });
    }, { fileRpc: "deny" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/artifacts/artifact%3Aexample/open-externally",
      body: {},
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: "instance_mutation_forbidden",
      category: "artifacts",
      instance_role: "preview",
    });
    expect(invoked).toBe(false);
  });

  it("leaves read-only auth checks available on preview instances", async () => {
    const router = previewRouter();
    router.post("/api/auth/check", (_req, res) => {
      res.status(200).json({ check: { status: "clean" } });
    }, { fileRpc: "allow" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/auth/check",
      body: { repo: "mandible", head_branch: "feature/demo" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ check: { status: "clean" } });
  });

  it("leaves Timeline projection queries available on preview instances", async () => {
    const router = previewRouter();
    router.post("/api/timeline/project", (_req, res) => {
      res.status(200).json({ project: { id: "prj_mandible" }, rows: [], events: [] });
    });

    const response = await router.invoke({
      method: "POST",
      url: "/api/timeline/project",
      body: { project_ref: "mandible" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ project: { id: "prj_mandible" }, rows: [], events: [] });
  });

  it("rejects representative ledger and work-unit mutations on preview instances", async () => {
    const router = previewRouter();
    registerUnsafeRoutes(router);

    for (const url of [
      "/api/ledger/issues/abc123/comments",
      "/api/ledger/issues/abc123/branches",
      "/api/ledger/issues/abc123/checkpoints",
      "/api/ledger/relationships",
      "/api/work-units/claim",
      "/api/issues/mandible/abc123/comment",
    ]) {
      const response = await router.invoke({ method: "POST", url, body: {} });
      expect(response.status, url).toBe(403);
      expect(response.body).toMatchObject({ error: "instance_mutation_forbidden" });
    }
  });

  it("rejects broad control-plane mutation families on preview instances", async () => {
    const router = previewRouter();
    registerUnsafeRoutes(router);

    for (const route of REPRESENTATIVE_UNSAFE_ROUTES) {
      const response = await router.invoke({ method: route.method, url: route.url, body: {} });
      expect(response.status, route.url).toBe(403);
      expect(response.body).toMatchObject({
        error: "instance_mutation_forbidden",
        category: route.category,
        instance_role: "preview",
        operational_mutations: "reject",
      });
    }
  });

  it("treats session registration as a control-plane mutation on preview instances", async () => {
    const router = previewRouter();
    router.post("/api/sessions/register", (_req, res) => {
      res.status(200).json({ ok: true });
    }, { fileRpc: "allow" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/sessions/register",
      body: { id: "session-1", app: "codex" },
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: "instance_mutation_forbidden",
      category: "sessions",
    });
  });

  it("guards future unsafe API routes by default", async () => {
    const router = previewRouter();
    router.post("/api/new-control-plane/write", (_req, res) => {
      res.status(200).json({ ok: true });
    }, { fileRpc: "deny" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/new-control-plane/write",
      body: {},
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: "instance_mutation_forbidden",
      category: "api",
    });
  });

  it("exposes instance metadata through health and instance routes", async () => {
    const instance = resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
        MANDIBLE_INSTANCE_SOURCE_DB: "/tmp/mandible-main.db",
      },
      dbPath: "/tmp/mandible-preview.db",
    });
    const router = new Router({ instance });
    createServer({
      db: {} as Db,
      sse: new SseManager(),
      logger: () => undefined,
      version: "test",
      router,
      getStartupInfo: () => null,
      instance,
      fileRpcDir: "/tmp/mandible-preview-agent-rpc",
    });

    const health = await router.invoke({ method: "GET", url: "/api/health" });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: "ok",
      instance: {
        role: "preview",
        operational_mutations: "reject",
        db_path: "/tmp/mandible-preview.db",
        db_path_source: "iab-preview-copy",
        source_db_path: "/tmp/mandible-main.db",
        source_db_path_source: "env",
      },
      file_rpc_dir: "/tmp/mandible-preview-agent-rpc",
    });

    const instanceResponse = await router.invoke({ method: "GET", url: "/api/instance" });
    expect(instanceResponse.status).toBe(200);
    expect(instanceResponse.body).toEqual({ instance });
  });

  it("embeds instance metadata in the dashboard bootstrap payload", async () => {
    const instance = resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
      },
      dbPath: "/tmp/mandible-preview.db",
    });
    const router = new Router({ instance });
    const server = createServer({
      db: {} as Db,
      sse: new SseManager(),
      logger: () => undefined,
      version: "test",
      router,
      getStartupInfo: () => null,
      instance,
    });
    const port = await listenOnEphemeralPort(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const html = await response.text();
      const match = html.match(/<script id="mandible-bootstrap" type="application\/json">([^<]+)<\/script>/);
      expect(match).toBeTruthy();
      expect(JSON.parse(match?.[1] ?? "{}")).toMatchObject({
        instance: {
          role: "preview",
          operational_mutations: "reject",
          db_path: "/tmp/mandible-preview.db",
          db_path_source: "iab-preview-copy",
        },
      });
      expect(html.indexOf('id="mandible-bootstrap"')).toBeLessThan(html.indexOf('src="./dist/app.js"'));
    } finally {
      await closeServer(server);
    }
  });

  it("honors If-Modified-Since for static assets using second-granularity mtimes", async () => {
    const instance = resolveInstanceInfo({ env: {}, dbPath: "/tmp/mandible-main.db" });
    const router = new Router({ instance });
    const server = createServer({
      db: {} as Db,
      sse: new SseManager(),
      logger: () => undefined,
      version: "test",
      router,
      getStartupInfo: () => null,
      instance,
    });
    const port = await listenOnEphemeralPort(server);
    const assetPath = path.join(process.cwd(), "ui", "icon.svg");
    const stat = fs.statSync(assetPath);
    try {
      const notModified = await fetch(`http://127.0.0.1:${port}/icon.svg`, {
        headers: { "If-Modified-Since": stat.mtime.toUTCString() },
      });
      expect(notModified.status).toBe(304);
      expect(await notModified.text()).toBe("");

      const older = new Date(Math.floor(stat.mtime.getTime() / 1000) * 1000 - 10_000);
      const modified = await fetch(`http://127.0.0.1:${port}/icon.svg`, {
        headers: { "If-Modified-Since": older.toUTCString() },
      });
      expect(modified.status).toBe(200);
      expect(await modified.text()).toContain("<svg");
    } finally {
      await closeServer(server);
    }
  });

  it("allows an explicit operational mutation override for test instances", async () => {
    const instance = resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "test",
        MANDIBLE_OPERATIONAL_MUTATIONS: "allow",
      },
    });
    const router = new Router({ instance });
    router.post("/api/work-units/claim", (_req, res) => {
      res.status(201).json({ id: "wu_test" });
    }, { fileRpc: "allow" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: { issue_id: "abc123", repo_id: "mandible" },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: "wu_test" });
  });
});

function listenOnEphemeralPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(address.port);
        return;
      }
      reject(new Error("server did not listen on an ephemeral TCP port"));
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function previewRouter(): Router {
  return new Router({
    instance: resolveInstanceInfo({
      env: { MANDIBLE_INSTANCE_ROLE: "preview" },
      dbPath: "/tmp/mandible-preview.db",
      dbPathSource: "env",
    }),
  });
}

const REPRESENTATIVE_UNSAFE_ROUTES = [
  { method: "POST", url: "/api/auth/request", name: "auth", category: "auth" },
  { method: "POST", url: "/api/ledger/issues/abc123/comments", name: "ledger", category: "ledger" },
  { method: "POST", url: "/api/ledger/issues/abc123/branches", name: "ledger-branches", category: "ledger" },
  { method: "POST", url: "/api/ledger/issues/abc123/checkpoints", name: "ledger-checkpoints", category: "ledger" },
  { method: "POST", url: "/api/ledger/relationships", name: "ledger-relationships", category: "ledger" },
  { method: "POST", url: "/api/issues/mandible/abc123/comment", name: "issues", category: "issues" },
  { method: "POST", url: "/api/work-units/claim", name: "work-units", category: "work_units" },
  { method: "POST", url: "/api/projects", name: "projects", category: "projects" },
  { method: "POST", url: "/api/sessions/register", name: "sessions", category: "sessions" },
  { method: "POST", url: "/api/inbox/delivered/auth1", name: "inbox", category: "inbox" },
  { method: "POST", url: "/api/inbox/auth/auth1/ack", name: "inbox-ack", category: "inbox" },
  { method: "POST", url: "/api/console/sessions/console1/start", name: "console-start", category: "console" },
  { method: "POST", url: "/api/console/sessions/console1/prompt", name: "console", category: "console" },
  { method: "POST", url: "/api/work/push", name: "work", category: "work" },
  { method: "POST", url: "/api/runtime/update", name: "runtime-update", category: "runtime" },
  { method: "POST", url: "/api/runtime/reset", name: "runtime-reset", category: "runtime" },
  { method: "POST", url: "/api/artifacts/ingest", name: "artifacts-ingest", category: "artifacts" },
  { method: "POST", url: "/api/artifacts/link", name: "artifacts-link", category: "artifacts" },
  { method: "POST", url: "/api/providers/register", name: "providers", category: "providers" },
  { method: "POST", url: "/api/provider-manifests/ingest", name: "provider-manifests", category: "providers" },
  { method: "POST", url: "/api/knowledge-backrefs", name: "knowledge-backrefs", category: "artifacts" },
] as const;

function registerUnsafeRoutes(router: Router): void {
  for (const route of REPRESENTATIVE_UNSAFE_ROUTES) {
    const handler = (_req: unknown, res: { status(code: number): { json(payload: unknown): void } }) => {
      res.status(200).json({ ok: true, route: route.name });
    };
    switch (route.method) {
      case "POST":
        router.post(patternForUrl(route.url), handler);
        break;
      case "PUT":
        router.put(patternForUrl(route.url), handler);
        break;
      case "PATCH":
        router.patch(patternForUrl(route.url), handler);
        break;
      case "DELETE":
        router.delete(patternForUrl(route.url), handler);
        break;
    }
  }
}

function patternForUrl(url: string): string {
  return url
    .replace("/abc123", "/:issueId")
    .replace("/mandible", "/:repoId")
    .replace("/auth1", "/:id")
    .replace("/console1", "/:id");
}
