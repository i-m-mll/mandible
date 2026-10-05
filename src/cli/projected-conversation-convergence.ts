#!/usr/bin/env bun

import { parseCommand, stringOption, flagOption } from "./grammar.js";
import SqliteDatabase from "../sqlite.js";
import { pathToFileURL } from "node:url";
import { configureIngestionWorker, convergeProjectedConversationTitlesForWorker } from "../ingestion.js";
import { setDb, type Db } from "../db.js";

export async function convergeProjectedConversationCopy(dbPath: string) {
  const db = new SqliteDatabase(dbPath) as Db;
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    setDb(db);
    configureIngestionWorker(() => {}, () => {});
    return await convergeProjectedConversationTitlesForWorker(db);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseCommand(["projected-conversation-convergence"], process.argv.slice(2));
  const dbPath = stringOption(parsed, "db")!;
  const result = await convergeProjectedConversationCopy(dbPath);
  if (flagOption(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`Converged ${result.updated} projected conversation title(s).\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`projected-conversation-convergence failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
