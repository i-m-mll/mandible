import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb } from "../../src/db.js";
import { CLAUDE_PTY_LANE_ENV_KEY } from "../../src/claude-lane-policy.js";
import { SessionManager } from "../../src/session-manager.js";

function createManager(): { db: InstanceType<typeof SqliteDatabase>; manager: SessionManager } {
  const db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  return {
    db,
    manager: new SessionManager(db, () => undefined),
  };
}

describe("console transport lanes", () => {
  // Issue 8aadf70 — the Claude PTY/Channel lanes are local-only and off by
  // default. The lane-selection behaviour under test here is unchanged; the
  // tests that exercise those lanes opt into them explicitly.
  beforeEach(() => {
    delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
  });

  afterEach(() => {
    delete process.env[CLAUDE_PTY_LANE_ENV_KEY];
  });

  it("adds the persisted transport lane column through migrations", () => {
    const { db } = createManager();
    try {
      const columns = db.prepare("PRAGMA table_info(console_sessions)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("transport_lane");
    } finally {
      db.close();
    }
  });

  it("defaults Claude to the SDK lane and Codex/Gemini to ACP", () => {
    const { db, manager } = createManager();
    try {
      const claude = manager.create({ label: "Claude", command: "claude" });
      const codex = manager.create({ label: "Codex", command: "codex" });
      const gemini = manager.create({ label: "Gemini", command: "gemini" });

      expect(claude).toMatchObject({
        backend_type: "sdk",
        transport_lane: "sdk",
        channel_enabled: false,
        transport_badge: { label: "SDK" },
      });
      expect(codex).toMatchObject({
        backend_type: "acp",
        transport_lane: "acp",
        transport_badge: { label: "ACP" },
      });
      expect(gemini).toMatchObject({
        backend_type: "acp",
        transport_lane: "acp",
        transport_badge: { label: "ACP" },
      });
    } finally {
      db.close();
    }
  });

  it("preserves the legacy channel-enabled PTY path as the Channel lane", () => {
    process.env[CLAUDE_PTY_LANE_ENV_KEY] = "1";
    const { db, manager } = createManager();
    try {
      const session = manager.create({
        label: "Claude Channel",
        command: "claude",
        backend_type: "pty",
        channel_enabled: true,
      });
      const row = db
        .prepare("SELECT backend_type, channel_enabled, transport_lane FROM console_sessions WHERE id = ?")
        .get(session.id) as { backend_type: string; channel_enabled: number; transport_lane: string };

      expect(session).toMatchObject({
        backend_type: "pty",
        transport_lane: "channel",
        channel_enabled: true,
        transport_badge: { label: "Channel" },
      });
      expect(row).toEqual({
        backend_type: "pty",
        channel_enabled: 1,
        transport_lane: "channel",
      });
    } finally {
      db.close();
    }
  });

  it("normalizes explicit provider lane selections", () => {
    const { db, manager } = createManager();
    try {
      expect(manager.create({
        label: "Claude SDK",
        command: "claude",
        transport_lane: "sdk",
      })).toMatchObject({ backend_type: "sdk", transport_lane: "sdk", channel_enabled: false });

      expect(manager.create({
        label: "Gemini PTY",
        command: "gemini",
        transport_lane: "pty",
      })).toMatchObject({ backend_type: "pty", transport_lane: "pty", channel_enabled: false });

      expect(manager.create({
        label: "Codex ACP",
        command: "codex",
        transport_lane: "acp",
      })).toMatchObject({ backend_type: "acp", transport_lane: "acp", channel_enabled: false });

      expect(manager.create({
        label: "Legacy Codex Spawn",
        command: "codex",
        backend_type: "spawn",
      })).toMatchObject({ backend_type: "spawn", transport_lane: "spawn", channel_enabled: false });
    } finally {
      db.close();
    }
  });
});
