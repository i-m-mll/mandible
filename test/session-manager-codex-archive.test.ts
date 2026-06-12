import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate, setDb } from "../src/db.js";
import { SessionManager } from "../src/session-manager.js";

function createMigratedDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("SessionManager Codex archive integration", () => {
  it("unarchives a Codex provider thread before creating a resume session", () => {
    const db = createMigratedDb();
    setDb(db);
    const unarchived: string[] = [];
    const manager = new SessionManager(
      db,
      () => undefined,
      undefined,
      {
        archive: () => undefined,
        unarchive: (threadId) => unarchived.push(threadId),
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
