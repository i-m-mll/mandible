import type { Db } from "./db.js";

/** One-time v229 migration; its migration entry requires_foreign_keys_off. */
export function migrateLocalAuthorizationEvidence(db: Db): void {
  const tables = ["briefing_collection_sharing_receipts", "briefing_destination_owners",
    "briefing_group_review_dispositions"];
  const existing = tables.filter(table => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('trigger','index') AND sql IS NOT NULL")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const triggers = objects.filter(object => object.type === "trigger"
    && existing.some(table => object.sql.includes(table)));
  const indexes = objects.filter(object => object.type === "index" && existing.includes(object.tbl_name));
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  for (const table of existing) {
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string };
    const methods = table === "briefing_group_review_dispositions" ? "'api_token','credential_signature'"
      : table === "briefing_collection_sharing_receipts" ? "'api_token','local_default','session_claim'"
      : "'api_token','local_default','session_claim','credential_signature'";
    const definition = original.sql.slice(original.sql.indexOf("("))
      .replaceAll("evidence_method = 'api_token'", `evidence_method IN (${methods})`)
      .replaceAll("evidence_method IN ('api_token','migration')", "evidence_method IN ('api_token','local_default','session_claim','credential_signature','migration')");
    const replacement = `${table}_authorization_migration`;
    db.exec(`CREATE TABLE ${replacement} ${definition}`);
    db.exec(`INSERT INTO ${replacement} SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
  }
  for (const object of [...indexes, ...triggers]) db.exec(object.sql);
}
