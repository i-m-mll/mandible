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
    transport_lane: "acp",
    transport_badge: { label: "ACP", title: "Agent Client Protocol transport" },
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

async function makeNpxAcpScript(
  sessionId: string,
  setOptionBehavior: "accept" | "reject" | "disagree" | "missing" | "timeout" = "accept",
): Promise<{ root: string; env: Record<string, string>; logPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-codex-acp-"));
  tempRoots.push(root);
  const script = path.join(root, "npx");
  const logPath = path.join(root, "requests.jsonl");
  await fs.writeFile(script, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
const setOptionBehavior = ${JSON.stringify(setOptionBehavior)};
const config = { model: "gpt-5.3-codex", reasoning_effort: "medium", mode: "agent" };
const inventory = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: config.model,
    options: [{ value: "gpt-5.3-codex", name: "Codex" }, { value: "gpt-next", name: "Next" }] },
  { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: config.reasoning_effort,
    options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: config.mode,
    options: [{ value: "read-only", name: "Read only" }, { value: "agent", name: "Agent" }, { value: "agent-full-access", name: "Full access" }] }
];
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
        configOptions: inventory()
      }
    }) + "\\n");
    return;
  }
  if (msg.method === "session/set_config_option") {
    if (setOptionBehavior === "timeout") return;
    if (setOptionBehavior === "reject") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "rejected" } }) + "\\n");
      return;
    }
    if (setOptionBehavior !== "disagree") config[msg.params.configId] = msg.params.value;
    const configOptions = setOptionBehavior === "missing"
      ? inventory().filter((option) => option.id !== msg.params.configId)
      : inventory();
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { configOptions } }) + "\\n");
    return;
  }
  if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: ${JSON.stringify(sessionId)}, update: { sessionUpdate: "completed" }
    } }) + "\\n");
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
  it("applies initial Codex model, reasoning_effort, and mode before first prompt", async () => {
    const fake = await makeNpxAcpScript("codex-options");
    const backend = new AcpBackend(makeMeta({
      command: "codex", agent_type: "codex", env: fake.env, cwd: fake.root,
    }), vi.fn());
    const pending = backend.applyRunOptions({ values: {
      model: "gpt-next", reasoning_effort: "high", mode: "read-only",
    } }, { phase: "initial" });
    backend.sendPrompt("first prompt");
    await expect(pending).resolves.toMatchObject({ applied: [
      { id: "model", currentValue: "gpt-next" },
      { id: "reasoning_effort", currentValue: "high" },
      { id: "mode", currentValue: "read-only" },
    ] });
    await waitForLog(fake.logPath, '"method":"session/prompt"');
    const methods = (await fs.readFile(fake.logPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((line) => line.method)
      .map((line) => line.method === "session/set_config_option" ? `set:${line.params?.configId}` : line.method);
    expect(methods).toEqual([
      "initialize", "authenticate", "session/new", "set:model", "set:reasoning_effort", "set:mode", "session/prompt",
    ]);
    expect(backend.getRunOptions()).toMatchObject({ phase: "ready" });
    backend.destroy();
  });

  it.each([
    ["provider rejection", "reject", "provider_rejected"],
    ["provider disagreement", "disagree", "provider_disagreement"],
    ["a missing response option", "missing", "provider_disagreement"],
  ] as const)("blocks the first prompt after %s", async (_label, behavior, code) => {
    const fake = await makeNpxAcpScript(`codex-${behavior}`, behavior);
    const backend = new AcpBackend(makeMeta({
      command: "codex", agent_type: "codex", env: fake.env, cwd: fake.root,
    }), vi.fn());
    const pending = backend.applyRunOptions({ values: { model: "gpt-next" } }, { phase: "initial" });
    backend.sendPrompt("must remain gated");
    await expect(pending).rejects.toMatchObject({ code, optionId: "model" });
    const log = await fs.readFile(fake.logPath, "utf8");
    expect(log).not.toContain('"method":"session/prompt"');
    expect(backend.getRunOptions().phase).toBe("blocked");
    backend.destroy();
  });

  it("marks a timed-out option indeterminate and blocks subsequent prompts", async () => {
    const fake = await makeNpxAcpScript("codex-timeout", "timeout");
    const backend = new AcpBackend(makeMeta({
      command: "codex", agent_type: "codex", env: fake.env, cwd: fake.root,
    }), vi.fn());
    backend.start();
    await waitFor(() => backend.getRunOptions().phase === "ready");

    const pending = backend.applyRunOptions({ values: { model: "gpt-next" } }, { phase: "runtime" });
    await expect(pending).rejects.toMatchObject({ code: "provider_timeout", optionId: "model" });
    expect(backend.getRunOptions()).toMatchObject({
      phase: "blocked",
      options: expect.arrayContaining([
        expect.objectContaining({ id: "model", enforcement: expect.objectContaining({ status: "indeterminate" }) }),
      ]),
    });
    backend.sendPrompt("must remain blocked");
    const log = await fs.readFile(fake.logPath, "utf8");
    expect(log).not.toContain('"method":"session/prompt"');
    backend.destroy();
  }, 15_000);

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
      config_options: [{ id: "model" }, { id: "reasoning_effort" }, { id: "mode" }],
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
    const pending = backend.applyRunOptions({ values: { reasoning_effort: "high" } }, { phase: "initial" });
    const log = await waitForLog(fake.logPath, '"method":"session/load"');
    expect(log).toContain('"method":"session/load"');
    expect(log).toContain('"sessionId":"codex-existing"');
    await expect(pending).resolves.toMatchObject({ applied: [{ id: "reasoning_effort", currentValue: "high" }] });
    expect(await waitForLog(fake.logPath, '"configId":"reasoning_effort"'))
      .toContain('"configId":"reasoning_effort"');

    backend.destroy();
  });
});
