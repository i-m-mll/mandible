import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { ConversationSourceStore } from '../../src/conversations/source-store.js';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../../src/conversations/source-types.js';
import { migrate, setDb } from '../../src/db.js';
import { resolveInstanceInfo } from '../../src/instance-policy.js';
import { CodexParser } from '../../src/parsers/codex.js';
import { registerConversationRoutes } from '../../src/routes/conversations.js';
import { createServer, Router } from '../../src/server.js';
import { SseManager } from '../../src/sse.js';
import {
  SOURCE_BACKED_HISTORY_BLOCK_COUNT,
  SOURCE_BACKED_HISTORY_SESSION_ID,
  sourceBackedHistoryJsonl,
} from '../fixtures/source-backed-chat-history.js';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync);

type CdpClient = {
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>;
  close: () => void;
};

type BrowserSnapshot = {
  requests: string[];
  fetchedBlockIds: string[];
  seenBlockIds: string[];
  mountedRows: number;
  maximumMountedRows: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  focusedBlockId: string | null;
  text: string;
};

let directory = '';
let db: Database.Database;
let server: http.Server;
let origin = '';
let expectedBlockIds: string[] = [];
let expectedReadableBlockIds: string[] = [];
let targetBlockId = '';
let fixtureBundle = '';

function bundleFixture(): string {
  const output = join(directory, 'source-backed-chat-history.js');
  const bundled = spawnSync(resolve('node_modules/esbuild/bin/esbuild'), [
    resolve('test/browser/fixtures/source-backed-chat-history-fixture.tsx'),
    '--bundle',
    `--outfile=${output}`,
    '--format=iife',
    '--platform=browser',
    '--target=es2020',
    '--jsx=automatic',
    '--jsx-import-source=preact',
    '--alias:react=preact/compat',
    '--alias:react-dom=preact/compat',
    '--alias:react/jsx-runtime=preact/jsx-runtime',
    '--loader:.css=empty',
    '--minify',
    '--log-level=silent',
  ], { encoding: 'utf8' });
  if (bundled.status !== 0) throw new Error(`Source-backed Chat fixture bundle failed: ${bundled.stderr || bundled.stdout}`);
  return readFileSync(output, 'utf8');
}

async function seedSourceBackedConversation(): Promise<void> {
  const sourceDirectory = join(directory, '.codex', 'sessions', '2026', '09', '14');
  const sourcePath = join(sourceDirectory, `rollout-2026-09-14T01-00-00-${SOURCE_BACKED_HISTORY_SESSION_ID}.jsonl`);
  const mkdir = await import('node:fs/promises');
  await mkdir.mkdir(sourceDirectory, { recursive: true });
  writeFileSync(sourcePath, sourceBackedHistoryJsonl());
  const parsed = await new CodexParser().parse(sourcePath);
  if (!parsed) throw new Error('Provider-native source-backed history fixture did not parse.');
  expect(parsed.blocks).toHaveLength(SOURCE_BACKED_HISTORY_BLOCK_COUNT);

  db.prepare(`
    INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, model, tags, created_at, updated_at
    ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))
  `).run(
    'source-backed-history', sourcePath, parsed.conversation.source_hash,
    parsed.conversation.source_mtime, 'Source-backed 751-block history',
    parsed.conversation.started_at, parsed.blocks.length, SOURCE_BACKED_HISTORY_SESSION_ID,
    parsed.conversation.model,
  );
  const insert = db.prepare(`
    INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, compressed, position, timestamp,
      parent_id, metadata_json, dag_uuid, dag_parent_uuid
    ) VALUES (?, 'source-backed-history', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `);
  const sourceBlocks = parsed.blocks.map((block) => ({ ...block, legacyId: `legacy-${block.position}` }));
  for (const block of sourceBlocks) {
    insert.run(
      block.legacyId, block.type, block.role, block.content, block.position,
      block.timestamp, block.parent_id, JSON.stringify(block.metadata),
      block.dag_uuid ?? null, block.dag_parent_uuid ?? null,
    );
  }
  await new ConversationSourceStore(db).recordConversation({
    conversationId: 'source-backed-history',
    provider: 'codex',
    nativeSessionId: SOURCE_BACKED_HISTORY_SESSION_ID,
    filePath: sourcePath,
    expectedContentHash: parsed.conversation.source_hash,
    blocks: sourceBlocks,
    structuralMode: 'replace',
    ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
  });
  const rows = db.prepare(`
    SELECT id, position FROM conversation_structural_blocks
     WHERE conversation_id = 'source-backed-history' AND status = 'current'
     ORDER BY position
  `).all() as Array<{ id: string; position: number }>;
  expect(rows).toHaveLength(SOURCE_BACKED_HISTORY_BLOCK_COUNT);
  expectedBlockIds = rows.map((row) => row.id);
  const hiddenPositions = new Set(parsed.blocks
    .filter((block) => block.metadata.usage_telemetry !== undefined)
    .map((block) => block.position));
  expectedReadableBlockIds = rows.filter((row) => !hiddenPositions.has(row.position)).map((row) => row.id);
  targetBlockId = rows.find((row) => row.position === 123)?.id ?? '';
  expect(targetBlockId).not.toBe('');
}

function fixtureHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body,#root { height: 100%; margin: 0; }
    body { font: 14px system-ui; }
    .detail-pane-shell,.chat-detail-frame { display:flex; flex-direction:column; height:100%; min-height:0; }
    .detail-pane-shell__body,.chat-detail-frame__body,.conv-transcript,.chat-entity-link-boundary,.stream-renderer { display:flex; flex:1; flex-direction:column; min-height:0; }
    .stream-renderer__scroll { flex:1; min-height:0; overflow-y:auto; }
    .stream-renderer__virtual-canvas { position:relative; min-height:100%; }
    .stream-renderer__virtual-row { position:absolute; left:0; right:0; }
    .turn-group,.message-block-wrapper,.stream-renderer__history-state { min-height:48px; padding:8px 12px; box-sizing:border-box; }
    [data-navigation-focus="true"],:focus { outline:3px solid #55f; }
  </style></head><body><div id="root"></div><script>${fixtureBundle}</script></body></html>`;
}

async function listen(): Promise<void> {
  const instance = resolveInstanceInfo({ env: {}, dbPath: join(directory, 'mandible.db') });
  const router = new Router({ instance });
  registerConversationRoutes(router);
  router.get('/source-backed-history', (_req, res) => res.html?.(fixtureHtml()), { fileRpc: 'deny' });
  server = createServer({
    db,
    sse: new SseManager(),
    logger: () => undefined,
    version: 'source-backed-history-test',
    router,
    getStartupInfo: () => null,
    instance,
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (typeof address === 'object' && address) resolvePort(address.port);
      else reject(new Error('Source-backed Chat test server did not bind.'));
    });
  });
  origin = `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  if (!chrome) throw new Error('Chromium is required for the source-backed Chat history gate.');
  directory = mkdtempSync(join(tmpdir(), 'mandible-source-backed-history-'));
  db = new Database(join(directory, 'mandible.db'));
  migrate(db);
  setDb(db);
  await seedSourceBackedConversation();
  fixtureBundle = bundleFixture();
  await listen();
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  db?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('Timed out opening Chromium DevTools.')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Chromium DevTools failed to open.')); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (reason: Error) => void }>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result?: Record<string, any> };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result ?? {});
  });
  return {
    call: (method, params = {}) => new Promise((resolveCall, rejectCall) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    close: () => socket.close(),
  };
}

