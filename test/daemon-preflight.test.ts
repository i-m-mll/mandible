import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/db-migrations.js";
import SqliteDatabase from "../src/sqlite.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

it("preflights an active ledger using the WAL schema version without changing its bytes", () => {
  const home = fs.mkdtempSync(path.join(testRuntimeRoot, "daemon-preflight-"));
  const database = path.join(home, "ledger.db");
  const writer = new SqliteDatabase(database);
  try {
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
    const setVersion = writer.prepare("INSERT OR REPLACE INTO meta VALUES ('schema_version', ?)");
    const preflight = () => spawnSync(process.execPath, ["--no-install", path.resolve("src/index.ts"), "--preflight", database], {
      env: { ...process.env, MANDIBLE_HOME: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    const snapshot = () => [fs.readFileSync(database), fs.readFileSync(`${database}-wal`)];

    setVersion.run(String(CURRENT_SCHEMA_VERSION));
    const supportedBytes = snapshot();
    const supported = preflight();
    expect(supported.status, supported.stderr).toBe(0);
    expect(JSON.parse(supported.stdout)).toEqual({ schema: "mandible-daemon-preflight@1", schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(snapshot()).toEqual(supportedBytes);

    setVersion.run(String(CURRENT_SCHEMA_VERSION + 1));
    const newerBytes = snapshot();
    const newer = preflight();
    expect(newer.status, newer.stderr).toBe(1);
    expect(newer.stderr).toContain(`Database schema v${CURRENT_SCHEMA_VERSION + 1} is newer`);
    expect(snapshot()).toEqual(newerBytes);
  } finally {
    writer.close();
    fs.rmSync(home, { recursive: true });
  }
});
