import { describe, expect, it } from "vitest";

import { setDb } from "../src/db.js";
import {
  SessionManager,
  TERMINAL_BACKEND_RETENTION_LIMIT,
} from "../src/session-manager.js";
import { PTYBackend } from "../src/backends/pty-backend.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

describe("SessionManager terminal backend retention", () => {
  it("loads copied sessions without reconciling or starting them in read-only mode", () => {
    const db = migratedMemoryDb();
    setDb(db);
    const seed = new SessionManager(db, () => undefined);
    const session = seed.create({
      label: "Copied running session",
      command: "/bin/sh",
      backend_type: "pty",
    });
    seed.close();
    db.prepare(
      "UPDATE console_sessions SET status = 'running', pid = 12345 WHERE id = ?",
    ).run(session.id);

    const preview = new SessionManager(db, () => undefined);
    try {
      preview.init({ readOnly: true });

      expect(preview.getAll().map((backend) => backend.meta)).toEqual([
        expect.objectContaining({ id: session.id, status: "running", pid: 12345 }),
      ]);
      expect(preview.getRetentionStats()).toEqual({ retainedTerminal: 0, dormant: 1 });
      expect(db.prepare(
        "SELECT status, pid FROM console_sessions WHERE id = ?",
      ).get(session.id)).toEqual({ status: "running", pid: 12345 });
    } finally {
      preview.close();
      db.close();
    }
  });

  it("evicts backend resources while preserving list and on-demand lookup behavior", () => {
    const db = migratedMemoryDb();
    setDb(db);
    const manager = new SessionManager(db, () => undefined);
    const sessionIds: string[] = [];

    try {
      for (let index = 0; index < TERMINAL_BACKEND_RETENTION_LIMIT + 2; index += 1) {
        sessionIds.push(manager.create({
          label: `Finished ${index}`,
          command: "/bin/sh",
          backend_type: "pty",
        }).id);
      }

      expect(manager.getAll()).toHaveLength(TERMINAL_BACKEND_RETENTION_LIMIT + 2);
      expect(manager.getRetentionStats()).toEqual({
        retainedTerminal: TERMINAL_BACKEND_RETENTION_LIMIT,
        dormant: 2,
      });

      const rehydrated = manager.get(sessionIds[0]);
      expect(rehydrated).toBeInstanceOf(PTYBackend);
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
