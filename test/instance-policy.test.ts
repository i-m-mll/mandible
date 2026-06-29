import { describe, expect, it } from "vitest";

import { resolveInstanceInfo } from "../src/instance-policy.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import type { Db } from "../src/db.js";

describe("instance mutation policy", () => {
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
    });

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

  it("leaves read-only auth checks available on preview instances", async () => {
    const router = previewRouter();
    router.post("/api/auth/check", (_req, res) => {
      res.status(200).json({ check: { status: "clean" } });
    });

    const response = await router.invoke({
      method: "POST",
      url: "/api/auth/check",
      body: { repo: "mandible", head_branch: "feature/demo" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ check: { status: "clean" } });
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
    });

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
    });

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
    });

    const instanceResponse = await router.invoke({ method: "GET", url: "/api/instance" });
    expect(instanceResponse.status).toBe(200);
    expect(instanceResponse.body).toEqual({ instance });
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
    });

    const response = await router.invoke({
      method: "POST",
      url: "/api/work-units/claim",
      body: { issue_id: "abc123", repo_id: "mandible" },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: "wu_test" });
  });
});

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
