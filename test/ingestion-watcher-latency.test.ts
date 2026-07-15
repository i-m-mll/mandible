import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Db } from "../src/db.js";
import type { Logger } from "../src/types.js";

let tempDir = "";
let db: Db | null = null;
let stopIngestion: (() => void) | null = null;
let savedHome: string | undefined;

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

async function waitForConversationGone(filePath: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const existing = db?.prepare("SELECT id FROM conversations WHERE source_path = ?").get(filePath);
    if (!existing) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for deleted watched conversation cleanup");
}

beforeEach(async () => {
  savedHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ingestion-watch-"));
  process.env.HOME = path.join(tempDir, "home");
  vi.resetModules();

  const dbModule = await import("../src/db.js");
  db = dbModule.openDb(path.join(tempDir, "mandible.db"));
  dbModule.migrate(db);
  dbModule.setDb(db);

  const ingestion = await import("../src/ingestion.js");
  stopIngestion = ingestion.stopIngestion;
});

afterEach(() => {
  stopIngestion?.();
  stopIngestion = null;
  db?.close();
  db = null;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("watched tail ingestion latency", () => {
  it("ingests appended watched JSONL records without waiting for reconcile", async () => {
    const ingestion = await import("../src/ingestion.js");
    const sessionDir = path.join(process.env.HOME!, ".codex", "sessions", "2026", "07", "02");
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

  it("transactionally removes an unstarred conversation when its watched source disappears", async () => {
    const ingestion = await import("../src/ingestion.js");
    const sessionDir = path.join(process.env.HOME!, ".codex", "sessions", "2026", "07", "02");
    await fsp.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "rollout-2026-07-02T00-00-00-watchdelete.jsonl");
    await fsp.writeFile(sessionPath, initialRows(), "utf8");
    await ingestion.triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    await waitForBlockCount(sessionPath, 1);

    ingestion.startIngestion(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fsp.rm(sessionPath);
    await waitForConversationGone(sessionPath);

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
