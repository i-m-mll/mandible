import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Db } from "../../src/db.js";
import type { Logger } from "../../src/types.js";

let tempDir = "";
let db: Db | null = null;
let stopIngestion: (() => Promise<void>) | null = null;
let sessionRoot = "";

function row(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function initialRows(): string {
  return [
    row({
      type: "session_meta",
      timestamp: "2026-07-02T00:00:00.000Z",
      payload: { id: "watch-latency", cwd: "/tmp/project", model_provider: "openai" },
    }),
    row({
      type: "response_item",
      timestamp: "2026-07-02T00:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello watcher" }],
      },
    }),
  ].join("");
}

function assistantRow(index: number): string {
  return row({
    type: "response_item",
    timestamp: `2026-07-02T00:00:${String(index + 2).padStart(2, "0")}.000Z`,
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `watch append ${index}` }],
    },
  });
}

async function waitForBlockCount(filePath: string, expected: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = db?.prepare("SELECT block_count FROM conversations WHERE source_path = ?")
      .get(filePath) as { block_count: number } | undefined;
    if (row?.block_count === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for block_count=${expected}`);
}

async function waitForSourceUnavailable(filePath: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const source = db?.prepare(`
      SELECT s.availability
        FROM conversation_sources s
        JOIN conversation_source_aliases a ON a.source_id = s.id
       WHERE a.path = ?
    `).get(filePath) as { availability: string } | undefined;
    if (source?.availability === "missing") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for watched source tombstone");
}

beforeEach(async () => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ingestion-watch-")));
  // The runner creates this private home before Bun captures it. Keep fixture
  // transcripts within the real watched root rather than overriding HOME late.
  const watchedRoot = path.join(os.homedir(), ".codex", "sessions");
  fs.mkdirSync(watchedRoot, { recursive: true });
  sessionRoot = fs.mkdtempSync(path.join(watchedRoot, "latency-fixture-"));
  vi.resetModules();

  const dbModule = await import("../../src/db.js");
  db = dbModule.openDb(path.join(tempDir, "mandible.db"));
  dbModule.migrate(db);
  dbModule.setDb(db);

  const ingestion = await import("../../src/ingestion.js");
  stopIngestion = ingestion.stopIngestionGracefully;
});

afterEach(async () => {
  await stopIngestion?.();
  stopIngestion = null;
  db?.close();
  db = null;
  fs.rmSync(sessionRoot, { recursive: true, force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("watched tail ingestion latency", () => {
  it("ingests appended watched JSONL records without waiting for reconcile", async () => {
    const ingestion = await import("../../src/ingestion.js");
    const sessionDir = path.join(sessionRoot, "2026", "07", "02");
    await fsp.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "rollout-2026-07-02T00-00-00-watchlatency.jsonl");
    await fsp.writeFile(sessionPath, initialRows(), "utf8");
    await ingestion.triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    await waitForBlockCount(sessionPath, 1);

    const logs: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const logger: Logger = (_level, message, details) => {
      logs.push({ message, details });
    };

    ingestion.startIngestion(logger);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const latencies: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const appendedAt = Date.now();
      await fsp.appendFile(sessionPath, assistantRow(index), "utf8");
      await waitForBlockCount(sessionPath, index + 2);
      latencies.push(Date.now() - appendedAt);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const sorted = [...latencies].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
    expect(p95).toBeLessThan(1000);
    expect(
      logs.some((entry) =>
        entry.message === "ingestion_complete"
        && entry.details?.ingest_mode === "append"
        && entry.details?.delta === true
      ),
    ).toBe(true);
  });

  it("tombstones a missing watched source while preserving its durable coordinates", async () => {
    const ingestion = await import("../../src/ingestion.js");
    const sessionDir = path.join(sessionRoot, "2026", "07", "02");
    await fsp.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "rollout-2026-07-02T00-00-00-watchdelete.jsonl");
    await fsp.writeFile(sessionPath, initialRows(), "utf8");
    await ingestion.triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    await waitForBlockCount(sessionPath, 1);

    ingestion.startIngestion(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fsp.rm(sessionPath);
    await waitForSourceUnavailable(sessionPath);

    expect(
      db?.prepare("SELECT block_count FROM conversations WHERE source_path = ?").get(sessionPath),
    ).toEqual({ block_count: 1 });
    expect(
      db?.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = (SELECT id FROM conversations WHERE source_path = ?)")
        .get(sessionPath),
    ).toMatchObject({ count: 0 });

    expect(
      db?.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_blocks b
        LEFT JOIN conversations c ON c.id = b.conversation_id
        WHERE c.id IS NULL
      `).get(),
    ).toMatchObject({ count: 0 });
  });
});
