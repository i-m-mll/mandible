import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { migrate, setDb, type Db } from "../src/db.js";
import { registerHookRoutes } from "../src/routes/hooks.js";
import { Router } from "../src/server.js";

let db: Db;
let router: Router;
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-claude-hooks-"));
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  resetHookNotificationAttentionForTests();
  router = new Router();
  registerHookRoutes(router);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  resetHookNotificationAttentionForTests();
});

describe("Claude hook routes", () => {
  it("allows hook endpoints over file RPC policy", () => {
    expect(router.resolveFileRpcPolicy("POST", "/api/hooks/ingest-nudge")).toBe(true);
    expect(router.resolveFileRpcPolicy("POST", "/api/hooks/notification")).toBe(true);
    expect(router.resolveFileRpcPolicy("POST", "/api/hooks/statusline")).toBe(true);
  });

  it("ingests one transcript path immediately and rate-limits a burst nudge", async () => {
    const transcriptPath = writeClaudeTranscript("claude-session-1");

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

  it("skips attention for unknown sessions without failing the hook", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/hooks/notification",
      body: { sessionRef: "missing-claude-session", message: "Permission needed" },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      attention: {
        ok: true,
        status: "unknown_session",
        session_id: null,
      },
    });
  });

  it("raises hook notification attention for a known provider session", async () => {
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

  it("stores statusline telemetry for unrecognized external sessions", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/hooks/statusline?sessionRef=external-claude",
      body: {
        model: "Claude",
        context_window: { used_percentage: null },
      },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      telemetry: {
        telemetry_key: "provider:external-claude",
        console_session_id: null,
        provider_session_id: "external-claude",
      },
      ingest: {
        ok: true,
        status: "no_target",
      },
    });
  });

  it("returns last-known statusline telemetry by session ref", async () => {
    db.prepare(`
      INSERT INTO console_session_telemetry (
        telemetry_key, console_session_id, provider_session_id, transcript_path,
        model, context_used_percentage, context_window_size,
        raw_payload_json, received_at
      ) VALUES (
        'provider:external-claude-read', NULL, 'external-claude-read', NULL,
        'Claude', 64, 200000,
        '{}', 12345
      )
    `).run();

    const response = await router.invoke({
      method: "GET",
      url: "/api/hooks/statusline?sessionRef=external-claude-read",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      telemetry: {
        telemetry_key: "provider:external-claude-read",
        provider_session_id: "external-claude-read",
        context_window: {
          used_percentage: 64,
          context_window_size: 200000,
        },
        received_at: 12345,
      },
    });
  });
});

describe("Claude hook settings", () => {
  it("merges Mandible hooks without replacing existing user hooks", () => {
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
  });

  it("writes merged settings and replaces an existing --settings argument", () => {
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
  });

  it("keeps installs idempotent when no user settings file existed", () => {
    const settingsPath = path.join(tempDir, ".claude", "new-settings.json");

    const first = installUserClaudeIntegration({ settingsPath });
    const installedText = fs.readFileSync(settingsPath, "utf8");
    const second = installUserClaudeIntegration({ settingsPath });

    expect(first).toMatchObject({ status: "installed", backupPath: null, chainedStatusLine: null });
    expect(second).toMatchObject({ status: "unchanged", backupPath: null, chainedStatusLine: null });
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(installedText);
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
  }, 10_000);
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
