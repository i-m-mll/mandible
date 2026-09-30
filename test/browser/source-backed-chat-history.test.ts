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
  detailReadBlockIds: string[];
  seenBlockIds: string[];
  sourceVersionId: string | null;
  totalPositions: number;
  loadedIntervals: Array<{ start: number; end: number }>;
  anchorBlockLoaded: boolean;
  anchorBlockPosition: number | null;
  mountedRows: number;
  historyRows: number;
  maximumMountedRows: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  readingAnchor: { blockId?: string | null; position?: number | null; viewportOffset?: number; followingTail?: boolean } | null;
  focusedBlockId: string | null;
  expandedToolDetails: boolean;
  text: string;
};

let directory = '';
let db: Database.Database;
let server: http.Server;
let origin = '';
let expectedBlockIds: string[] = [];
let expectedReadableBlockIds: string[] = [];
let targetBlockId = '';
let toolCallBlockId = '';
let toolCallPosition = -1;
let toolResultBlockId = '';
let toolResultPosition = -1;
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
  const toolCall = parsed.blocks.find((block) => {
    const item = block.metadata.chat_item as { type?: unknown; phase?: unknown } | undefined;
    return item?.type === 'tool-call' && item.phase === 'call';
  });
  const toolResult = parsed.blocks.find((block) => {
    const item = block.metadata.chat_item as { type?: unknown; phase?: unknown } | undefined;
    return item?.type === 'tool-call' && item.phase === 'result';
  });
  toolCallPosition = toolCall?.position ?? -1;
  toolCallBlockId = toolCallPosition >= 0 ? legacyBlockId(toolCallPosition) : '';
  toolResultPosition = toolResult?.position ?? -1;
  toolResultBlockId = toolResultPosition >= 0 ? legacyBlockId(toolResultPosition) : '';
  expect(targetBlockId).not.toBe('');
  expect(toolCallBlockId).not.toBe('');
  expect(toolResultBlockId).not.toBe('');
}

function fixtureHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body,#root { height: 100%; margin: 0; }
    body { font: 14px system-ui; }
    .detail-pane-shell,.chat-detail-frame { display:flex; flex-direction:column; height:100%; min-height:0; }
    .detail-pane-shell__body,.chat-detail-frame__body,.conv-transcript,.chat-entity-link-boundary,.stream-renderer { display:flex; flex:1; flex-direction:column; min-height:0; }
    .stream-renderer { position:relative; }
    .stream-renderer__scroll { flex:1; min-height:0; overflow-y:auto; }
    .stream-renderer__scroll--overlay-bar { scrollbar-width:none; padding-right:12px; }
    .stream-renderer__scroll--overlay-bar::-webkit-scrollbar { display:none; }
    .stream-renderer__scrollbar-track { position:absolute; right:0; width:12px; touch-action:none; }
    .stream-renderer__scrollbar-thumb { width:6px; margin-left:3px; }
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
        .filter(candidate=>candidate.getBoundingClientRect().bottom<=viewport.top)
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
    const visibleAnchor = (blockId?: string, requireVisible = false) => evaluate<{ id: string; text: string; top: number; scrollTop: number; viewportTop: number } | null>(`(() => {
      const scroll=document.querySelector('.stream-renderer__scroll');
      if (!scroll) return null;
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
        text:(block.textContent||'').replace(/\\s+/g,' ').trim().slice(0,240),
        top:rect.top,
        scrollTop:scroll.scrollTop,
        viewportTop:viewport.top,
      };
    })()`);
    await waitFor('initial source-backed page', async () => {
      const value = await snapshot();
      return value?.text.includes('LATEST SOURCE BACKED RESPONSE')
        && value.totalPositions === SOURCE_BACKED_HISTORY_BLOCK_COUNT ? value : null;
    }, browser, profile);
    await evaluate(`(() => {
      const scroll = document.querySelector('.stream-renderer__scroll');
      scroll.scrollTop = 0;
    })()`);
    await waitFor('earlier source-backed page', async () => {
      const value = await snapshot();
      return value?.fetchedBlockIds.length === expectedBlockIds.length ? value : null;
    }, browser, profile);
    await evaluate(`(() => {
      const scroll = document.querySelector('.stream-renderer__scroll');
      scroll.scrollTop = scroll.scrollHeight;
    })()`);
    const cold = await waitFor('complete compact source projection', async () => {
      const value = await snapshot();
      return value?.text.includes('LATEST SOURCE BACKED RESPONSE')
        && value.totalPositions === SOURCE_BACKED_HISTORY_BLOCK_COUNT
        && value.fetchedBlockIds.length === expectedBlockIds.length
        ? value
        : null;
    }, browser, profile);
    expect(cold.text).not.toContain('Load earlier history');
    expect(cold.text).not.toContain('Load later history');
    expect(cold.text).not.toContain('Load missing history');
    expect(cold.text).not.toContain('Start of conversation');
    expect(cold.text).not.toContain('End of conversation');
    expect(cold.requests.filter((url) => {
      const query = new URL(url, origin).searchParams;
      return query.get('target') === 'initial' && query.get('view') === 'display';
    })).toHaveLength(1);
    expect(cold.loadedIntervals).toEqual([{ start: 0, end: SOURCE_BACKED_HISTORY_BLOCK_COUNT - 1 }]);
    expect(cold.historyRows).toBe(0);
    expect(cold.mountedRows).toBeLessThanOrEqual(20);
    expect(cold.detailReadBlockIds).not.toContain(toolCallBlockId);
    expect(cold.detailReadBlockIds).not.toContain(toolResultBlockId);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE full-display\n');

    // Follow actual animation frames during one native continuous gesture.
    // Stable visible block coordinates matter more than numeric scrollTop.
    await evaluate(`(() => {
      window.__chatContinuity = { frames: [], running: true };
      const sample = () => {
        const state = window.__chatContinuity;
        if (!state.running) return;
        const scroller = document.querySelector('.stream-renderer__scroll');
        const viewport = scroller.getBoundingClientRect();
        const first = [...scroller.querySelectorAll('[data-block-id]')]
          .filter(el => el.getBoundingClientRect().bottom > viewport.top
            && el.getBoundingClientRect().top < viewport.bottom)
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
        state.frames.push({ id: first?.dataset.blockId ?? null,
          top: first?.getBoundingClientRect().top ?? null,
          scrollTop: scroller.scrollTop });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })()`);
    await client.call('Input.synthesizeScrollGesture', {
      x: 450, y: 450, yDistance: 4_000, speed: 2_000, gestureSourceType: 'mouse',
    });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const gestureFrames = await evaluate<Array<{ id: string | null; top: number | null; scrollTop: number }>>(`(() => {
      window.__chatContinuity.running = false;
      return window.__chatContinuity.frames;
    })()`);
    const visiblePositions = gestureFrames.flatMap((frame) => frame.id
      ? [Number(frame.id.replace(/^legacy-/, ''))] : []);
    expect(visiblePositions.length).toBeGreaterThan(10);
    expect(visiblePositions.at(-1)).toBeLessThan(visiblePositions[0]);
    expect(gestureFrames.filter((frame) => frame.id === null)).toHaveLength(0);
    expect(visiblePositions.slice(1).filter((position, index) => position - visiblePositions[index] > 20)).toHaveLength(0);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE continuous-wheel\n');

    await evaluate(`window.__sourceBackedHistory.navigate({block:'${targetBlockId}'})`);
    const exact = await waitFor('exact target focus', async () => {
      const value = await snapshot();
      return value?.focusedBlockId === targetBlockId ? value : null;
    }, browser, profile);
    const exactRequest = exact.requests.map((url) => new URL(url, origin)).find((url) => (
      url.searchParams.get('block') === targetBlockId && url.searchParams.get('view') === 'display'
    ));
    expect(exactRequest).toBeTruthy();
    expect(exact.historyRows).toBe(0);
    expect(exact.loadedIntervals).toEqual([{ start: 0, end: SOURCE_BACKED_HISTORY_BLOCK_COUNT - 1 }]);
    expect(exact.anchorBlockLoaded).toBe(true);
    expect(exact.scrollHeight).toBeLessThanOrEqual(cold.scrollHeight + (2 * exact.clientHeight));
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE canonical-anchor\n');

    await evaluate(`window.__sourceBackedHistory.navigate({block:'${toolCallBlockId}'})`);
    const toolCall = await waitFor('tool call display request', async () => {
      const value = await snapshot();
      return value.requests.some((url) => {
        const query = new URL(url, origin).searchParams;
        return query.get('block') === toolCallBlockId && query.get('view') === 'display';
      }) ? value : null;
    }, browser, profile);
    let toolCallRowVisible = false;
    for (let attempt = 0; attempt < 50 && !toolCallRowVisible; attempt += 1) {
      toolCallRowVisible = await evaluate<boolean>(`[...document.querySelectorAll('.message-block-wrapper')].some(element => (
        element.dataset.blockId === ${JSON.stringify(toolCallBlockId)}
        || element.dataset.memberRefs?.split(/\\s+/).includes(${JSON.stringify(toolCallBlockId)})
      ))`);
      if (!toolCallRowVisible) await wheel(900);
    }
    expect(toolCallRowVisible, 'tool activity should enter the mounted virtual range during traversal').toBe(true);
    expect(toolCall.text).not.toContain('source-backed tool result');
    expect(toolCall.detailReadBlockIds).not.toContain(toolCallBlockId);
    const openedTool = await evaluate<boolean>(`(() => {
      const owner=[...document.querySelectorAll('.message-block-wrapper')].find(element => (
        element.dataset.blockId === ${JSON.stringify(toolCallBlockId)}
        || element.dataset.memberRefs?.split(/\\s+/).includes(${JSON.stringify(toolCallBlockId)})
      ));
      const disclosure=owner?.querySelector('.tool-card .compact-activity__row');
      if(!(disclosure instanceof HTMLButtonElement)) return false;
      disclosure.click();
      return true;
    })()`);
    expect(openedTool).toBe(true);
    const expandedTool = await waitFor('tool call and result detail reads', async () => {
      const value = await snapshot();
      return value?.detailReadBlockIds.includes(toolCallBlockId)
        && value.detailReadBlockIds.includes(toolResultBlockId)
        && value.text.includes('source-backed tool result')
        ? value
        : null;
    }, browser, profile);
    expect(expandedTool.expandedToolDetails).toBe(true);
    expect(expandedTool.requests.some((url) => {
      const query = new URL(url, origin).searchParams;
      return query.get('position') === String(toolCallPosition) && query.get('view') === null;
    })).toBe(true);
    expect(expandedTool.requests.some((url) => {
      const query = new URL(url, origin).searchParams;
      return query.get('position') === String(toolResultPosition) && query.get('view') === null;
    })).toBe(true);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE lazy-tool-details\n');

    const traversalRequestStart = expandedTool.requests.length;
    let atBeginning: BrowserSnapshot | null = null;
    for (let attempt = 0; attempt < 20 && !atBeginning; attempt += 1) {
      await wheel(-12_000);
      const value = await snapshot();
      if (value.text.includes('FIRST SOURCE BACKED PROMPT') && value.scrollTop <= 1) atBeginning = value;
    }
    expect(atBeginning, 'repeated upward wheel input should reach the true beginning').not.toBeNull();
    expect(atBeginning!.historyRows).toBe(0);
    process.stdout.write('SOURCE_BACKED_CHAT_STAGE beginning\n');

    let traversalSteps = 0;
    for (; traversalSteps < 1_200; traversalSteps += 1) {
      const value = await snapshot();
      const atEnd = value.scrollHeight - value.scrollTop - value.clientHeight <= 1;
      if (atEnd
          && value.seenBlockIds.length === expectedReadableBlockIds.length) break;
      await wheel(Math.max(1, Math.floor(value.clientHeight * 0.5)));
    }
    const complete = await snapshot();
    process.stdout.write(`SOURCE_BACKED_CHAT_STAGE traversed ${complete.seenBlockIds.length} readable, fetched ${complete.fetchedBlockIds.length} blocks in ${traversalSteps} steps\n`);
    const extentRatio = Math.max(cold.scrollHeight, complete.scrollHeight)
      / Math.max(1, Math.min(cold.scrollHeight, complete.scrollHeight));
    process.stdout.write(`SOURCE_BACKED_CHAT_EXTENT initial ${cold.scrollHeight} full ${complete.scrollHeight} ratio ${extentRatio.toFixed(2)}\n`);
    // This fixture omits production Chat CSS, so measured rows are shorter
    // than the estimates calibrated for the real layout.
    expect(extentRatio).toBeLessThan(1.6);
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
    expect(complete.historyRows).toBe(0);
    expect(complete.requests.slice(traversalRequestStart).some((url) => (
      new URL(url, origin).searchParams.has('position')
    ))).toBe(false);
    expect(new Set(complete.detailReadBlockIds)).toEqual(new Set([toolCallBlockId, toolResultBlockId]));
    const windowRequests = complete.requests.filter((url) => url.includes(`/api/conversations/source-backed-history?`));
    expect(windowRequests.length).toBeGreaterThan(3);
    for (const request of windowRequests) {
      const response = await fetch(new URL(request, origin));
      const payload = await response.json() as {
        blocks: unknown[];
        total: number;
        window: {
          limit: number;
          start_position: number | null;
          end_position: number | null;
          has_before: boolean;
          has_after: boolean;
        };
      };
      expect(payload.total).toBe(SOURCE_BACKED_HISTORY_BLOCK_COUNT);
      const view = new URL(request, origin).searchParams.get('view');
      if (view === 'display') {
        expect(payload.blocks.length).toBeLessThanOrEqual(500);
        expect(payload.window.limit).toBeLessThanOrEqual(500);
        expect(payload.window.start_position).toBeGreaterThanOrEqual(0);
        expect(payload.window.end_position).toBeLessThan(SOURCE_BACKED_HISTORY_BLOCK_COUNT);
      } else {
        expect(payload.blocks.length).toBeLessThanOrEqual(160);
        expect(payload.window.limit).toBeLessThanOrEqual(160);
      }
    }

    const rss = Number(spawnSync('ps', ['-o', 'rss=', '-p', String(browser.pid)], { encoding: 'utf8' }).stdout.trim());
    expect(rss).toBeLessThan(1_000_000);

    // Save an older reading position, then remount on a newer source version.
    // The source-backed window restores the same canonical block.
    let sourceRefreshBeforeAnchor: { id: string; top: number; scrollTop: number; viewportTop: number } | null = null;
    let sourceRefreshBeforeState: BrowserSnapshot | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const value = await snapshot();
      const anchorBlockId = value.readingAnchor?.blockId;
      const anchorPosition = value.readingAnchor?.position;
      if (anchorBlockId && typeof anchorPosition === 'number' && anchorPosition < 450
          && value.readingAnchor?.followingTail === false) {
        const block = await visibleAnchor(anchorBlockId, true);
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
    expect(sourceRefreshBeforeAnchor!.id).toBe(sourceRefreshBeforeState!.readingAnchor?.blockId);
    expect(sourceRefreshBeforeState!.anchorBlockPosition).toBe(sourceRefreshBeforeState!.readingAnchor?.position);
    expect(Math.abs(
      sourceRefreshBeforeAnchor!.top - sourceRefreshBeforeAnchor!.viewportTop
        - sourceRefreshBeforeState!.readingAnchor!.viewportOffset!,
    )).toBeLessThan(5);
    const sourceRefreshRequestStart = sourceRefreshBeforeState!.transformedSourceRequests.length;
    const sourceRefreshHttpRequestStart = sourceRefreshBeforeState!.requests.length;
    await evaluate('window.__sourceBackedHistory.reloadWithNewSourceVersion()');
    await waitFor('complete display from the new source version is active after remount', async () => {
      const value = await snapshot();
      return value.transformedSourceRequests.slice(sourceRefreshRequestStart).some((url) => (
        new URL(url, origin).searchParams.get('target') === 'initial'
      )) ? value : null;
    }, browser, profile);
    const sourceRefreshRestored = await waitFor('same reading block is restored from the new source version', async () => {
      const value = await snapshot();
      const anchor = value.readingAnchor;
      const block = anchor?.blockId ? await visibleAnchor(anchor.blockId, true) : null;
      if (!block || anchor?.blockId !== sourceRefreshBeforeAnchor!.id
          || anchor.position !== sourceRefreshBeforeState!.readingAnchor!.position) return null;
      const refreshedDisplay = value.requests.slice(sourceRefreshHttpRequestStart).some((url) => {
        const query = new URL(url, origin).searchParams;
        return query.get('target') === 'initial' && query.get('view') === 'display';
      });
      return refreshedDisplay
        && anchor.followingTail === false
        && value.sourceVersionId !== sourceRefreshBeforeState!.sourceVersionId
        && value.anchorBlockLoaded
        && value.anchorBlockPosition === anchor.position
        ? { block, value }
        : null;
    }, browser, profile);
    const sourceRefreshAfterAnchor = sourceRefreshRestored.block;
    const sourceRefreshRestoredState = sourceRefreshRestored.value;
    expect(sourceRefreshAfterAnchor.id).toBe(sourceRefreshBeforeAnchor!.id);
    expect(sourceRefreshAfterAnchor.text).toBe(sourceRefreshBeforeAnchor!.text);
    expect(Math.abs(
      sourceRefreshAfterAnchor.top - sourceRefreshAfterAnchor.viewportTop
        - sourceRefreshRestoredState.readingAnchor!.viewportOffset!,
    )).toBeLessThan(5);
    expect(Math.abs(
      sourceRefreshAfterAnchor.top - sourceRefreshAfterAnchor.viewportTop
        - sourceRefreshBeforeAnchor!.top + sourceRefreshBeforeAnchor!.viewportTop,
    )).toBeLessThan(5);
    const sourceRefreshExtentRatio = Math.max(
      sourceRefreshBeforeState!.scrollHeight,
      sourceRefreshRestoredState.scrollHeight,
    ) / Math.max(1, Math.min(
      sourceRefreshBeforeState!.scrollHeight,
      sourceRefreshRestoredState.scrollHeight,
    ));
    expect(sourceRefreshExtentRatio).toBeLessThan(1.6);
    await wheel(-40);
    const beforeUpwardMeasurement = await visibleAnchor(sourceRefreshAfterAnchor.id, true);
    expect(beforeUpwardMeasurement, 'the reading block should remain visible during upward input').not.toBeNull();
    const beforeUpwardState = await snapshot();
    const measurement = await scheduleDelayedGroupMeasurement(beforeUpwardMeasurement!.id);
    expect(measurement, 'a mounted group above the reading anchor should be available for delayed measurement').not.toBeNull();
    const afterDelayedMeasurement = await waitFor('delayed group measurement preserves the visible message', async () => {
      const value = await snapshot();
      const block = await visibleAnchor(beforeUpwardMeasurement!.id, true);
      if (!block || value.scrollHeight < beforeUpwardState.scrollHeight + 200) return null;
      return { value, block };
    }, browser, profile);
    expect(afterDelayedMeasurement.block.id).toBe(beforeUpwardMeasurement!.id);
    expect(Math.abs(afterDelayedMeasurement.block.top - beforeUpwardMeasurement!.top)).toBeLessThan(5);
    expect(afterDelayedMeasurement.value.scrollTop).toBeGreaterThan(beforeUpwardState.scrollTop + 200);
    expect(afterDelayedMeasurement.value.readingAnchor).toEqual(beforeUpwardState.readingAnchor);
    expect(afterDelayedMeasurement.value.readingAnchor?.followingTail).toBe(false);

    const scrollbar = await evaluate<{ x: number; thumbY: number; middleY: number }>(`(() => {
      const track=document.querySelector('.stream-renderer__scrollbar-track').getBoundingClientRect();
      const thumb=document.querySelector('.stream-renderer__scrollbar-thumb').getBoundingClientRect();
      return {x:thumb.left+thumb.width/2,thumbY:thumb.top+thumb.height/2,middleY:track.top+track.height/2};
    })()`);
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: scrollbar.x, y: scrollbar.thumbY });
    await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: scrollbar.x, y: scrollbar.thumbY,
      button: 'left', buttons: 1, clickCount: 1 });
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: scrollbar.x, y: scrollbar.middleY,
      button: 'left', buttons: 1 });
    const beforeDragGrowth = await snapshot();
    await evaluate(`(() => {
      const style=document.createElement('style');
      style.id='held-thumb-row-growth';
      style.textContent='.stream-renderer__virtual-row[data-virtual-kind="group"] { padding-bottom: 320px !important; box-sizing: border-box !important; }';
      document.head.append(style);
    })()`);
    const duringDragGrowth = await waitFor('held thumb stays with pointer through row growth', async () => {
      const value = await snapshot();
      if (value.scrollHeight < beforeDragGrowth.scrollHeight + 200) return null;
      return evaluate<{ thumbY: number; scrollTop: number }>(`(() => {
        const thumb=document.querySelector('.stream-renderer__scrollbar-thumb').getBoundingClientRect();
        const scroll=document.querySelector('.stream-renderer__scroll');
        return {thumbY:thumb.top+thumb.height/2,scrollTop:scroll.scrollTop};
      })()`);
    }, browser, profile);
    expect(Math.abs(duringDragGrowth.thumbY - scrollbar.middleY)).toBeLessThan(1);
    expect(Math.abs(duringDragGrowth.scrollTop - beforeDragGrowth.scrollTop)).toBeGreaterThan(100);
    await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: scrollbar.x, y: scrollbar.middleY,
      button: 'left', buttons: 0, clickCount: 1 });
    await client.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scrollbar.x, y: scrollbar.middleY,
      deltaX: 0, deltaY: -80 });
    await waitFor('wheel over released thumb scrolls immediately', async () => {
      const value = await snapshot();
      return value.scrollTop < duringDragGrowth.scrollTop - 20 ? value : null;
    }, browser, profile);
    await evaluate(`document.getElementById('held-thumb-row-growth').remove()`);

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
      historyRequests: windowRequests,
      firstPromptReached: complete.seenBlockIds.includes(expectedReadableBlockIds[0]),
      sourceCanonicalIdentities: complete.fetchedBlockIds.length,
      readableCanonicalIdentities: complete.seenBlockIds.length,
      maximumMountedRows: complete.maximumMountedRows,
      sourceRefreshAnchor: {
        position: sourceRefreshBeforeState!.readingAnchor!.position,
        before: sourceRefreshBeforeAnchor,
        after: sourceRefreshAfterAnchor,
        extentRatio: sourceRefreshExtentRatio,
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
