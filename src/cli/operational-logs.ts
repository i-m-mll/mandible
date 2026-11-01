#!/usr/bin/env bun
import { parseCommand, stringOption, numberOption } from "./grammar.js";

import {
  getOperationalLogDbPath,
  openOperationalLogStore,
} from "../operational-log-db.js";
import { getDbPath } from "../db.js";

type Options = {
  canonicalDbPath: string;
  logDbPath?: string;
  level?: string;
  event?: string;
  subsystem?: string;
  since?: number;
  until?: number;
  limit?: number;
};

function parseArgs(argv: string[]): Options {
  const parsed = parseCommand(["logs", "daemon"], argv);
  return {
    canonicalDbPath: stringOption(parsed, "canonical-db") ?? getDbPath(),
    logDbPath: stringOption(parsed, "log-db"),
    level: stringOption(parsed, "level"),
    event: stringOption(parsed, "event"),
    subsystem: stringOption(parsed, "subsystem"),
    since: numberOption(parsed, "since"),
    until: numberOption(parsed, "until"),
    limit: numberOption(parsed, "limit"),
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = options.logDbPath ?? getOperationalLogDbPath(options.canonicalDbPath);
  const store = openOperationalLogStore(options.canonicalDbPath, {
    dbPath,
    readonly: true,
  });
  if (!store) throw new Error(`operational-log database does not exist: ${dbPath}`);
  try {
    exportRows(store.db, options);
  } finally {
    store.close();
  }
}

function exportRows(db: import("../db.js").Db, options: Options): void {
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
    `SELECT * FROM daemon_log ${where} ORDER BY ts ASC, id ASC ${limit}`,
  ).iterate(...params) as Iterable<Record<string, unknown>>;
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
