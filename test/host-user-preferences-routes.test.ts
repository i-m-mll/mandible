import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostUserPreferencesStore } from "../src/host-user-preferences.js";
import { registerHostUserPreferencesRoutes } from "../src/routes/host-user-preferences.js";
import type {
  RequestLike,
  ResolvedClientIdentity,
  ResponseLike,
  RouteHandler,
  RouteRegistrar,
} from "../src/server.js";

class TestRoutes implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();
  get(routePath: string, handler: RouteHandler): void { this.handlers.set(`GET ${routePath}`, handler); }
  post(routePath: string, handler: RouteHandler): void { this.handlers.set(`POST ${routePath}`, handler); }
  put(routePath: string, handler: RouteHandler): void { this.handlers.set(`PUT ${routePath}`, handler); }
  patch(routePath: string, handler: RouteHandler): void { this.handlers.set(`PATCH ${routePath}`, handler); }
  delete(routePath: string, handler: RouteHandler): void { this.handlers.set(`DELETE ${routePath}`, handler); }
  handler(method: string, routePath = "/api/host-preferences/chat-shown-projects"): RouteHandler {
    const handler = this.handlers.get(`${method} ${routePath}`);
    if (!handler) throw new Error(`Missing ${method} handler`);
    return handler;
  }
}

async function callTheme(
  routes: TestRoutes,
  method: "GET" | "PUT",
  body?: unknown,
) {
  const res = response();
  const routePath = "/api/host-preferences/app-theme";
  await routes.handler(method, routePath)({
    method,
    url: routePath,
    params: {},
    query: {},
    body,
    client_identity: identity(),
  }, res);
  return { statusCode: res.statusCode, payload: res.payload };
}

async function callSidebarOrder(
  routes: TestRoutes,
  method: "GET" | "PUT",
  body?: unknown,
  user: ResolvedClientIdentity | null = identity(),
) {
  const res = response();
  const routePath = "/api/host-preferences/sidebar-order";
  await routes.handler(method, routePath)({
    method,
    url: routePath,
    params: {},
    query: {},
    body,
    client_identity: user,
  }, res);
  return { statusCode: res.statusCode, payload: res.payload };
}

function identity(userId = "user-stable-1"): ResolvedClientIdentity {
  return {
    user_id: userId,
    slug: "operator",
    method: "api_token",
    credential_id: null,
    source: "http_bearer",
  };
}

function response(): ResponseLike & { statusCode: number; payload: unknown } {
  return {
    statusCode: 200,
    payload: null,
    status(code: number): ResponseLike { this.statusCode = code; return this; },
    json(payload: unknown): void { this.payload = payload; },
  };
}

