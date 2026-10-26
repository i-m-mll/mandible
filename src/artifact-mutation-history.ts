import type { Db } from "./db.js";
import { mutateLedgerRecord } from "./ledger/mutation-history.js";

export function mutateArtifactRecord<T>(db: Db,
  table: "artifact_links" | "artifact_drafts" | "project_artifact_associations", id: string, action: () => T): T {
  return mutateLedgerRecord(db, { entity_type: table === "artifact_drafts" ? "artifact_draft"
    : table === "artifact_links" ? "artifact_link" : "project_artifact_association", entity_id: id,
    snapshot: () => db.prepare(`SELECT * FROM ${table} WHERE ${table === "artifact_drafts" ? "artifact_id" : "id"} = ?`)
      .get(id) as Record<string, unknown> | undefined ?? null,
  }, action);
}
