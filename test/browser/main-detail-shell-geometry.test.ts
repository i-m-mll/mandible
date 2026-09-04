import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Edges = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type RailMode = 'expanded' | 'icons';
type SidebarMode = 'shown' | 'hidden';
type Surface = 'chat' | 'graph' | 'timeline';
type Geometry = {
  width: 1280 | 760;
  rail: RailMode;
  sidebar: SidebarMode;
  surface: Surface;
  appHeader: Edges;
  railRect: Edges;
  sidebarRect: Edges | null;
  main: Edges;
  shell: Edges | null;
  header: Edges | null;
  body: Edges | null;
  footer: Edges | null;
  slots: Array<string | null>;
  productionClass: string | null;
  bottomPanel: Edges;
  bottomBoundary: Edges | null;
  bottomShell: Edges;
  bottomHeader: Edges | null;
  bottomBody: Edges | null;
  bottomFooter: Edges | null;
  transcript: Edges | null;
  composer: Edges | null;
  scrollTopBefore: number | null;
  scrollPreserved: boolean | null;
  scrollNodeStable: boolean | null;
  previewSelected: boolean | null;
};

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync);

const styles = [
  'ui/src/styles/tokens.css',
  'ui/src/styles/base.css',
  'ui/src/styles/chat-history.css',
  'ui/src/styles/conversations.css',
  'ui/src/styles/chat-bottom-shelf.css',
  'ui/src/styles/console.css',
  'ui/src/styles/detail-pane-shell.css',
  'ui/src/styles/graph.css',
  'ui/src/styles/timeline.css',
].map((path) => readFileSync(resolve(path), 'utf8')).join('\n');

function canonicalCheckoutRoot(): string {
  if (statSync(resolve('.git')).isDirectory()) return process.cwd();
  const gitFile = readFileSync(resolve('.git'), 'utf8').trim();
  const gitDirectory = gitFile.replace(/^gitdir:\s*/, '');
  const marker = `${join('.git', 'worktrees')}`;
  const markerIndex = gitDirectory.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error(`Cannot resolve canonical checkout from ${gitDirectory}`);
  return gitDirectory.slice(0, markerIndex).replace(/[\\/]$/, '');
}

function fixtureBundle(temporaryDirectory: string): string {
  const checkoutRoot = canonicalCheckoutRoot();
  const outputPath = join(temporaryDirectory, 'fixture.js');
  const bundled = spawnSync(join(checkoutRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
    resolve('test/browser/fixtures/main-detail-shell-native-fixture.tsx'),
    '--bundle', `--outfile=${outputPath}`, '--format=iife', '--platform=browser', '--target=es2020',
    '--jsx=automatic', '--jsx-import-source=preact', '--alias:react=preact/compat',
    '--alias:react-dom=preact/compat', '--alias:react/jsx-runtime=preact/jsx-runtime',
    '--loader:.css=empty', '--minify', '--log-level=silent',
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: join(checkoutRoot, 'node_modules') },
  });
  if (bundled.status !== 0) {
    throw new Error(`Native fixture bundle failed (${bundled.status}/${bundled.signal}): ${bundled.stderr || bundled.stdout || bundled.error?.message}`);
  }
  return readFileSync(outputPath, 'utf8');
}

