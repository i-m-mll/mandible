// @vitest-environment node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import SqliteDatabase from "../src/sqlite.js";
import { describe, expect, it } from "vitest";

import { IngestionActor } from "../src/ingestion-actor.js";
import { ConversationSourceChangedError } from "../src/conversations/source-store.js";
import { STATE_DEADLINE_MS, waitUntil } from "./helpers/wait-until.js";

const TEST_WORKER_SOURCE = `
  import { parentPort } from "node:worker_threads";
  parentPort.postMessage({ kind: "ready" });
  parentPort.on("message", (request) => {
    if (request.kind === "ingest" && request.paths.includes("source-change")) {
      parentPort.postMessage({ kind: "result", id: request.id, ok: false, error: "Failed to ingest 1 source(s)", errorCode: "conversation_source_changed" });
      return;
    }
    if (request.kind === "ingest" && request.paths.includes("never")) return;
    const until = performance.now() + 200;
    while (performance.now() < until) { /* representative CPU-bound worker task */ }
    parentPort.postMessage({ kind: "result", id: request.id, ok: true });
  });
`;

function testWorkerUrl(): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(TEST_WORKER_SOURCE)}`);
}

describe("ingestion worker actor", () => {
  it("repairs unchanged old epochs through the unmocked Bun TypeScript source-runtime actor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-source-runtime-actor-"));
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./helpers/ingestion-source-runtime.ts", import.meta.url)), root],
        { encoding: "utf8", timeout: 15_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("source-runtime actor repaired unchanged Gemini epochs");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the caller event loop responsive during CPU-heavy ingestion work", async () => {
    const actor = new IngestionActor({
      dbPath: ":memory:",
      logger: () => undefined,
      publish: () => undefined,
      workerUrl: testWorkerUrl(),
    });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    try {
      await actor.ingest(["heavy"]);
      expect(ticks).toBeGreaterThanOrEqual(8);
    } finally {
      clearInterval(timer);
      await actor.close();
    }
  });

  it("rejects queued work when shutdown safely cancels the worker", async () => {
    const actor = new IngestionActor({
      dbPath: ":memory:",
      logger: () => undefined,
      publish: () => undefined,
      workerUrl: testWorkerUrl(),
    });
    const pending = actor.ingest(["never"]);
    const rejected = expect(pending).rejects.toThrow("ingestion worker stopped");
    await actor.close();
    await rejected;
  });

  it("preserves the typed source-change race across the worker protocol", async () => {
    const actor = new IngestionActor({
      dbPath: ":memory:",
      logger: () => undefined,
      publish: () => undefined,
      workerUrl: testWorkerUrl(),
    });
    try {
      await expect(actor.ingest(["source-change"]))
        .rejects.toBeInstanceOf(ConversationSourceChangedError);
    } finally {
      await actor.close();
    }
  });
});


it("opens the same pinned SQLite database in the actual ingestion Worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-real-ingestion-worker-"));
  const dbPath = path.join(root, "ledger.db");
  const db = openDb(dbPath);
  const warnings: string[] = [];
  const actor = new IngestionActor({
    dbPath,
    logger: (level, message) => { if (level === "warn" || level === "error") warnings.push(message); },
    publish: () => undefined,
    workerUrl: new URL("../src/ingestion-worker.ts", import.meta.url),
  });
  try {
    await actor.ingest([]);
    await actor.reconcile();
    expect(warnings).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    await actor.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


it("T4: the ingestion worker checkpoints outstanding WAL frames", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-worker-checkpoint-"));
  const dbPath = path.join(root, "ledger.db");
  const db = openDb(dbPath);
  const originalAutocheckpoint = db.pragma("wal_autocheckpoint", { simple: true });
  db.exec("CREATE TABLE checkpoint_payload (body BLOB)");
  const reader = new SqliteDatabase(dbPath, { readonly: true });
  const actor = new IngestionActor({
    dbPath,
    mainDb: db,
    checkpointIntervalMs: 10,
    logger: () => undefined,
    publish: () => undefined,
    workerUrl: new URL("../src/ingestion-worker.ts", import.meta.url),
  });
  const progress = () => db.prepare("PRAGMA wal_checkpoint(NOOP)").get() as {
    busy: number; log: number; checkpointed: number;
  };
  try {
    await waitUntil(() => db.pragma("wal_autocheckpoint", { simple: true }) === 0,
      "worker checkpointer ownership");
    // Pin the pre-write snapshot so the timer cannot finish before we observe the backlog.
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM checkpoint_payload").get();
    const insert = db.prepare("INSERT INTO checkpoint_payload VALUES (zeroblob(4096))");
    db.transaction(() => {
      for (let i = 0; i < 1100; i++) insert.run();
    })();
    const backlog = progress();
    expect(backlog.log - backlog.checkpointed).toBeGreaterThan(1000);
    reader.exec("ROLLBACK");
    const completed = await waitUntil(() => {
      const current = progress();
      return current.log >= backlog.log && current.checkpointed === current.log && current;
    }, "worker to checkpoint all WAL frames");
    expect(completed.busy).toBe(0);
    await actor.close();
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(originalAutocheckpoint);
  } finally {
    await actor.close();
    reader.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "darwin")("rejects an unowned loaded library and a forged Worker selection receipt", () => {
  const runtimeUrl = new URL("../src/sqlite-runtime.ts", import.meta.url).href;
  const facadeUrl = new URL("../src/sqlite.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    import { Worker, setEnvironmentData } from "node:worker_threads";
    const { configureSqliteRuntime, SQLITE_RUNTIME_LOCK, sqliteRuntimePaths } = await import(${JSON.stringify(runtimeUrl)});
    const unowned = new DatabaseSync(":memory:");
    try { configureSqliteRuntime(DatabaseSync); throw new Error("unowned selection accepted"); }
    catch (error) { if (!String(error).includes("already loaded")) throw error; }
    setEnvironmentData("mandible.sqlite.library-owner@1", {
      pid: process.pid, sha256: SQLITE_RUNTIME_LOCK.librarySha256,
      sourceId: SQLITE_RUNTIME_LOCK.sourceId, filename: process.env.MANDIBLE_SQLITE_LIBRARY || sqliteRuntimePaths().library,
    });
    const source = 'import { parentPort } from "node:worker_threads"; try { const { default: Database } = await import(' + ${JSON.stringify(JSON.stringify(facadeUrl))} + '); const db = new Database(); db.close(); parentPort.postMessage("forged receipt accepted"); } catch (error) { parentPort.postMessage(String(error)); }';
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)), { execArgv: [] });
    const message = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    await worker.terminate(); unowned.close();
    if (!String(message).includes("Loaded SQLite library does not match")) throw new Error(String(message));
    console.log("unowned and forged identity rejected");
  `], { encoding: "utf8", timeout: STATE_DEADLINE_MS });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("unowned and forged identity rejected");
});
