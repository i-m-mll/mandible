import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { SessionExecutionStore } from "../src/session-execution.js";
// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractSettingsPath,
  getUserClaudeIntegrationStatus,
  injectMandibleClaudeHookSettingsArgs,
  installUserClaudeIntegration,
  mergeMandibleClaudeHookSettings,
  stripSettingsArgs,
  uninstallUserClaudeIntegration,
} from "../src/claude-hook-settings.js";
import {
  getHookNotificationAttention,
  resetHookNotificationAttentionForTests,
} from "../src/claude-hook-attention.js";
import { setDb, type Db } from "../src/db.js";
import { scratchDir } from "./helpers/cli-process.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { registerHookRoutes } from "../src/routes/hooks.js";
import { Router, createServer, createLocalSocketServer } from "../src/server.js";
import { SseManager, setSseManager } from "../src/sse.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";

let db: Db;
let router: Router;
let tempDir = "";

beforeEach(() => {
  tempDir = scratchDir("h");
  db = migratedMemoryDb();
  setDb(db);
  resetHookNotificationAttentionForTests();
  router = new Router();
  registerHookRoutes(router);
});

afterEach(() => {
  setSseManager(null);
  vi.useRealTimers();
  db.close();
  resetHookNotificationAttentionForTests();
});

