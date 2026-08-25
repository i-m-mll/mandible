import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PTYBackend } from "../../src/backends/pty-backend.js";
import { detectClaudePermissionPrompt } from "../../src/claude-permission-patterns.js";
import { CLAUDE_PTY_LANE_ENV_KEY } from "../../src/claude-lane-policy.js";
import {
  detectInteractiveState,
  PtyScreenObserver,
  shouldEnablePtyScreenModel,
  type ScreenSnapshot,
} from "../../src/screen-model.js";
import type { ConsoleAttentionState, ConsoleSession, Logger } from "../../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURE_DIR = path.join(
  __dirname,
  "..",
  "fixtures",
  "claude-permission-screens",
  "claude-code-1.0.117",
);

function snapshot(text: string): ScreenSnapshot {
  const rows = text.split("\n");
  return {
    session_id: "session-1",
    rows,
    cursor: { x: 0, y: rows.length - 1 },
    cols: 120,
    row_count: 30,
    text,
    at: 1_000,
  };
}

function makeSession(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return {
    id: "session-1",
    label: "Claude PTY",
    command: "claude",
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
    created_at: 1,
    updated_at: 1,
    started_at: null,
    stopped_at: null,
    backend_type: "pty",
    transport_lane: "pty",
    transport_badge: { label: "PTY", title: "Mandible-owned PTY transport" },
    allowed_tools: null,
    mandible_session_id: null,
    resume_at_message: null,
    agent_type: "claude",
    channel_enabled: false,
    ...overrides,
  };
}

describe("PTY screen detection", () => {
  it.each([
    ["bash-command.txt", "bash_command", "npm test -- --runInBand"],
    ["file-edit.txt", "file_edit", "/tmp/mandible-fixture/src/index.ts"],
    ["mcp-tool.txt", "mcp_tool", "mcp__github__create_issue"],
    ["tool-use.txt", "tool_use", "Read"],
  ])("parses Claude Code 1.0.117 permission fixture %s", (fileName, kind, subject) => {
    const text = fs.readFileSync(path.join(CLAUDE_FIXTURE_DIR, fileName), "utf8");
    const prompt = detectClaudePermissionPrompt(text);

    expect(prompt).toMatchObject({
      kind,
      subject,
      detect_only: false,
    });
    expect(prompt?.question).toContain("?");
    expect(prompt?.options).toEqual([
      { key: "1", label: "Yes", decision: "option:1" },
      expect.objectContaining({ key: "2", label: expect.stringContaining("don't ask again") }),
      expect.objectContaining({ key: "3", label: expect.stringContaining("No") }),
    ]);

    const state = detectInteractiveState(snapshot(text), "claude");
    expect(state?.kind).toBe("permission_menu");
    expect(state?.matched).toBe(`claude-permission-${kind}`);
    expect(state?.claude_permission?.screen_hash).toBe(prompt?.screen_hash);
  });

  it("detects Claude trust prompts without creating answer options", () => {
    const text = fs.readFileSync(path.join(CLAUDE_FIXTURE_DIR, "trust-folder.txt"), "utf8");
    const prompt = detectClaudePermissionPrompt(text);

    expect(prompt).toMatchObject({
      kind: "trust_folder",
      detect_only: true,
      options: [],
    });

    const state = detectInteractiveState(snapshot(text), "claude");
    expect(state?.kind).toBe("permission_menu");
    expect(state?.matched).toBe("claude-detect-only-trust_folder");
  });

  it("classifies Claude terminal permission menus", () => {
    const state = detectInteractiveState(
      snapshot("Claude needs your permission to use Bash\n❯ Allow\n  Deny"),
      "claude",
    );

    expect(state?.kind).toBe("permission_menu");
    expect(state?.requires_attention).toBe(true);
    expect(state?.matched).toBe("claude-permission-menu");
  });

  it("classifies interactive input prompts", () => {
    const state = detectInteractiveState(snapshot("What would you like to do?\n> "), "claude");

    expect(state?.kind).toBe("input_prompt");
    expect(state?.requires_attention).toBe(true);
  });

  it("classifies running output without requiring attention", () => {
    const state = detectInteractiveState(snapshot("Thinking...\nEsc to interrupt"), "claude");

    expect(state?.kind).toBe("running_output");
    expect(state?.requires_attention).toBe(false);
  });

  it("uses unknown fallback only without recent structured activity", () => {
    const stalled = detectInteractiveState(snapshot("New release available. Continue?"), "claude", {
      recentStructuredActivity: false,
    });
    const active = detectInteractiveState(snapshot("New release available. Continue?"), "claude", {
      recentStructuredActivity: true,
    });

    expect(stalled?.kind).toBe("unknown");
    expect(stalled?.requires_attention).toBe(true);
    expect(active?.kind).toBe("running_output");
    expect(active?.requires_attention).toBe(false);
  });

  it("defaults screen modeling to agent PTY sessions and honors kill switches", () => {
    // Issue 8aadf70 — Claude screen classification belongs to the gated
    // local-only lane, so the default agent case here is codex, not claude.
    const codex = makeSession({ command: "codex", agent_type: "codex" });
    expect(shouldEnablePtyScreenModel(codex)).toBe(true);
    expect(shouldEnablePtyScreenModel(makeSession({ command: "bash", agent_type: "shell" }))).toBe(false);
    expect(
      shouldEnablePtyScreenModel({ ...codex, env: { MANDIBLE_PTY_SCREEN_ATTENTION: "0" } }),
    ).toBe(false);
  });

  it("never engages screen modeling for Claude while the PTY lane is gated off", () => {
    expect(shouldEnablePtyScreenModel(makeSession())).toBe(false);
    expect(
      shouldEnablePtyScreenModel(makeSession({ env: { MANDIBLE_PTY_SCREEN_ATTENTION: "1" } })),
    ).toBe(false);
  });
});

