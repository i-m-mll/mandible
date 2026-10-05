#!/usr/bin/env bun
import {
  DEFAULT_ROW_LIMIT,
  ledgerInfo,
  ledgerSchema,
  listLedgerObjects,
  openReadOnlyLedger,
  runReadOnlyQuery,
  type ReadOnlyLedger,
} from "../db-read.js";

function usage(): void {
  process.stderr.write(`Usage:
  mandible db query <sql> [--limit N] [--json]
  mandible db tables [--json]
  mandible db schema [table] [--json]
  mandible db info [--json]

Reads the live ledger database, including its write-ahead log, over a
connection SQLite itself holds read-only. Set MANDIBLE_DB to read a different
database file; a SQLite URI is refused, so a stale 'immutable=1' snapshot is
not something these commands can be pointed at.

query accepts one row-returning statement. Output is tab-separated by default
and lossless column arrays under --json. --limit caps rows at ${DEFAULT_ROW_LIMIT}
by default; --limit 0 reads them all. Truncation is always announced.
`);
}

interface Args {
  positional: string[];
  json: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], json: false, limit: DEFAULT_ROW_LIMIT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--limit expects a non-negative integer, got: ${raw}`);
      }
      args.limit = parsed;
      continue;
    }
    args.positional.push(arg);
  }
  return args;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return String(value).replace(/[\t\n\r]/g, " ");
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    process.exitCode = command ? 0 : 2;
    return;
  }

  const args = parseArgs(rest);
  let ledger: ReadOnlyLedger | null = null;
  try {
    ledger = openReadOnlyLedger();
    switch (command) {
      case "query": {
        const sql = args.positional.join(" ");
        const result = runReadOnlyQuery(ledger, sql, args.limit);
        if (args.json) {
          printJson({ database: ledger.path, ...result });
          break;
        }
        process.stdout.write(`${result.columns.join("\t")}\n`);
        for (const row of result.rows) {
          process.stdout.write(`${row.map(cell).join("\t")}\n`);
        }
        if (result.truncated) {
          process.stderr.write(
            `-- truncated at ${args.limit} rows; pass --limit 0 to read them all\n`,
          );
        }
        break;
      }
      case "tables": {
        const objects = listLedgerObjects(ledger);
        if (args.json) {
          printJson({ database: ledger.path, objects });
          break;
        }
        for (const object of objects) {
          process.stdout.write(`${object.type}\t${object.name}\n`);
        }
        break;
      }
      case "schema": {
        const entries = ledgerSchema(ledger, args.positional[0]);
        if (args.json) {
          printJson({ database: ledger.path, entries });
          break;
        }
        for (const entry of entries) {
          process.stdout.write(`${entry.sql.trim()};\n\n`);
        }
        break;
      }
      case "info": {
        const info = ledgerInfo(ledger);
        if (args.json) {
          printJson(info);
          break;
        }
        for (const [key, value] of Object.entries(info)) {
          process.stdout.write(`${key}\t${String(value)}\n`);
        }
        break;
      }
      default:
        usage();
        process.exitCode = 2;
    }
  } finally {
    ledger?.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
