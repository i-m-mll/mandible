// @vitest-environment node
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { IngestionActor } from "../src/ingestion-actor.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { getConversationStructureCache } from "../src/conversations/structure-cache.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import { waitUntil } from "./helpers/wait-until.js";

it("commits comments and references and serves health while real ingestion prepares derived rows", async () => {
  const root = path.join(testRuntimeRoot, "ledger-ingestion");
  fs.mkdirSync(root);
  const dbPath = path.join(root, "ledger.db");
  const db = openDb(dbPath);
  const observer = openDb(dbPath);
  const store = new LedgerStore(db);
  const { project } = resolveProjectForCheckout(db, { root, name: "fixture", defaultBranch: "main" });
  const makeIssue = (title: string) => store.createIssue({ attribution: systemAction(), project_id: project.id,
    title, body: title, kind: "bug", priority: "normal", labels: [], actor_type: "agent", author_display: "Agent" });
  const source = makeIssue("source");
  const target = makeIssue("target");
  const session = "01a00000-0000-7000-8000-00000000c0de";
  const file = path.join(process.env.CODEX_HOME!, "sessions", `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: "session_meta", payload: { id: session, cwd: root } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "prepared content" }] } },
  ].map(row => JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", ...row }) + "\n").join(""));
  let gate: Int32Array | undefined;
  const actor = new IngestionActor({ dbPath, mainDb: db, publish: () => undefined,
    workerUrl: new URL("./helpers/ingestion-preparation-gate.ts", import.meta.url),
    logger: (_level, message, details) => {
      if (message === "derived_preparation_held") gate = new Int32Array(details!.gate as SharedArrayBuffer);
    } });
  const router = new Router();
  createServer({ db, router, sse: new SseManager(), logger: () => undefined, version: "ingestion-fixture",
    getStartupInfo: () => null, instance: { ...MAIN_CLI_INSTANCE_RESPONSE.instance, writable_roots: [root] } });
  let completed = false;
  const ingestion = actor.ingest([file], true, true).then(() => { completed = true; });
  try {
    await Promise.race([waitUntil(() => gate, "real derived row preparation"), ingestion.then(() => { throw new Error("Ingestion completed without entering derived preparation"); })]);
    const comment = store.addComment(source.id, { attribution: systemAction(), body: `Prepared work cites [issue:${target.short_id}]`,
      actor_type: "agent", author_display: "Agent" });
    const health = await router.invoke({ method: "GET", url: "/api/health" });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: "ok", ready: true });
    expect(completed).toBe(false);
    expect(observer.prepare("SELECT body FROM ledger_comments WHERE id = ?").get(comment.id)).toEqual({ body: comment.body });
    expect(observer.prepare(`SELECT target_issue_id FROM ledger_issue_relationship_sources
      WHERE source_entity_type = 'comment' AND source_entity_id = ? AND relationship_type = 'references' AND deleted_at IS NULL`).all(comment.id))
      .toEqual([{ target_issue_id: target.id }]);
    Atomics.store(gate!, 0, 1);
    Atomics.notify(gate!, 0);
    await ingestion;
    const conversation = db.prepare("SELECT id FROM conversations WHERE session_id = ?").get(session) as { id: string };
    const read = await new ConversationSourceReader(db).readAll(conversation.id);
    expect(read.status).toBe("source");
    if (read.status === "source") expect(read.value.map(block => block.content)).toEqual(["prepared content"]);
  } finally {
    if (gate) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); }
    await ingestion.catch(() => undefined);
    await actor.close();
    getConversationStructureCache(db).close();
    observer.close();
    db.close();
  }
});
