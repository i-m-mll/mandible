import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientAuthenticator } from "../../src/client-auth/authenticator.js";
import { migrate, setDb } from "../../src/db.js";
import { resolveSessionClientIdentity, SessionManager } from "../../src/session-manager.js";
import {
  addBinding,
  createUser,
  removeBinding,
  setupOperator,
} from "../../src/users/store.js";

describe("agent client-auth provisioning", () => {
  let db: InstanceType<typeof SqliteDatabase>;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    setDb(db);
  });

  afterEach(() => { db.close(); vi.unstubAllEnvs(); });

  function fakeAuthenticator() {
    const issued: Array<{ identity: { user_id: string; slug: string }; purpose: string }> = [];
    const revoked: string[] = [];
    const value = {
      mode: () => "strict" as const,
      authenticate: () => ({ user_id: "test" }),
      issueEphemeralToken: (
        identity: { user_id: string; slug: string },
        purpose: string,
      ) => {
        issued.push({ identity, purpose });
        return `token-for-${identity.slug}`;
      },
      revokeEphemeralToken: (token: string) => revoked.push(token),
    } as unknown as ClientAuthenticator;
    return { value, issued, revoked };
  }

  it("binds explicit HTTP SDK credentials to the unique active app user without persisting raw tokens", () => {
    const agent = createUser(db, {
      slug: "claude-agent",
      kind: "agent",
      display_name: "Claude Agent",
    });
    addBinding(db, agent.id, { binding_type: "app_name", value: "claude" });
    const auth = fakeAuthenticator();
    const manager = new SessionManager(db, () => undefined, undefined, undefined, auth.value);

    const session = manager.create({
      label: "Claude",
      command: "claude",
      backend_type: "sdk",
      env: { MANDIBLE_TOKEN: "caller-supplied-token", MANDIBLE_BASE: "http://127.0.0.1:31337" },
    });
    const backend = manager.get(session.id) as unknown as {
      buildClientEnv(): Record<string, string | undefined>;
    };
    const clientEnv = backend.buildClientEnv();

    expect(auth.issued).toEqual([{
      identity: { user_id: agent.id, slug: agent.slug },
      purpose: `agent_session:${session.id}`,
    }]);
    expect(clientEnv.MANDIBLE_TOKEN).toBe("token-for-claude-agent");
    const stored = db.prepare("SELECT env_json FROM console_sessions WHERE id = ?")
      .get(session.id) as { env_json: string };
    expect(stored.env_json).not.toContain("caller-supplied-token");
    expect(stored.env_json).not.toContain("token-for-claude-agent");

    manager.delete(session.id);
    expect(auth.revoked).toEqual(["token-for-claude-agent"]);
  });

  it("projects no bearer for an ordinary local SDK child", () => {
    const agent = createUser(db, { slug: "claude-agent", kind: "agent", display_name: "Claude Agent" });
    addBinding(db, agent.id, { binding_type: "app_name", value: "claude" });
    const auth = fakeAuthenticator();
    const manager = new SessionManager(db, () => undefined, undefined, undefined, auth.value);
    const session = manager.create({ label: "Claude", command: "claude", backend_type: "sdk",
      env: { MANDIBLE_BASE: "https://app.mandible.localhost:19420", MANDIBLE_TOKEN: "inherited-stale" } });
    const clientEnv = (manager.get(session.id) as unknown as {
      buildClientEnv(): Record<string, string | undefined>;
    }).buildClientEnv();
    expect(clientEnv.MANDIBLE_TOKEN).toBeUndefined();
    expect(clientEnv.MANDIBLE_MANAGED_APP).toBe("claude");
    expect(clientEnv.MANDIBLE_SESSION_ID).toBe(session.id);
    expect(auth.issued).toEqual([]);
  });

  it("uses a distinct local alias for a fresh native child and the recorded provider ID on resume", () => {
    const manager = new SessionManager(db, () => undefined);
    const fresh = manager.create({ label: "Codex", command: "codex", backend_type: "spawn",
      env: { CODEX_THREAD_ID: "parent-task", MANDIBLE_SESSION_ID: "parent-session" } });
    const build = (id: string) => (manager.get(id) as unknown as {
      buildCleanEnv(env: Record<string, string>): Record<string, string>;
    }).buildCleanEnv({ MANDIBLE_BASE: "https://app.mandible.localhost:19420" });
    const freshEnv = build(fresh.id);
    expect(freshEnv.CODEX_THREAD_ID).toBeUndefined();
    expect(freshEnv.MANDIBLE_MANAGED_APP).toBe("codex");
    expect(freshEnv.MANDIBLE_SESSION_ID).toBe(fresh.id);

    const providerId = "12345678-1234-4234-8234-123456789abc";
    const resumed = manager.create({ label: "Resumed", command: "codex", backend_type: "spawn",
      provider_session_id: providerId });
    const resumedEnv = build(resumed.id);
    expect(resumedEnv.CODEX_THREAD_ID).toBe(providerId);
    expect(resumedEnv.MANDIBLE_SESSION_ID).toBe(resumed.id);
  });

  it("never falls back to the operator when an agent binding is missing", () => {
    setupOperator(db, { slug: "operator", display_name: "Operator" });
    const auth = fakeAuthenticator();
    const logger = vi.fn();
    const manager = new SessionManager(db, logger, undefined, undefined, auth.value);

    const missing = manager.create({ label: "Shell", command: "bash", backend_type: "spawn" });
    (manager.get(missing.id) as unknown as {
      buildCleanEnv(env: Record<string, string>): Record<string, string>;
    }).buildCleanEnv({ MANDIBLE_BASE: "http://127.0.0.1:31337" });

    expect(auth.issued).toEqual([]);
    expect(logger).toHaveBeenCalledWith(
      "warn",
      "client_auth_agent_identity_unresolved",
      expect.objectContaining({ session_id: missing.id, command: "bash" }),
    );
  });

  it("pins unbound and ambiguous sessions as permanently credential-ineligible", () => {
    const first = createUser(db, {
      slug: "first-binding",
      kind: "agent",
      display_name: "First Binding",
    });
    const second = createUser(db, {
      slug: "second-binding",
      kind: "agent",
      display_name: "Second Binding",
    });
    const auth = fakeAuthenticator();
    const manager = new SessionManager(db, () => undefined, undefined, undefined, auth.value);

    const unbound = manager.create({
      label: "Initially unbound",
      command: "late-bound",
      backend_type: "spawn",
    });
    expect(manager.isCredentialBearing(unbound.id)).toBe(false);
    addBinding(db, first.id, { binding_type: "app_name", value: "late-bound" });
    expect(manager.isCredentialBearing(unbound.id)).toBe(false);
    (manager.get(unbound.id) as unknown as {
      buildCleanEnv(env: Record<string, string>): Record<string, string>;
    }).buildCleanEnv({ MANDIBLE_BASE: "http://127.0.0.1:31337" });

    // Model a legacy/corrupt database that predates active-binding uniqueness;
    // the runtime resolver deliberately remains fail-closed for this state.
    db.exec(
      "DROP INDEX uq_user_bindings_active_scoped; " +
      "DROP INDEX uq_user_bindings_active_unscoped;",
    );
    const firstAmbiguous = addBinding(db, first.id, {
      binding_type: "app_name",
      value: "ambiguous-app",
    });
    addBinding(db, second.id, { binding_type: "app_name", value: "ambiguous-app" });
    const ambiguous = manager.create({
      label: "Initially ambiguous",
      command: "ambiguous-app",
      backend_type: "spawn",
    });
    expect(manager.isCredentialBearing(ambiguous.id)).toBe(false);
    removeBinding(db, firstAmbiguous.id);
    expect(manager.isCredentialBearing(ambiguous.id)).toBe(false);
    (manager.get(ambiguous.id) as unknown as {
      buildCleanEnv(env: Record<string, string>): Record<string, string>;
    }).buildCleanEnv({ MANDIBLE_BASE: "http://127.0.0.1:31337" });

    expect(auth.issued).toEqual([]);
  });

  it("pins a credential-bearing session to its original identity across rebinding", () => {
    const original = createUser(db, {
      slug: "original-owner",
      kind: "agent",
      display_name: "Original Owner",
    });
    const replacement = createUser(db, {
      slug: "replacement-owner",
      kind: "agent",
      display_name: "Replacement Owner",
    });
    const binding = addBinding(db, original.id, {
      binding_type: "app_name",
      value: "rebound-app",
    });
    const auth = fakeAuthenticator();
    const manager = new SessionManager(db, () => undefined, undefined, undefined, auth.value);
    const session = manager.create({
      label: "Pinned owner",
      command: "rebound-app",
      backend_type: "spawn",
    });
    expect(manager.isCredentialBearing(session.id)).toBe(true);

    removeBinding(db, binding.id);
    addBinding(db, replacement.id, { binding_type: "app_name", value: "rebound-app" });
    expect(manager.isCredentialBearing(session.id)).toBe(true);
    (manager.get(session.id) as unknown as {
      buildCleanEnv(env: Record<string, string>): Record<string, string>;
    }).buildCleanEnv({ MANDIBLE_BASE: "http://127.0.0.1:31337" });

    expect(auth.issued).toEqual([{
      identity: { user_id: original.id, slug: original.slug },
      purpose: `agent_session:${session.id}`,
    }]);
  });

  it("binds the operator console only to the configured operator", () => {
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const auth = fakeAuthenticator();
    const manager = new SessionManager(db, () => undefined, undefined, undefined, auth.value);

    expect(() => manager.create({
      label: "Fake Operator",
      command: "bash",
      is_operator: true,
    })).toThrow("Operator sessions may only be created");

    expect(resolveSessionClientIdentity(db, {
      id: "legacy-caller-selected-operator",
      command: "bash",
      is_operator: true,
    })).toBeNull();

    manager.startOperator();
    const session = manager.getAll().find((backend) => backend.meta.is_operator)?.meta;
    expect(session).toBeDefined();
    vi.stubEnv("MANDIBLE_BASE", "http://127.0.0.1:31337");
    (manager.get(session!.id) as unknown as {
      buildClientEnv(): Record<string, string | undefined>;
    }).buildClientEnv();

    expect(auth.issued[0]).toEqual({
      identity: { user_id: operator.id, slug: operator.slug },
      purpose: `agent_session:${session!.id}`,
    });
    expect(resolveSessionClientIdentity(db, session!)).toEqual({
      user_id: operator.id,
      slug: operator.slug,
    });
  });
});
