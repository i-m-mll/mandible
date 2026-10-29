import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { Worker } from "node:worker_threads";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setupOperator } from "../src/users/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { managedSearchSource } from "./helpers/search-managed-source.js";
import { setDb, type Db } from "../src/db.js";
import { Router } from "../src/server.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { inlineLedgerReader, workerLedgerReaderPool } from "../src/ledger-reads/index.js";
import { configureSearchJobRuntime, getFullTextSearchJobs } from "../src/conversations/full-text-search-jobs.js";
import { getConversationSearchCache } from "../src/conversations/search-cache.js";
let db: Db;
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "search-jobs-")); process.env.MANDIBLE_CONVERSATION_CACHE_DB = path.join(root, "cache.db"); db = migratedMemoryDb(); setDb(db); });
afterEach(() => { getFullTextSearchJobs(db).close(); getConversationSearchCache(db).close(); db.close(); delete process.env.MANDIBLE_CONVERSATION_CACHE_DB; fs.rmSync(root, { recursive: true, force: true }); });
async function conversation(id: string, content = "needle"): Promise<string> {
  db.prepare(`INSERT INTO conversations(id,source,source_path,source_hash,source_mtime,title,started_at,session_id,block_count,tags,created_at,updated_at) VALUES (?,'codex',?,'hash',1,?,'2026-10-01',?,1,'[]','2026-10-01','2026-10-01')`).run(id, path.join(root, id), id, id);
  return managedSearchSource(db, root, id, content);
}
async function finish(router: Router, url: string, observer?: {
  search_id: string;
  observer_token: string;
}) {
  const target = new URL(url, "http://localhost");
  if (observer) {
    target.searchParams.set("search_id", observer.search_id);
    target.searchParams.set("observer_token", observer.observer_token);
  }
  let result = await router.invoke({ method: "GET", url: target.pathname + target.search });
  const end = Date.now() + 10000;
  while (result.status === 202 && Date.now() < end) {
    const body = result.body as {
      search_id: string;
      observer_token: string;
    };
    target.searchParams.set("search_id", body.search_id);
    target.searchParams.set("observer_token", body.observer_token);
    await new Promise<void>(resolve => setImmediate(resolve));
    result = await router.invoke({ method: "GET", url: target.pathname + target.search });
  }
  return result;
}
it("admits through real HTTP promptly before worker startup and returns exact immutable cursor partitions", async () => {
  for (const id of ["a", "b", "c"])
    await conversation(id);
  const dbPath = path.join(root, "ledger.db");
  fs.writeFileSync(dbPath, db.serialize());
  const reader = workerLedgerReaderPool(dbPath, { size: 1 });
  const router = new Router();
  registerConversationRoutes(router, reader);
  const server = http.createServer((request, response) => { void router.handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as {
      port: number;
    }).port}/api/conversations/sidebar?search=needle&full_text=true&limit=1`;
    const start = performance.now();
    const first = await fetch(url);
    const pending = await first.json() as {
      state: string;
      search_id: string;
      observer_token: string;
    };
    expect(first.status).toBe(202);
    expect(performance.now() - start).toBeLessThan(250);
    expect(pending).not.toHaveProperty("groups");
    const complete = await finish(router, new URL(url).pathname + new URL(url).search, pending);
    expect(complete.status).toBe(200);
    type Page = {
      state: string;
      search_id: string;
      coverage: {
        complete: boolean;
      };
      groups: Array<{
        key: string;
        total: number;
        conversations: Array<{
          id: string;
        }>;
        next_cursor: string | null;
      }>;
    };
    let page = complete.body as Page;
    expect(page.coverage.complete).toBe(true);
    const seen: string[] = [];
    do {
      expect(page.groups[0].total).toBe(3);
      seen.push(...page.groups[0].conversations.map(row => row.id));
      const cursor = page.groups[0].next_cursor;
      if (!cursor)
        break;
      const next = new URL(url);
      next.searchParams.set("search_id", page.search_id);
      next.searchParams.set("group_key", page.groups[0].key);
      next.searchParams.set("cursor", cursor);
      const response = await finish(router, next.pathname + next.search);
      expect(response.status).toBe(200);
      page = response.body as Page;
    } while (true);
    expect(seen).toEqual(["a", "b", "c"]);
  }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await reader.close();
  }
});
it("reuses facts without rescanning, rejects stale query cursors and invalidates removed source custody", async () => {
  const source = await conversation("a");
  await conversation("b");
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const first = await finish(router, "/api/conversations?search=needle&full_text=true&limit=1");
  expect(first.status).toBe(200);
  const searchId = (first.body as {
    search_id: string;
  }).search_id;
  const scan = vi.spyOn(getConversationSearchCache(db), "search");
  const page = await finish(router, `/api/conversations?search=needle&full_text=true&limit=1&page=2&search_id=${searchId}`);
  expect(page.body).toMatchObject({ total: 2, conversations: [{ id: "b" }] });
  expect(scan).not.toHaveBeenCalled();
  const mismatch = await finish(router, `/api/conversations?search=other&full_text=true&search_id=${searchId}`);
  expect(mismatch.status).toBe(409);
  expect(mismatch.body).not.toHaveProperty("total");
  fs.unlinkSync(source);
  const invalid = await finish(router, `/api/conversations?search=needle&full_text=true&search_id=${searchId}`);
  expect(invalid.status).toBe(409);
  expect(invalid.body).toMatchObject({ state: "superseded" });
  expect(invalid.body).not.toHaveProperty("total");
  scan.mockRestore();
});
it("shares observers without cancelling a sibling and bounds queued corpus keys before preparation", async () => {
  await conversation("a");
  db.prepare("DELETE FROM conversation_structural_blocks").run();
  db.exec("UPDATE conversation_sources SET parser_format='provider-jsonl',parser_version='2',normalization_version='2',redaction_epoch=0; UPDATE conversation_source_versions SET parser_format='provider-jsonl',parser_version='2',normalization_version='2',redaction_epoch=0");
  // Hold actual readiness repair to exercise admitted jobs, without a fake matcher.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  configureSearchJobRuntime(db, { publish() { }, async repair() { await gate; } });
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const base = "/api/conversations?search=needle&full_text=true";
  const first = await router.invoke({ method: "GET", url: base });
  const a = first.body as {
    search_id: string;
    observer_token: string;
  };
  const second = await router.invoke({ method: "GET", url: base });
  const b = second.body as typeof a;
  expect(b.search_id).toBe(a.search_id);
  expect(b.observer_token).not.toBe(a.observer_token);
  await router.invoke({ method: "GET", url: `${base}&search_id=${a.search_id}&observer_token=${a.observer_token}&cancel=true` });
  const still = await router.invoke({ method: "GET", url: `${base}&search_id=${b.search_id}&observer_token=${b.observer_token}` });
  expect(still.status).toBe(202);
  for (let index = 0; index < 8; index++)
    expect((await router.invoke({ method: "GET", url: `/api/conversations?search=needle${index}&full_text=true` })).status).toBe(202);
  const overflow = await router.invoke({ method: "GET", url: "/api/conversations?search=overflow&full_text=true" });
  expect(overflow.status).toBe(409);
  expect(overflow.body).toMatchObject({ reason: "admission_full" });
  getFullTextSearchJobs(db).close();
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
});
it("discards unpublished matches after replacement and settles corrupt coverage without exact totals", async () => {
  const source = await conversation("a");
  const cache = getConversationSearchCache(db);
  const original = cache.search.bind(cache);
  const scan = vi.spyOn(cache, "search").mockImplementation(async (input) => {
    const result = await original(input);
    fs.writeFileSync(source, "replaced transcript");
    return result;
  });
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const changed = await finish(router, "/api/conversations?search=needle&full_text=true");
  expect(changed.status).toBe(409);
  expect(changed.body).toMatchObject({ state: "superseded", coverage: { complete: false } });
  expect(changed.body).not.toHaveProperty("conversations");
  expect(changed.body).not.toHaveProperty("total");
  scan.mockRestore();
  const corrupt = await finish(router, "/api/conversations/search?q=another");
  expect(corrupt.status).toBe(409);
  expect(corrupt.body).toMatchObject({ coverage: { complete: false } });
  expect(corrupt.body).not.toHaveProperty("results");
});
it("expires idle snapshots explicitly and evicts the oldest completed snapshot after four", async () => {
  await conversation("a", "needle0 needle1 needle2 needle3 needle4");
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const result = await finish(router, `/api/conversations?search=needle${index}&full_text=true`);
    expect(result.status).toBe(200);
    ids.push((result.body as {
      search_id: string;
    }).search_id);
  }
  const evicted = await finish(router, `/api/conversations?search=needle0&full_text=true&search_id=${ids[0]}`);
  expect(evicted.status).toBe(409);
  expect(evicted.body).toMatchObject({ state: "expired", reason: "snapshot_expired" });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 300001);
  try {
    const expired = await finish(router, `/api/conversations?search=needle4&full_text=true&search_id=${ids[4]}`);
    expect(expired.status).toBe(409);
    expect(expired.body).toMatchObject({ state: "expired" });
  }
  finally {
    clock.mockRestore();
  }
});
it("settles a lost worker snapshot and permits an explicit refresh", async () => {
  await conversation("a");
  const dbPath = path.join(root, "ledger.db");
  fs.writeFileSync(dbPath, db.serialize());
  const reader = workerLedgerReaderPool(dbPath, { size: 1 });
  const router = new Router();
  registerConversationRoutes(router, reader);
  let worker: Worker | undefined;
  const post = Worker.prototype.postMessage;
  const capture = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
    if (args[0]?.kind === "conversation_list")
      worker = this;
    return post.apply(this, args);
  });
  try {
    const url = "/api/conversations?search=needle&full_text=true";
    const first = await router.invoke({ method: "GET", url });
    expect(first.status).toBe(202);
    capture.mockRestore();
    expect(worker).toBeDefined();
    await worker!.terminate();
    const id = (first.body as {
      search_id: string;
    }).search_id;
    const expired = await router.invoke({ method: "GET", url: `${url}&search_id=${id}` });
    expect(expired.status).toBe(409);
    expect(expired.body).toMatchObject({ state: "expired", reason: "worker_restarted" });
    expect(expired.body).not.toHaveProperty("total");
    const refreshed = await finish(router, url);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ total: 1 });
  }
  finally {
    capture.mockRestore();
    await reader.close();
  }
});
it("invalidates every completed snapshot when credential redaction facts change", async () => {
  await conversation("a");
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const url = "/api/conversations?search=needle&full_text=true";
  const first = await finish(router, url);
  expect(first.status).toBe(200);
  const user = setupOperator(db, { display_name: "Operator" });
  const credentials = new ClientAuthenticator(db, { secretsDir: path.join(root, "secrets") });
  credentials.mintApiToken(user.id, { label: "redaction epoch" });
  const id = (first.body as {
    search_id: string;
  }).search_id;
  const invalid = await finish(router, `${url}&search_id=${id}`);
  expect(invalid.status).toBe(409);
  expect(invalid.body).toMatchObject({ state: "superseded", reason: "redaction_changed" });
  expect(invalid.body).not.toHaveProperty("conversations");
});
it("rechecks the job redaction epoch after the last asynchronous physical proof", async () => {
  await conversation("a");
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const original = ConversationSourceReader.prototype.verifyVersion;
  let changed = false;
  const proof = vi.spyOn(ConversationSourceReader.prototype, "verifyVersion").mockImplementation(async function (this: ConversationSourceReader, ...args: Parameters<ConversationSourceReader["verifyVersion"]>) {
    const result = await original.apply(this, args);
    if (!changed) {
      changed = true;
      const user = setupOperator(db, { display_name: "Operator" });
      new ClientAuthenticator(db, { secretsDir: path.join(root, "race-secrets") }).mintApiToken(user.id, { label: "during proof" });
    }
    return result;
  });
  try {
    const result = await finish(router, "/api/conversations?search=needle&full_text=true");
    expect(changed).toBe(true);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ state: "superseded", reason: "redaction_changed" });
    expect(result.body).not.toHaveProperty("total");
  }
  finally {
    proof.mockRestore();
  }
});
it("pins route ordering after readiness repair rather than before it", async () => {
  await conversation("a");
  await conversation("b");
  db.exec("UPDATE conversations SET started_at='2020-01-01' WHERE id='a'; UPDATE conversation_sources SET parser_format='provider-jsonl',parser_version='2',normalization_version='2',redaction_epoch=0 WHERE conversation_id='a'; UPDATE conversation_source_versions SET parser_format='provider-jsonl',parser_version='2',normalization_version='2',redaction_epoch=0 WHERE source_id IN (SELECT id FROM conversation_sources WHERE conversation_id='a')");
  configureSearchJobRuntime(db, { publish() { }, async repair(id) {
      expect(id).toBe("a");
      db.exec("UPDATE conversation_sources SET parser_format='mandible-normalized-jsonl',parser_version='1',normalization_version='1',redaction_epoch=1 WHERE conversation_id='a'; UPDATE conversation_source_versions SET parser_format='mandible-normalized-jsonl',parser_version='1',normalization_version='1',redaction_epoch=1 WHERE source_id IN (SELECT id FROM conversation_sources WHERE conversation_id='a'); UPDATE conversations SET started_at='2027-01-01' WHERE id='a'");
    } });
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const result = await finish(router, "/api/conversations?search=needle&full_text=true");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ total: 2, conversations: [{ id: "a" }, { id: "b" }] });
});
it("captures a new snapshot when no ID is supplied after an undisplayed source changes", async () => {
  await conversation("a");
  const hidden = await conversation("b");
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const url = "/api/conversations?search=needle&full_text=true&limit=1";
  const first = await finish(router, url);
  expect(first.status).toBe(200);
  const id = (first.body as {
    search_id: string;
  }).search_id;
  fs.writeFileSync(hidden, "unobserved replacement");
  const pinned = await finish(router, `${url}&search_id=${id}`);
  expect(pinned.status).toBe(200);
  expect(pinned.body).toMatchObject({ total: 2, conversations: [{ id: "a" }] });
  const refreshed = await finish(router, url);
  expect(refreshed.status).toBe(409);
  expect((refreshed.body as {
    search_id: string;
  }).search_id).not.toBe(id);
  expect(refreshed.body).not.toHaveProperty("total");
});
it("keeps frozen filter and sort fields when live display metadata changes", async () => {
  await conversation("a");
  await conversation("b");
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const url = "/api/conversations?search=needle&full_text=true&sort=title&order=asc&starred=false";
  const first = await finish(router, url);
  expect(first.status).toBe(200);
  const id = (first.body as {
    search_id: string;
  }).search_id;
  db.prepare("UPDATE conversations SET title='z',starred=1 WHERE id='a'").run();
  const pinned = await finish(router, `${url}&search_id=${id}`);
  expect(pinned.status).toBe(200);
  expect(pinned.body).toMatchObject({ total: 2, conversations: [{ id: "a", title: "a", starred: false }, { id: "b", title: "b" }] });
  const fresh = await finish(router, url);
  expect(fresh.status).toBe(200);
  expect(fresh.body).toMatchObject({ total: 1, conversations: [{ id: "b" }] });
});
it("invalidates an undisplayed source when canonical alias availability changes", async () => {
  await conversation("a");
  await conversation("b");
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const url = "/api/conversations?search=needle&full_text=true&limit=1";
  const first = await finish(router, url);
  expect(first.status).toBe(200);
  const id = (first.body as {
    search_id: string;
  }).search_id;
  db.prepare("UPDATE conversation_source_aliases SET availability='missing' WHERE source_id IN (SELECT id FROM conversation_sources WHERE conversation_id='b')").run();
  const invalid = await finish(router, `${url}&search_id=${id}`);
  expect(invalid.status).toBe(409);
  expect(invalid.body).toMatchObject({ state: "superseded" });
  expect(invalid.body).not.toHaveProperty("total");
});

it("preserves group-mode child navigation counts in the full-text projection",async()=>{
  await conversation("a");await conversation("b");db.prepare("UPDATE conversations SET parent_conversation_id='a' WHERE id='b'").run();
  const router=new Router();registerConversationRoutes(router,inlineLedgerReader());const result=await finish(router,"/api/conversations?search=needle&full_text=true&group=true");expect(result.status).toBe(200);expect(result.body).toMatchObject({total:1,conversations:[{id:"a",children_count:1}]});
});
