import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, setDb } from "../../src/db.js";
import { SessionManager } from "../../src/session-manager.js";

let db: InstanceType<typeof SqliteDatabase> | null = null;
let manager: SessionManager | null = null;

afterEach(() => {
  manager?.close(); manager = null;
  db?.close(); db = null;
});

describe("SessionManager run options", () => {
  it("persists acknowledged values, mirrors model, and preserves legacy args and tool policy", async () => {
    db = new SqliteDatabase(":memory:"); migrate(db); setDb(db);
    manager = new SessionManager(db, () => undefined);
    const session = manager.create({
      label: "SDK", command: "claude", backend_type: "sdk",
      args: ["--flag", "kept", "--model", "old"], allowed_tools: ["Read"],
    });
    const result = await manager.updateOptions(session.id, {
      runOptions: { model: "fable", thinking_effort: "high" },
      allowedTools: ["Read", "Write"],
    });
    expect(result.applied.map((option) => option.id)).toEqual(["model", "thinking_effort"]);
    const row = db.prepare("SELECT args_json, run_options_json, allowed_tools FROM console_sessions WHERE id = ?")
      .get(session.id) as { args_json: string; run_options_json: string; allowed_tools: string };
    expect(JSON.parse(row.args_json)).toEqual(["--flag", "kept", "--model", "fable"]);
    expect(JSON.parse(row.run_options_json)).toEqual({ model: "fable", thinking_effort: "high" });
    expect(JSON.parse(row.allowed_tools)).toEqual(["Read", "Write"]);
  });

  it("rehydrates old/default rows without inventing provider current values", () => {
    db = new SqliteDatabase(":memory:"); migrate(db); setDb(db);
    manager = new SessionManager(db, () => undefined);
    const session = manager.create({ label: "Legacy", command: "claude", backend_type: "sdk", args: ["--model", "legacy"] });
    manager.close(); manager = new SessionManager(db, () => undefined); manager.init({ readOnly: true });
    const hydrated = manager.getAll()[0]!.meta;
    expect(hydrated.run_options).toEqual({});
    expect(hydrated.args).toEqual(["--model", "legacy"]);
  });
});
