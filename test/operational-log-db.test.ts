// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { openOperationalLogStore } from "../src/operational-log-db.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

it("preserves operational records across bookkeeping retirement and readonly export", () => {
  const dir = fs.mkdtempSync(path.join(testRuntimeRoot, "operational-export-"));
  const canonicalPath = path.join(dir, "mandible.db");
  let store = openOperationalLogStore(canonicalPath)!;
  try {
    const insert = store.db.prepare("INSERT INTO daemon_log (id, ts, level, event) VALUES (?, ?, 'info', ?)");
    insert.run("other", 1, "other_event");
    insert.run("selected", 2, "selected_event");
    store.db.exec("CREATE TABLE operational_log_copy_state (source_path TEXT PRIMARY KEY, copied_rows INTEGER NOT NULL)");
    store.db.prepare("INSERT INTO operational_log_copy_state VALUES (?, ?)").run(canonicalPath, 2);
    const records = store.db.prepare("SELECT * FROM daemon_log ORDER BY id").all();
    const output = execFileSync(process.execPath, [
      "src/cli/operational-logs.ts", "export", "--canonical-db", canonicalPath,
      "--log-db", store.dbPath, "--event", "selected_event",
    ], { encoding: "utf8", timeout: 10_000 });
    expect(output.trim().split("\n").map(line => JSON.parse(line).id)).toEqual(["selected"]);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 2 });
    expect(store.db.prepare("SELECT copied_rows FROM operational_log_copy_state").get()).toEqual({ copied_rows: 2 });
    store.close();
    store = openOperationalLogStore(canonicalPath)!;
    expect(store.db.prepare("SELECT * FROM daemon_log ORDER BY id").all()).toEqual(records);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'operational_log_copy_state'").get()).toBeUndefined();
    expect(fs.existsSync(canonicalPath)).toBe(false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