function renderGeometrySuite(): Geometry[] {
  if (!chrome) throw new Error('A Chromium browser is required for the main-detail shell geometry regression.');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'mandible-main-detail-'));
  try {
    const bundle = fixtureBundle(temporaryDirectory);
    const frameHtml = `<!doctype html><html><head><style>${styles}</style><style>
    *{box-sizing:border-box}html,body{margin:0;overflow:clip}.fixture-case{height:540px}
    .app-shell{--app-view-sidebar-persisted-width:320px;--app-view-sidebar-width:320px;--app-bottom-panel-height:180px}
    .app-shell,.app-layout{height:100%}
  </style></head><body><script>${bundle}</script></body></html>`;
    const framePayload = JSON.stringify(frameHtml).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html><body><script>
    const frameHtml = ${framePayload};
    const widths = [1280, 760];
    const results = [];
    const rect = (root, selector) => {
      const node = root.querySelector(selector);
      if (!node) return null;
      const bounds = node.getBoundingClientRect();
      return Object.fromEntries(['left','right','top','bottom','width','height'].map((key) => [key, bounds[key]]));
    };
    const measure = async (width, frame) => {
      const doc = frame.contentDocument;
      for (const root of doc.querySelectorAll('.fixture-case')) {
        const surface = root.dataset.surface;
        const shellRoot = surface === 'chat' ? root.querySelector('.chat-history-detail') : root.querySelector('.app-bottom-panel');
        const shell = shellRoot.querySelector('.detail-pane-shell');
        const scrollNode = surface === 'chat' ? root.querySelector('.stream-renderer__scroll') : null;
        if (scrollNode) {
          scrollNode.scrollTop = Math.min(120, Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight));
          scrollNode.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        const scrollTopBefore = scrollNode ? scrollNode.scrollTop : null;
        if (surface === 'chat') {
          root.querySelector('.app-bottom-panel [role="tab"][aria-controls="chat-shelf-panel-preview"]').click();
          await Promise.resolve();
        }
        const currentScrollNode = surface === 'chat' ? root.querySelector('.stream-renderer__scroll') : null;
        results.push({
          width,
          rail: root.dataset.rail,
          sidebar: root.dataset.sidebar,
          surface,
          appHeader: rect(root, '.app-header'),
          railRect: rect(root, '.app-rail'),
          sidebarRect: rect(root, '.view-sidebar'),
          main: rect(root, surface === 'chat' ? '.chat-history-detail' : '.app-bottom-panel'),
          shell: rect(shellRoot, '.detail-pane-shell'),
          header: rect(shellRoot, '.detail-pane-shell > .detail-pane-shell__header'),
          body: rect(shellRoot, '.detail-pane-shell > .detail-pane-shell__body'),
          footer: rect(shellRoot, '.detail-pane-shell > .detail-pane-shell__footer'),
          slots: Array.from(shell.children, (child) => child.getAttribute('data-detail-pane-slot')),
          productionClass: surface === 'chat'
            ? shell.classList.contains('chat-detail-frame') ? 'chat-detail-frame' : null
            : surface === 'graph'
              ? shell.classList.contains('graph-detail-pane') ? 'graph-detail-pane' : null
              : shell.classList.contains('timeline-inspector') ? 'timeline-inspector' : null,
          bottomPanel: rect(root, '.app-bottom-panel'),
          bottomBoundary: rect(root, '.app-bottom-panel__content > .chat-entity-link-boundary'),
          bottomShell: rect(root, '.app-bottom-panel .detail-pane-shell'),
          bottomHeader: rect(root, '.app-bottom-panel .detail-pane-shell__header'),
          bottomBody: rect(root, '.app-bottom-panel .detail-pane-shell__body'),
          bottomFooter: rect(root, '.app-bottom-panel .detail-pane-shell__footer'),
          transcript: rect(root, '.conv-transcript'),
          composer: rect(root, '.conv-compose'),
          scrollTopBefore,
          scrollPreserved: scrollNode ? currentScrollNode.scrollTop === scrollTopBefore : null,
          scrollNodeStable: scrollNode ? currentScrollNode === scrollNode : null,
          previewSelected: surface === 'chat'
            ? root.querySelector('.app-bottom-panel [role="tab"][aria-controls="chat-shelf-panel-preview"]').getAttribute('aria-selected') === 'true'
            : null,
        });
      }
      if (results.length === widths.length * 12) document.title = btoa(JSON.stringify(results));
    };
    for (const width of widths) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'display:block;border:0;width:' + width + 'px;height:540px';
      frame.addEventListener('load', async () => {
        try {
          if (frame.contentDocument.title !== 'ready') throw new Error('fixture runtime did not reach ready');
          await measure(width, frame);
        } catch (error) {
          document.title = 'fixture-error:' + btoa(String(error && error.stack || error));
        }
      }, { once: true });
      frame.srcdoc = frameHtml;
      document.body.append(frame);
    }
  </script></body></html>`;
    const fixturePath = join(temporaryDirectory, 'fixture.html');
    writeFileSync(fixturePath, html);
    const rendered = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom', '--window-size=1400,900',
      `file://${fixturePath}`,
    ], { encoding: 'utf8', maxBuffer: 20_000_000 });
    if (rendered.status !== 0) throw new Error(`Chromium geometry fixture failed: ${rendered.stderr}`);
    const fixtureError = rendered.stdout.match(/<title>fixture-error:([^<]+)<\/title>/)?.[1];
    if (fixtureError) throw new Error(atob(fixtureError));
    const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
    if (!encoded) throw new Error(`Chromium did not emit production main-detail geometry: ${rendered.stderr}\n${rendered.stdout.slice(0, 2000)}`);
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Geometry[];
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function expectSameHorizontalEdges(actual: Edges | null, expected: Edges): void {
  expect(actual).not.toBeNull();
  expect(actual).toMatchObject({ left: expected.left, right: expected.right, width: expected.width });
}

