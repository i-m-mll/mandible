#!/usr/bin/env node

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
  const dbIndex = process.argv.indexOf("--db");
  const dbPath = dbIndex >= 0 ? process.argv[dbIndex + 1] : undefined;
  if (!dbPath || dbPath.startsWith("--")) {
    throw new Error("Usage: projected-conversation-convergence --db PATH [--json]");
  }
  const result = await convergeProjectedConversationCopy(dbPath);
  if (process.argv.includes("--json")) {
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
