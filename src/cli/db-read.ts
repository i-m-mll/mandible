#!/usr/bin/env node
import { parseCommand, commandHelp, numberOption, flagOption } from "./grammar.js";
import {
  DEFAULT_ROW_LIMIT,
  ledgerInfo,
  ledgerSchema,
  listLedgerObjects,
  openReadOnlyLedger,
  runReadOnlyQuery,
  type ReadOnlyLedger,
} from "../db-read.js";

function usage(): void { process.stderr.write(commandHelp(["db"])); }

interface Args {
  positional: string[];
  json: boolean;
  limit: number;
}

function parseArgs(argv: string[], command: string): Args {
  const parsed = parseCommand(["db", command], argv);
  return { positional: parsed.positionals, json: flagOption(parsed, "json"), limit: numberOption(parsed, "limit") ?? DEFAULT_ROW_LIMIT };
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

  const args = parseArgs(rest, command);
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
