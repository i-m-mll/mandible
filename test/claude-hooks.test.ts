import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractSettingsPath,
  injectMandibleClaudeHookSettingsArgs,
  mergeMandibleClaudeHookSettings,
  stripSettingsArgs,
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
  db = new Database(":memory:");
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
  });
});

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
