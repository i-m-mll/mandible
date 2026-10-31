import { AUTH_CLEARANCE_SCHEMA_SQL } from "./auth-clearance-schema.js";
import type { Db } from "./db.js";

/** One-time v229 migration; its migration entry requires_foreign_keys_off. */
export function migrateLocalAuthorizationEvidence(db: Db): void {
  const tables = ["briefing_collection_sharing_receipts", "briefing_destination_owners",
    "briefing_group_review_dispositions", "auth_clearances", "auth_clearance_uses"];
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
    let definition = original.sql.slice(original.sql.indexOf("("))
      .replaceAll("evidence_method = 'api_token'", `evidence_method IN (${methods})`)
      .replaceAll("evidence_method IN ('api_token','migration')", "evidence_method IN ('api_token','local_default','session_claim','credential_signature','migration')");
    if (table === "auth_clearances") {
      definition = definition.replace("grantee_credential_id TEXT NOT NULL", "grantee_credential_id TEXT");
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column: { name: string }) => column.name === "retired_at")) {
        const column = "created_from_request_id TEXT,";
        if (!definition.includes(column)) throw new Error("Clearance schema is missing its final provenance column.");
        definition = definition.replace(column, `${column}
          retired_at INTEGER,
          retirement_reason TEXT,
          CHECK((retired_at IS NULL AND retirement_reason IS NULL) OR (retired_at IS NOT NULL AND retirement_reason IS NOT NULL)),`);
      }
    }
    if (table === "auth_clearance_uses") {
      definition = definition.replace("requester_credential_id TEXT NOT NULL", "requester_credential_id TEXT")
        .replace("requester_evidence_method IN ('api_token','credential_signature')", "requester_evidence_method IN ('api_token','credential_signature','session_claim','ephemeral')");
    }
    const replacement = `${table}_authorization_migration`;
    db.exec(`CREATE TABLE ${replacement} ${definition}`);
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(column => `"${column.name}"`).join(", ");
    db.exec(`INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM ${table}`);
    if (table === "auth_clearances") {
      db.prepare(`UPDATE ${replacement} SET retired_at = ?, retirement_reason = 'credential_bound_scope_requires_reissue'
        WHERE grantee_credential_id IS NOT NULL AND revoked_at IS NULL AND retired_at IS NULL`).run(Date.now());
    }
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
  }
  for (const object of [...indexes, ...triggers]) db.exec(object.sql);
  for (const sql of AUTH_CLEARANCE_SCHEMA_SQL.filter(sql => sql.startsWith("CREATE TRIGGER IF NOT EXISTS"))) db.exec(sql);
}
