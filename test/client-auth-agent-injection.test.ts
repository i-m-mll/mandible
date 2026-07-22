import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { migrate, setDb } from "../src/db.js";
import { resolveSessionClientIdentity, SessionManager } from "../src/session-manager.js";
import { addBinding, createUser, setupOperator } from "../src/users/store.js";

describe("agent client-auth provisioning", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    setDb(db);
  });

  afterEach(() => db.close());

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

  it("binds SDK and MCP child credentials to the unique active app user without persisting raw tokens", () => {
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
      env: { MANDIBLE_TOKEN: "caller-supplied-token" },
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

  it("never falls back to the operator when an agent binding is missing or ambiguous", () => {
    setupOperator(db, { slug: "operator", display_name: "Operator" });
    const first = createUser(db, { slug: "agent-one", kind: "agent", display_name: "Agent One" });
    const second = createUser(db, { slug: "agent-two", kind: "agent", display_name: "Agent Two" });
    addBinding(db, first.id, { binding_type: "app_name", value: "codex" });
    addBinding(db, second.id, { binding_type: "app_name", value: "codex" });
    const auth = fakeAuthenticator();
    const logger = vi.fn();
    const manager = new SessionManager(db, logger, undefined, undefined, auth.value);

    const missing = manager.create({ label: "Shell", command: "bash", backend_type: "spawn" });
    const ambiguous = manager.create({ label: "Codex", command: "codex", backend_type: "spawn" });
    const buildEnv = (id: string) => (manager.get(id) as unknown as {
      buildCleanEnv(env: Record<string, string>): Record<string, string>;
    }).buildCleanEnv({});
    buildEnv(missing.id);
    buildEnv(ambiguous.id);

    expect(auth.issued).toEqual([]);
    expect(logger).toHaveBeenCalledWith(
      "warn",
      "client_auth_agent_identity_unresolved",
      expect.objectContaining({ session_id: missing.id, command: "bash" }),
    );
    expect(logger).toHaveBeenCalledWith(
      "warn",
      "client_auth_agent_identity_unresolved",
      expect.objectContaining({ session_id: ambiguous.id, command: "codex" }),
    );
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
