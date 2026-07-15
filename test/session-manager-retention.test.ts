import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate, setDb } from "../src/db.js";
import {
  SessionManager,
  TERMINAL_BACKEND_RETENTION_LIMIT,
} from "../src/session-manager.js";
import { SDKBackend } from "../src/backends/sdk-backend.js";

describe("SessionManager terminal backend retention", () => {
  it("evicts backend resources while preserving list and on-demand lookup behavior", () => {
    const db = new Database(":memory:");
    migrate(db);
    setDb(db);
    const manager = new SessionManager(db, () => undefined);
    const sessionIds: string[] = [];

    try {
      for (let index = 0; index < TERMINAL_BACKEND_RETENTION_LIMIT + 2; index += 1) {
        sessionIds.push(manager.create({
          label: `Finished ${index}`,
          command: "claude",
          backend_type: "sdk",
        }).id);
      }

      expect(manager.getAll()).toHaveLength(TERMINAL_BACKEND_RETENTION_LIMIT + 2);
      expect(manager.getRetentionStats()).toEqual({
        retainedTerminal: TERMINAL_BACKEND_RETENTION_LIMIT,
        dormant: 2,
      });

      const rehydrated = manager.get(sessionIds[0]);
      expect(rehydrated).toBeInstanceOf(SDKBackend);
      expect(manager.getAll()).toHaveLength(TERMINAL_BACKEND_RETENTION_LIMIT + 2);
      expect(manager.getRetentionStats()).toEqual({
        retainedTerminal: TERMINAL_BACKEND_RETENTION_LIMIT,
        dormant: 2,
      });
    } finally {
      manager.close();
      db.close();
    }
  });
});
