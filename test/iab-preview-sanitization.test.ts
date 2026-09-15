// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { addCredential, setupOperator } from "../src/users/store.js";
import { sanitizePreviewDatabase } from "../scripts/iab-preview.mjs";

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

describe("preview database sanitization", () => {
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

    const sanitized = new Database(databasePath);
    expect(sanitized.prepare("SELECT id FROM user_credentials WHERE id = ?").get(credential.id)).toEqual({ id: credential.id });
    expect(sanitized.prepare("SELECT owner_credential_id FROM work_units WHERE id = 'work-unit-preview-history'").get())
      .toEqual({ owner_credential_id: credential.id });
    expect(sanitized.prepare("SELECT value FROM settings WHERE key = 'provider.secret.credential'").get()).toBeUndefined();
    expect(sanitized.pragma("foreign_key_check")).toEqual([]);
    sanitized.close();
  });
});
