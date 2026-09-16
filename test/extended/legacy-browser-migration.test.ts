// @vitest-environment node

import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import {
  __resetBrowserSessionForTests,
  getBrowserSessionMigrationFailure,
  initializeBrowserSession,
} from "../../ui/src/client-auth-token.js";
import {
  exportLegacyBrowserState,
  LEGACY_BROWSER_STATE_MAX_ENTRIES,
  restoreLegacyBrowserState,
  validateLegacyBrowserState,
} from "../../src/client-auth/legacy-browser-state.js";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

afterEach(() => {
  __resetBrowserSessionForTests();
  Object.assign(globalThis, { window: originalWindow, document: originalDocument });
});

it.each([
  ["http://127.0.0.1:19420/#/issues", "https://app.mandible.localhost:19419/api/client-auth/legacy-conversion/complete"],
  ["http://127.0.0.1:19421/#/timeline", "https://preview-0123456789abcdef.mandible.localhost:19419/api/client-auth/legacy-conversion/complete"],
] as const)("submits old browser state only to its exact registered migration host from %s", async (oldUrl, completeUrl) => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: oldUrl });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  dom.window.localStorage.setItem("mandible.client_auth.token", "legacy-browser-token");
  let submitted: HTMLFormElement | null = null;
  dom.window.HTMLFormElement.prototype.submit = function submit() { submitted = this; };

  const state = await initializeBrowserSession(async (_input, init) => {
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer legacy-browser-token");
    return new Response(JSON.stringify({ reference: "migration-1", secret: "secret-1", complete_url: completeUrl }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  });

  expect(state).toBe("signed-out");
  expect(submitted?.action).toBe(completeUrl);
  expect([...submitted!.querySelectorAll("input")].map((input) => [input.name, input.value]))
    .toEqual([["reference", "migration-1"], ["secret", "secret-1"]]);
});

it.each([
  "http://preview-0123456789abcdef.mandible.localhost:19419/api/client-auth/legacy-conversion/complete",
  "https://preview-0123456789abcdef.mandible.localhost:19420/api/client-auth/legacy-conversion/complete",
  "https://preview-0123456789abcdeg.mandible.localhost:19419/api/client-auth/legacy-conversion/complete",
  "https://preview-0123456789abcdef.mandible.localhost:19419/api/client-auth/legacy-conversion/complete?target=production",
  "https://evil.invalid:19419/api/client-auth/legacy-conversion/complete",
] as const)("refuses hostile legacy completion URL %s", async (completeUrl) => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1:19421/#/timeline" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  dom.window.localStorage.setItem("mandible.client_auth.token", "legacy-browser-token");
  let submitted = false;
  dom.window.HTMLFormElement.prototype.submit = () => { submitted = true; };
  const state = await initializeBrowserSession(async () => new Response(JSON.stringify({
    reference: "migration-1", secret: "secret-1", complete_url: completeUrl,
  }), { status: 201, headers: { "Content-Type": "application/json" } }));
  expect(state).toBe("unreachable");
  expect(submitted).toBe(false);
});

