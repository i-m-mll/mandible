#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRuntime } from "./test-runtime-isolation.mjs";

if (!process.argv.includes("--isolated-child")) {
  const runtime = createTestRuntime();
  try {
    const root = runtime.env.MANDIBLE_TEST_RUNTIME_ROOT!;
    const env = { ...runtime.env, MANDIBLE_HOME: path.join(root, "state"), MANDIBLE_DB: path.join(root, "ledger.db"),
      MANDIBLE_CONVERSATION_STRUCTURE_DB: path.join(root, "structure.db"), MANDIBLE_SOCKET: path.join(root, "api.sock") };
    for (const key of Object.keys(env)) {
      if (/^(CLAUDE|GEMINI_|CODEX_(?!HOME$)|MANDIBLE_(?:MANAGED_|SESSION_|TOKEN$|BASE$|TRANSPORT$|CLI_DIR$))/.test(key)) delete env[key];
    }
    const result = spawnSync(runtime.env.MANDIBLE_RUNTIME!, [fileURLToPath(import.meta.url), "--isolated-child"], {
      env, stdio: "inherit", timeout: 55_000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { runtime.close(); }
} else {
  const { openDb, setDb } = await import("../src/db.js");
  const { IngestionActor } = await import("../src/ingestion-actor.js");
  const { LedgerStore } = await import("../src/ledger/store.js");
  const { resolveProjectForCheckout } = await import("../src/ledger/projects.js");
  const { systemAction } = await import("../src/identity/resolver.js");
  const { ConversationSourceReader } = await import("../src/conversations/source-reader.js");
  const { getConversationStructureCache } = await import("../src/conversations/structure-cache.js");
  const { HANDLER_TURN_BUDGET_MS, EVENT_LOOP_STALL_BUDGET_MS } = await import("../src/runtime-health-contract.js");
  const root = process.env.MANDIBLE_TEST_RUNTIME_ROOT!;
  const db = openDb(process.env.MANDIBLE_DB!);
  setDb(db);
  const store = new LedgerStore(db);
  const { project } = resolveProjectForCheckout(db, { root, name: "responsiveness", defaultBranch: "main" });
  const makeIssue = (title: string) => store.createIssue({ attribution: systemAction(), project_id: project.id,
    title, body: title, kind: "bug", priority: "normal", labels: [], actor_type: "agent", author_display: "Fixture" });
  const issue = makeIssue("writes during ingestion");
  const target = makeIssue("referenced issue");
  const warnings: unknown[] = [];
  const actor = new IngestionActor({ dbPath: process.env.MANDIBLE_DB!, mainDb: db, publish: () => undefined,
    logger: (level, message, details) => { if (level === "warn" || level === "error") warnings.push({ level, message, details }); } });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim();
  const results: unknown[] = [];
  try {
    for (const provider of ["claude", "codex"] as const) {
      const count = provider === "claude" ? 26_343 : 12_000;
      const session = provider === "claude" ? "11111111-1111-4111-8111-111111111111" : "01a00000-0000-7000-8000-00000000c0de";
      const file = provider === "claude" ? path.join(process.env.HOME!, ".claude", "projects", "fixture", `${session}.jsonl`)
        : path.join(process.env.CODEX_HOME!, "sessions", `${session}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const timestamp = "2026-10-01T00:00:00Z";
      const body = (i: number) => `${i}: fixture message ${"body ".repeat(200)}`;
      const rows = Array.from({ length: count }, (_, i) => provider === "claude"
        ? { uuid: `block-${i}`, parentUuid: i ? `block-${i - 1}` : null, type: i % 2 ? "assistant" : "user", timestamp,
          sessionId: session, cwd: "/fixture/project", message: { role: i % 2 ? "assistant" : "user", content: body(i) } }
        : { type: "response_item", timestamp, payload: { type: "message", role: i % 2 ? "assistant" : "user",
          content: [{ type: i % 2 ? "output_text" : "input_text", text: body(i) }] } });
      if (provider === "codex") rows.unshift({ type: "session_meta", timestamp, payload: { id: session, cwd: "/fixture/project" } } as typeof rows[number]);
      const bytes = rows.map(row => JSON.stringify(row) + "\n").join("");
      fs.writeFileSync(file, bytes);
      const fixture = { provider, blocks: count, bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
      for (const pass of ["first", "forced"] as const) {
        let previous = performance.now(), maxLoopDelayMs = 0, maxWriteMs = 0, writes = 0;
        const errors: string[] = [];
        const sampleLoop = () => {
          const now = performance.now();
          maxLoopDelayMs = Math.max(maxLoopDelayMs, Math.max(0, now - previous - 5));
          previous = now;
        };
        const timer = setInterval(() => {
          sampleLoop();
          const started = performance.now();
          try {
            store.addComment(issue.id, { attribution: systemAction(), body: `${provider}/${pass}/${writes} [issue:${target.short_id}]`,
              actor_type: "agent", author_display: "Fixture" });
            writes++;
          } catch (error) { errors.push(String(error)); }
          maxWriteMs = Math.max(maxWriteMs, performance.now() - started);
        }, 5);
        const started = performance.now();
        try { await actor.ingest([file], true, true); }
        finally { sampleLoop(); clearInterval(timer); }
        const elapsedMs = performance.now() - started;
        const conversation = db.prepare("SELECT id, block_count FROM conversations WHERE session_id = ?").get(session) as { id: string; block_count: number };
        assert.equal(conversation.block_count, count);
        const tail = await new ConversationSourceReader(db).readPage(conversation.id, { offset: count - 1, limit: 1 });
        assert.equal(tail.status, "source");
        if (tail.status === "source") assert.equal(tail.value.blocks[0]?.content, body(count - 1));
        const passed = writes > 0 && errors.length === 0 && maxWriteMs < HANDLER_TURN_BUDGET_MS && maxLoopDelayMs < EVENT_LOOP_STALL_BUDGET_MS;
        results.push({ fixture, pass, elapsedMs, writes, maxWriteMs, maxLoopDelayMs, errors, completedBlocks: conversation.block_count, passed });
        if (!passed) process.exitCode = 1;
      }
    }
    console.log(JSON.stringify({ schema: "mandible-ingestion-responsiveness@1", revision, runtime: process.versions,
      sqlite: db.prepare("SELECT sqlite_version() AS version").get(), budgets: { writeMs: HANDLER_TURN_BUDGET_MS, loopDelayMs: EVENT_LOOP_STALL_BUDGET_MS },
      isolated: true, results, warnings }, null, 2));
    if (warnings.length) process.exitCode = 1;
  } finally { await actor.close(); getConversationStructureCache(db).close(); db.close(); }
}
