import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../db.js";
import { LedgerStore } from "./store.js";
import type { LedgerActorInput, LedgerAttributionInput, LedgerActorType, LedgerEventSource } from "./types.js";

const actors = new AsyncLocalStorage<LedgerActorInput>();

/** Carries attribution only; grants no authority to perform a mutation. */
export function withLedgerMutationActor<T>(actor: LedgerActorInput, action: () => T): T {
  return actors.run(actor, action);
}

/** Use the existing event stream for canonical state without specialized history. */
export function mutateLedgerRecord<T>(db: Db, input: {
  entity_type: string;
  entity_id: string;
  project_id?: string | null;
  attribution?: LedgerAttributionInput | null;
  actor_type?: LedgerActorType;
  actor_id?: string | null;
  source?: LedgerEventSource;
  payload?: Record<string, unknown>;
  snapshot: () => Record<string, unknown> | null;
}, mutate: () => T): T {
  const store = new LedgerStore(db);
  let event: ReturnType<LedgerStore["recordEvent"]> | undefined;
  const result = db.transaction(() => {
    const record = store.prepareEventRecorder({
      ...actors.getStore(),
      attribution: input.attribution === undefined ? actors.getStore()?.attribution ?? null : input.attribution,
      ...(input.actor_type ? { actor_type: input.actor_type } : {}),
      ...(input.actor_id !== undefined ? { actor_id: input.actor_id } : {}),
    });
    const before = input.snapshot();
    const result = mutate();
    const after = input.snapshot();
    const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
      .filter(key => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null));
    if (fields.length) event = record({
      entity_type: input.entity_type, entity_id: input.entity_id,
      event_type: `${input.entity_type}.${before ? after ? "updated" : "deleted" : "created"}`,
      project_id: input.project_id, source: input.source ?? "mandible",
      notify: false,
      payload: { ...input.payload, operation: before ? after ? "update" : "delete" : "create", changed_fields: fields },
    });
    return result;
  })();
  if (event) { const committed = event; db.afterCommit(() => store.notifyEvent(committed)); }
  return result;
}
