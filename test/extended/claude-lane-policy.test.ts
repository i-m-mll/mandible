// Issue 8aadf70 — Claude Code ToS compliance: SDK is the default Claude lane and
// the Mandible-owned Claude PTY lane is local-only and off by default.
import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb } from "../../src/db.js";
import {
  CLAUDE_PTY_LANE_ENV_KEY,
  CLAUDE_PTY_LANE_SETTING_KEY,
  ClaudeLaneDisabledError,
  DEFAULT_CLAUDE_BACKEND_TYPE,
  DEFAULT_SDK_PERMISSION_MODE,
  assertClaudeLaneAllowed,
  describeAnthropicBilling,
  isClaudePtyLaneEnabled,
} from "../../src/claude-lane-policy.js";
import { SessionManager } from "../../src/session-manager.js";
import { PTYBackend } from "../../src/backends/pty-backend.js";
import { shouldEnablePtyScreenModel } from "../../src/screen-model.js";
import type { ConsoleSession } from "../../src/types.js";

type Db = ReturnType<typeof makeDb>;

function makeDb() {
  const db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  return db;
}

function enableLane(db: Db): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, 'true', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(CLAUDE_PTY_LANE_SETTING_KEY, Date.now());
}

function claudeSession(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return {
    id: "session-1",
    label: "Claude",
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
    created_at: 0,
    updated_at: 0,
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
    owner_user_id: null,
    ...overrides,
  };
}

