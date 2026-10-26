import type { Db } from "../db.js";
import { mutateLedgerRecord } from "../ledger/mutation-history.js";

const records = {
  briefing: { table: "briefings", children: ["SELECT * FROM briefing_members WHERE briefing_id = ? ORDER BY user_id"] },
  briefing_bundle: { table: "briefing_bundles", children: ["SELECT * FROM briefing_bundle_members WHERE bundle_id = ? ORDER BY layout_position, subgroup_position, briefing_id"] },
  briefing_group: { table: "briefing_groups", children: ["SELECT * FROM briefing_group_updates WHERE group_id = ? ORDER BY position", "SELECT * FROM briefing_destination_owners WHERE group_id = ? ORDER BY logical_artifact_id"] },
  briefing_route: { table: "briefing_destination_routes", children: ["SELECT * FROM briefing_destination_policies WHERE route_key = ?"] },
} as const;

export function mutateBriefing<T>(db: Db, kind: keyof typeof records, id: string, action: () => T): T {
  const record = records[kind];
  return mutateLedgerRecord(db, { entity_type: kind, entity_id: id, snapshot: () => {
    const row = db.prepare(`SELECT * FROM ${record.table} WHERE ${kind === "briefing_route" ? "route_key" : "id"} = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? { ...row, membership: record.children.map(sql => db.prepare(sql).all(id)) } : null;
  } }, action);
}