describe("execution observation boundaries", () => {
  it("maps only supported native events and protects parent and managed identities", async () => {
    const events = new SseManager();
    const emitted = vi.spyOn(events, "broadcast");
    setSseManager(events);
    const post = (body: Record<string, unknown>) => router.invoke({ method: "POST", url: "/api/hooks/session-execution", body });
    const base = { provider: "claude", session_id: "native-1", hook_event_name: "StopFailure", error: "cloud_credential_error", error_details: "native details" };
    expect((await post(base)).body).toMatchObject({ status: "applied", observation: { state: { kind: "failure", error: { type: "cloud_credential_error" } } } });
    expect((await post({ ...base, hook_event_name: "SessionStart", source: "compact" })).body).toMatchObject({ status: "applied", observation: { event: "SessionStart", state: { kind: "failure" } } });
    expect((await post({ ...base, agent_id: "subagent", hook_event_name: "Stop" })).body).toMatchObject({ status: "unchanged" });
    for (const bad of [{ ...base, error: null }, { ...base, provider: "codex" }, { ...base, hook_event_name: "Interrupt" }, { ...base, hook_event_name: "SubagentStop" }]) {
      expect((await post(bad)).status).toBe(400);
    }
    db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, block_count, session_id, created_at, updated_at)
      VALUES ('managed-conversation', 'claude_code', '/tmp/native-1', 'hash', 1, 'Managed', '2026-01-01', 0, 'native-1', '2026-01-01', '2026-01-01')`).run();
    db.prepare(`INSERT INTO conversation_control_state (conversation_id, provider, provider_session_id, generation, owner_kind, controller_state,
      controller_instance_id, adapter_id, last_authoritative_signal, turn_state, updated_at)
      VALUES ('managed-conversation', 'claude_code', 'native-1', 2, 'mandible', 'ready', 'controller-2', 'adapter', 1, 'none', 1)`).run();
    const store = new SessionExecutionStore(db);
    const managed = { provider: "claude" as const, provider_session_id: "native-1", source: "claude_sdk_hook" as const,
      controller_instance_id: "controller-2", controller_generation: 2, state: { kind: "working" as const }, event: "UserPromptSubmit", turn_id: null };
    expect(store.apply(managed).status).toBe("applied");
    expect(store.apply(managed).status).toBe("unchanged");
    expect(emitted.mock.calls.map(([event]) => event.type)).toEqual(["session:execution-updated", "session:execution-updated", "session:execution-updated"]);
    expect(emitted.mock.calls.at(-1)?.[0].data).toMatchObject({ provider: "claude", provider_session_id: "native-1", observation: { source: "claude_sdk_hook", controller_generation: 2 } });
    const authoritative = store.read("claude", "native-1");
    expect((await post(base)).body).toEqual({ status: "handled_by_managed_observer", observation: authoritative });
    expect(store.apply({ ...managed, controller_generation: 1, state: { kind: "stopped" } })).toEqual({ status: "stale_controller", observation: authoritative });
    expect(store.apply({ ...managed, controller_instance_id: "old-controller" }).status).toBe("stale_controller");
    expect(store.apply({ ...managed, provider_session_id: "different-native-id" }).status).toBe("stale_controller");
    expect((await router.invoke({ method: "GET", url: "/api/hooks/session-execution?provider=claude&session_id=native-1" })).body).toEqual({ observation: authoritative });
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it.each(["claude", "codex"])("delivers %s payload identity through the silent shell observer", async (provider) => {
    const socket = path.join(tempDir, "s");
    const options: Parameters<typeof createServer>[0] = { db, sse: new SseManager(), logger: () => undefined, version: "test", router,
      getStartupInfo: () => null, instance: { role: "main", instance_id: "observer-test", installation_id: "test-installation",
        public_origin: "http://localhost", backend_generation: "observer-1", allowed_effects: PRODUCTION_EFFECTS,
        writable_roots: [tempDir], preview_root: null, user_preferences_root: tempDir, db_path: path.join(tempDir, "db"),
        db_path_source: "test", source_db_path: null, source_db_path_source: null } };
    router = new Router({ instance: options.instance });
    registerHookRoutes(router);
    options.router = router;
    createServer(options).close();
    const server = createLocalSocketServer(options);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const stdout = await runScriptWithInput("bash", [path.resolve("hooks/session-execution.sh"), provider], JSON.stringify({
        session_id: "payload-native", hook_event_name: "UserPromptSubmit", prompt: "private prompt", transcript_path: "private path",
      }), { env: { ...process.env, MANDIBLE_BASE: "", MANDIBLE_SOCKET: socket, MANDIBLE_SESSION_ID: "unrelated-parent",
        MANDIBLE_EXECUTION_OBSERVER_ID: "inherited-controller", MANDIBLE_EXECUTION_OBSERVER_SESSION_ID: "unrelated-parent" } });
      expect(stdout).toBe("");
      expect(new SessionExecutionStore(db).read(provider as "claude" | "codex", "payload-native")?.event).toBe("UserPromptSubmit");
      const store = new SessionExecutionStore(db);
      expect(store.read(provider as "claude" | "codex", "payload-native")?.state).toEqual({ kind: "working" });
      expect(store.read(provider as "claude" | "codex", "unrelated-parent")).toBeNull();
      const spool = path.join(tempDir, "rpc");
      const transport = new FileRpcTransport({ router, dir: spool, pollIntervalMs: 10 });
      transport.start();
      try {
        expect(await runScriptWithInput("bash", [path.resolve("hooks/session-execution.sh"), provider], JSON.stringify({
          session_id: "file-native", hook_event_name: "Stop", last_assistant_message: "private normal message",
        }), { env: { ...process.env, MANDIBLE_BASE: `file://${spool}`, MANDIBLE_SESSION_ID: "unrelated-parent" } })).toBe("");
        expect((await router.invoke({ method: "GET", transport: "file-rpc",
          url: `/api/hooks/session-execution?provider=${provider}&session_id=file-native` })).body)
          .toMatchObject({ observation: { state: { kind: "stopped" } } });
      } finally { transport.stop(); }

      expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Claude hook routes", () => {
  it("ingests one transcript path immediately and rate-limits a burst nudge", async () => {
    const transcriptPath = writeClaudeTranscript("claude-session-1");
    // One instant for both nudges: the burst is defined by the clock, not by how long ingestion takes.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });

    const first = await router.invoke({
      method: "POST",
      url: "/api/hooks/ingest-nudge",
      body: { sessionRef: "claude-session-1", transcriptPath },
    });

    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      ok: true,
      status: "ingested",
      transcript_path: transcriptPath,
      session_ref: "claude-session-1",
    });
    expect(
      db.prepare("SELECT session_id, source_path FROM conversations WHERE source_path = ?").get(transcriptPath),
    ).toEqual({ session_id: "claude-session-1", source_path: transcriptPath });

    const second = await router.invoke({
      method: "POST",
      url: "/api/hooks/ingest-nudge",
      body: { sessionRef: "claude-session-1", transcriptPath },
    });

    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ ok: true, status: "rate_limited" });
  });

  it("raises notification attention for a known provider session and skips unknown ones without failing", async () => {
    const unknown = await router.invoke({
      method: "POST",
      url: "/api/hooks/notification",
      body: { sessionRef: "missing-claude-session", message: "Permission needed" },
    });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toMatchObject({ ok: true, attention: { ok: true, status: "unknown_session", session_id: null } });

    db.prepare(`
      INSERT INTO console_sessions (
        id, label, command, args_json, provider_session_id, cwd, env_json,
        cols, rows, status, auto_restart, is_operator, interaction_mode,
        created_at, updated_at, backend_type, channel_enabled
      ) VALUES (
        'console-1', 'Claude', 'claude', '[]', 'claude-provider-1', ?, '{}',
        120, 30, 'running', 0, 0, 'both',
        1, 1, 'pty', 0
      )
    `).run(tempDir);

    const response = await router.invoke({
      method: "POST",
      url: "/api/hooks/notification",
      body: { sessionRef: "claude-provider-1", message: "Permission needed" },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      attention: {
        ok: true,
        status: "raised",
        session_id: "console-1",
      },
    });
    expect(getHookNotificationAttention("console-1")).toMatchObject({
      kind: "hook_notification",
      message: "Permission needed",
      provider_session_id: "claude-provider-1",
    });
  });

  it("persists latest statusline telemetry and nudges transcript ingestion", async () => {
    const transcriptPath = writeClaudeTranscript("claude-provider-telemetry");
    db.prepare(`
      INSERT INTO console_sessions (
        id, label, command, args_json, provider_session_id, cwd, env_json,
        cols, rows, status, auto_restart, is_operator, interaction_mode,
        created_at, updated_at, backend_type, channel_enabled
      ) VALUES (
        'console-telemetry', 'Claude', 'claude', '[]', 'claude-provider-telemetry', ?, '{}',
        120, 30, 'running', 0, 0, 'both',
        1, 1, 'pty', 0
      )
    `).run(tempDir);

    const response = await router.invoke({
      method: "POST",
      url: "/api/hooks/statusline",
      body: {
        session_id: "claude-provider-telemetry",
        transcript_path: transcriptPath,
        model: { id: "claude-sonnet-4-5", display_name: "Sonnet 4.5" },
        context_window: {
          total_input_tokens: 72_000,
          total_output_tokens: 8_000,
          used_percentage: 37.5,
          context_window_size: 200000,
          current_usage: {
            input_tokens: 1000,
            output_tokens: 250,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 400,
          },
        },
        rate_limits: {
          five_hour: { used_percentage: 12, resets_at: "2026-07-02T18:00:00Z" },
        },
      },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      telemetry: {
        telemetry_key: "console:console-telemetry",
        console_session_id: "console-telemetry",
        provider_session_id: "claude-provider-telemetry",
        model: "Sonnet 4.5",
        context_window: {
          total_input_tokens: 72_000,
          total_output_tokens: 8_000,
          used_percentage: 37.5,
          context_window_size: 200000,
          current_usage: {
            input_tokens: 1000,
            output_tokens: 250,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 400,
          },
        },
      },
      ingest: {
        ok: true,
        transcript_path: transcriptPath,
      },
    });
    expect(db.prepare(`
      SELECT console_session_id, provider_session_id, model, context_used_percentage,
             context_input_tokens, context_output_tokens,
             context_cache_creation_input_tokens, context_cache_read_input_tokens,
             rate_limit_five_hour_used_percentage, rate_limit_seven_day_used_percentage
      FROM console_session_telemetry
      WHERE telemetry_key = 'console:console-telemetry'
    `).get()).toEqual({
      console_session_id: "console-telemetry",
      provider_session_id: "claude-provider-telemetry",
      model: "Sonnet 4.5",
      context_used_percentage: 37.5,
      context_input_tokens: 72_000,
      context_output_tokens: 8_000,
      context_cache_creation_input_tokens: 300,
      context_cache_read_input_tokens: 400,
      rate_limit_five_hour_used_percentage: 12,
      rate_limit_seven_day_used_percentage: null,
    });

    const roundTrip = await router.invoke({
      method: "GET",
      url: "/api/hooks/statusline?sessionRef=claude-provider-telemetry",
    });
    expect(roundTrip.body).toMatchObject({
      telemetry: {
        context_window: {
          total_input_tokens: 72_000,
          total_output_tokens: 8_000,
          current_usage: {
            input_tokens: 1000,
            output_tokens: 250,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 400,
          },
        },
      },
    });
  });

  it("keys statusline telemetry for an unrecognized session by its provider ref", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/hooks/statusline?sessionRef=external-claude",
      body: { model: "Claude", context_window: { used_percentage: null } },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      telemetry: { telemetry_key: "provider:external-claude", console_session_id: null, provider_session_id: "external-claude" },
      ingest: { ok: true, status: "no_target" },
    });
  });
});

