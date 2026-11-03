import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exactAgentRef, parseExactAgentRef, resolveAmbientProviderIdentity, normalizeAmbientProviderIdentity } from "../src/ambient-provider-identity.js";
import { runCli } from "./helpers/cli-process.js";
import { mergeMandibleClaudeHookSettings } from "../src/claude-hook-settings.js";
import { currentRequestOrigin, requestOriginForRequest, withRequestOrigin } from "../src/request-origin.js";
import { withChannelExecutionContext, ambientHeaders } from "../channel-server/transport.js";
const run = promisify(execFile);

describe("exact execution ingress", () => {
  it("keeps opaque scoped Claude identities distinct and canonical", () => {
    const context = { provider: "claude", session_id: "session:a/%'", agent_id: "child:b/%'" };
    const ref = exactAgentRef(context)!;
    expect(parseExactAgentRef(ref)).toEqual(context);
    expect(parseExactAgentRef(ref.replace("%3A", "%3a"))).toBeNull();
    expect(exactAgentRef({ ...context, session_id: "another" })).not.toBe(ref);
    expect(resolveAmbientProviderIdentity({ CLAUDE_CODE_SESSION_ID: "root" })).toEqual({ provider: "claude", session_id: "root", agent_id: null });
    expect(resolveAmbientProviderIdentity({ CODEX_THREAD_ID: "child", CODEX_SESSION_ID: "enclosing" })).toEqual({ provider: "codex", agent_id: "child", session_id: "enclosing" });
    expect(exactAgentRef(resolveAmbientProviderIdentity({ CODEX_SESSION_ID: "enclosing" }))).toBeNull();
    expect(normalizeAmbientProviderIdentity({ provider: "claude", provider_session_id: "old" })).toEqual({ provider: "claude", agent_id: null, session_id: "old" });
  });

  it("executes installed hook projections concurrently and resets root identity without changing tool fields or permissions", async () => {
    const settings = mergeMandibleClaudeHookSettings({}, "external") as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const hook = settings.hooks.PreToolUse[0].hooks[0].command;
    const bash = async (agent_id?: string) => {
      const input = { session_id: "enclosing", ...(agent_id ? { agent_id } : {}), tool_name: "Bash", tool_input: { command: `source '${path.resolve("cli/api.sh")}' --mandible-api-definitions-only; api_current_agent_ref; printf '%s' "$CLAUDE_CODE_SESSION_ID"`, timeout: 123, description: "original" } };
      const emitted = await runCli(["-c", hook], { command: "/bin/bash", input: JSON.stringify(input) });
      expect(emitted.status, emitted.stderr).toBe(0);
      const projection = JSON.parse(emitted.stdout) as { hookSpecificOutput: { updatedInput: { command: string; timeout: number; description: string } } };
      expect(projection.hookSpecificOutput).not.toHaveProperty("permissionDecision");
      expect(projection.hookSpecificOutput.updatedInput).toMatchObject({ timeout: 123, description: "original" });
      return run("/bin/bash", ["-c", projection.hookSpecificOutput.updatedInput.command], { timeout: 10_000, env: { ...process.env, CLAUDE_AGENT_ID: "stale", MANDIBLE_REQUEST_ORIGIN: '{"provider":"codex","agent_id":"stale","session_id":null}' } });
    };
    const results = await Promise.all([bash("child-a"), bash("child-b"), bash()]);
    expect(results.map(result => result.stdout)).toEqual(["agent:claude:enclosing:child-a\nenclosing", "agent:claude:enclosing:child-b\nenclosing", "agent:claude:enclosing:enclosing\nenclosing"]);
  });

  it("does not mark an ordinary local shell as an agent and retains malformed managed evidence", async () => {
    const env = { ...process.env };
    for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_AGENT_ID", "GEMINI_SESSION_ID", "MANDIBLE_SESSION_ID", "MANDIBLE_MANAGED_CLIENT", "MANDIBLE_EXECUTION_CONTEXT", "MANDIBLE_MANAGED_APP", "MANDIBLE_REQUEST_ORIGIN"]) delete env[key];
    const shell = `source '${path.resolve("cli/api.sh")}' --mandible-api-definitions-only; api_curl_ambient_headers`;
    expect((await run("/bin/bash", ["-c", shell], { timeout: 10_000, env })).stdout).toBe("");
    const invalid = await run("/bin/bash", ["-c", shell], { timeout: 10_000, env: { ...env, MANDIBLE_EXECUTION_CONTEXT: "malformed" } });
    expect(invalid.stdout).toContain("X-Mandible-Managed-Client: 1");
    expect(invalid.stdout).not.toContain("X-Mandible-Execution-Context:");
  });

  it("isolates channel calls and deferred origins while retaining session-only managed evidence", async () => {
    const a = { provider: "claude", agent_id: "a", session_id: "root" }, b = { ...a, agent_id: "b" };
    const results = await Promise.all([a, b].map(context => withChannelExecutionContext(context, async () => {
      await Promise.resolve();
      return JSON.parse(ambientHeaders()["X-Mandible-Execution-Context"]);
    })));
    expect(results).toEqual([a, b]);
    expect(requestOriginForRequest({ ambient_identity: a, local_managed_identity: { app_name: "claude", session_id: "wrapper" } }, () => ({ status: "resolved", origin: { ...a, agent_id: null } }))).toEqual(a);
    const saved = await withRequestOrigin(a, async () => { await Promise.resolve(); return JSON.stringify(currentRequestOrigin()); });
    expect(currentRequestOrigin()).toBeNull();
    expect(withRequestOrigin(JSON.parse(saved), currentRequestOrigin)).toEqual(a);
  });
});
