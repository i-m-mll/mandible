// Issue 0b989d1 — session-scoped ephemeral agent tokens.
//
// `cli/wrap.sh` exchanges a launched agent's long-lived keychain PAT for a token
// bound to the session it is about to register, and exports only that. These
// tests pin the properties that make the swap worth doing: the exchanged token
// authenticates as exactly the same user (so nothing downstream, including the
// fail-closed auth-request requester gate, changes behavior), and it stops
// working the moment the session ends — by the explicit revoke on the orphan
// watcher's end call, by any other path that marks the session non-active, and
// by the TTL backstop when a session never reports an end at all.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import { registerClientAuthRoutes } from "../src/routes/client-auth.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { SessionRegistry } from "../src/registry.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { addBinding, createUser, setupOperator } from "../src/users/store.js";

let tempDir = "";
let db: Db;
let authenticator: ClientAuthenticator;
let registry: SessionRegistry;
let server: http.Server;
let sse: SseManager;
let port = 0;
let clock = 0;

const SESSION_ID = "sess-wrap-0b989d1";
const WRAP_TTL_MS = 30 * 60_000;
const PRE_REGISTRATION_GRACE_MS = 10 * 60_000;

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** An agent user plus the durable PAT wrap.sh would have read from the keychain. */
function agentWithPat(slug = "agent-wrapped"): { id: string; slug: string; pat: string } {
  const agent = createUser(db, { slug, kind: "agent", display_name: "Wrapped Agent" });
  addBinding(db, agent.id, { binding_type: "app_name", value: "claude" });
  const { token } = authenticator.mintApiToken(agent.id, { label: `${slug}-keychain` });
  return { id: agent.id, slug: agent.slug, pat: token };
}

async function exchange(
  pat: string | null,
  sessionId: string | null = SESSION_ID,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await requestJson(
    "POST",
    "/api/client-auth/session-token",
    sessionId === null ? {} : { session_id: sessionId },
    pat ? bearer(pat) : {},
  );
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

/** Register the session row wrap.sh would create right after the exchange. */
function registerSession(id = SESSION_ID): void {
  registry.registerSession({ id, app: "claude", status: "active" });
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-session-token-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
  clock = 1_700_000_000_000;
  authenticator = new ClientAuthenticator(db, {
    secretsDir: path.join(tempDir, "client-auth"),
    wrapSessionTtlMs: WRAP_TTL_MS,
    wrapSessionPreRegistrationGraceMs: PRE_REGISTRATION_GRACE_MS,
    now: () => clock,
  });
  registry = new SessionRegistry(db);

  const router = new Router({ clientAuth: authenticator });
  router.post("/api/write", (req, res) => {
    res.json({ ok: true, identity: req.client_identity ?? null });
  }, { fileRpc: "allow" });
  registerClientAuthRoutes(router, authenticator);
  registerSessionRoutes(router, registry, undefined, undefined, authenticator);

  sse = new SseManager();
  server = createServer({
    db,
    sse,
    logger: () => undefined,
    version: "test",
    router,
    getStartupInfo: () => null,
    clientAuth: authenticator,
  });
  port = await listen(server);
});

afterEach(async () => {
  await close(server);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("session-token exchange", () => {
  it("mints a distinct session-scoped token for the PAT's own user", async () => {
    const agent = agentWithPat();
    const response = await exchange(agent.pat);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      session_id: SESSION_ID,
      user: { id: agent.id, slug: agent.slug },
      expires_at: clock + WRAP_TTL_MS,
    });
    const token = response.body.token as string;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    // The exchange replaces the PAT; it must not hand back the same bytes.
    expect(token).not.toBe(agent.pat);
  });

  it("authenticates as the same agent user the PAT resolves to", async () => {
    const agent = agentWithPat();
    const { body } = await exchange(agent.pat);
    registerSession();

    const withPat = await requestJson("POST", "/api/write", {}, bearer(agent.pat));
    const withSessionToken = await requestJson(
      "POST",
      "/api/write",
      {},
      bearer(body.token as string),
    );

    expect(withSessionToken.status).toBe(200);
    // user_id is exactly what resolveAuthRequester consumes, so the fail-closed
    // auth-request gate sees an identical requester either way.
    expect(withSessionToken.body).toMatchObject({
      ok: true,
      identity: {
        user_id: agent.id,
        slug: agent.slug,
        method: "ephemeral",
        ephemeral_purpose: `wrap_session:${SESSION_ID}`,
      },
    });
    expect((withPat.body as { identity: { user_id: string } }).identity.user_id)
      .toBe((withSessionToken.body as { identity: { user_id: string } }).identity.user_id);
  });

  it("works in strict mode, where an unauthenticated exchange is refused", async () => {
    setClientAuthMode(db, "strict");
    const agent = agentWithPat();

    const anonymous = await exchange(null);
    expect(anonymous.status).toBe(401);

    const authenticated = await exchange(agent.pat);
    expect(authenticated.status).toBe(201);
  });

  it("requires a session id", async () => {
    const agent = agentWithPat();
    const response = await exchange(agent.pat, null);
    expect(response.status).toBe(400);
  });

  it("refuses to re-exchange an already-ephemeral token", async () => {
    const agent = agentWithPat();
    const first = await exchange(agent.pat);
    registerSession();

    // Chaining would mint a fresh TTL from a leaked ephemeral, defeating the point.
    const second = await exchange(first.body.token as string);
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ code: "exchange_requires_api_token" });
  });

  it("refuses an exchange from the operator's dashboard session token", async () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const dashboard = authenticator.issueDashboardToken({
      user_id: operator.id,
      slug: operator.slug,
    });
    const response = await exchange(dashboard.token);
    expect(response.status).toBe(403);
  });

  it("refuses another user's exchange for an existing active session", async () => {
    agentWithPat();
    registerSession();
    const other = createUser(db, {
      slug: "agent-other",
      kind: "agent",
      display_name: "Other Agent",
    });
    const otherPat = authenticator.mintApiToken(other.id, { label: "other-keychain" }).token;

    const response = await exchange(otherPat);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "session_exchange_forbidden" });
  });

  it("allows the owner to exchange for an existing active session", async () => {
    const agent = agentWithPat();
    registerSession();

    expect((await exchange(agent.pat)).status).toBe(201);
  });

  it("replaces a same-session exchange without growing retained state", async () => {
    const agent = agentWithPat();
    const first = await exchange(agent.pat);
    const sizeAfterFirst = (
      authenticator as unknown as { ephemeral: Map<string, unknown> }
    ).ephemeral.size;
    const second = await exchange(agent.pat);
    const sizeAfterSecond = (
      authenticator as unknown as { ephemeral: Map<string, unknown> }
    ).ephemeral.size;

    expect(sizeAfterSecond).toBe(sizeAfterFirst);
    expect((await requestJson("POST", "/api/write", {}, bearer(first.body.token as string))).body)
      .toMatchObject({ identity: null });
    expect((await requestJson("POST", "/api/write", {}, bearer(second.body.token as string))).body)
      .toMatchObject({ identity: { user_id: agent.id } });
  });

  it("caps wrap tokens without evicting a dashboard handshake", () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const dashboard = authenticator.issueDashboardToken({
      user_id: operator.id,
      slug: operator.slug,
    });
    const agent = agentWithPat();
    const wrapTokens = Array.from(
      { length: 65 },
      (_, index) => authenticator.issueSessionScopedToken(agent, `unknown-${index}`).token,
    );

    expect(authenticator.authenticate(dashboard.token)).toMatchObject({
      user_id: operator.id,
      ephemeral_purpose: "dashboard_handshake",
    });
    expect(authenticator.authenticate(wrapTokens[0])).toBeNull();
    expect(authenticator.authenticate(wrapTokens.at(-1)!)).toMatchObject({ user_id: agent.id });
  });
});

