// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.ts";
import { openDb } from "../src/db.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { addCredential, setupOperator } from "../src/users/store.js";
import { reloadLocalFrontDoor, sanitizePreviewDatabase } from "../scripts/iab-preview.mjs";

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

describe("preview database sanitization", () => {
  it("does not reload an old-storage preview gateway into an empty pinned CA", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-old-ca-")); roots.add(home);
    const oldStorage = path.join(home, "old-default-caddy-storage");
    fs.mkdirSync(oldStorage, { recursive: true });
    fs.writeFileSync(path.join(oldStorage, "root.crt"), "old-root");
    const config = path.join(home, "config", "local-sessions", "Caddyfile");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, `{\n storage file_system ${JSON.stringify(oldStorage)}\n}\n`);
    const binary = path.join(home, "runtime", "caddy", "2.11.3", "caddy");
    const marker = path.join(home, "reload-invoked");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, `#!/bin/sh\nprintf x > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    const previousHome = process.env.MANDIBLE_HOME;
    process.env.MANDIBLE_HOME = home;
    try {
      expect(() => reloadLocalFrontDoor()).toThrow();
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readFileSync(config, "utf8")).toContain(oldStorage);
      expect(fs.existsSync(path.join(home, "config", "local-sessions", "caddy-storage"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.MANDIBLE_HOME;
      else process.env.MANDIBLE_HOME = previousHome;
    }
  });

  it("removes capability-bearing state without deleting referenced provenance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-sanitize-")); roots.add(root);
    const databasePath = path.join(root, "preview.db");
    const db = openDb(databasePath);
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" }, 1_000);
    const credential = addCredential(db, operator.id, {
      type: "api_token",
      fingerprint: `sha256:${"a".repeat(64)}`,
      label: "attribution-only",
    }, 1_001);
    db.prepare(`INSERT INTO work_units
      (id, issue_id, repo_id, branch, kind, state, created_at, owner_user_id, owner_credential_id, custody_generation)
      VALUES ('work-unit-preview-history', 'issue-preview-history', 'mandible', 'feature/history', 'solo', 'committed', 1002, ?, ?, 1)`)
      .run(operator.id, credential.id);
    setSetting(db, "provider.secret.credential", "must-not-survive");
    db.close();

    sanitizePreviewDatabase(databasePath);

    const sanitized = new SqliteDatabase(databasePath);
    expect(sanitized.prepare("SELECT id FROM user_credentials WHERE id = ?").get(credential.id)).toEqual({ id: credential.id });
    expect(sanitized.prepare("SELECT owner_credential_id FROM work_units WHERE id = 'work-unit-preview-history'").get())
      .toEqual({ owner_credential_id: credential.id });
    expect(sanitized.prepare("SELECT value FROM settings WHERE key = 'provider.secret.credential'").get()).toBeUndefined();
    expect(sanitized.pragma("foreign_key_check")).toEqual([]);
    sanitized.close();
  });
});
