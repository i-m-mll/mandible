// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { updateOrigin } from "../scripts/local-origin-migration.mjs";

it("changes only the registered origin under an exact compare-and-swap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-origin-cas-"));
  try {
    const db = new Database(path.join(root, "sessions.db"));
    db.exec(`CREATE TABLE instance_registrations (
      instance_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, role TEXT NOT NULL,
      public_origin TEXT NOT NULL, backend_origin TEXT NOT NULL,
      backend_generation TEXT NOT NULL, effect_ceiling_json TEXT NOT NULL,
      writable_roots_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO instance_registrations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "production", "install_original", "main", "https://app.mandible.localhost:19420",
      "http://127.0.0.1:29420", "generation_original", '["ledger:read"]', '["/tmp"]', 1,
    );
    const before = db.prepare("SELECT * FROM instance_registrations").get() as Record<string, unknown>;
    updateOrigin(db, "https://app.mandible.localhost:19420", "https://mandible.localhost", before);
    const after = db.prepare("SELECT * FROM instance_registrations").get() as Record<string, unknown>;
    expect(after).toMatchObject({ ...before, public_origin: "https://mandible.localhost", updated_at: expect.any(Number) });
    expect(() => updateOrigin(db, "https://app.mandible.localhost:19420", "https://mandible.localhost", before))
      .toThrow("changed during the guarded update");
    db.prepare("UPDATE instance_registrations SET backend_generation = 'unexpected' WHERE instance_id = 'production'").run();
    expect(() => updateOrigin(db, "https://mandible.localhost", "https://app.mandible.localhost:19420", after))
      .toThrow("changed during the guarded update");
    db.prepare("UPDATE instance_registrations SET backend_generation = 'generation_original' WHERE instance_id = 'production'").run();
    updateOrigin(db, "https://mandible.localhost", "https://app.mandible.localhost:19420", after);
    expect(db.prepare("SELECT * FROM instance_registrations").get()).toMatchObject({
      ...before, updated_at: expect.any(Number),
    });
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("leaves an installation without a completed cutover untouched in the rebuild hook", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-origin-no-cutover-"));
  try {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/local-origin-migration.mjs"), "converge-hook"], {
      env: { ...process.env, MANDIBLE_HOME: root }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ skipped: "no completed production cutover" });
    expect(fs.readdirSync(root)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
