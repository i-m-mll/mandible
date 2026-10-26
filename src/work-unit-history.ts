import type { Db } from "./db.js";
import { mutateLedgerRecord } from "./ledger/mutation-history.js";
import type { LedgerAttributionInput } from "./ledger/types.js";

export function mutateWorkUnit<T>(db: Db, id: string, mutate: () => T,
  attribution?: LedgerAttributionInput | null): T {
  const unit = db.prepare("SELECT * FROM work_units WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  const issue = unit?.ledger_issue_id
    ? db.prepare("SELECT project_id FROM ledger_issues WHERE id = ?").get(unit.ledger_issue_id) as { project_id: string } | undefined
    : undefined;
  return mutateLedgerRecord(db, {
    entity_type: "work_unit", entity_id: id, project_id: issue?.project_id, attribution, source: "work_unit",
    snapshot: () => db.prepare("SELECT * FROM work_units WHERE id = ?").get(id) as Record<string, unknown> | undefined ?? null,
  }, mutate);
}
