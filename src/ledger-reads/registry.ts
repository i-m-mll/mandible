import { issueSummaries } from "./issues.js";
import { authHistory } from "./auth-history.js";
import { artifactSeries } from "./artifacts.js";
import { graphPayload } from "./graph.js";
import { inboxGlobal } from "./inbox.js";
import { briefingsList } from "./briefings.js";
import type { Db } from "../db.js";
import { buildProjectTimelineProjection } from "../ledger/timeline-projection.js";

function diagnosticsDelay(db: Db, { ms }: { ms: number }): { elapsed_ms: number; iterations: number } {
  if (!Number.isFinite(ms) || ms < 0) throw new Error("diagnostics_delay ms must be finite and nonnegative");
  const statement = db.prepare(`WITH RECURSIVE work(n) AS (
    VALUES(1) UNION ALL SELECT n + 1 FROM work WHERE n < 10000
  ) SELECT sum(n) FROM work`);
  const started = performance.now();
  let iterations = 0;
  while (performance.now() - started < ms) {
    statement.get();
    iterations += 10000;
  }
  return { elapsed_ms: performance.now() - started, iterations };
}

/** Add pure ledger reads here; the transport derives its closed protocol from this registry. */
export const ledgerReads = {
  briefings_list: briefingsList,
  inbox_global: inboxGlobal,
  graph_payload: graphPayload,
  artifact_series: artifactSeries,
  auth_history: authHistory,
  issue_summaries: issueSummaries,
  timeline_projection: buildProjectTimelineProjection,
  diagnostics_delay: diagnosticsDelay,
};

export type LedgerReadKind = keyof typeof ledgerReads;
export type LedgerReadParams<K extends LedgerReadKind> = Parameters<typeof ledgerReads[K]>[1];
export type LedgerReadResult<K extends LedgerReadKind> = ReturnType<typeof ledgerReads[K]>;

export function runLedgerRead<K extends LedgerReadKind>(db: Db, kind: K, params: LedgerReadParams<K>): LedgerReadResult<K> {
  const read = ledgerReads[kind] as (db: Db, params: LedgerReadParams<K>) => LedgerReadResult<K>;
  return read(db, params);
}

export type LedgerReadRequest = {
  [K in LedgerReadKind]: { id: number; kind: K; params: LedgerReadParams<K> };
}[LedgerReadKind];

export type LedgerReadResponse =
  | { id: number; ok: true; value: LedgerReadResult<LedgerReadKind> }
  | { id: number; ok: false; message: string };
