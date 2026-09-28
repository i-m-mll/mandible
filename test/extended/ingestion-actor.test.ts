import { describe, expect, it } from "vitest";

import { IngestionActor } from "../../src/ingestion-actor.js";
import { ConversationSourceChangedError } from "../../src/conversations/source-store.js";

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