describe("Claude hook settings", () => {
  it("appends Mandible hooks after the user's own, directly and through a replaced --settings argument", () => {
    const merged = mergeMandibleClaudeHookSettings({
      theme: "dark",
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "npm run format", timeout: 5 }],
          },
        ],
      },
    }, "session-1") as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };

    expect(merged.theme).toBe("dark");
    expect(merged.hooks.PostToolUse.map((entry) => entry.hooks[0]?.command)).toEqual([
      "npm run format",
      expect.stringContaining("mandible-claude-ingest-nudge.sh"),
    ]);
    expect(merged.hooks.Stop[0].hooks[0].command).toContain("mandible-claude-ingest-nudge.sh");
    expect(merged.hooks.Notification[0].hooks[0].command).toContain("mandible-claude-notification.sh");
    expect((merged.statusLine as { command: string }).command).toContain("mandible-claude-statusline.sh");

    const baseSettingsPath = path.join(tempDir, "base-settings.json");
    fs.writeFileSync(
      baseSettingsPath,
      JSON.stringify({
        hooks: {
          Notification: [
            {
              matcher: "permission_prompt",
              hooks: [{ type: "command", command: "say attention", timeout: 2 }],
            },
          ],
        },
      }),
      "utf8",
    );
    const settingsDir = path.join(tempDir, "generated");

    const args = injectMandibleClaudeHookSettingsArgs(
      ["--model", "sonnet", "--settings", baseSettingsPath],
      { sessionRef: "session-1", settingsDir },
    );
    const generatedPath = extractSettingsPath(args);

    expect(stripSettingsArgs(args)).toEqual(["--model", "sonnet"]);
    expect(generatedPath).toBe(path.join(settingsDir, "session-1.settings.json"));
    const generated = JSON.parse(fs.readFileSync(generatedPath!, "utf8")) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    };
    expect(generated.hooks.Notification.map((entry) => entry.hooks[0]?.command)).toEqual([
      "say attention",
      expect.stringContaining("mandible-claude-notification.sh"),
    ]);
    expect(generated.statusLine.command).toContain("mandible-claude-statusline.sh");
  });

  it("installs, reports, and uninstalls user-level Claude integration idempotently", () => {
    const settingsPath = path.join(tempDir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = {
      theme: "dark",
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "say done", timeout: 2 }],
          },
        ],
      },
      statusLine: { type: "command", command: "node ~/statusline.js --flag" },
    };
    const originalText = `${JSON.stringify(original, null, 2)}\n`;
    fs.writeFileSync(settingsPath, originalText, "utf8");

    const first = installUserClaudeIntegration({
      settingsPath,
      now: new Date("2026-07-02T12:00:00Z"),
    });
    const installedText = fs.readFileSync(settingsPath, "utf8");
    const second = installUserClaudeIntegration({ settingsPath });
    const installed = JSON.parse(installedText) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      statusLine: { command: string };
    };

    expect(first.status).toBe("installed");
    expect(first.backupPath).toContain(".mandible-backup-2026-07-02T12-00-00-000Z");
    expect(second.status).toBe("unchanged");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(installedText);
    expect(installed.hooks.Stop.map((entry) => entry.hooks[0]?.command)).toEqual([
      "say done",
      expect.stringContaining("mandible-claude-ingest-nudge.sh"),
    ]);
    expect(installed.statusLine.command).toContain("MANDIBLE_CHAINED_STATUSLINE='node ~/statusline.js --flag'");
    expect(getUserClaudeIntegrationStatus({ settingsPath })).toMatchObject({
      status: "installed",
      chainedStatusLine: "node ~/statusline.js --flag",
    });

    expect(uninstallUserClaudeIntegration({ settingsPath }).status).toBe("uninstalled");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(originalText);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(original);
    expect(uninstallUserClaudeIntegration({ settingsPath }).status).toBe("absent");

    const freshPath = path.join(tempDir, ".claude", "new-settings.json");

    const fresh = installUserClaudeIntegration({ settingsPath: freshPath });
    const freshText = fs.readFileSync(freshPath, "utf8");

    expect(fresh).toMatchObject({ status: "installed", backupPath: null, chainedStatusLine: null });
    expect(installUserClaudeIntegration({ settingsPath: freshPath }).status).toBe("unchanged");
    expect(fs.readFileSync(freshPath, "utf8")).toBe(freshText);
  });
});

