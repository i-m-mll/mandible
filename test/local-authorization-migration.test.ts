// @vitest-environment node
import { expect, it } from "vitest";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { migrateLocalAuthorizationEvidence } from "../src/local-authorization-migration.js";
import { createUser } from "../src/users/store.js";

it("preserves historical token receipts while admitting truthful local attribution in the one-time migration", () => {
  const db = migratedMemoryDb();
  try {
    const user = createUser(db, { slug: "publisher", kind: "agent", display_name: "Publisher" });
    const insert = () => db.prepare(`INSERT INTO briefing_collection_sharing_receipts
      (id, operation, target_kind, target_id, subject_kind, subject_id, owner_kind, owner_id,
        reason, actor_user_id, evidence_method, credential_id, created_at)
      VALUES (?, 'share', 'group', 'group', 'briefing', 'briefing', 'group', 'owner', 'share report', ?, ?, NULL, 1)`);
    insert().run("historical", user.id, "api_token");
    const before = db.prepare("SELECT * FROM briefing_collection_sharing_receipts WHERE id = 'historical'").get();
    db.pragma("foreign_keys = OFF");
    db.transaction(() => migrateLocalAuthorizationEvidence(db))();
    db.pragma("foreign_keys = ON");
    expect(db.prepare("SELECT * FROM briefing_collection_sharing_receipts WHERE id = 'historical'").get()).toEqual(before);
    insert().run("local", user.id, "session_claim");
    expect(db.prepare("SELECT evidence_method FROM briefing_collection_sharing_receipts WHERE id = 'local'").get()).toEqual({ evidence_method: "session_claim" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() => db.prepare("UPDATE briefing_collection_sharing_receipts SET reason = 'changed'").run()).toThrow();
  } finally { db.close(); }
});
