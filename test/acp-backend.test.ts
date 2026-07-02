import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AcpBackend, probeGeminiAcpFlag } from "../src/backends/acp-backend.js";
import type { ConsoleSession, ConsoleStreamEvent, Logger } from "../src/types.js";

const tempRoots: string[] = [];

function makeMeta(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return {
    id: "acp-test",
    label: "ACP Test",
    command: "not-gemini",
    args: [],
    provider_session_id: null,
    cwd: "/tmp",
    env: {},
    cols: 120,
    rows: 30,
    status: "stopped",
    pid: null,
    exit_code: null,
    auto_restart: false,
    is_operator: false,
    interaction_mode: "both",
    created_at: Date.now(),
    updated_at: Date.now(),
    started_at: null,
    stopped_at: null,
    backend_type: "acp",
    allowed_tools: null,
    mandible_session_id: null,
    resume_at_message: null,
    channel_enabled: false,
    agent_type: "gemini",
    ...overrides,
  };
}

async function makeHelpScript(helpText: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-acp-help-"));
  tempRoots.push(root);
  const script = path.join(root, "gemini-help");
  await fs.writeFile(script, `#!/bin/sh\nprintf '%s\\n' '${helpText}'\n`, "utf8");
  await fs.chmod(script, 0o755);
  return script;
}

async function makeNpxAcpScript(sessionId: string): Promise<{ root: string; env: Record<string, string>; logPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-codex-acp-"));
  tempRoots.push(root);
  const script = path.join(root, "npx");
  const logPath = path.join(root, "requests.jsonl");
  await fs.writeFile(script, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "@agentclientprotocol/codex-acp", title: "Codex", version: "1.0.2" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true, image: true },
          sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {}, additionalDirectories: {} },
          auth: { logout: {} }
        },
        authMethods: [
          { id: "api-key", name: "API Key", description: "Use an API key to authenticate" },
          { id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" }
        ]
      }
    }) + "\\n");
    return;
  }
  if (msg.method === "authenticate") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    return;
  }
  if (msg.method === "session/new" || msg.method === "session/load") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: ${JSON.stringify(sessionId)},
        currentModelId: "gpt-5.3-codex[medium]",
        configOptions: [
          { id: "model", name: "Model", type: "select", currentValue: "gpt-5.3-codex", options: [] },
          { id: "mode", name: "Mode", type: "select", currentValue: "agent", options: [] }
        ]
      }
    }) + "\\n");
  }
});
`, "utf8");
  await fs.chmod(script, 0o755);
  return {
    root,
    env: {
      PATH: `${root}:${process.env.PATH ?? ""}`,
      CODEX_API_KEY: "test-key",
    },
    logPath,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

async function waitForLog(logPath: string, pattern: string, timeoutMs = 1000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const log = await fs.readFile(logPath, "utf8");
      if (log.includes(pattern)) return log;
    } catch {
      // Log file may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for log pattern: ${pattern}`);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("AcpBackend", () => {
  it("crashes cleanly for unsupported ACP commands", async () => {
    const logger: Logger = vi.fn();
    const backend = new AcpBackend(makeMeta(), logger);
    const events: ConsoleStreamEvent[] = [];
    backend.on("stream_event", (event: ConsoleStreamEvent) => events.push(event));

    backend.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(backend.meta.status).toBe("crashed");
    expect(events[0]).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    });
  });

  it("selects Gemini --acp before --experimental-acp", async () => {
    const script = await makeHelpScript("Usage: gemini --acp --experimental-acp");
    await expect(probeGeminiAcpFlag(script)).resolves.toBe("--acp");
  });

  it("falls back to Gemini --experimental-acp when --acp is absent", async () => {
    const script = await makeHelpScript("Usage: gemini --experimental-acp");
    await expect(probeGeminiAcpFlag(script)).resolves.toBe("--experimental-acp");
  });

  it("launches Codex through the pinned ACP adapter and surfaces auth/config metadata", async () => {
    const fake = await makeNpxAcpScript("codex-thread-1");
    const logger: Logger = vi.fn();
    const backend = new AcpBackend(makeMeta({
      command: "codex",
      agent_type: "codex",
      env: fake.env,
      cwd: fake.root,
    }), logger);
    const events: ConsoleStreamEvent[] = [];
    backend.on("stream_event", (event: ConsoleStreamEvent) => events.push(event));

    backend.start();
    await waitFor(() => backend.meta.provider_session_id === "codex-thread-1");

    const lines = (await fs.readFile(fake.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv?: string[]; method?: string; params?: Record<string, unknown> });
    expect(lines[0].argv).toEqual(["-y", "@agentclientprotocol/codex-acp@1.0.2"]);
    expect(lines.find((line) => line.method === "authenticate")?.params)
      .toMatchObject({ methodId: "api-key" });
    expect(lines.some((line) => line.method === "session/new")).toBe(true);
    expect(events.find((event) => event.subtype === "acp_initialize")).toMatchObject({
      auth_methods: [{ id: "api-key" }, { id: "chat-gpt" }],
      agent_capabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
      },
    });
    expect(events.find((event) => event.subtype === "init")).toMatchObject({
      session_id: "codex-thread-1",
      config_options: [{ id: "model" }, { id: "mode" }],
    });

    backend.destroy();
  });

  it("uses Codex ACP session/load when resume is advertised", async () => {
    const fake = await makeNpxAcpScript("codex-existing");
    const backend = new AcpBackend(makeMeta({
      command: "codex",
      agent_type: "codex",
      provider_session_id: "codex-existing",
      env: fake.env,
      cwd: fake.root,
    }), vi.fn());

    backend.start();
    const log = await waitForLog(fake.logPath, '"method":"session/load"');
    expect(log).toContain('"method":"session/load"');
    expect(log).toContain('"sessionId":"codex-existing"');

    backend.destroy();
  });
});
