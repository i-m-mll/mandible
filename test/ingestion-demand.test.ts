import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IngestionActor } from "../src/ingestion-actor.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { startIngestion, stopIngestionGracefully, triggerExactPathIngest, triggerTargetedIngest } from "../src/ingestion.js";
import { waitUntil } from "./helpers/wait-until.js";

vi.mock("../src/ingestion-actor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ingestion-actor.js")>();
  return {
    ...actual,
    canUseDefaultIngestionWorker: () => true,
    IngestionActor: class extends actual.IngestionActor {
      constructor(options: import("../src/ingestion-actor.js").IngestionActorOptions) {
        super({ ...options, workerUrl: new URL("./helpers/ingestion-demand-worker.ts", import.meta.url) });
      }
    },
  };
});

interface Observation { message: string; details: Record<string, unknown> }
let fixture: ReturnType<typeof setup> | undefined;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-source-demand-"));
  const sources = path.join(root, "home", ".codex", "sessions");
  fs.mkdirSync(sources, { recursive: true });
  const dbPath = path.join(root, "ledger.db");
  const db = openDb(dbPath);
  const observations: Observation[] = [];
  const actor = new IngestionActor({
    dbPath, logger: (_level, message, details) => observations.push({ message, details: details ?? {} }),
    publish: () => undefined, workerUrl: new URL("./helpers/ingestion-demand-worker.ts", import.meta.url),
  });
  return {
    root, sources, db, actor, observations,
    source(name: string) {
      const file = path.join(sources, `${name}.jsonl`);
      fs.writeFileSync(file, line({ type: "session_meta", timestamp: "2026-10-01T00:00:00Z",
        payload: { id: name, cwd: "/tmp/project" } }) + message("initial"));
      return file;
    },
    gate(name: string) { fs.writeFileSync(path.join(root, name), ""); },
    release(name: string) { fs.unlinkSync(path.join(root, name)); },
    barrier(name: string) { return waitUntil(() => observations.some((event) =>
      event.message === "barrier" && event.details.name === name), `source barrier ${name}`); },
    received(count: number) { return waitUntil(() => observations.filter((event) =>
      event.message === "received").length >= count, `${count} actor requests received`); },
  };
}