describe("PtyScreenObserver", () => {
  it("settles ANSI redraws into one attention state and clears on structured activity", () => {
    let now = 1_000;
    const changes: Array<ConsoleAttentionState | null> = [];
    const observer = new PtyScreenObserver({
      sessionId: "session-1",
      provider: "claude",
      cols: 80,
      rows: 8,
      now: () => now,
      onAttentionChange: (state) => changes.push(state),
    });

    observer.feed("\x1b[2J\x1b[HThinking...\r\x1b[KClaude needs your permission\n❯ Allow\n  Deny");
    const classification = observer.settleNow();

    expect(classification?.kind).toBe("permission_menu");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.active).toBe(true);
    expect(changes[0]?.screen_excerpt).toContain("Claude needs your permission");

    now += 10;
    observer.markStructuredActivity();

    expect(changes).toHaveLength(2);
    expect(changes[1]?.active).toBe(false);
    expect(changes[1]?.cleared_by).toBe("structured_stream_activity");
  });

  it("does not publish attention for normal running output", () => {
    const changes: Array<ConsoleAttentionState | null> = [];
    const observer = new PtyScreenObserver({
      sessionId: "session-1",
      provider: "claude",
      cols: 80,
      rows: 8,
      onAttentionChange: (state) => changes.push(state),
    });

    observer.feed("Thinking...\nEsc to interrupt");
    const classification = observer.settleNow();

    expect(classification?.kind).toBe("running_output");
    expect(changes).toEqual([]);
  });
});

describe("PTYBackend screen attention integration", () => {
  it("emits console attention changes from scripted terminal output", async () => {
    vi.useFakeTimers();
    // Issue 8aadf70 — driving a Claude terminal is the gated local-only lane;
    // this integration test exercises that lane, so it opts in explicitly.
    process.env[CLAUDE_PTY_LANE_ENV_KEY] = "1";
    try {
      const backend = new PTYBackend(makeSession({ status: "running" }), (() => undefined) as Logger);
      const changes: Array<ConsoleAttentionState | null> = [];
      backend.on("attention", (state: ConsoleAttentionState | null) => changes.push(state));

      (backend as unknown as { handleData(data: string): void }).handleData(
        "\x1b[2J\x1b[HClaude needs your permission to run a command\n❯ Allow\n  Deny",
      );
      await vi.advanceTimersByTimeAsync(130);

      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("permission_menu");
      expect(backend.meta.attention?.active).toBe(true);

      backend.ingestStructuredEvent({ type: "result", session_id: "provider-1" });

      expect(changes).toHaveLength(2);
      expect(changes[1]?.active).toBe(false);
      expect(backend.meta.attention).toBeNull();
    } finally {
      delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
      vi.useRealTimers();
    }
  });
});
