import { describe, expect, it } from "vitest";

import { SessionManager } from "../src/session-manager.js";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";

describe("SessionManager Codex archive integration", () => {
  it("unarchives a Codex provider thread before creating a resume session", () => {
    const db = createMigratedDb({ setGlobal: true });
    const unarchived: string[] = [];
    const manager = new SessionManager(
      db,
      () => undefined,
      undefined,
      {
        archive: async () => undefined,
        unarchive: async (threadId) => { unarchived.push(threadId); },
      },
    );

    try {
      manager.create({
        label: "Resume Codex",
        command: "codex",
        backend_type: "spawn",
        provider_session_id: "thread-archived",
      });
      manager.create({
        label: "New Codex",
        command: "codex",
        backend_type: "spawn",
      });
      manager.create({
        label: "Claude",
        command: "claude",
        backend_type: "sdk",
        provider_session_id: "claude-session",
      });

      expect(unarchived).toEqual(["thread-archived"]);
    } finally {
      db.close();
    }
  });
});
