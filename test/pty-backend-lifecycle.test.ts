import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleSession, Logger } from "../src/types.js";

const ptyMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  exitHandlers: [] as Array<(event: { exitCode?: number; signal?: number | null }) => void>,
}));

vi.mock("node-pty", () => ({
  default: {
    spawn: ptyMock.spawn,
  },
}));

const { PTYBackend } = await import("../src/backends/pty-backend.js");

function makeMeta(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return {
    id: "pty-test-id",
    label: "PTY Test",
    command: "bash",
    args: [],
    provider_session_id: null,
    cwd: "/tmp",
    env: {},
    cols: 120,
    rows: 30,
    status: "stopped",
    pid: null,
    exit_code: null,
    auto_restart: true,
    is_operator: false,
    interaction_mode: "both",
    created_at: Date.now(),
    updated_at: Date.now(),
    started_at: null,
    stopped_at: null,
    backend_type: "pty",
    allowed_tools: null,
    mandible_session_id: null,
    resume_at_message: null,
    agent_type: "shell",
    ...overrides,
  };
}

function makeLogger(): Logger {
  return vi.fn();
}

function makePtyProcess(): EventEmitter & {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  onData: (handler: (data: string) => void) => { dispose: () => void };
  onExit: (handler: (event: { exitCode?: number; signal?: number | null }) => void) => { dispose: () => void };
} {
  return Object.assign(new EventEmitter(), {
    pid: 1234,
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((handler) => {
      ptyMock.exitHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
  });
}

describe("PTYBackend lifecycle", () => {
  let tempHome = "";

  beforeEach(() => {
    vi.useFakeTimers();
    ptyMock.spawn.mockReset();
    ptyMock.exitHandlers = [];
    ptyMock.spawn.mockImplementation(() => makePtyProcess());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  it("cancels a scheduled auto-restart when destroyed after a crash", () => {
    const backend = new PTYBackend(makeMeta(), makeLogger());

    backend.start();
    expect(ptyMock.spawn).toHaveBeenCalledTimes(1);

    ptyMock.exitHandlers[0]?.({ exitCode: 1, signal: null });
    expect(backend.meta.status).toBe("crashed");

    backend.destroy();
    vi.advanceTimersByTime(10_000);

    expect(ptyMock.spawn).toHaveBeenCalledTimes(1);
  });

  it("injects Claude hook settings without dropping an existing settings hook", () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-pty-hooks-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    const baseSettingsPath = path.join(tempHome, "base-settings.json");
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
    const backend = new PTYBackend(makeMeta({
      command: "claude",
      args: ["--settings", baseSettingsPath],
      provider_session_id: "provider-1",
      agent_type: "claude",
    }), makeLogger());

    backend.start();

    expect(ptyMock.spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = ptyMock.spawn.mock.calls[0];
    const settingsIndex = (args as string[]).indexOf("--settings");
    expect(settingsIndex).toBeGreaterThan(-1);
    const generatedPath = (args as string[])[settingsIndex + 1];
    expect(generatedPath).toBe(path.join(tempHome, ".cache", "mandible", "claude-hooks", "provider-1.settings.json"));
    expect((options as { env: Record<string, string> }).env.MANDIBLE_SESSION_REF).toBe("provider-1");

    const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(generated.hooks.Notification.map((entry) => entry.hooks[0]?.command)).toEqual([
      "say attention",
      expect.stringContaining("mandible-claude-notification.sh"),
    ]);
  });
});