it("carries more than 64 eligible settings, a draft, and auth-view state without the old bearer", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1:19420/#/auth" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const storage = dom.window.localStorage;
  for (let index = 0; index < 90; index += 1) storage.setItem(`mandible.view.setting:${index}`, `value-${index}`);
  storage.setItem("mandible.briefing.draft:v2:test", "unsent answer");
  storage.setItem("sidebar-width:auth", "320");
  storage.setItem("mandible.client_auth.token", "legacy-browser-token");
  storage.setItem("mandible.session.revocation_pending", "1");
  dom.window.HTMLFormElement.prototype.submit = () => undefined;
  let submittedState: Record<string, string> | null = null;
  await initializeBrowserSession(async (_input, init) => {
    submittedState = (JSON.parse(String(init?.body)) as { browser_state: Record<string, string> }).browser_state;
    return new Response(JSON.stringify({
      reference: "migration-1", secret: "secret-1",
      complete_url: "https://app.mandible.localhost:19419/api/client-auth/legacy-conversion/complete",
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  });
  expect(Object.keys(submittedState!)).toHaveLength(92);
  expect(submittedState).toMatchObject({
    "mandible.view.setting:89": "value-89",
    "mandible.briefing.draft:v2:test": "unsent answer",
    "sidebar-width:auth": "320",
  });
  expect(submittedState).not.toHaveProperty("mandible.client_auth.token");
  expect(submittedState).not.toHaveProperty("mandible.session.revocation_pending");
  const restored = new JSDOM("<!doctype html>", { url: "https://app.mandible.localhost:19420" });
  restoreLegacyBrowserState(restored.window.localStorage, submittedState);
  expect(restored.window.localStorage.getItem("mandible.briefing.draft:v2:test")).toBe("unsent answer");
  expect(restored.window.localStorage.getItem("sidebar-width:auth")).toBe("320");
  expect(restored.window.localStorage.length).toBe(92);
});

it("preserves app-cache choices while refetching oversized instance data", () => {
  const dom = new JSDOM("<!doctype html>", { url: "http://127.0.0.1:19420" });
  const storage = dom.window.localStorage;
  const choices = {
    settings: { "auth.sidebar.width": "320", "timeline.zoom": "2" },
    selectedAuthId: "request-1",
    selectedInboxItemId: "inbox-2",
  };
  const original = JSON.stringify({ v: 2, state: {
    authQueue: [{ body: "x".repeat(2_000_000) }],
    authHistory: [], workRepos: [], workBranches: [], issueRepos: [],
    inboxData: [], consoleSessions: [], ...choices,
  } });
  storage.setItem("mandible_state_cache", original);
  storage.setItem("mandible.briefing.draft:v2:test", "unsent answer");
  const exported = exportLegacyBrowserState(storage);
  expect(JSON.parse(exported.mandible_state_cache)).toEqual({ v: 2, state: choices });
  expect(exported["mandible.briefing.draft:v2:test"]).toBe("unsent answer");
  expect(storage.getItem("mandible_state_cache")).toBe(original);

  const restored = new JSDOM("<!doctype html>", { url: "https://app.mandible.localhost:19420" });
  restoreLegacyBrowserState(restored.window.localStorage, exported);
  expect(JSON.parse(restored.window.localStorage.getItem("mandible_state_cache")!))
    .toEqual({ v: 2, state: choices });
});

it("blocks unknown app-cache fields rather than silently dropping user state", () => {
  const dom = new JSDOM("<!doctype html>", { url: "http://127.0.0.1:19420" });
  dom.window.localStorage.setItem("mandible_state_cache", JSON.stringify({ v: 2, state: { newChoice: "keep me" } }));
  expect(() => exportLegacyBrowserState(dom.window.localStorage)).toThrow("unknown field");
});

it("visibly blocks conversion above the entry bound rather than sending a truncated state", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1:19420/#/timeline" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  dom.window.localStorage.setItem("mandible.client_auth.token", "legacy-browser-token");
  for (let index = 0; index <= LEGACY_BROWSER_STATE_MAX_ENTRIES; index += 1) {
    dom.window.localStorage.setItem(`view:${index}`, "x");
  }
  let requests = 0;
  const state = await initializeBrowserSession(async () => { requests += 1; return new Response("{}"); });
  expect(state).toBe("migration-blocked");
  expect(requests).toBe(0);
  expect(getBrowserSessionMigrationFailure()).toContain("none were silently truncated");
  expect(() => exportLegacyBrowserState(dom.window.localStorage)).toThrow("entry migration limit");
});

it("refuses oversized UTF-8 drafts and exact credential keys without rejecting auth-view settings", () => {
  expect(() => validateLegacyBrowserState({ "mandible.briefing.draft:v2:test": "🙂".repeat(16_385) }))
    .toThrow("oversized entry");
  expect(() => validateLegacyBrowserState({ "mandible.client_auth.token": "reusable-bearer" }))
    .toThrow("reusable credential");
  expect(validateLegacyBrowserState({ "sidebar-width:auth": "320" })).toEqual({ "sidebar-width:auth": "320" });
  expect(() => validateLegacyBrowserState(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`view:${index}`, "x".repeat(60_000)]))))
    .toThrow("byte migration limit");
});