async function call(
  routes: TestRoutes,
  method: "GET" | "PUT",
  body?: unknown,
  user: ResolvedClientIdentity | null = identity(),
) {
  const res = response();
  const req: RequestLike = {
    method,
    url: "/api/host-preferences/chat-shown-projects",
    params: {},
    query: {},
    body,
    client_identity: user,
  };
  await routes.handler(method)(req, res);
  return { statusCode: res.statusCode, payload: res.payload };
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("host user Chat project preferences", () => {
  it("stores ordered sidebar intent in a separate per-user authority without rewriting legacy preferences", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-host-preferences-"));
    roots.push(root);
    const routes = new TestRoutes();
    registerHostUserPreferencesRoutes(routes, new HostUserPreferencesStore(root));
    const projects = [{ projectId: "prj-mandible", checkoutId: "checkout-main" }];
    await call(routes, "PUT", { value: projects, expected_revision: 0 });
    const legacyPath = path.join(root, "user-stable-1.json");
    const legacyBytes = fs.readFileSync(legacyPath, "utf8");

    const value = {
      pinnedConversationIds: ["conversation-b", "conversation-a"],
      briefingTopLevelIds: ["group-one", "briefing-two"],
    };
    expect(await callSidebarOrder(routes, "GET")).toMatchObject({
      payload: { key: "sidebar_order", value: { pinnedConversationIds: null, briefingTopLevelIds: null }, revision: 0 },
    });
    expect(await callSidebarOrder(routes, "PUT", { value, expected_revision: 0 })).toMatchObject({
      payload: { key: "sidebar_order", value, revision: 1 },
    });
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
    expect(JSON.parse(fs.readFileSync(path.join(root, "user-stable-1.sidebar-order.json"), "utf8"))).toEqual({
      version: 1,
      userId: "user-stable-1",
      revision: 1,
      value,
    });
    expect(await callSidebarOrder(routes, "GET", undefined, identity("user-two"))).toMatchObject({
      payload: { value: { pinnedConversationIds: null, briefingTopLevelIds: null }, revision: 0 },
    });
  });

  it("rejects stale and malformed sidebar order writes without losing the durable value", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-host-preferences-"));
    roots.push(root);
    const routes = new TestRoutes();
    registerHostUserPreferencesRoutes(routes, new HostUserPreferencesStore(root));
    const value = { pinnedConversationIds: ["b", "a"], briefingTopLevelIds: null };
    await callSidebarOrder(routes, "PUT", { value, expected_revision: 0 });

    expect(await callSidebarOrder(routes, "PUT", {
      value: { pinnedConversationIds: ["a", "b"], briefingTopLevelIds: null },
      expected_revision: 0,
    })).toMatchObject({
      statusCode: 409,
      payload: { code: "preference_revision_conflict", current: { value, revision: 1 } },
    });
    expect(await callSidebarOrder(routes, "PUT", {
      value: { pinnedConversationIds: ["duplicate", "duplicate"], briefingTopLevelIds: null },
      expected_revision: 1,
    })).toMatchObject({ statusCode: 400, payload: { code: "invalid_sidebar_order" } });
    expect(await callSidebarOrder(routes, "GET")).toMatchObject({ payload: { value, revision: 1 } });

    fs.writeFileSync(path.join(root, "user-stable-1.sidebar-order.json"), "{broken", { mode: 0o600 });
    expect(await callSidebarOrder(routes, "GET")).toMatchObject({
      statusCode: 500,
      payload: { code: "host_preferences_invalid_file" },
    });
  });

  it("shares app theme through the same host/user authority", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-host-preferences-"));
    roots.push(root);
    const routes = new TestRoutes();
    registerHostUserPreferencesRoutes(routes, new HostUserPreferencesStore(root));

    expect(await callTheme(routes, "GET")).toMatchObject({
      payload: { key: "app_theme", value: null, revision: 0 },
    });
    expect(await callTheme(routes, "PUT", { value: "dark", expected_revision: 0 })).toMatchObject({
      payload: { key: "app_theme", value: "dark", revision: 1 },
    });
    expect(await call(routes, "GET")).toMatchObject({ payload: { value: [], revision: 1 } });
  });

  it("shares one revisioned file across independently constructed daemon stores", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-host-preferences-"));
    roots.push(root);
    const firstRoutes = new TestRoutes();
    const secondRoutes = new TestRoutes();
    registerHostUserPreferencesRoutes(firstRoutes, new HostUserPreferencesStore(root));
    registerHostUserPreferencesRoutes(secondRoutes, new HostUserPreferencesStore(root));

    expect(await call(firstRoutes, "GET")).toEqual({
      statusCode: 200,
      payload: { version: 1, key: "chat_shown_projects", value: [], revision: 0 },
    });

    const value = [{ projectId: "prj-mandible", checkoutId: "checkout-main" }];
    expect(await call(firstRoutes, "PUT", { value, expected_revision: 0 })).toEqual({
      statusCode: 200,
      payload: { version: 1, key: "chat_shown_projects", value, revision: 1 },
    });
    expect(await call(secondRoutes, "GET")).toMatchObject({
      statusCode: 200,
      payload: { value, revision: 1 },
    });

    const stored = JSON.parse(fs.readFileSync(path.join(root, "user-stable-1.json"), "utf8"));
    expect(stored).toEqual({
      version: 1,
      userId: "user-stable-1",
      revision: 1,
      settings: { chatShownProjects: value, appTheme: null },
    });
    expect(fs.statSync(path.join(root, "user-stable-1.json")).mode & 0o077).toBe(0);
  });

  it("rejects stale concurrent revisions and invalid references without changing the file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-host-preferences-"));
    roots.push(root);
    const routes = new TestRoutes();
    registerHostUserPreferencesRoutes(routes, new HostUserPreferencesStore(root));
    const initial = [{ projectId: "prj-one", checkoutId: "checkout-one" }];
    await call(routes, "PUT", { value: initial, expected_revision: 0 });

    expect(await call(routes, "PUT", {
      value: [{ projectId: "prj-two", checkoutId: "checkout-two" }],
      expected_revision: 0,
    })).toMatchObject({
      statusCode: 409,
      payload: {
        code: "preference_revision_conflict",
        expected_revision: 0,
        current: { value: initial, revision: 1 },
      },
    });
    expect(await call(routes, "PUT", {
      value: [{ projectId: "", checkoutId: "checkout" }],
      expected_revision: 1,
    })).toMatchObject({ statusCode: 400, payload: { code: "invalid_chat_shown_projects" } });
    expect(await call(routes, "GET")).toMatchObject({ payload: { value: initial, revision: 1 } });
  });

  it("serializes simultaneous writers so exactly one compare-and-swap wins", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-host-preferences-"));
    roots.push(root);
    const first = new HostUserPreferencesStore(root);
    const second = new HostUserPreferencesStore(root);
    const results = await Promise.allSettled([
      first.writeChatShownProjects("user-stable-1", 0, [{ projectId: "prj-one", checkoutId: "checkout-one" }]),
      second.writeChatShownProjects("user-stable-1", 0, [{ projectId: "prj-two", checkoutId: "checkout-two" }]),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await first.readChatShownProjects("user-stable-1");
    expect(current.revision).toBe(1);
    expect(current.value).toEqual(
      results.find((result) => result.status === "fulfilled")!.value.value,
    );
  });

  it("fails visibly for unauthenticated callers and malformed authority files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-host-preferences-"));
    roots.push(root);
    const routes = new TestRoutes();
    registerHostUserPreferencesRoutes(routes, new HostUserPreferencesStore(root));
    expect(await call(routes, "GET", undefined, null)).toMatchObject({
      statusCode: 401,
      payload: { code: "authentication_required" },
    });
    fs.writeFileSync(path.join(root, "user-stable-1.json"), "{broken", { mode: 0o600 });
    expect(await call(routes, "GET")).toMatchObject({
      statusCode: 500,
      payload: { code: "host_preferences_invalid_file" },
    });
  });
});
