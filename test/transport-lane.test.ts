import SqliteDatabase from "../src/sqlite.ts";
import { describe, expect, it } from "vitest";
import { migrate, setDb } from "../src/db.js";
import { SessionManager } from "../src/session-manager.js";
import type { ConsoleSessionInput } from "../src/types.js";

// Managed provider control belongs to ConversationControlService. Console owns
// plain terminals; retired SDK/ACP/Channel creation is deliberately rejected.
describe("Console transport boundary", () => {
  it("persists a plain terminal as PTY even when its command names a provider", () => {
    const db = new SqliteDatabase(":memory:");
    migrate(db); setDb(db);
    const manager = new SessionManager(db, () => undefined);
    try {
      const session = manager.create({ label: "Terminal", command: "codex" });
      expect(session).toMatchObject({ backend_type: "pty", transport_lane: "pty", channel_enabled: false });
      expect(db.prepare("SELECT backend_type, transport_lane, channel_enabled FROM console_sessions WHERE id = ?")
        .get(session.id)).toEqual({ backend_type: "pty", transport_lane: "pty", channel_enabled: 0 });
    } finally { manager.close(); db.close(); }
  });

  it("rejects managed lifecycle inputs before creating a Console record", () => {
    const db = new SqliteDatabase(":memory:");
    migrate(db); setDb(db);
    const manager = new SessionManager(db, () => undefined);
    const inputs: Partial<ConsoleSessionInput>[] = [
      { backend_type: "sdk" }, { backend_type: "acp" }, { backend_type: "spawn" },
      { transport_lane: "channel" }, { channel_enabled: true },
      { provider_session_id: "provider-exact" }, { resume_at_message: "message-exact" },
      { runOptions: { model: "managed-model" } },
    ];
    try {
      for (const input of inputs) {
        expect(() => manager.create({ label: "Managed", command: "claude", ...input }))
          .toThrow("Managed conversations use ConversationControlService");
      }
      expect(db.prepare("SELECT count(*) AS count FROM console_sessions").get()).toEqual({ count: 0 });
    } finally { manager.close(); db.close(); }
  });
});
