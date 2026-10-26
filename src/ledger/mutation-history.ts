import type { Db } from "../db.js";
import { LedgerStore } from "./store.js";
import type { LedgerAttributionInput } from "./types.js";

/** Use the existing event stream for canonical state without specialized history. */
export function mutateLedgerRecord<T>(db: Db, input: {
  entity_type: string;
  entity_id: string;
  project_id?: string | null;
  attribution?: LedgerAttributionInput | null;
  snapshot: () => Record<string, unknown> | null;
}, mutate: () => T): T {
  const nested = db.inTransaction;
  const store = new LedgerStore(db);
  let event: ReturnType<LedgerStore["recordEvent"]> | undefined;
  const result = db.transaction(() => {
    const before = input.snapshot();
    const result = mutate();
    const after = input.snapshot();
    const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
      .filter(key => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null));
    if (fields.length) event = store.recordEvent({
      entity_type: input.entity_type, entity_id: input.entity_id,
      event_type: `${input.entity_type}.${before ? after ? "updated" : "deleted" : "created"}`,
      project_id: input.project_id, source: "mandible", attribution: input.attribution ?? null,
      actor_type: input.attribution ? "mandible_user" : "system", notify: false,
      payload: { changed_fields: fields,
        previous: before ? Object.fromEntries(fields.map(key => [key, before[key] ?? null])) : null,
        current: after ? Object.fromEntries(fields.map(key => [key, after[key] ?? null])) : null },
    });
    return result;
  })();
  if (event && !nested) store.notifyEvent(event);
  return result;
}
