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

const { PTYBackend, formatPtyPromptInput } = await import("../src/backends/pty-backend.js");

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
    transport_lane: "pty",
    transport_badge: { label: "PTY", title: "Mandible-owned PTY transport" },
    allowed_tools: null,
    mandible_session_id: null,
    resume_at_message: null,
    agent_type: "shell",
    channel_enabled: false,
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

function makeAttention(
  kind: "input_prompt" | "running_output" | "permission_menu" | "unknown",
): NonNullable<ConsoleSession["attention"]> {
  return {
    session_id: "pty-test-id",
    kind,
    source: "pty_screen",
    at: Date.now(),
    active: true,
    screen_excerpt: kind,
    clear_conditions: ["screen_changed", "structured_stream_activity", "process_exit"],
    detail: {
      provider: "claude",
      confidence: "high",
      reason: `test ${kind}`,
    },
  };
}

function publishAttention(
  backend: InstanceType<typeof PTYBackend>,
  kind: NonNullable<ConsoleSession["attention"]>["kind"],
): void {
  (backend as unknown as { publishAttention(attention: ConsoleSession["attention"]): void })
    .publishAttention(makeAttention(kind));
}

function activePtyWrite(): ReturnType<typeof vi.fn> {
  const proc = ptyMock.spawn.mock.results.at(-1)?.value as { write?: ReturnType<typeof vi.fn> } | undefined;
  if (!proc?.write) {
    throw new Error("missing mocked PTY process");
  }
  return proc.write;
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

  it("formats multi-line composer prompts as bracketed paste plus submit", () => {
    expect(formatPtyPromptInput("one line")).toBe("one line\r");
    expect(formatPtyPromptInput("line one\nline two")).toBe("\x1b[200~line one\nline two\x1b[201~\r");
  });

  it("writes composer prompts directly to an owned PTY at input prompt", () => {
    const backend = new PTYBackend(
      makeMeta({ command: "claude", agent_type: "claude", status: "stopped" }),
      makeLogger(),
    );
    const events: unknown[] = [];
    backend.on("stream_event", (event) => events.push(event));

    backend.start();
    publishAttention(backend, "input_prompt");

    backend.sendPrompt("hello");

    expect(activePtyWrite()).toHaveBeenCalledWith("hello\r");
    expect(events).toMatchObject([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);
    expect(backend.meta.prompt_queue?.pending_count).toBe(0);
  });

  it("uses bracketed paste when writing multi-line composer prompts to a PTY", () => {
    const backend = new PTYBackend(
      makeMeta({ command: "claude", agent_type: "claude", status: "stopped" }),
      makeLogger(),
    );

    backend.start();
    publishAttention(backend, "input_prompt");
    backend.sendPrompt("line one\nline two");

    expect(activePtyWrite()).toHaveBeenCalledWith("\x1b[200~line one\nline two\x1b[201~\r");
  });

  it.each(["permission_menu", "running_output", "unknown"] as const)(
    "queues composer prompts while attention is %s and flushes at input prompt",
    (kind) => {
      const backend = new PTYBackend(
        makeMeta({ command: "claude", agent_type: "claude", status: "stopped" }),
        makeLogger(),
      );

      backend.start();
      publishAttention(backend, kind);

      backend.sendPrompt("queued prompt");

      expect(activePtyWrite()).not.toHaveBeenCalled();
      expect(backend.meta.prompt_queue?.pending_count).toBe(1);
      expect(backend.meta.prompt_queue?.items[0]?.blocked_by).toBe(kind);

      publishAttention(backend, "input_prompt");

      expect(activePtyWrite()).toHaveBeenCalledWith("queued prompt\r");
      expect(backend.meta.prompt_queue?.pending_count).toBe(0);
    },
  );

  it("rejects composer prompt injection for unsupported non-agent PTY sessions", () => {
    const backend = new PTYBackend(makeMeta({ command: "bash", agent_type: "shell" }), makeLogger());

    backend.start();

    expect(() => backend.sendPrompt("echo no")).toThrow("unsupported_prompt_backend");
    expect(activePtyWrite()).not.toHaveBeenCalled();
  });

  it("turns Claude permission screens into option-key PTY writes", async () => {
    const backend = new PTYBackend(
      makeMeta({ command: "claude", agent_type: "claude", status: "stopped" }),
      makeLogger(),
    );
    const requests: unknown[] = [];
    backend.on("permission", (request) => requests.push(request));

    backend.start();
    (backend as unknown as { handleData(data: string): void }).handleData(
      "\x1b[2J\x1b[HClaude needs your permission to use Bash\r\n\r\n" +
        "Bash command:\r\nnpm test\r\n\r\n" +
        "Do you want to allow this command?\r\n" +
        "> 1. Yes\r\n  2. Yes, and don't ask again\r\n  3. No, and tell Claude what to do differently",
    );
    await vi.advanceTimersByTimeAsync(130);

    const pending = backend.getPendingPermissions();
    expect(requests).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tool_name: "Bash",
      display_name: "npm test",
      options: [
        { key: "1", label: "Yes", decision: "option:1" },
        { key: "2", label: "Yes, and don't ask again", decision: "option:2" },
        { key: "3", label: "No, and tell Claude what to do differently", decision: "option:3" },
      ],
    });

    expect(backend.resolvePermission(pending[0].id, "option:2")).toBe(true);

    expect(activePtyWrite()).toHaveBeenCalledWith("2");
    expect(backend.getPendingPermissions()).toEqual([]);
  });

  it("does not write a PTY permission answer when the settled screen hash changed", async () => {
    const backend = new PTYBackend(
      makeMeta({ command: "claude", agent_type: "claude", status: "stopped" }),
      makeLogger(),
    );
    const cleared: unknown[] = [];
    backend.on("permission_cleared", (event) => cleared.push(event));

    backend.start();
    (backend as unknown as { handleData(data: string): void }).handleData(
      "\x1b[2J\x1b[HClaude needs your permission to use Bash\r\n\r\n" +
        "Bash command:\r\nnpm test\r\n\r\n" +
        "Do you want to allow this command?\r\n" +
        "> 1. Yes\r\n  2. Yes, and don't ask again\r\n  3. No",
    );
    await vi.advanceTimersByTimeAsync(130);
    const [pending] = backend.getPendingPermissions();

    (backend as unknown as { handleData(data: string): void }).handleData(
      "\x1b[2J\x1b[HWhat would you like to do?\n> ",
    );
    await vi.advanceTimersByTimeAsync(130);

    expect(backend.resolvePermission(pending.id, "option:1")).toBe(false);
    expect(activePtyWrite()).not.toHaveBeenCalled();
    expect(cleared).toHaveLength(1);
    expect(backend.getPendingPermissions()).toEqual([]);
  });

  it("does not inject from generic unclassified permission attention", () => {
    const backend = new PTYBackend(
      makeMeta({ command: "claude", agent_type: "claude", status: "stopped" }),
      makeLogger(),
    );

    backend.start();
    publishAttention(backend, "permission_menu");

    expect(backend.getPendingPermissions()).toEqual([]);
    expect(backend.resolvePermission("missing", "option:1")).toBe(false);
    expect(activePtyWrite()).not.toHaveBeenCalled();
  });
});
