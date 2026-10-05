import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { migrate, setDb } from "../../src/db.js";
import { resolveSessionClientIdentity, SessionManager } from "../../src/session-manager.js";
import { ClaudeSdkTransport } from "../../src/conversation-control/claude-sdk-transport.js";
import { projectManagedProviderIdentity } from "../../src/backends/mandible-transport.js";
import { addBinding, createUser, setupOperator } from "../../src/users/store.js";

// Managed SDK/Spawn Console backends were retired. Provider transports now
// obtain local credentials through the private socket, rather than minting or
// persisting bearer tokens on Console rows. Test the maintained boundaries.
describe("agent client-auth provisioning", () => {
  let db: InstanceType<typeof SqliteDatabase>;
  beforeEach(() => { db = new SqliteDatabase(":memory:"); migrate(db); setDb(db); });
  afterEach(() => { db.close(); vi.unstubAllEnvs(); });

  it("strips explicit bearer credentials from terminal metadata and rejects managed Console creation", () => {
    const manager = new SessionManager(db, () => {});
    const terminal = manager.create({ label: "Fixture terminal", command: "bash", env: { MANDIBLE_TOKEN: "caller-secret" } });
    expect(terminal.env).not.toHaveProperty("MANDIBLE_TOKEN");
    expect(db.prepare("SELECT env_json FROM console_sessions WHERE id = ?").get(terminal.id))
      .toEqual({ env_json: "{}" });
    expect(manager.isCredentialBearing(terminal.id)).toBe(false);
    for (const backend_type of ["sdk", "spawn"] as const) {
      expect(() => manager.create({ label: "Fixture terminal", command: "claude", backend_type }))
        .toThrow("Managed conversations use ConversationControlService");
    }
    manager.delete(terminal.id);
  });

  it("projects a fresh local alias and only the recorded native ID when resuming", () => {
    const fresh: Record<string, string | undefined> = { CODEX_THREAD_ID: "parent-native", CLAUDE_SESSION_ID: "parent-claude", MANDIBLE_SESSION_ID: "parent-local" };
    projectManagedProviderIdentity(fresh, "codex", null, "child-local");
    expect(fresh).toEqual({ MANDIBLE_MANAGED_APP: "codex", MANDIBLE_SESSION_ID: "child-local" });
    projectManagedProviderIdentity(fresh, "codex", "child-native", "child-local");
    expect(fresh).toEqual({ MANDIBLE_MANAGED_APP: "codex", MANDIBLE_SESSION_ID: "child-local", CODEX_THREAD_ID: "child-native" });
  });

  it.each(["start", "resume-provider-session"] as const)("keeps inherited credentials out of %s SDK and MCP child environments", async (kind) => {
    vi.stubEnv("MANDIBLE_TOKEN", "inherited-secret");
    vi.stubEnv("CODEX_THREAD_ID", "daemon-parent");
    vi.stubEnv("CLAUDE_SESSION_ID", "daemon-parent-claude");
    let options: Options | undefined;
    const common = { conversation_id: "child-conversation", generation: 1, controller_instance_id: "child-controller", cwd: "/tmp" };
    const request = kind === "start" ? { ...common, kind } : { ...common, kind, provider_session_id: "child-native" };
    const transport = new ClaudeSdkTransport(request, {
      startup: async (input) => { options = input.options; throw new Error("fixture startup stopped"); },
    });
    await expect(transport.start()).rejects.toThrow("fixture startup stopped");
    expect(options?.env).not.toHaveProperty("MANDIBLE_TOKEN");
    expect(options?.env).not.toHaveProperty("CODEX_THREAD_ID");
    expect(options?.env).not.toHaveProperty("CLAUDE_SESSION_ID");
    const nativeId = kind === "start" ? options?.sessionId : "child-native";
    expect(nativeId).toBeTruthy();
    expect(options?.env).toMatchObject({ MANDIBLE_MANAGED_CLIENT: "1", MANDIBLE_MANAGED_APP: "claude", CLAUDE_CODE_SESSION_ID: nativeId });
    const mcp = options?.mcpServers?.mandible;
    expect(mcp).toMatchObject({ type: "stdio", env: { MANDIBLE_PROVIDER_SESSION_ID: nativeId, MANDIBLE_SESSION_ID: nativeId } });
    expect(mcp && "env" in mcp ? mcp.env : {}).not.toHaveProperty("MANDIBLE_TOKEN");
  });

  it("resolves only one active app binding and never falls back to the operator", () => {
    setupOperator(db, { display_name: "Operator", email: "operator@example.com" });
    const session = { id: "agent-local", command: "claude", is_operator: false };
    expect(resolveSessionClientIdentity(db, session)).toBeNull();
    const agent = createUser(db, { slug: "claude-agent", kind: "agent", display_name: "Claude Agent" });
    addBinding(db, agent.slug, { binding_type: "app_name", value: "claude" });
    expect(resolveSessionClientIdentity(db, session)).toEqual({ user_id: agent.id, slug: agent.slug });
    // Corrupt legacy ambiguity must remain credential-ineligible.
    db.exec("DROP INDEX uq_user_bindings_active_unscoped; DROP INDEX uq_user_bindings_active_scoped;");
    const other = createUser(db, { slug: "other-agent", kind: "agent", display_name: "Other Agent" });
    addBinding(db, other.slug, { binding_type: "app_name", value: "claude" });
    expect(resolveSessionClientIdentity(db, session)).toBeNull();
  });

  it("requires the canonical operator terminal instead of a caller-selected operator flag", () => {
    const operator = setupOperator(db, { display_name: "Operator", email: "operator@example.com" });
    const manager = new SessionManager(db, () => {});
    expect(() => manager.create({ label: "Fixture terminal", command: "bash", is_operator: true })).toThrow("Operator terminals use startOperator");
    const session = { id: "caller-selected", command: "bash", is_operator: true };
    expect(resolveSessionClientIdentity(db, session)).toBeNull();
    db.prepare("UPDATE settings SET value = ? WHERE key = 'console_operator_session_id'").run("canonical-operator");
    expect(resolveSessionClientIdentity(db, { ...session, id: "canonical-operator" })).toEqual({ user_id: operator.id, slug: operator.slug });
    manager.close();
  });
});
