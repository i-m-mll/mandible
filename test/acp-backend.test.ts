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
});
