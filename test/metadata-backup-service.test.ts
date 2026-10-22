import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import SqliteDatabase from "../src/sqlite.js";
import { MetadataBackupService, type BackupWorkerInput } from "../src/metadata-backup-service.js";
import { waitUntil } from "./helpers/wait-until.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });

function fixture(factory?: (input: BackupWorkerInput) => Worker, logger = vi.fn()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-backup-service-"));
  const db = openDb(path.join(root, "ledger.db"));
  const service = new MetadataBackupService(db, logger, factory);
  const destination = path.join(root, "backup.sql");
  service.updateSetting("backup.destination", destination);
  cleanups.push(async () => { await service.close(); if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, service, destination };
}

function heldWriter() {
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const workers: Worker[] = [];
  const inputs: BackupWorkerInput[] = [];
  const facade = new URL("../src/sqlite.ts", import.meta.url).href;
  const writer = new URL("../src/ledger/backup.ts", import.meta.url).href;
  const source = `
    import {parentPort,workerData} from 'node:worker_threads';
    import Database from ${JSON.stringify(facade)};
    import {writeMetadataBackupFile} from ${JSON.stringify(writer)};
    const db = new Database(workerData.database,{readonly:true,fileMustExist:true});
    const gate = new Int32Array(workerData.gate);
    const prepare = db.prepare.bind(db); let held = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (!held && sql.includes('sqlite_master')) {
        const get = statement.get.bind(statement);
        statement.get = (...args) => { const result=get(...args); held=true; Atomics.store(gate,1,1); Atomics.wait(gate,0,0); return result; };
      }
      return statement;
    };
    let response;
    try { response={ok:true,value:writeMetadataBackupFile(db,workerData.staging)}; }
    catch(error) { response={ok:false,error:String(error)}; }
    finally { db.close(); }
    parentPort.postMessage(response); parentPort.close();
  `;
  return {
    workers, inputs,
    factory(input: BackupWorkerInput) {
      inputs.push(input);
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { execArgv: [], workerData: { ...input, gate: gate.buffer } });
      workers.push(worker);
      return worker;
    },
    ready: () => waitUntil(() => Atomics.load(gate, 1) === 1, "the actual backup read snapshot"),
    release() { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); },
  };
}

