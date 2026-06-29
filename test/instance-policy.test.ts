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
    router.post("/api/auth/request", (_req, res) => {
      res.status(201).json({ request_id: "req_main" });
    });

    const response = await router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: { command: "true", title: "main" },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ request_id: "req_main" });
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
    router.post("/api/ledger/issues/:issueId/comments", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    router.post("/api/ledger/issues/:issueId/branches", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    router.post("/api/ledger/issues/:issueId/checkpoints", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    router.post("/api/ledger/relationships", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    router.post("/api/work-units/claim", (_req, res) => {
      res.status(201).json({ ok: true });
    });
    router.post("/api/issues/mandible/abc123/comment", (_req, res) => {
      res.status(200).json({ ok: true });
    });

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