function line(value: unknown): string { return `${JSON.stringify(value)}\n`; }
function message(text: string): string {
  return line({ type: "response_item", timestamp: "2026-10-01T00:00:01Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
}
function blocks(db: Db, file: string): number {
  return (db.prepare("SELECT block_count FROM conversations WHERE source_path = ?").get(file) as { block_count: number } | undefined)?.block_count ?? 0;
}

afterEach(async () => {
  if (!fixture) return;
  await stopIngestionGracefully();
  await fixture.actor.close();
  fixture.db.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

describe("selected source demand through the ingestion actor", () => {
  it("forwards a public selected read that strengthens an already queued targeted request", async () => {
    const f = fixture = setup();
    await f.actor.close();
    setDb(f.db);
    startIngestion((_level, message, details) => f.observations.push({ message, details: details ?? {} }),
      { dbPath: path.join(f.root, "ledger.db"), background: false });
    const held = f.source("held");
    const selected = f.source("selected");
    f.gate("before-held.jsonl");
    const active = triggerTargetedIngest({ transcriptPath: held });
    await f.barrier("before-held.jsonl");
    const normal = triggerTargetedIngest({ transcriptPath: selected });
    const strict = triggerExactPathIngest(selected);
    await f.received(3);
    f.release("before-held.jsonl");
    await Promise.all([active, normal, strict]);
    expect(blocks(f.db, selected)).toBe(1);
    expect(f.observations.filter((event) => event.message === "source_start" && event.details.name === "selected.jsonl")
      .map((event) => event.details.bypassSameMtimeUnchanged)).toEqual([true]);
  });

  it.each(["reconcile", "full-ingest"] as const)("upgrades queued normal demand at the next %s source boundary", async (kind) => {
    const f = fixture = setup();
    const first = f.source("a-background");
    const next = f.source("b-background");
    const selected = f.source("z-selected");
    f.gate(`after-${path.basename(first)}`);
    f.gate(`before-${path.basename(next)}`);
    const background = kind === "reconcile" ? f.actor.reconcile() : f.actor.fullIngest();
    await f.barrier(`after-${path.basename(first)}`);
    const normal = f.actor.ingest([selected], kind === "full-ingest");
    const strict = f.actor.ingest([selected], false, true, true);
    await f.received(3);
    f.release(`after-${path.basename(first)}`);
    await strict;
    await normal;
    expect(blocks(f.db, selected)).toBe(1);
    expect(blocks(f.db, next)).toBe(0);
    const executions = f.observations.filter((event) => event.message === "source_start" && event.details.name === "z-selected.jsonl");
    expect(executions.map((event) => event.details.bypassSameMtimeUnchanged)).toEqual([true]);
    expect(executions.map((event) => event.details.forceFull)).toEqual([kind === "full-ingest"]);
    await f.barrier(`before-${path.basename(next)}`);
    f.release(`before-${path.basename(next)}`);
    await background;
    expect(blocks(f.db, next)).toBe(1);
  });

  it("deduplicates stronger follow-up work and keeps strict waiters behind an append", async () => {
    const f = fixture = setup();
    const selected = f.source("running");
    f.gate("after-running.jsonl");
    let strictCompleted = false;
    const normal = f.actor.ingest([selected]);
    await f.barrier("after-running.jsonl");
    const strict = f.actor.ingest([selected], false, true, true).then(() => { strictCompleted = true; });
    const repeated = f.actor.ingest([selected], false, true, true);
    fs.appendFileSync(selected, message("appended while normal work was running"));
    await f.received(3);
    expect(strictCompleted).toBe(false);
    expect(blocks(f.db, selected)).toBe(1);
    f.release("after-running.jsonl");
    await Promise.all([normal, strict, repeated]);
    expect(blocks(f.db, selected)).toBe(2);
    const executions = f.observations.filter((event) => event.message === "source_start");
    expect(executions.map((event) => event.details.bypassSameMtimeUnchanged)).toEqual([false, true]);
  });

  it("isolates sibling failures, rejects target failure, and permits a later retry", async () => {
    const f = fixture = setup();
    const broken = f.source("broken");
    const sibling = f.source("sibling");
    const selected = f.source("selected");
    f.gate("before-broken.jsonl");
    f.gate("before-sibling.jsonl");
    f.gate("fail-broken.jsonl");
    const batch = f.actor.ingest([broken, sibling, selected]);
    const batchFailed = expect(batch).rejects.toThrow("parser failed: broken.jsonl");
    await f.barrier("before-broken.jsonl");
    const strict = f.actor.ingest([selected], false, true, true);
    await f.received(2);
    f.release("before-broken.jsonl");
    await strict;
    expect(blocks(f.db, sibling)).toBe(0);
    await f.barrier("before-sibling.jsonl");
    f.release("before-sibling.jsonl");
    await batchFailed;
    expect(blocks(f.db, selected)).toBe(1);
    await expect(f.actor.ingest([broken], false, true, true)).rejects.toThrow("parser failed");
    f.release("fail-broken.jsonl");
    await f.actor.ingest([broken], false, true, true);
    expect(blocks(f.db, broken)).toBe(1);
  });

  it.each([false, true])("settles coalesced watcher demand after the append (initially empty: %s)", async (empty) => {
    const f = fixture = setup();
    const selected = f.source("dirty");
    const initial = fs.readFileSync(selected, "utf8");
    if (empty) fs.writeFileSync(selected, "");
    f.gate("after-dirty.jsonl");
    const first = f.actor.ingest([selected]);
    await f.barrier("after-dirty.jsonl");
    const watcher = f.actor.ingest([selected]);
    fs.appendFileSync(selected, empty ? initial : message("new watcher extent"));
    await f.received(2);
    f.release("after-dirty.jsonl");
    await Promise.all([first, watcher]);
    expect(blocks(f.db, selected)).toBe(empty ? 1 : 2);
    expect(f.observations.filter((event) => event.message === "source_start")).toHaveLength(2);
  });

  it("rejects active and pending waiters on stop and emits no stale callbacks", async () => {
    const f = fixture = setup();
    const first = f.source("held");
    const pending = f.source("pending");
    f.gate("before-held.jsonl");
    const held = f.actor.ingest([first]);
    const heldRejected = expect(held).rejects.toThrow("ingestion worker stopped");
    await f.barrier("before-held.jsonl");
    const queued = f.actor.ingest([pending], false, true, true);
    const queuedRejected = expect(queued).rejects.toThrow("ingestion worker stopped");
    await f.received(2);
    await f.actor.close();
    await Promise.all([heldRejected, queuedRejected]);
    const observed = f.observations.length;
    f.release("before-held.jsonl");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.observations).toHaveLength(observed);
    expect(blocks(f.db, first)).toBe(0);
    expect(blocks(f.db, pending)).toBe(0);
    expect(f.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});
