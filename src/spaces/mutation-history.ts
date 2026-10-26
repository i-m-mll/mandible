import type { Db } from "../db.js";
import { mutateLedgerRecord } from "../ledger/mutation-history.js";

type AuthoredTable = "spaces" | "space_items" | "space_occurrences" | "space_edges" | "space_blocks" | "space_publications";

/** Compare authored fields in memory; history contains identifiers and field names only. */
export function mutateSpaceRecord<T>(db: Db, table: AuthoredTable, id: string, spaceId: string, action: () => T, projectId?: string | null): T {
  const space = db.prepare("SELECT project_id FROM spaces WHERE id=?").get(spaceId) as { project_id: string | null } | undefined;
  const destination = table === "space_publications"
    ? db.prepare("SELECT c.project_id FROM space_publications p JOIN ledger_project_checkouts c ON c.id=p.repo_id WHERE p.id=?").get(id) as { project_id: string } | undefined
    : undefined;
  return mutateLedgerRecord(db, {
    entity_type: table === "spaces" ? "space" : table.replace(/s$/, ""),
    entity_id: id,
    project_id: projectId ?? destination?.project_id ?? space?.project_id,
    payload: { space_id: spaceId },
    snapshot: () => {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      const { created_at: _created, updated_at: _updated, ...authored } = row;
      return authored;
    },
  }, action);
}
