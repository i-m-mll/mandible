import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { ConversationSourceStore } from '../../src/conversations/source-store.js';
import { observeStableSourceAliasExtent } from '../../src/conversations/source-observer.js';
import { getConversationStructureCache } from '../../src/conversations/structure-cache.js';
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
const esbuildCli = createRequire(import.meta.url).resolve('esbuild/bin/esbuild');

type CdpClient = {
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>;
  close: () => void;
};

type BrowserSnapshot = {
  requests: string[];
  transformedSourceRequests: string[];
  fetchedBlockIds: string[];
  seenBlockIds: string[];
  sourceVersionId: string | null;
  anchorBlockLoaded: boolean;
  mountedRows: number;
  historyRows: number;
  maximumMountedRows: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  readingAnchor: { blockId?: string | null; position?: number | null; viewportOffset?: number; followingTail?: boolean } | null;
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

function legacyBlockId(position: number): string {
  return `legacy-${position}`;
}

function bundleFixture(): string {
  const output = join(directory, 'source-backed-chat-history.js');
  const bundled = spawnSync(esbuildCli, [
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
  const sourceStore = new ConversationSourceStore(db);
  await sourceStore.recordConversation({
    conversationId: 'source-backed-history',
    provider: 'codex',
    nativeSessionId: SOURCE_BACKED_HISTORY_SESSION_ID,
    filePath: sourcePath,
    expectedContentHash: parsed.conversation.source_hash,
    blocks: sourceBlocks,
    structuralMode: 'replace',
    ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
  });
  const source = db.prepare(`
    SELECT id FROM conversation_sources
     WHERE conversation_id = 'source-backed-history' AND provider = 'codex'
  `).get() as { id: string };
  const alias = sourceStore.listAliases(source.id).find((entry) => entry.path === sourcePath);
  if (!alias) throw new Error('Source-backed history fixture did not retain its provider alias.');
  const observed = await observeStableSourceAliasExtent(alias);
  db.prepare(`
    INSERT INTO conversation_ingest_state
      (file_path, byte_offset, line_count, tail_hash, partial_line, updated_at)
    VALUES (?, ?, ?, ?, '', ?)
  `).run(sourcePath, observed.byteLength, sourceBackedHistoryJsonl().trimEnd().split('\n').length,
    observed.tailHash, Date.now());
  const captured = getConversationStructureCache(db).captureDenseRows(db, 'source-backed-history', 'replace');
  expect(captured.cached).toBe(SOURCE_BACKED_HISTORY_BLOCK_COUNT);
  const rows = db.prepare(`
    SELECT id, position FROM conversation_structural_blocks
     WHERE conversation_id = 'source-backed-history' AND status = 'current'
     ORDER BY position
  `).all() as Array<{ id: string; position: number }>;
  expect(rows).toHaveLength(SOURCE_BACKED_HISTORY_BLOCK_COUNT);
  expectedBlockIds = rows.map((row) => legacyBlockId(row.position));
  const hiddenPositions = new Set(parsed.blocks
    .filter((block) => block.metadata.usage_telemetry !== undefined)
    .map((block) => block.position));
  expectedReadableBlockIds = rows
    .filter((row) => !hiddenPositions.has(row.position))
    .map((row) => legacyBlockId(row.position));
  targetBlockId = rows.find((row) => row.position === 123)
    ? legacyBlockId(123)
    : '';
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
  instance.public_origin = origin;
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
  expect(preflightResponse.status, JSON.stringify(preflight)).toBe(200);
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
    const wheel = async (deltaY: number) => {
      await client!.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 450, y: 450, deltaX: 0, deltaY,
      });
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    const setScrollTop = async (scrollTop: number) => {
      await evaluate(`(() => {
        const scroll=document.querySelector('.stream-renderer__scroll');
        if(scroll) scroll.scrollTop=${scrollTop};
      })()`);
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    const clickJumpToLatest = () => evaluate<boolean>(`(() => {
      const button=document.querySelector('button[aria-label="Jump to latest"]');
      if(!(button instanceof HTMLButtonElement)||button.disabled) return false;
      button.click();
      return true;
    })()`);
    const scheduleDelayedGroupMeasurement = (anchorBlockId: string) => evaluate<{
      rowIndex: number;
      beforeHeight: number;
    } | null>(`(() => {
      const scroll=document.querySelector('.stream-renderer__scroll');
      const anchor=[...document.querySelectorAll('[data-block-id]')]
        .find(el=>el.dataset.blockId===${JSON.stringify(anchorBlockId)});
      const anchorRow=anchor?.closest('.stream-renderer__virtual-row');
      if(!scroll||!anchorRow) return null;
      const anchorIndex=Number(anchorRow.getAttribute('data-index'));
      const viewport=scroll.getBoundingClientRect();
      const row=[...document.querySelectorAll('.stream-renderer__virtual-row')]
        .filter(candidate=>Number(candidate.getAttribute('data-index'))<anchorIndex)
        .filter(candidate=>candidate.querySelector('.turn-group'))
        .filter(candidate=>candidate.getBoundingClientRect().top<viewport.top)
        .sort((left,right)=>Number(right.getAttribute('data-index'))-Number(left.getAttribute('data-index')))[0];
      if(!row) return null;
      const beforeHeight=row.getBoundingClientRect().height;
      const probe=document.createElement('div');
      probe.dataset.delayedGroupMeasurement='true';
      probe.style.height='320px';
      probe.style.minHeight='320px';
      requestAnimationFrame(()=>requestAnimationFrame(()=>row.append(probe)));
      return {rowIndex:Number(row.getAttribute('data-index')),beforeHeight};
    })()`);
    const visibleAnchor = (blockId?: string, requireVisible = false) => evaluate<{ id: string; top: number; scrollTop: number; viewportTop: number } | null>(`(() => {
      const scroll=document.querySelector('.stream-renderer__scroll');
      const viewport=scroll.getBoundingClientRect();
      const blocks=[...document.querySelectorAll('[data-block-id]')];
      const visible=blocks.filter(el=>{
        const rect=el.getBoundingClientRect();
        return el.dataset.blockId&&rect.bottom>viewport.top&&rect.top<viewport.bottom;
      }).sort((left,right)=>left.getBoundingClientRect().top-right.getBoundingClientRect().top);
      const block=${blockId ? `blocks.find(el=>el.dataset.blockId===${JSON.stringify(blockId)})` : 'visible[0]'};
      if(!block) return null;
      const rect=block.getBoundingClientRect();
      if(${requireVisible ? 'true' : 'false'}&&(rect.bottom<=viewport.top||rect.top>=viewport.bottom)) return null;
      return {
        id:block.dataset.blockId,
        top:rect.top,
        scrollTop:scroll.scrollTop,
        viewportTop:viewport.top,
      };
    })()`);
    const cold = await waitFor('cold latest window', async () => {
      const value = await snapshot();
      return value?.text.includes('LATEST SOURCE BACKED RESPONSE') ? value : null;
    }, browser, profile);
    expect(cold.text).not.toContain('Load earlier history');
    expect(cold.text).not.toContain('Load later history');
    expect(cold.text).not.toContain('Load missing history');
    expect(cold.text).not.toContain('Start of conversation');
    expect(cold.text).not.toContain('End of conversation');
    expect(cold.requests.filter((url) => url.includes('/source-backed-history?target=initial'))).toHaveLength(1);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE cold\n');

    await evaluate(`window.__sourceBackedHistory.navigate({block:'${targetBlockId}'})`);
    const exact = await waitFor('exact target focus', async () => {
      const value = await snapshot();
      return value?.focusedBlockId === targetBlockId ? value : null;
    }, browser, profile);
    expect(exact.requests.some((url) => url.includes(`block=${encodeURIComponent(targetBlockId)}`))).toBe(true);
    expect(exact.historyRows).toBeGreaterThan(0);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE target-gap\n');

    const gapRequestStart = exact.requests.length;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const value = await snapshot();
      if (value.requests.slice(gapRequestStart).some((url) => {
        const position = Number(new URL(url, origin).searchParams.get('position'));
        return position >= 204 && position <= 590;
      })) break;
      await wheel(900);
    }
    await waitFor('automatic nearby gap fetch', async () => {
      const value = await snapshot();
      return value.requests.slice(gapRequestStart).some((url) => {
        const position = Number(new URL(url, origin).searchParams.get('position'));
        return position >= 204 && position <= 590;
      }) ? value : null;
    }, browser, profile);
    const fetchedBeforeGapFill = exact.fetchedBlockIds.length;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = await snapshot();
      if (value.fetchedBlockIds.length > fetchedBeforeGapFill
          && !value.text.includes('Loading history…')) break;
      await wheel(900);
    }
    const afterGapFill = await waitFor('automatic nearby window completion', async () => {
      const value = await snapshot();
      return value.fetchedBlockIds.length > fetchedBeforeGapFill
        && !value.text.includes('Loading history…') ? value : null;
    }, browser, profile);
    const gapTargets = afterGapFill.requests.slice(gapRequestStart)
      .map((url) => new URL(url, origin).searchParams.get('position'))
      .filter((position): position is string => position !== null)
      .map(Number);
    expect(gapTargets.length).toBeGreaterThan(0);
    expect(gapTargets.every((position) => position >= 204 && position <= 590)).toBe(true);
    expect(new Set(gapTargets).size).toBe(gapTargets.length);
    expect(gapTargets.every((position, index) => index === 0 || position > gapTargets[index - 1])).toBe(true);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE gap-auto-filled\n');

    const anchorRequestStart = afterGapFill.requests.length;
    const prefetchDistance = Math.max(afterGapFill.clientHeight * 1.5, 720);
    let beforeEdge = afterGapFill;
    for (let attempt = 0; attempt < 30 && beforeEdge.scrollTop > prefetchDistance + 900; attempt += 1) {
      await wheel(-900);
      beforeEdge = await snapshot();
    }
    const toPrefetchEdge = Math.max(0, Math.floor(beforeEdge.scrollTop - prefetchDistance - 1));
    if (toPrefetchEdge > 0) {
      await wheel(-toPrefetchEdge);
      beforeEdge = await snapshot();
    }
    const beforePrepend = await waitFor(
      'visible source-backed block at the older-history edge',
      async () => visibleAnchor(),
      browser,
      profile,
      4_000,
    );
    const previousFetchedCount = afterGapFill.fetchedBlockIds.length;
    const savedAnchorBeforePassiveScroll = beforeEdge.readingAnchor;
    expect(savedAnchorBeforePassiveScroll).not.toBeNull();
    const targetScrollTop = Math.max(0, beforePrepend.scrollTop - 2);
    await setScrollTop(targetScrollTop);
    expect((await snapshot()).readingAnchor).toEqual(savedAnchorBeforePassiveScroll);
    const beforePrependRestore = await visibleAnchor(beforePrepend.id, true);
    expect(beforePrependRestore).not.toBeNull();
    await waitFor('automatic older window request', async () => {
      const value = await snapshot();
      return value.requests.slice(anchorRequestStart)
        .some((url) => new URL(url, origin).searchParams.get('position') === '43') ? value : null;
    }, browser, profile);
    const afterPrepend = await waitFor('older window preserves the reading anchor', async () => {
      const value = await snapshot();
      if (value.fetchedBlockIds.length <= previousFetchedCount) return null;
      return visibleAnchor(beforePrepend.id, true);
    }, browser, profile);
    expect(afterPrepend.id).toBe(beforePrepend.id);
    expect(
      Math.abs(
        (afterPrepend.top - afterPrepend.viewportTop)
        - (beforePrependRestore!.top - beforePrependRestore!.viewportTop),
      ),
      JSON.stringify({ beforePrependRestore, afterPrepend }),
    ).toBeLessThan(5);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE prepend\n');

    await wheel(-800);
    const afterWheel = await waitFor('wheel input remains in control after prepend', async () => {
      const value = await snapshot();
      return value.scrollTop < afterPrepend.scrollTop - 300 ? value : null;
    }, browser, profile);
    expect(afterWheel.scrollTop).toBeLessThan(afterPrepend.scrollTop - 300);
    let atBeginning: BrowserSnapshot | null = null;
    for (let attempt = 0; attempt < 20 && !atBeginning; attempt += 1) {
      const previousFetchedCount = (await snapshot()).fetchedBlockIds.length;
      await wheel(-12_000);
      const step = await waitFor('older page or true beginning', async () => {
        const value = await snapshot();
        if (value.text.includes('FIRST SOURCE BACKED PROMPT') && value.scrollTop <= 1) {
          return { kind: 'beginning' as const, value };
        }
        if (value.fetchedBlockIds.length > previousFetchedCount && !value.text.includes('Loading history…')) {
          return { kind: 'page' as const, value };
        }
        return null;
      }, browser, profile);
      if (step.kind === 'beginning') atBeginning = step.value;
    }
    expect(atBeginning, 'repeated upward wheel input should reach the true beginning').not.toBeNull();
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE beginning\n');

    let traversalSteps = 0;
    for (; traversalSteps < 1_200; traversalSteps += 1) {
      const value = await snapshot();
      const atEnd = value.scrollHeight - value.scrollTop - value.clientHeight <= 1;
      if (atEnd
          && value.fetchedBlockIds.length === expectedBlockIds.length
          && value.seenBlockIds.length === expectedReadableBlockIds.length) break;
      await wheel(Math.max(1, Math.floor(value.clientHeight * 0.5)));
    }
    const complete = await snapshot();
    process.stdout.write(`SOURCE_BACKED_CHAT_STAGE traversed ${complete.seenBlockIds.length} readable, fetched ${complete.fetchedBlockIds.length} blocks in ${traversalSteps} steps\n`);
    const extentRatio = Math.max(cold.scrollHeight, complete.scrollHeight)
      / Math.max(1, Math.min(cold.scrollHeight, complete.scrollHeight));
    expect(afterGapFill.scrollHeight).toBeLessThanOrEqual(cold.scrollHeight + (2 * afterGapFill.clientHeight));
    expect(extentRatio).toBeLessThan(1.25);
    process.stdout.write(`SOURCE_BACKED_CHAT_EXTENT initial ${cold.scrollHeight} full ${complete.scrollHeight} ratio ${extentRatio.toFixed(2)}\n`);
    expect(new Set(complete.fetchedBlockIds)).toEqual(new Set(expectedBlockIds));
    expect(complete.fetchedBlockIds).toHaveLength(expectedBlockIds.length);
    const missingReadablePositions = expectedReadableBlockIds
      .filter((id) => !complete.seenBlockIds.includes(id))
      .map((id) => expectedBlockIds.indexOf(id));
    expect(missingReadablePositions.slice(0, 20), `${missingReadablePositions.length} readable blocks were never mounted`).toEqual([]);
    expect(new Set(complete.seenBlockIds).size).toBe(expectedReadableBlockIds.length);
    expect(complete.seenBlockIds).toHaveLength(expectedReadableBlockIds.length);
    expect(complete.seenBlockIds).toContain(expectedReadableBlockIds[0]);
    expect(complete.maximumMountedRows).toBeLessThanOrEqual(20);
    const windowRequests = complete.requests.filter((url) => url.includes(`/api/conversations/source-backed-history?`));
    expect(windowRequests.length).toBeGreaterThan(3);
    const edgeTargets = complete.requests.slice(anchorRequestStart)
      .map((url) => new URL(url, origin).searchParams.get('position'))
      .filter((position): position is string => position !== null)
      .map(Number);
    expect(edgeTargets).toContain(43);
    expect(new Set(edgeTargets).size).toBe(edgeTargets.length);
    const prependTargetIndex = edgeTargets.indexOf(43);
    const targetsAfterPrepend = edgeTargets.slice(prependTargetIndex + 1);
    expect(targetsAfterPrepend.every((position, index) => (
      index === 0 || position > targetsAfterPrepend[index - 1]
    ))).toBe(true);
    for (const request of windowRequests) {
      const response = await fetch(new URL(request, origin));
      const payload = await response.json() as { blocks: unknown[]; total: number; window: { limit: number } };
      expect(payload.total).toBe(SOURCE_BACKED_HISTORY_BLOCK_COUNT);
      expect(payload.blocks.length).toBeLessThanOrEqual(160);
      expect(payload.window.limit).toBeLessThanOrEqual(160);
    }

    const rss = Number(spawnSync('ps', ['-o', 'rss=', '-p', String(browser.pid)], { encoding: 'utf8' }).stdout.trim());
    expect(rss).toBeLessThan(1_000_000);

    // Re-fetch the active latest window while the user is reading older
    // content. A new source version replaces that window; Chat must retain the
    // reading anchor and materialize it from the new version before resuming
    // automatic edge prefetch.
    const sourceRefreshPrevious = await snapshot();
    await evaluate('window.__sourceBackedHistory.navigate(null)');
    await waitFor('latest window is active', async () => {
      const value = await snapshot();
      return value.requests.slice(sourceRefreshPrevious.requests.length).some((url) => (
        new URL(url, origin).searchParams.get('target') === 'initial'
      ))
        ? value : null;
    }, browser, profile);
    let sourceRefreshBeforeAnchor: { id: string; top: number; scrollTop: number; viewportTop: number } | null = null;
    let sourceRefreshBeforeState: BrowserSnapshot | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const value = await snapshot();
      const anchorBlockId = value.readingAnchor?.blockId;
      const anchorPosition = value.readingAnchor?.position;
      if (anchorBlockId && typeof anchorPosition === 'number' && anchorPosition < 450
          && value.readingAnchor?.followingTail === false) {
        const block = await visibleAnchor();
        if (block) {
          sourceRefreshBeforeAnchor = block;
          sourceRefreshBeforeState = value;
          break;
        }
      }
      await wheel(-900);
    }
    expect(sourceRefreshBeforeAnchor, 'user scroll should place a stable anchor in older history').not.toBeNull();
    expect(sourceRefreshBeforeState?.readingAnchor?.followingTail).toBe(false);
    const sourceRefreshRequestStart = sourceRefreshBeforeState!.transformedSourceRequests.length;
    const sourceRefreshAnchorRequestStart = sourceRefreshBeforeState!.requests.length;
    await evaluate('window.__sourceBackedHistory.refreshSourceVersion()');
    await waitFor('latest window refetched from the new source version', async () => {
      const value = await snapshot();
      return value.transformedSourceRequests.slice(sourceRefreshRequestStart).some((url) => (
        new URL(url, origin).searchParams.get('target') === 'initial'
      )) ? value : null;
    }, browser, profile);
    const sourceRefreshAfterAnchor = await waitFor('same reading block is restored from the new source version', async () => {
      const value = await snapshot();
      const anchor = value.readingAnchor;
      const block = anchor?.blockId ? await visibleAnchor(anchor.blockId, true) : null;
      if (!block || anchor?.blockId === sourceRefreshBeforeAnchor!.id
          || anchor.position !== sourceRefreshBeforeState!.readingAnchor!.position) return null;
      const requestedAnchorPosition = value.requests.slice(sourceRefreshAnchorRequestStart).some((url) => (
        new URL(url, origin).searchParams.get('position') === String(sourceRefreshBeforeState!.readingAnchor!.position)
      ));
      return requestedAnchorPosition
        && anchor.followingTail === false
        && value.sourceVersionId !== sourceRefreshBeforeState!.sourceVersionId
        && value.anchorBlockLoaded
        ? block
        : null;
    }, browser, profile);
    expect(sourceRefreshAfterAnchor.id).not.toBe(sourceRefreshBeforeAnchor!.id);
    expect(Math.abs(sourceRefreshAfterAnchor.top - sourceRefreshBeforeAnchor!.top)).toBeLessThan(5);
    const sourceRefreshRestoredState = await snapshot();
    const measurement = await scheduleDelayedGroupMeasurement(sourceRefreshAfterAnchor.id);
    expect(measurement, 'a mounted group above the reading anchor should be available for delayed measurement').not.toBeNull();
    const afterDelayedMeasurement = await waitFor('delayed group measurement preserves the visible message', async () => {
      const value = await snapshot();
      const block = await visibleAnchor(sourceRefreshAfterAnchor.id, true);
      if (!block || value.scrollHeight < sourceRefreshRestoredState.scrollHeight + 200) return null;
      return { value, block };
    }, browser, profile);
    expect(afterDelayedMeasurement.block.id).toBe(sourceRefreshAfterAnchor.id);
    expect(Math.abs(afterDelayedMeasurement.block.top - sourceRefreshAfterAnchor.top)).toBeLessThan(5);
    expect(afterDelayedMeasurement.value.scrollTop).toBeGreaterThan(sourceRefreshRestoredState.scrollTop + 200);
    expect(afterDelayedMeasurement.value.readingAnchor).toEqual(sourceRefreshRestoredState.readingAnchor);
    expect(afterDelayedMeasurement.value.readingAnchor?.followingTail).toBe(false);

    const latestRequestStart = afterDelayedMeasurement.value.requests.length;
    expect(await clickJumpToLatest(), 'the older reading position should expose Jump to latest').toBe(true);
    const afterLatestNavigation = await waitFor('latest navigation replaces older reading intent and settles at the end', async () => {
      const value = await snapshot();
      const requestedLatest = value.requests.slice(latestRequestStart).some((url) => (
        new URL(url, origin).searchParams.get('target') === 'latest'
      ));
      const distanceFromEnd = value.scrollHeight - value.scrollTop - value.clientHeight;
      return requestedLatest
        && distanceFromEnd <= 5
        && value.readingAnchor?.followingTail === true
        && value.readingAnchor?.position === null
        && value.readingAnchor?.blockId === null
        ? value
        : null;
    }, browser, profile);
    const latestVisibleBlock = await waitFor('latest message remains visible after navigation', async () => (
      visibleAnchor(undefined, true)
    ), browser, profile);
    const latestMeasurement = await scheduleDelayedGroupMeasurement(latestVisibleBlock.id);
    expect(latestMeasurement, 'a mounted group above the latest viewport should be available for delayed measurement').not.toBeNull();
    const afterLatestMeasurement = await waitFor('tail intent survives delayed group layout after Jump to latest', async () => {
      const value = await snapshot();
      const block = await visibleAnchor(latestVisibleBlock.id, true);
      const distanceFromEnd = value.scrollHeight - value.scrollTop - value.clientHeight;
      if (!block || value.scrollHeight < afterLatestNavigation.scrollHeight + 200
          || distanceFromEnd > 5 || value.readingAnchor?.followingTail !== true) return null;
      return { value, block };
    }, browser, profile);
    expect(afterLatestMeasurement.block.id).toBe(latestVisibleBlock.id);
    expect(Math.abs(afterLatestMeasurement.block.top - latestVisibleBlock.top)).toBeLessThan(5);
    expect(afterLatestMeasurement.value.scrollTop).toBeGreaterThan(afterLatestNavigation.scrollTop + 200);
    return {
      coldRequest: cold.requests.find((url) => url.includes('target=initial')),
      boundedWindowRequests: windowRequests,
      firstPromptReached: complete.seenBlockIds.includes(expectedReadableBlockIds[0]),
      sourceCanonicalIdentities: complete.fetchedBlockIds.length,
      readableCanonicalIdentities: complete.seenBlockIds.length,
      maximumMountedRows: complete.maximumMountedRows,
      prependAnchor: { before: beforePrepend, after: afterPrepend },
      sourceRefreshAnchor: {
        position: sourceRefreshBeforeState!.readingAnchor!.position,
        before: sourceRefreshBeforeAnchor,
        after: sourceRefreshAfterAnchor,
      },
      delayedGroupMeasurement: {
        rowIndex: measurement!.rowIndex,
        beforeHeight: measurement!.beforeHeight,
        scrollTopBefore: sourceRefreshRestoredState.scrollTop,
        scrollTopAfter: afterDelayedMeasurement.value.scrollTop,
      },
      latestNavigation: {
        beforeScrollTop: afterDelayedMeasurement.value.scrollTop,
        afterScrollTop: afterLatestNavigation.scrollTop,
        remainingDistance: afterLatestNavigation.scrollHeight - afterLatestNavigation.scrollTop - afterLatestNavigation.clientHeight,
        stableBlock: latestVisibleBlock,
        scrollTopAfterDelayedMeasurement: afterLatestMeasurement.value.scrollTop,
      },
      wheelAfterPrepend: { before: afterPrepend.scrollTop, after: afterWheel.scrollTop },
      gapTargets,
      targetBlockId,
      focusedBlockId: exact.focusedBlockId,
      beganAtScrollTop: atBeginning.scrollTop,
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
      focusedBlockId: targetBlockId,
    });
    process.stdout.write(`SOURCE_BACKED_CHAT_EVIDENCE ${JSON.stringify(evidence)}\n`);
  }, 45_000);
});