it("serves HTTP and timers and commits writes while an actual backup holds one consistent WAL snapshot", async () => {
  const held = heldWriter();
  const f = fixture(held.factory);
  f.service.updateSetting("private.snapshot", "before 'quoted'\ntext");
  f.db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('private.binary',?,0)").run(Buffer.from([0, 255, 39]));
  const server = createServer((_req, res) => {
    const value = f.db.prepare("SELECT value FROM settings WHERE key = 'private.snapshot'").get();
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Private HTTP listener has no address.");
  try {
    let finished = false;
    const backup = f.service.run().then(result => { finished = true; return result; });
    await held.ready();
    const [response, timer] = await Promise.all([
      fetch(`http://127.0.0.1:${address.port}/health`).then(response => response.json()),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 0)),
    ]);
    expect(response).toEqual({ value: "before 'quoted'\ntext" });
    expect(timer).toBe(true);
    expect(finished).toBe(false);
    f.service.updateSetting("private.snapshot", "after");
    expect(f.service.setting("private.snapshot")).toBe("after");
    expect(finished).toBe(false);
    held.release();
    expect(await backup).toMatchObject({ ok: true, path: f.destination });
    const restored = new SqliteDatabase();
    try {
      restored.exec(fs.readFileSync(f.destination, "utf8"));
      expect(restored.prepare("SELECT value FROM settings WHERE key = 'private.snapshot'").get()).toEqual({ value: "before 'quoted'\ntext" });
      expect(restored.prepare("SELECT value FROM settings WHERE key = 'private.binary'").get()).toEqual({ value: Buffer.from([0, 255, 39]) });
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally { restored.close(); }
  } finally {
    held.release();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it("coalesces scheduled ticks, serializes manual jobs and freezes each admitted destination", async () => {
  const held = heldWriter();
  const f = fixture(held.factory);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  f.service.updateSetting("backup.interval_hours", "1");
  f.service.reschedule();
  await vi.advanceTimersByTimeAsync(5_000);
  await held.ready();
  const manualDestination = path.join(f.root, "manual.sql");
  f.service.updateSetting("backup.destination", manualDestination);
  const manual = f.service.run();
  f.service.updateSetting("backup.destination", path.join(f.root, "later.sql"));
  await vi.advanceTimersByTimeAsync(3 * 3_600_000);
  expect(held.workers).toHaveLength(1);
  held.release();
  expect(await manual).toMatchObject({ ok: true, path: manualDestination });
  expect(held.inputs).toHaveLength(2);
  expect(fs.existsSync(f.destination)).toBe(true);
  expect(fs.existsSync(manualDestination)).toBe(true);
  expect(fs.existsSync(path.join(f.root, "later.sql"))).toBe(false);
  await f.service.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces the delayed startup timer when settings change and leaves no timer on close", async () => {
  const calls = vi.fn(() => { throw new Error("Disabled timer started a worker."); });
  const f = fixture(calls);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f.service.reschedule();
  f.service.reschedule();
  expect(vi.getTimerCount()).toBe(2);
  f.service.updateSetting("backup.enabled", "false");
  f.service.reschedule();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls).not.toHaveBeenCalled();
  await f.service.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("admits a manual successor immediately from its predecessor result", async () => {
  const f = fixture();
  const result = await f.service.run().then(first => {
    expect(first.ok).toBe(true);
    f.service.updateSetting("backup.destination", path.join(f.root, "successor.sql"));
    return f.service.run();
  });
  expect(result).toMatchObject({ ok: true, path: path.join(f.root, "successor.sql") });
});

it("preserves the previous backup and records a failed worker result", async () => {
  const source = `import fs from 'node:fs'; import {parentPort,workerData} from 'node:worker_threads'; fs.writeFileSync(workerData.staging,'partial'); parentPort.postMessage({ok:false,error:'private writer failure'}); parentPort.close();`;
  const f = fixture(input => new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { execArgv: [], workerData: input }));
  fs.writeFileSync(f.destination, "previous backup");
  expect(await f.service.run()).toEqual({ ok: false, error: "private writer failure" });
  expect(fs.readFileSync(f.destination, "utf8")).toBe("previous backup");
  expect(f.service.setting("backup.last_error")).toBe("private writer failure");
  expect(f.service.setting("backup.last_size_bytes")).toBe("");
  expect(fs.readdirSync(f.root).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

it("reaps active work and settles queued callers before database close without late publication or status writes", async () => {
  const held = heldWriter();
  const f = fixture(held.factory);
  fs.writeFileSync(f.destination, "previous backup");
  const active = f.service.run();
  await held.ready();
  const queued = f.service.run();
  await f.service.close();
  expect(await active).toMatchObject({ ok: false });
  expect(await queued).toMatchObject({ ok: false });
  expect(held.workers).toHaveLength(1);
  expect(held.workers[0].threadId).toBe(-1);
  expect(fs.readFileSync(f.destination, "utf8")).toBe("previous backup");
  expect(fs.readdirSync(f.root).filter(name => name.endsWith(".tmp"))).toEqual([]);
  const prepare = vi.spyOn(f.db, "prepare");
  f.db.close();
  expect(await f.service.run()).toMatchObject({ ok: false });
  await f.service.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(prepare).not.toHaveBeenCalled();
});

it("settles every caller and releases scheduled admission when SQLite rejects failure status persistence", async () => {
  const source = `import fs from 'node:fs'; import {parentPort,workerData} from 'node:worker_threads'; fs.writeFileSync(workerData.staging,'partial'); parentPort.postMessage({ok:false,error:'private writer failure'}); parentPort.close();`;
  const logs = vi.fn();
  const factory = vi.fn((input: BackupWorkerInput) => new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { execArgv: [], workerData: input }));
  const f = fixture(factory, logs);
  f.db.exec(`CREATE TRIGGER reject_backup_status BEFORE INSERT ON settings
    WHEN NEW.key = 'backup.last_error' BEGIN SELECT RAISE(ABORT, 'private status rejection'); END`);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  f.service.updateSetting("backup.interval_hours", "1");
  f.service.reschedule();
  await vi.advanceTimersByTimeAsync(5_000);
  await waitUntil(() => logs.mock.calls.length === 1, "the first scheduled failure result");
  await vi.advanceTimersByTimeAsync(3_600_000);
  await waitUntil(() => logs.mock.calls.length === 2, "the next scheduled failure result");
  const results = await Promise.all([f.service.run(), f.service.run()]);
  for (const result of results) expect(result).toMatchObject({ ok: false,
    error: expect.stringMatching(/private writer failure; backup status persistence failed:.*private status rejection/) });
  expect(factory).toHaveBeenCalledTimes(4);
  expect(logs.mock.calls.map(call => call[2])).toEqual([
    expect.objectContaining({ ok: false, error: expect.stringContaining("private status rejection") }),
    expect.objectContaining({ ok: false, error: expect.stringContaining("private status rejection") }),
  ]);
  expect(fs.readdirSync(f.root).filter(name => name.endsWith(".tmp"))).toEqual([]);
  await f.service.close();
  expect(vi.getTimerCount()).toBe(0);
});
