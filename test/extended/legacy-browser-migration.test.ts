// @vitest-environment node

import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import {
  __resetBrowserSessionForTests,
  initializeBrowserSession,
} from "../../ui/src/client-auth-token.js";

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
