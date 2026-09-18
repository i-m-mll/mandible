// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { registerClientAuthRoutes } from "../src/routes/client-auth.js";
import { Router } from "../src/server.js";
import { createUser, setupOperator } from "../src/users/store.js";

let root = ""; let db: Db; let auth: ClientAuthenticator; let router: Router;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-whoami-"));
  db = openDb(path.join(root, "mandible.db")); setDb(db);
  auth = new ClientAuthenticator(db, { secretsDir: path.join(root, "client-auth") });
  router = new Router({ clientAuth: auth }); registerClientAuthRoutes(router, auth);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const whoami = (credential?: string | null) => router.invoke({ method: "GET", url: "/api/client-auth/whoami", credential: credential ?? null, transport: "http" });

describe("GET /api/client-auth/whoami", () => {
  it("reports an unauthenticated caller without compatibility state", async () => {
    expect((await whoami()).body).toEqual({
      authenticated: false, user: null, evidence_method: null, source: null,
      ephemeral_purpose: null, credential: null, audience: auth.authorityId(), failure_reason: "unknown",
    });
  });

  it("names the exact user and durable credential", async () => {
    const user = createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" });
    const issued = auth.mintApiToken(user.id, { label: "agent-token" });
    expect((await whoami(issued.token)).body).toMatchObject({
      authenticated: true, user: { id: user.id, slug: user.slug, kind: "agent" },
      evidence_method: "api_token", source: "http_bearer",
      credential: { id: issued.credential.id, label: "agent-token", status: "active" },
    });
  });

  it("does not confuse an operator credential with an agent", async () => {
    const operator = setupOperator(db, { display_name: "Operator", email: "op@example.com" });
    const issued = auth.mintApiToken(operator.id, { label: "operator-token" });
    expect((await whoami(issued.token)).body).toMatchObject({
      authenticated: true, user: { id: operator.id, kind: "human" }, credential: { label: "operator-token" },
    });
  });

  it("rejects unknown credentials", async () => {
    setupOperator(db, { display_name: "Operator", email: "op@example.com" });
    expect((await whoami("unknown")).body).toMatchObject({ authenticated: false });
  });
});
