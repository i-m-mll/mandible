import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { exactAgentRef, parseExactAgentRef, resolveAmbientProviderIdentity, normalizeAmbientProviderIdentity } from "../src/ambient-provider-identity.js";
import { startStubDaemon, scratchDir, runCli } from "./helpers/cli-process.js";
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
    expect(invalid.stdout).toContain("X-Mandible-Execution-Context: null");
    expect(invalid.stdout).not.toContain("X-Mandible-Ambient-Provider:");
    const enclosingOnly = await runCli(['identity', 'exec', '--', '/bin/bash', '-c', shell], {
      env: { ...env, MANDIBLE_EXECUTION_CONTEXT: 'malformed', CODEX_SESSION_ID: 'enclosing-only' }, inheritEnv: false,
    });
    expect(enclosingOnly.status, enclosingOnly.stderr).toBe(0);
    expect(enclosingOnly.stdout).toContain('X-Mandible-Execution-Context: null');
    expect(enclosingOnly.stdout).not.toContain('X-Mandible-Ambient-Provider:');
  });

  it("replaces inherited lifecycle identity with the actual root or child hook payload", async () => {
    const root = scratchDir('nested-hook');
    const daemon = await startStubDaemon(() => ({ body: {} }));
    try {
      for (const hook of ['session-start', 'subagent-start', 'subagent-stop', 'session-end']) {
        daemon.requests.length = 0;
        const agent_id = hook.startsWith('subagent') ? 'new-child' : 'new-session';
        const result = await runCli(['hook', hook], { input: JSON.stringify({ session_id: 'new-session', ...(hook.startsWith('subagent') ? { agent_id } : {}), cwd: root }),
          env: { ...daemon.env, MANDIBLE_TOKEN: 'fixture', MANDIBLE_NO_KEYCHAIN_TOKEN: '1', MANDIBLE_SESSION_ID: undefined,
            CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined, GEMINI_SESSION_ID: undefined, CLAUDE_SESSION_ID: undefined,
            CLAUDE_CODE_SESSION_ID: 'old-session', CLAUDE_AGENT_ID: 'old-child', CLAUDE_PID: String(process.pid),
            CLAUDE_ENV_FILE: path.join(root, 'env'), MANDIBLE_EXECUTION_CONTEXT: JSON.stringify({ provider: 'claude', session_id: 'old-session', agent_id: 'old-child' }) } });
        expect(result.status, result.stderr).toBe(0);
        const writes = daemon.requests.filter(request => request.method !== 'GET');
        expect(writes.length).toBeGreaterThan(0);
        for (const request of writes) expect(JSON.parse(String(request.headers['x-mandible-execution-context'])))
          .toEqual({ provider: 'claude', session_id: 'new-session', agent_id });
      }
    } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("scopes actual CLI projection when enclosing sessions or the nearest provider change", async () => {
    const root = scratchDir('nested-provider');
    const env = { CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined, GEMINI_SESSION_ID: undefined,
      CLAUDE_SESSION_ID: undefined, MANDIBLE_SESSION_ID: undefined, CLAUDE_CODE_SESSION_ID: 'same-session', CLAUDE_AGENT_ID: 'child',
      MANDIBLE_EXECUTION_CONTEXT: JSON.stringify({ provider: 'claude', session_id: 'same-session', agent_id: 'child' }) };
    const output = 'printf "%s|%s" "$MANDIBLE_EXECUTION_CONTEXT" "${CLAUDE_AGENT_ID:-}"';
    try {
      const same = await runCli(['identity', 'exec', '--', '/bin/sh', '-c', output], { env });
      expect(same.status, same.stderr).toBe(0);
      expect(same.stdout).toBe(JSON.stringify({ provider: 'claude', agent_id: 'child', session_id: 'same-session' }) + '|child');
      const changed = await runCli(['identity', 'exec', '--', '/bin/sh', '-c', output], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'new-session' } });
      expect(changed.status, changed.stderr).toBe(0);
      expect(changed.stdout).toBe(JSON.stringify({ provider: 'claude', agent_id: null, session_id: 'new-session' }) + '|');
      const codex = path.join(root, 'codex'); fs.symlinkSync('/bin/bash', codex);
      const nested = await runCli(['-c', '"$1" identity exec -- /bin/sh -c "$2"; :', 'nested', path.resolve('bin/mandible'), output],
        { command: codex, env: { ...env, CODEX_THREAD_ID: 'new-thread', CLAUDE_PID: undefined } });
      expect(nested.status, nested.stderr).toBe(0);
      expect(nested.stdout).toBe(JSON.stringify({ provider: 'codex', agent_id: 'new-thread', session_id: null }) + '|');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves native Codex child and partial evidence without promoting wrapper bindings to executors", () => {
    const managed = { app_name: 'codex', session_id: 'wrapper' };
    const wrapperOrigin = { provider: 'codex', agent_id: null, session_id: 'root-thread' };
    const resolve = () => ({ status: 'resolved' as const, origin: wrapperOrigin });
    for (const ambient_identity of [
      { provider: 'codex', agent_id: 'child-thread', session_id: 'root-thread' },
      { provider: 'codex', agent_id: null, session_id: 'root-thread' },
      { provider: 'codex', agent_id: 'root-thread', session_id: null },
    ]) expect(requestOriginForRequest({ ambient_identity, local_managed_identity: managed }, resolve)).toEqual(ambient_identity);
    expect(requestOriginForRequest({ local_managed_identity: managed }, () => ({ status: 'unknown' }))).toBeNull();
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