describe('production main-detail shell geometry', () => {
  it('keeps mounted Chat, Graph, and Timeline compositions inside the main column', () => {
    const geometries = renderGeometrySuite();
    expect(geometries).toHaveLength(24);

    for (const geometry of geometries) {
      const railWidth = geometry.rail === 'icons' ? 56 : 208;
      const detailLeft = railWidth + (geometry.sidebar === 'shown' ? 320 : 0);
      expect(geometry.railRect).toMatchObject({ left: 0, right: railWidth, width: railWidth });
      expect(geometry.appHeader.right).toBe(detailLeft);
      if (geometry.sidebar === 'shown') {
        expect(geometry.sidebarRect).toMatchObject({ left: railWidth, right: detailLeft, width: 320 });
      } else {
        expect(geometry.sidebarRect).toBeNull();
      }
      expect(geometry.main).toMatchObject({ left: detailLeft, right: geometry.width, width: geometry.width - detailLeft });
      expectSameHorizontalEdges(geometry.shell, geometry.main);
      expectSameHorizontalEdges(geometry.header, geometry.main);
      expectSameHorizontalEdges(geometry.body, geometry.main);
      expect(geometry.header?.top).toBe(geometry.shell?.top);
      expect(geometry.body?.top).toBe(geometry.header?.bottom);
      if (geometry.surface === 'chat') {
        expect(geometry.footer).not.toBeNull();
        expect(geometry.slots).toEqual(['header', 'body', 'footer', 'overlay-host']);
        expect(geometry.body?.bottom).toBe(geometry.footer?.top);
        expect(geometry.transcript?.bottom).toBeLessThanOrEqual(geometry.composer!.top);
        expect(geometry.scrollTopBefore).toBeGreaterThan(0);
        expect(geometry.scrollPreserved).toBe(true);
        expect(geometry.scrollNodeStable).toBe(true);
        expect(geometry.previewSelected).toBe(true);
        expect(Math.abs(geometry.main.bottom - geometry.bottomPanel.top)).toBeLessThanOrEqual(1);
        expect(geometry.bottomPanel).toMatchObject({
          left: detailLeft,
          right: geometry.width,
          width: geometry.width - detailLeft,
        });
        expectSameHorizontalEdges(geometry.bottomShell, geometry.bottomPanel);
        expect(geometry.bottomBoundary).not.toBeNull();
        expect(geometry.bottomHeader).not.toBeNull();
        expect(geometry.bottomBody).not.toBeNull();
        expect(geometry.bottomFooter).not.toBeNull();
        expect(Math.abs(geometry.bottomBoundary!.top - geometry.bottomPanel.top)).toBeLessThanOrEqual(1);
        expect(geometry.bottomBoundary!.bottom).toBe(geometry.bottomPanel.bottom);
        expect(geometry.bottomShell).toMatchObject(geometry.bottomBoundary!);
        expect(geometry.bottomHeader!.top).toBe(geometry.bottomShell.top);
        expect(geometry.bottomBody!.top).toBe(geometry.bottomHeader!.bottom);
        expect(geometry.bottomBody!.bottom).toBe(geometry.bottomFooter!.top);
        expect(geometry.bottomFooter!.bottom).toBe(geometry.bottomShell.bottom);
        expect(geometry.bottomBody!.height).toBeGreaterThan(0);
      } else {
        expect(geometry.footer).toBeNull();
        expect(geometry.slots).toEqual(['header', 'body', 'overlay-host']);
      }
      const expectedClass = geometry.surface === 'chat'
        ? 'chat-detail-frame'
        : geometry.surface === 'graph' ? 'graph-detail-pane' : 'timeline-inspector';
      expect(geometry.productionClass).toBe(expectedClass);
    }
  });
});
