import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { attributionForRequest, authorizeOperatorSetup, isLocalHumanRequest, requireDurableIdentity, requireOperator,
  requireProtectedOperator } from "../src/client-auth/authz.js";
import { migrate, type Db } from "../src/db.js";
import type { RequestLike, ResolvedClientIdentity } from "../src/server.js";
import { addBinding, createUser, setupOperator } from "../src/users/store.js";

let db: Db;
beforeEach(() => { db = new SqliteDatabase(":memory:"); migrate(db); });
afterEach(() => db.close());

function socketRequest(user: { id: string; slug: string }, managed = false): RequestLike {
  return {
    method: "POST", url: "/api/issues", params: {}, query: {}, body: {},
    client_identity: {
      user_id: user.id, slug: user.slug, method: "local_socket", source: "local_socket",
      credential_id: null, effect_ceiling: [],
    } as ResolvedClientIdentity,
    managed_client: managed,
  } as RequestLike;
}

it("grants local human operator access while withholding durable authority", () => {
  const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
  const req = socketRequest(operator);
  expect(isLocalHumanRequest(req)).toBe(true);
  expect(requireOperator(db, req).user_id).toBe(operator.id);
  expect(attributionForRequest(db, req)).toEqual({ user_id: operator.id, evidence_method: "local_default" });
  expect(() => requireDurableIdentity(req)).toThrow();
  expect(() => requireProtectedOperator(db, req)).toThrow();
});

it("does not turn a managed local claim into operator authority", () => {
  const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
  const agent = createUser(db, { slug: "codex", kind: "agent", display_name: "Codex" });
  addBinding(db, agent.id, { binding_type: "provider_session_env", value: "CODEX_THREAD_ID" });
  const missing = socketRequest(operator, true);
  expect(isLocalHumanRequest(missing)).toBe(false);
  expect(() => requireOperator(db, missing)).toThrow();
  expect(attributionForRequest(db, missing)).toBeNull();
  const req = socketRequest(agent, true);
  req.ambient_identity = { provider: "codex", provider_session_id: "thread-1" };
  expect(() => requireOperator(db, req)).toThrow();
  expect(attributionForRequest(db, req)).toEqual({ user_id: agent.id, evidence_method: "session_claim" });
});

it("attributes a validated managed app/session alias before a provider task exists", () => {
  const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
  const agent = createUser(db, { slug: "codex", kind: "agent", display_name: "Codex" });
  const req = socketRequest(agent, true) as RequestLike & {
    local_managed_identity: { app_name: string; session_id: string };
  };
  req.local_managed_identity = { app_name: "codex", session_id: "managed-session-1" };
  expect(isLocalHumanRequest(req)).toBe(false);
  expect(attributionForRequest(db, req)).toEqual({ user_id: agent.id, evidence_method: "session_claim" });
  expect(() => requireOperator(db, req)).toThrow();

  const mislabeledOperator = socketRequest(operator) as typeof req;
  mislabeledOperator.local_managed_identity = req.local_managed_identity;
  expect(isLocalHumanRequest(mislabeledOperator)).toBe(false);
  expect(attributionForRequest(db, mislabeledOperator)).toBeNull();
  expect(() => authorizeOperatorSetup(db, mislabeledOperator)).toThrow();
});

it("allows first-run human setup and requires durable evidence thereafter", () => {
  const initial = socketRequest({ id: "", slug: "" });
  initial.client_identity = null;
  expect(() => authorizeOperatorSetup(db, initial)).not.toThrow();
  expect(() => authorizeOperatorSetup(db, { ...initial, managed_client: true } as RequestLike)).toThrow();
  const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
  expect(() => authorizeOperatorSetup(db, socketRequest(operator))).toThrow();
  const durable = socketRequest(operator);
  durable.client_identity = { ...durable.client_identity!, method: "api_token", source: "http_bearer",
    credential_id: "verified-credential" };
  expect(() => authorizeOperatorSetup(db, durable)).not.toThrow();
});
