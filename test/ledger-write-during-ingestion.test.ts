// @vitest-environment node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { IngestionActor } from "../src/ingestion-actor.js";
import { ingestExactSelectedPath } from "../src/ingestion.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";

const SYSTEM_ACTOR = { attribution: systemAction() };

let tempDir = "";
let dbPath = "";
let db: Db;
let store: LedgerStore;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-ingestion-contention-"));
  previousHome = process.env.HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = path.join(tempDir, "home");
  process.env.CODEX_HOME = path.join(tempDir, "home", ".codex");
  dbPath = path.join(tempDir, "mandible.db");
  db = openDb(dbPath);
  store = new LedgerStore(db);
});

afterEach(() => {
  db.close();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeIssues(): { source: string; targetShortId: string } {
  const root = path.join(tempDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  const { project } = resolveProjectForCheckout(db, {
    root,
    name: "repo",
    defaultBranch: "main",
    remoteUrl: "git@github.com:mll/contention.git",
  });
  const make = (title: string) => store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: project.id,
    title,
    body: title,
    kind: "bug",
    priority: "normal",
    labels: [],
    actor_type: "agent",
    author_display: "Agent",
  });
  const source = make("source");
  const target = make("target");
  return { source: source.id, targetShortId: target.short_id };
}

function commentCount(issueId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM ledger_comments WHERE issue_id = ?").get(issueId) as { n: number }).n;
}

function codexRow(type: string, payload: unknown, second: number): string {
  const timestamp = new Date(Date.UTC(2026, 6, 2, 0, 0, second)).toISOString();
  return `${JSON.stringify({ type, timestamp, payload })}\n`;
}

it("records every ledger comment while ingestion appends to a live transcript", async () => {
  const { source, targetShortId } = makeIssues();
  const sessionId = "01a00000-0000-7000-8000-00000000c0de";
  const sessionDir = path.join(tempDir, "home", ".codex", "sessions", "2026", "07", "02");
  const transcript = path.join(sessionDir, `rollout-2026-07-02T00-00-00-${sessionId}.jsonl`);
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(transcript, codexRow("session_meta", { id: sessionId, cwd: "/tmp/project" }, 0));

  const ingestionWarnings: string[] = [];
  const actor = new IngestionActor({
    dbPath,
    logger: (level, message, details) => {
      if (level === "warn" || level === "error") ingestionWarnings.push(`${message} ${JSON.stringify(details)}`);
    },
    publish: () => undefined,
    workerUrl: new URL("../src/ingestion-worker.ts", import.meta.url),
  });
  let appending = true;
  const filler = "x".repeat(64 * 1024);
  const appender = (async () => {
    for (let second = 1; appending; second += 1) {
      await fsp.appendFile(transcript, codexRow("response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `${second} ${filler}` }],
      }, second % 60));
      await ingestExactSelectedPath(actor, transcript).catch((error) => {
        throw new Error(`${String(error)}\n${ingestionWarnings.join("\n")}`);
      });
    }
  })();

  const attempts = 300;
  const failures: string[] = [];
  try {
    for (let i = 0; i < attempts; i += 1) {
      const before = commentCount(source);
      try {
        store.addComment(source, {
          ...SYSTEM_ACTOR,
          body: `attempt ${i} cites [issue:${targetShortId}]`,
          actor_type: "agent",
          author_display: "Agent",
        });
      } catch (error) {
        failures.push(`${i}: ${String(error)}; committed=${commentCount(source) > before}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  } finally {
    appending = false;
    await appender;
    await actor.close();
  }

  const ingested = db.prepare("SELECT block_count FROM conversations WHERE session_id = ?").get(sessionId) as
    | { block_count: number }
    | undefined;
  expect(ingested?.block_count ?? 0).toBeGreaterThan(10);
  expect(failures).toEqual([]);
  expect(commentCount(source)).toBe(attempts);
  const referenceSources = db.prepare(
    `SELECT count(*) AS n FROM ledger_issue_relationship_sources
     WHERE source_entity_type = 'comment' AND relationship_type = 'references' AND deleted_at IS NULL`,
  ).get() as { n: number };
  expect(referenceSources.n).toBe(attempts);
}, 60_000);

it("waits out an ingestion-length write transaction instead of failing", async () => {
  const { source } = makeIssues();
  // 899 ms is the longest measured ingestion hold (full ingest of a 1.4 GB transcript).
  const holdMs = 900;
  const sqliteFacade = new URL("../src/sqlite.ts", import.meta.url).href;
  const holder = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { workerData, parentPort } from "node:worker_threads";
    const { default: SqliteDatabase } = await import(${JSON.stringify(sqliteFacade)});
    const db = new SqliteDatabase(workerData.dbPath);
    db.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("held");
    const until = performance.now() + workerData.holdMs;
    while (performance.now() < until) {}
    db.exec("COMMIT");
    db.close();
  `)}`), { workerData: { dbPath, holdMs } });
  try {
    await new Promise((resolve, reject) => {
      holder.once("message", resolve);
      holder.once("error", reject);
    });
    store.addComment(source, {
      ...SYSTEM_ACTOR,
      body: "written while ingestion holds the lock",
      actor_type: "agent",
      author_display: "Agent",
    });
    expect(commentCount(source)).toBe(1);
  } finally {
    await holder.terminate();
  }
}, 10_000);
