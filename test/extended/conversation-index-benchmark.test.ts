// Reproduce with:
// MANDIBLE_CHAT_INDEX_BENCH=1 node scripts/run-vitest.js run --config vitest.extended.config.ts test/extended/conversation-index-benchmark.test.ts
// An optional MANDIBLE_CHAT_INDEX_REPEATS changes the 751-block fixture multiplier.
import { afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate, setDb, type Db } from '../../src/db.js';
import { ingestBatchForWorker } from '../../src/ingestion.js';
import { CodexParser } from '../../src/parsers/codex.js';
import { ConversationSourceReader } from '../../src/conversations/source-reader.js';
import { ensureExactConversationFresh } from '../../src/conversations/freshness.js';
import { sourceBackedHistoryJsonl } from '../fixtures/source-backed-chat-history.js';

const benchmark = process.env.MANDIBLE_CHAT_INDEX_BENCH === '1' ? it : it.skip;
const repeats = Number(process.env.MANDIBLE_CHAT_INDEX_REPEATS ?? 32);
let directory: string | null = null;
let db: Db | null = null;
const oldHome = process.env.HOME;
const oldConfig = process.env.MANDIBLE_CONFIG_DIR;

afterEach(() => {
  db?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldConfig === undefined) delete process.env.MANDIBLE_CONFIG_DIR; else process.env.MANDIBLE_CONFIG_DIR = oldConfig;
});

benchmark('measures cold and repeated exact-source index plus first visible window', async () => {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 128) throw new RangeError('invalid fixture multiplier');
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-chat-index-benchmark-'));
  process.env.HOME = directory;
  process.env.MANDIBLE_CONFIG_DIR = path.join(directory, 'config');
  const source = path.join(directory, '.codex/sessions/2026/09/14/rollout-2026-09-14T01-00-00-source-backed-history-session.jsonl');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, sourceBackedHistoryJsonl().repeat(repeats));
  db = openDb(path.join(directory, 'mandible.db'));
  migrate(db);
  setDb(db);

  const started = performance.now();
  const parsed = await new CodexParser().parse(source);
  const parsedAt = performance.now();
  await ingestBatchForWorker([source], true, true, true);
  const coldAt = performance.now();
  const conversation = db.prepare('SELECT id, block_count FROM conversations WHERE source_path = ?')
    .get(source) as { id: string; block_count: number };
  expect(conversation.block_count).toBe(parsed?.blocks.length);
  const reader = new ConversationSourceReader(db);
  const first = await reader.readPage(conversation.id, { offset: Math.max(0, conversation.block_count - 160), limit: 160 });
  const firstAt = performance.now();
  expect(first.status).toBe('source');

  // An already indexed source with an older parser epoch is the user-visible
  // re-index case. Preserve exact bytes while forcing the normal epoch path.
  db.prepare("UPDATE conversation_sources SET parser_version = 'old' WHERE conversation_id = ?")
    .run(conversation.id);
  db.prepare("UPDATE conversation_source_versions SET parser_version = 'old' WHERE source_id IN (SELECT id FROM conversation_sources WHERE conversation_id = ?)")
    .run(conversation.id);
  const pendingAt = performance.now();
  await expect(ensureExactConversationFresh(db, conversation.id, {
    waitForFresh: false,
    scheduleReparse: () => true,
  })).rejects.toMatchObject({ code: 'freshness_pending' });
  const pendingReturnedAt = performance.now();
  await ingestBatchForWorker([source], false, true, true);
  const repeatAt = performance.now();
  const visible = await reader.readPage(conversation.id, { offset: Math.max(0, conversation.block_count - 160), limit: 160 });
  const visibleAt = performance.now();
  expect(visible.status).toBe('source');

  // The earlier tool call now lives only in the sparse index. An appended
  // result referring to it should remain an append, not reparse the file.
  fs.appendFileSync(source, `${JSON.stringify({
    type: 'response_item', timestamp: new Date().toISOString(),
    payload: { type: 'function_call_output', call_id: 'source-backed-tool-call', output: 'late tool result' },
  })}\n`);
  const laterMtime = new Date(Date.now() + 2_000);
  fs.utimesSync(source, laterMtime, laterMtime);
  const fullParse = vi.spyOn(CodexParser.prototype, 'parse');
  const appendStartedAt = performance.now();
  try {
    await ingestBatchForWorker([source], false, true, true);
    expect(fullParse).not.toHaveBeenCalled();
  } finally {
    fullParse.mockRestore();
  }
  const appendAt = performance.now();
  await ingestBatchForWorker([source], true, true, true);
  const controlFullAt = performance.now();

  process.stdout.write(`CHAT_INDEX_BENCH ${JSON.stringify({
    bytes: fs.statSync(source).size,
    blocks: conversation.block_count,
    parse_ms: Math.round(parsedAt - started),
    cold_index_ms: Math.round(coldAt - parsedAt),
    cold_window_ms: Math.round(firstAt - coldAt),
    pending_response_ms: Math.round(pendingReturnedAt - pendingAt),
    repeated_index_ms: Math.round(repeatAt - pendingReturnedAt),
    repeated_window_ms: Math.round(visibleAt - repeatAt),
    first_visible_after_pending_ms: Math.round(visibleAt - pendingAt),
    cross_append_tool_result_ms: Math.round(appendAt - appendStartedAt),
    forced_full_control_ms: Math.round(controlFullAt - appendAt),
  })}\n`);
}, 60_000);
