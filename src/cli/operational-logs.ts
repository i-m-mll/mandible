#!/usr/bin/env node

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

function usage(): never {
  process.stderr.write(`Usage:
  mandible logs daemon copy [--batch-size N] [--max-batches N] [--canonical-db PATH] [--log-db PATH]
  mandible logs daemon reconcile [--batch-size N] [--max-batches N] [--canonical-db PATH] [--log-db PATH]
  mandible logs daemon verify [--no-record] [--canonical-db PATH] [--log-db PATH]
  mandible logs daemon reclaim-plan [--canonical-db PATH] [--log-db PATH]
  mandible logs daemon export [--level LEVEL] [--event EVENT] [--subsystem NAME] [--since MS] [--until MS] [--limit N]

Copy is bounded and resumable. Verify records its pass only in the operational-log
database. Reclaim-plan is read-only and never drops rows, indexes, or tables.
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const command = argv.shift();
  if (!command || !["copy", "reconcile", "verify", "reclaim-plan", "export"].includes(command)) usage();
  const options: Options = {
    command,
    canonicalDbPath: getDbPath(),
    record: true,
  };
  while (argv.length > 0) {
    const arg = argv.shift();
    switch (arg) {
      case "--canonical-db": options.canonicalDbPath = requireValue(argv, arg); break;
      case "--log-db": options.logDbPath = requireValue(argv, arg); break;
      case "--batch-size": options.batchSize = positiveInteger(requireValue(argv, arg), arg); break;
      case "--max-batches": options.maxBatches = positiveInteger(requireValue(argv, arg), arg); break;
      case "--no-record": options.record = false; break;
      case "--level": options.level = requireValue(argv, arg); break;
      case "--event": options.event = requireValue(argv, arg); break;
      case "--subsystem": options.subsystem = requireValue(argv, arg); break;
      case "--since": options.since = finiteNumber(requireValue(argv, arg), arg); break;
      case "--until": options.until = finiteNumber(requireValue(argv, arg), arg); break;
      case "--limit": options.limit = positiveInteger(requireValue(argv, arg), arg); break;
      case "-h":
      case "--help": usage();
      default: throw new Error(`unknown option: ${arg ?? ""}`);
    }
  }
  return options;
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

function requireValue(argv: string[], option: string): string {
  const value = argv.shift();
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} requires a positive integer`);
  return parsed;
}

function finiteNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${option} requires a finite number`);
  return parsed;
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
