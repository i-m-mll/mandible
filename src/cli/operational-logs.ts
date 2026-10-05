#!/usr/bin/env node
import { parseCommand, stringOption, numberOption, flagOption } from "./grammar.js";

import {
  copyForwardLegacyDaemonLogs,
  getOperationalLogDbPath,
  openOperationalLogStore,
  planLegacyDaemonLogReclaim,
  verifyLegacyDaemonLogCopy,
  visibleDaemonLogSource,
} from "../operational-log-db.js";
import { getDbPath } from "../db.js";

type Options = {
  command: string;
  canonicalDbPath: string;
  logDbPath?: string;
  batchSize?: number;
  maxBatches?: number;
  record: boolean;
  level?: string;
  event?: string;
  subsystem?: string;
  since?: number;
  until?: number;
  limit?: number;
};


function parseArgs(argv: string[]): Options {
  const parsed = parseCommand(["logs", "daemon"], argv);
  return { command: parsed.command.split(".").at(-1)!, canonicalDbPath: stringOption(parsed, "canonical-db") ?? getDbPath(),
    logDbPath: stringOption(parsed, "log-db"), batchSize: numberOption(parsed, "batch-size"), maxBatches: numberOption(parsed, "max-batches"),
    record: !flagOption(parsed, "no-record"), level: stringOption(parsed, "level"), event: stringOption(parsed, "event"),
    subsystem: stringOption(parsed, "subsystem"), since: numberOption(parsed, "since"), until: numberOption(parsed, "until"), limit: numberOption(parsed, "limit") };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const readonly = options.command === "reclaim-plan" || (options.command === "verify" && !options.record) || options.command === "export";
  const dbPath = options.logDbPath ?? getOperationalLogDbPath(options.canonicalDbPath);
  const store = openOperationalLogStore(options.canonicalDbPath, {
    dbPath,
    readonly,
  });
  if (!store) throw new Error(`operational-log database does not exist: ${dbPath}`);
  try {
    if (options.command === "copy" || options.command === "reconcile") {
      const copy = copyForwardLegacyDaemonLogs(store, {
        batchSize: options.batchSize,
        maxBatches: options.maxBatches,
      });
      printJson(options.command === "reconcile"
        ? {
            copy,
            verification: copy.complete
              ? verifyLegacyDaemonLogCopy(store, { record: false })
              : null,
          }
        : copy);
      return;
    }
    if (options.command === "verify") {
      printJson(verifyLegacyDaemonLogCopy(store, { record: options.record }));
      return;
    }
    if (options.command === "reclaim-plan") {
      printJson(planLegacyDaemonLogReclaim(store));
      return;
    }
    exportRows(store.db, options);
  } finally {
    store.close();
  }
}

function exportRows(db: import("../db.js").Db, options: Options): void {
  const source = visibleDaemonLogSource(db);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.level) { clauses.push("level = ?"); params.push(options.level); }
  if (options.event) { clauses.push("event = ?"); params.push(options.event); }
  if (options.subsystem) { clauses.push("subsystem = ?"); params.push(options.subsystem); }
  if (options.since !== undefined) { clauses.push("ts >= ?"); params.push(options.since); }
  if (options.until !== undefined) { clauses.push("ts <= ?"); params.push(options.until); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = options.limit === undefined ? "" : "LIMIT ?";
  if (options.limit !== undefined) params.push(options.limit);
  const rows = db.prepare(
    `${source.cte} SELECT * FROM ${source.table} ${where} ORDER BY ts ASC, id ASC ${limit}`,
  ).iterate(...params) as Iterable<Record<string, unknown>>;
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
}







function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
