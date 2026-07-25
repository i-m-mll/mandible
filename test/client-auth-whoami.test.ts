// Issue 499c148 — GET /api/client-auth/whoami reports the identity the daemon
// actually resolves for the calling request, across every client-auth path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { Router } from "../src/server.js";
import { registerClientAuthRoutes } from "../src/routes/client-auth.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { createUser, setupOperator } from "../src/users/store.js";

let tempDir = "";
let db: Db;
let authenticator: ClientAuthenticator;
let router: Router;

function whoami(credential?: string | null) {
  return router.invoke({
    method: "GET",
    url: "/api/client-auth/whoami",
    credential: credential ?? null,
    transport: "http",
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-whoami-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
  authenticator = new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "client-auth") });
  router = new Router({ clientAuth: authenticator });
  registerClientAuthRoutes(router, authenticator);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /api/client-auth/whoami", () => {
  it("reports an unauthenticated caller instead of failing", async () => {
    const response = await whoami(null);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authenticated: false,
      mode: "compat",
      user: null,
      evidence_method: null,
      source: null,
      ephemeral_purpose: null,
      credential: null,
    });
  });

  it("treats an unrecognized bearer as unauthenticated", async () => {
    const response = await whoami("not-a-real-token");

    expect(response.body).toMatchObject({ authenticated: false, user: null });
  });

  it("names the user and the credential label behind an api_token", async () => {
    const agent = createUser(db, {
      slug: "claude-code",
      kind: "agent",
      display_name: "Claude Code",
    });
    const minted = authenticator.mintApiToken(agent.id, { label: "claude-code-agent" });

    const response = await whoami(minted.token);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      authenticated: true,
      mode: "compat",
      user: {
        id: agent.id,
        slug: "claude-code",
        kind: "agent",
        display_name: "Claude Code",
      },
      evidence_method: "api_token",
      source: "http_bearer",
      ephemeral_purpose: null,
      credential: {
        id: minted.credential.id,
        type: "api_token",
        label: "claude-code-agent",
        status: "active",
      },
    });
  });

  // The incident this issue came from: an agent session inherited the human
  // operator's token. whoami has to name the human, not the agent the session
  // claims to be, or it cannot be used as a pre-flight self-check.
  it("names the operator when an operator token is the effective credential", async () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const minted = authenticator.mintApiToken(operator.id, { label: "mll-cli" });

    const response = await whoami(minted.token);

    expect(response.body).toMatchObject({
      authenticated: true,
      user: { id: operator.id, kind: "human" },
      evidence_method: "api_token",
      credential: { label: "mll-cli" },
    });
  });

  it("reports an ephemeral dashboard session with no credential row", async () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const session = authenticator.issueDashboardToken({
      user_id: operator.id,
      slug: operator.slug,
    });

    const response = await whoami(session.token);

    expect(response.body).toMatchObject({
      authenticated: true,
      user: { id: operator.id, slug: operator.slug, kind: "human" },
      evidence_method: "ephemeral",
      ephemeral_purpose: "dashboard_handshake",
      credential: null,
    });
  });

  it("reports the operator bootstrap token as an ephemeral identity", async () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const bootstrap = authenticator.bootstrapToken();
    expect(bootstrap).toBeTruthy();

    const response = await whoami(bootstrap);

    expect(response.body).toMatchObject({
      authenticated: true,
      user: { id: operator.id, kind: "human" },
      evidence_method: "ephemeral",
      ephemeral_purpose: "operator_bootstrap",
      credential: null,
    });
  });

  it("reports the current client-auth mode alongside the identity", async () => {
    setClientAuthMode(db, "strict");

    const response = await whoami(null);

    expect(response.body).toMatchObject({ mode: "strict", authenticated: false });
  });
});