describe("session-token revocation", () => {
  it("kills the token when the session's end is reported", async () => {
    const agent = agentWithPat();
    const { body } = await exchange(agent.pat);
    const token = body.token as string;
    registerSession();

    expect((await requestJson("POST", "/api/write", {}, bearer(token))).body)
      .toMatchObject({ identity: { user_id: agent.id } });

    // Exactly the call cli/wrap.sh's orphan watcher makes when the agent exits.
    const ended = await requestJson(
      "PATCH",
      `/api/sessions/${SESSION_ID}/end`,
      { status: "ended" },
    );
    expect(ended.status).toBe(200);

    const afterEnd = await requestJson("POST", "/api/write", {}, bearer(token));
    expect(afterEnd.body).toMatchObject({ ok: true, identity: null });
    // The PAT it replaced is untouched — revocation cannot cascade past one session.
    expect((await requestJson("POST", "/api/write", {}, bearer(agent.pat))).body)
      .toMatchObject({ identity: { user_id: agent.id } });
  });

  it("kills the token when the session stops being active by any other path", async () => {
    const agent = agentWithPat();
    const { body } = await exchange(agent.pat);
    const token = body.token as string;
    registerSession();

    // The reaper marks an abandoned session dead directly, without the route
    // that revokes; the authenticator's liveness read must still refuse.
    registry.updateSession(SESSION_ID, { status: "dead" });

    const response = await requestJson("POST", "/api/write", {}, bearer(token));
    expect(response.body).toMatchObject({ ok: true, identity: null });
  });

  it("expires on the TTL backstop when a session never reports an end", async () => {
    const agent = agentWithPat();
    const { body } = await exchange(agent.pat);
    const token = body.token as string;
    registerSession();

    clock += WRAP_TTL_MS - 1;
    expect((await requestJson("POST", "/api/write", {}, bearer(token))).body)
      .toMatchObject({ identity: { user_id: agent.id } });

    clock += 2;
    expect((await requestJson("POST", "/api/write", {}, bearer(token))).body)
      .toMatchObject({ ok: true, identity: null });
  });

  it("stays usable in the window before the session row exists", async () => {
    // wrap.sh exchanges before it registers; a not-yet-registered session id is
    // not evidence of an ended session.
    const agent = agentWithPat();
    const { body } = await exchange(agent.pat);
    const response = await requestJson("POST", "/api/write", {}, bearer(body.token as string));
    expect(response.body).toMatchObject({ identity: { user_id: agent.id } });
  });

  it("kills a still-unregistered session after the ten-minute grace", async () => {
    const agent = agentWithPat();
    const { body } = await exchange(agent.pat);
    const token = body.token as string;

    clock += PRE_REGISTRATION_GRACE_MS - 1;
    expect((await requestJson("POST", "/api/write", {}, bearer(token))).body)
      .toMatchObject({ identity: { user_id: agent.id } });
    clock += 2;
    expect((await requestJson("POST", "/api/write", {}, bearer(token))).body)
      .toMatchObject({ identity: null });
  });
});

function listen(srv: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      srv.removeListener("error", reject);
      const address = srv.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("test server did not expose a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(srv: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestJson(
  method: string,
  reqPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const data = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data).toString(),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 500, body: raw ? JSON.parse(raw) : null });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