describe("Claude lane policy", () => {
  let db: Db;

  beforeEach(() => {
    delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
    db = makeDb();
  });

  afterEach(() => {
    delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
    db.close();
  });

  it("keeps the Claude PTY lane off unless deliberately enabled", () => {
    expect(isClaudePtyLaneEnabled(db)).toBe(false);
    enableLane(db);
    expect(isClaudePtyLaneEnabled(db)).toBe(true);
  });

  it("lets the environment override the setting in both directions", () => {
    enableLane(db);
    process.env[CLAUDE_PTY_LANE_ENV_KEY] = "0";
    expect(isClaudePtyLaneEnabled(db)).toBe(false);
    process.env[CLAUDE_PTY_LANE_ENV_KEY] = "1";
    expect(isClaudePtyLaneEnabled(db)).toBe(true);
  });

  it("rejects only the Claude PTY lane, never other providers or lanes", () => {
    expect(() => assertClaudeLaneAllowed("claude", "pty", db)).toThrow(ClaudeLaneDisabledError);
    expect(() => assertClaudeLaneAllowed("claude", "sdk", db)).not.toThrow();
    expect(() => assertClaudeLaneAllowed("claude", "spawn", db)).not.toThrow();
    expect(() => assertClaudeLaneAllowed("codex", "pty", db)).not.toThrow();
    expect(() => assertClaudeLaneAllowed("gemini", "pty", db)).not.toThrow();
    expect(() => assertClaudeLaneAllowed("bash", "pty", db)).not.toThrow();
    enableLane(db);
    expect(() => assertClaudeLaneAllowed("claude", "pty", db)).not.toThrow();
  });

  it("never defaults Claude to a bypassed permission posture", () => {
    expect(DEFAULT_CLAUDE_BACKEND_TYPE).toBe("sdk");
    expect(DEFAULT_SDK_PERMISSION_MODE).toBe("default");
    expect(DEFAULT_SDK_PERMISSION_MODE).not.toBe("bypassPermissions");
  });

  it("names the Anthropic billing path instead of inheriting it silently", () => {
    expect(describeAnthropicBilling({})).toMatchObject({ mode: "subscription", source: null });
    expect(describeAnthropicBilling({ ANTHROPIC_API_KEY: "   " })).toMatchObject({
      mode: "subscription",
    });
    expect(describeAnthropicBilling({ ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({
      mode: "api_key",
      source: "ANTHROPIC_API_KEY",
    });
    expect(describeAnthropicBilling({ ANTHROPIC_AUTH_TOKEN: "tok" })).toMatchObject({
      mode: "api_key",
      source: "ANTHROPIC_AUTH_TOKEN",
    });
  });
});

describe("SessionManager Claude lane defaults", () => {
  let db: Db;
  let manager: SessionManager;

  beforeEach(() => {
    delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
    db = makeDb();
    manager = new SessionManager(db, () => undefined);
  });

  afterEach(() => {
    manager.close();
    db.close();
    delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
  });

  it("puts a default-created Claude session on the SDK lane", () => {
    const session = manager.create({ label: "Claude", command: "claude" });
    expect(session.backend_type).toBe("sdk");
    expect(session.transport_lane).toBe("sdk");
    expect(session.args).toEqual([]);
  });

  it("leaves codex, gemini, and shell defaults untouched", () => {
    expect(manager.create({ label: "Codex", command: "codex" }).backend_type).toBe("acp");
    expect(manager.create({ label: "Gemini", command: "gemini" }).backend_type).toBe("acp");
    expect(manager.create({ label: "Shell", command: "bash" }).backend_type).toBe("pty");
  });

  it("rejects an explicit Claude PTY or Channel session while the lane is off", () => {
    expect(() => manager.create({
      label: "Claude PTY",
      command: "claude",
      backend_type: "pty",
    })).toThrow(ClaudeLaneDisabledError);
    expect(() => manager.create({
      label: "Claude Channel",
      command: "claude",
      transport_lane: "channel",
    })).toThrow(ClaudeLaneDisabledError);
    // Nothing half-created is left behind.
    expect(db.prepare("SELECT COUNT(*) AS n FROM console_sessions").get()).toEqual({ n: 0 });
  });

  it("still allows a Claude PTY session once the lane is deliberately enabled", () => {
    enableLane(db);
    const session = manager.create({
      label: "Claude PTY",
      command: "claude",
      backend_type: "pty",
    });
    expect(session.backend_type).toBe("pty");
  });

  it("still allows codex and gemini PTY sessions while the Claude lane is off", () => {
    expect(manager.create({
      label: "Codex PTY",
      command: "codex",
      backend_type: "pty",
    }).backend_type).toBe("pty");
  });

  it("projects the Anthropic billing posture onto Claude sessions only", () => {
    const claude = manager.create({
      label: "Claude",
      command: "claude",
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    expect(claude.anthropic_billing).toMatchObject({
      mode: "api_key",
      source: "ANTHROPIC_API_KEY",
    });
    expect(manager.create({ label: "Codex", command: "codex" }).anthropic_billing).toBeNull();
  });
});

describe("Claude PTY lane gating is total", () => {
  let db: Db;

  beforeEach(() => {
    delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
    db = makeDb();
  });

  afterEach(() => {
    delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
    db.close();
  });

  it("never engages screen classification for Claude while the lane is off", () => {
    expect(shouldEnablePtyScreenModel(claudeSession())).toBe(false);
    // Other PTY providers keep their existing screen-model behaviour.
    expect(shouldEnablePtyScreenModel(claudeSession({
      command: "codex",
      agent_type: "codex",
    }))).toBe(true);
    enableLane(db);
    expect(shouldEnablePtyScreenModel(claudeSession())).toBe(true);
  });

  it("refuses to start a Claude PTY backend recorded while the lane was enabled", () => {
    const backend = new PTYBackend(claudeSession(), () => undefined);
    expect(() => backend.start()).toThrow(ClaudeLaneDisabledError);
    backend.destroy();
  });

  it("only appends the development-channel flag when the lane is enabled", () => {
    const meta = claudeSession({ channel_enabled: true, transport_lane: "channel" });
    const gated = new PTYBackend(meta, () => undefined) as unknown as {
      buildLaunchArgs(): string[];
    };
    expect(gated.buildLaunchArgs()).not.toContain("--dangerously-load-development-channels");

    enableLane(db);
    const enabled = new PTYBackend(meta, () => undefined) as unknown as {
      buildLaunchArgs(): string[];
    };
    expect(enabled.buildLaunchArgs()).toContain("--dangerously-load-development-channels");
    (gated as unknown as PTYBackend).destroy();
    (enabled as unknown as PTYBackend).destroy();
  });
});