function rendererRssKb(profile: string): number {
  const rows = spawnSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf8' }).stdout.split('\n');
  return rows.reduce((total, row) => {
    if (!row.includes(profile)
        || !row.includes('(Renderer)')
        || row.includes('--top-chrome-webui')
        || row.includes('--extension-process')) return total;
    const value = Number(row.trim().split(/\s+/, 1)[0]);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

async function waitFor<T>(stage: string, read: () => T | null | Promise<T | null>, browser: ChildProcess, profile: string, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let poll = 0;
  const pending = Symbol('pending');
  while (Date.now() < deadline) {
    if (browser.exitCode !== null) throw new Error(`Chromium exited while waiting for ${stage}.`);
    if (poll++ % 20 === 0) {
      const rssKb = rendererRssKb(profile);
      if (rssKb > 800_000) {
        throw new Error(`Chromium renderer exceeded the 800000 KiB acceptance bound while waiting for ${stage}: ${rssKb} KiB.`);
      }
    }
    const value = await Promise.race([
      Promise.resolve(read()),
      new Promise<typeof pending>((resolvePending) => setTimeout(() => resolvePending(pending), 250)),
    ]);
    if (value === pending) continue;
    if (value !== null) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${stage}.`);
}

async function runBrowserJourney(): Promise<Record<string, unknown>> {
  const profile = join(directory, 'chromium-profile');
  const preflightStartedAt = performance.now();
  const preflightResponse = await fetch(`${origin}/api/conversations/source-backed-history?target=initial`);
  const preflight = await preflightResponse.json() as { body_source: string; total: number; blocks: unknown[]; window: { limit: number } };
  expect(preflightResponse.status).toBe(200);
  expect(preflight).toMatchObject({ body_source: 'source', total: SOURCE_BACKED_HISTORY_BLOCK_COUNT, window: { limit: 160 } });
  expect(preflight.blocks).toHaveLength(160);
  process.stdout.write(`SOURCE_BACKED_CHAT_STAGE source-http ${Math.round(performance.now() - preflightStartedAt)}ms\n`);
  const browser = spawn(chrome!, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-background-networking',
    '--disable-default-apps', '--disable-extensions', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=900,900',
    `${origin}/source-backed-history`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
  let client: CdpClient | null = null;
  try {
    const port = await waitFor('DevToolsActivePort', () => {
      const path = join(profile, 'DevToolsActivePort');
      if (!existsSync(path)) return null;
      const value = Number(readFileSync(path, 'utf8').split('\n')[0]);
      return Number.isInteger(value) && value > 0 ? value : null;
    }, browser, profile);
    const page = await waitFor('fixture page target', async () => {
      const entries = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{
        type: string; url: string; webSocketDebuggerUrl: string;
      }>;
      return entries.find((entry) => entry.type === 'page' && entry.url.startsWith(origin)) ?? null;
    }, browser, profile);
    client = await connectCdp(page.webSocketDebuggerUrl);
    const evaluate = async <T>(expression: string): Promise<T> => {
      const response = await client!.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result?.value as T;
    };
    const snapshot = () => evaluate<BrowserSnapshot>('window.__sourceBackedHistory?.snapshot()');
    const cold = await waitFor('cold latest window', async () => {
      const value = await snapshot();
      return value?.text.includes('LATEST SOURCE BACKED RESPONSE') && value.text.includes('Load earlier history') ? value : null;
    }, browser, profile);
    expect(cold.text).toContain('End of conversation');
    expect(cold.text).not.toContain('Start of conversation');
    expect(cold.requests.filter((url) => url.includes('/source-backed-history?target=initial'))).toHaveLength(1);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE cold\n');

    const beforePrepend = await evaluate<{ id: string; top: number }>(`new Promise(resolve => {(() => {
      const scroll=document.querySelector('.stream-renderer__scroll');scroll.scrollTop=0;scroll.dispatchEvent(new Event('scroll'));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const viewport=scroll.getBoundingClientRect();
        const block=[...document.querySelectorAll('[data-block-id]')].find(el=>{const rect=el.getBoundingClientRect();return rect.bottom>viewport.top&&rect.top<viewport.bottom});
        resolve({id:block?.dataset.blockId??'',top:block?.getBoundingClientRect().top??0});
      }));
    })()})`);
    const firstOlderCount = cold.requests.length;
    const afterPrepend = await waitFor('first bounded older window', async () => {
      const value = await snapshot();
      if (value.requests.length <= firstOlderCount) return null;
      return evaluate<{ id: string; top: number }>(`(() => {const block=[...document.querySelectorAll('[data-block-id]')].find(el=>el.dataset.blockId==='${beforePrepend.id}');return block?{id:block.dataset.blockId,top:block.getBoundingClientRect().top}:null})()`);
    }, browser, profile);
    expect(afterPrepend.id).toBe(beforePrepend.id);
    expect(Math.abs(afterPrepend.top - beforePrepend.top)).toBeLessThan(3);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE prepend\n');

    await waitFor('true beginning through edge demand', async () => {
      const value = await snapshot();
      if (value.text.includes('Start of conversation')) return true;
      await evaluate(`(() => {const scroll=document.querySelector('.stream-renderer__scroll');scroll.scrollTop=0;scroll.dispatchEvent(new Event('scroll'));const button=[...document.querySelectorAll('button')].find(el=>el.textContent?.includes('Load earlier history'));button?.click();return true})()`);
      return null;
    }, browser, profile, 20_000);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE beginning\n');

    const dimensions = await snapshot();
    await evaluate(`new Promise(resolve=>{const scroll=document.querySelector('.stream-renderer__scroll');let offset=0;const step=Math.max(180,scroll.clientHeight/2);const advance=()=>{scroll.scrollTop=offset;scroll.dispatchEvent(new Event('scroll'));offset+=step;if(offset<=scroll.scrollHeight){requestAnimationFrame(advance)}else{requestAnimationFrame(()=>requestAnimationFrame(resolve))}};advance()})`);
    const complete = await snapshot();
    process.stdout.write(`SOURCE_BACKED_CHAT_STAGE traversed ${complete.seenBlockIds.length}\n`);
    expect(new Set(complete.fetchedBlockIds)).toEqual(new Set(expectedBlockIds));
    expect(complete.fetchedBlockIds).toHaveLength(expectedBlockIds.length);
    expect(new Set(complete.seenBlockIds)).toEqual(new Set(expectedReadableBlockIds));
    expect(complete.seenBlockIds).toHaveLength(expectedReadableBlockIds.length);
    expect(complete.seenBlockIds).toContain(expectedReadableBlockIds[0]);
    expect(complete.maximumMountedRows).toBeLessThanOrEqual(20);
    const windowRequests = complete.requests.filter((url) => url.includes(`/api/conversations/source-backed-history?`));
    expect(windowRequests.length).toBeGreaterThan(3);
    for (const request of windowRequests) {
      const response = await fetch(new URL(request, origin));
      const payload = await response.json() as { blocks: unknown[]; total: number; window: { limit: number } };
      expect(payload.total).toBe(SOURCE_BACKED_HISTORY_BLOCK_COUNT);
      expect(payload.blocks.length).toBeLessThanOrEqual(160);
      expect(payload.window.limit).toBeLessThanOrEqual(160);
    }

    await client.call('Page.navigate', { url: `${origin}/source-backed-history?block=${encodeURIComponent(targetBlockId)}` });
    const exact = await waitFor('exact target focus', async () => {
      const value = await snapshot();
      return value.focusedBlockId === targetBlockId ? value : null;
    }, browser, profile);
    expect(exact.requests.some((url) => url.includes(`block=${encodeURIComponent(targetBlockId)}`))).toBe(true);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE exact\n');

    const searchTarget = await evaluate<string>(`window.__sourceBackedHistory.searchAndNavigate('readable source block 123')`);
    expect(searchTarget).toBe(targetBlockId);
    await waitFor('search target focus', async () => (await snapshot()).focusedBlockId === targetBlockId ? true : null, browser, profile);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE search\n');
    await evaluate(`window.__sourceBackedHistory.navigate(null)`);
    const gapped = await waitFor('truthful distant-window gap', async () => {
      const value = await snapshot();
      return value.text.includes('Load missing history from positions') ? value : null;
    }, browser, profile);
    expect(gapped.text).toContain('Load missing history from positions');
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE gap\n');

    const rss = Number(spawnSync('ps', ['-o', 'rss=', '-p', String(browser.pid)], { encoding: 'utf8' }).stdout.trim());
    expect(rss).toBeLessThan(1_000_000);
    return {
      coldRequest: cold.requests.find((url) => url.includes('target=initial')),
      boundedWindowRequests: windowRequests,
      firstPromptReached: complete.seenBlockIds.includes(expectedReadableBlockIds[0]),
      sourceCanonicalIdentities: complete.fetchedBlockIds.length,
      readableCanonicalIdentities: complete.seenBlockIds.length,
      maximumMountedRows: complete.maximumMountedRows,
      prependAnchor: { before: beforePrepend, after: afterPrepend },
      targetBlockId,
      focusedBlockId: exact.focusedBlockId,
      gapVisibleAfterDistantWindows: gapped.text.includes('Load missing history from positions'),
      browserRssKb: rss,
    };
  } finally {
    client?.close();
    const exited = new Promise<void>((resolveExit) => browser.once('exit', () => resolveExit()));
    browser.kill('SIGTERM');
    await Promise.race([exited, new Promise<void>((resolveExit) => setTimeout(resolveExit, 1_000))]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
    if (stderr && browser.exitCode && browser.exitCode !== 0) throw new Error(stderr);
  }
}

describe('source-backed Chat history acceptance', () => {
  it('traverses source reader to HTTP to Query to Virtual for the 751-block shape', async () => {
    const evidence = await runBrowserJourney();
    expect(evidence).toMatchObject({
      firstPromptReached: true,
      sourceCanonicalIdentities: SOURCE_BACKED_HISTORY_BLOCK_COUNT,
      readableCanonicalIdentities: SOURCE_BACKED_HISTORY_BLOCK_COUNT - 1,
      gapVisibleAfterDistantWindows: true,
      focusedBlockId: targetBlockId,
    });
    process.stdout.write(`SOURCE_BACKED_CHAT_EVIDENCE ${JSON.stringify(evidence)}\n`);
  }, 45_000);
});