describe("Claude statusline relay script", () => {
  it("posts captured stdin and preserves chained user statusline output", async () => {
    const received: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({
          url: req.url,
          body: JSON.parse(body),
          managed: req.headers["x-mandible-managed-client"],
          provider: req.headers["x-mandible-ambient-provider"],
          providerSessionId: req.headers["x-mandible-ambient-provider-session-id"],
          managedApp: req.headers["x-mandible-managed-app"],
          managedSessionId: req.headers["x-mandible-managed-session-id"],
        });
        res.writeHead(202, { "Content-Type": "application/json", Connection: "close" });
        res.end("{\"ok\":true}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("unexpected server address");
      }
      const script = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../cli/hooks/mandible-claude-statusline.sh",
      );
      const input = JSON.stringify({
        session_id: "12345678-1234-4234-8234-123456789abc",
        model: { display_name: "Sonnet" },
        context_window: { used_percentage: 42 },
      });
      const stdout = await runScriptWithInput("sh", [script], input, {
        env: {
          ...process.env,
          MANDIBLE_BASE: `http://127.0.0.1:${address.port}`,
          MANDIBLE_SESSION_REF: "console-alias",
          MANDIBLE_MANAGED_APP: "claude",
          MANDIBLE_SESSION_ID: "wrapper-123",
          MANDIBLE_CHAINED_STATUSLINE: "cat >/dev/null; printf chained-output",
        },
      });

      expect(stdout).toBe("chained-output");
      const aliasOnlyInput = JSON.stringify({ session_id: "not-a-provider-uuid", model: "Sonnet" });
      await runScriptWithInput("sh", [script], aliasOnlyInput, {
        env: { ...process.env, MANDIBLE_BASE: `http://127.0.0.1:${address.port}`,
          MANDIBLE_SESSION_REF: "console-alias", MANDIBLE_MANAGED_APP: "claude",
          MANDIBLE_SESSION_ID: "wrapper-123" },
      });
      expect(received).toEqual([
        {
          url: "/api/hooks/statusline?sessionRef=console-alias",
          body: JSON.parse(input),
          managed: "1",
          provider: "claude",
          providerSessionId: "12345678-1234-4234-8234-123456789abc",
          managedApp: "claude",
          managedSessionId: "wrapper-123",
        },
        {
          url: "/api/hooks/statusline?sessionRef=console-alias",
          body: JSON.parse(aliasOnlyInput),
          managed: "1",
          provider: undefined,
          providerSessionId: undefined,
          managedApp: "claude",
          managedSessionId: "wrapper-123",
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function runScriptWithInput(
  command: string,
  args: string[],
  input: string,
  options: { env: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`script exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}

function writeClaudeTranscript(sessionId: string): string {
  const dir = path.join(tempDir, ".claude", "projects", "-tmp-project");
  fs.mkdirSync(dir, { recursive: true });
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const rows = [
    {
      uuid: "u1",
      type: "user",
      timestamp: "2026-07-01T00:00:00.000Z",
      sessionId,
      cwd: tempDir,
      message: { role: "user", content: "Hello" },
    },
    {
      uuid: "a1",
      type: "assistant",
      timestamp: "2026-07-01T00:00:01.000Z",
      sessionId,
      cwd: tempDir,
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    },
  ];
  fs.writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return transcriptPath;
}
