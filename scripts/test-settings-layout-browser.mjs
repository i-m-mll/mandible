import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(chrome)) throw new Error(`Chrome is unavailable at ${chrome}`);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mandible-settings-layout-'));
const profile = path.join(temporaryRoot, 'chrome-profile');
let browser;
let server;

const html = `<!doctype html>
<html data-theme="light">
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="/ui/src/styles/tokens.css">
    <link rel="stylesheet" href="/ui/src/styles/base.css">
    <link rel="stylesheet" href="/ui/src/styles/shared.css">
    <link rel="stylesheet" href="/ui/src/styles/settings.css">
  </head>
  <body>
    <div class="app-shell app-shell--rail-both">
      <div class="app-layout app-layout--rail-both app-layout--route-settings">
        <aside class="app-rail" data-app-surface="chrome"></aside>
        <main class="app-content" data-app-surface="main">
          <section class="app-tab-panel app-tab-panel--settings" data-tab="settings">
            <div class="settings-view">
              <div class="view-header">
                <div><h2>Settings</h2><div class="text-muted">Mandible configuration.</div></div>
                <button type="button" class="settings-view__close" aria-label="Close settings">×</button>
              </div>
              <div class="settings-view__section">
                <div class="settings-view__section-header"><h3 class="settings-view__section-title">Notifications</h3></div>
                <div class="settings-view__section-body">First card</div>
              </div>
              <div class="settings-view__section">
                <div class="settings-view__section-header"><h3 class="settings-view__section-title">Appearance</h3></div>
                <div class="settings-view__section-body">Second card</div>
              </div>
              <div class="settings-view__section" style="height: 700px">
                <div class="settings-view__section-header"><h3 class="settings-view__section-title">Scrollable content</h3></div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  </body>
</html>`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function cdpRequest(webSocket, method, params = {}) {
  const id = cdpRequest.nextId++;
  webSocket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CDP ${method} timed out.`)), 10_000);
    const listener = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timeout);
      webSocket.removeEventListener('message', listener);
      if (message.error) reject(new Error(`CDP ${method}: ${message.error.message}`));
      else resolve(message.result);
    };
    webSocket.addEventListener('message', listener);
  });
}
cdpRequest.nextId = 1;

function assert(condition, message, observed) {
  if (!condition) {
    throw new Error(`${message}: ${JSON.stringify(observed)}`);
  }
}

try {
  await writeFile(path.join(temporaryRoot, 'index.html'), html);
  server = http.createServer((request, response) => {
    const requestPath = request.url === '/' ? '/index.html' : request.url;
    const filePath = requestPath === '/index.html'
      ? path.join(temporaryRoot, 'index.html')
      : path.join(repoRoot, requestPath);
    const relativePath = path.relative(repoRoot, filePath);
    if (requestPath !== '/index.html' && (relativePath.startsWith('..') || path.isAbsolute(relativePath))) {
      response.writeHead(403).end();
      return;
    }
    if (!existsSync(filePath)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', filePath.endsWith('.css') ? 'text/css' : 'text/html');
    createReadStream(filePath).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate the isolated harness port.');

  browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    `http://127.0.0.1:${address.port}/`,
  ], { stdio: 'ignore' });

  const devtoolsPort = await waitFor(async () => {
    try {
      const lines = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      return Number(lines[0]) || null;
    } catch {
      return null;
    }
  }, 'Chrome DevTools port');
  const targets = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json`);
      const rows = await response.json();
      return rows.find((row) => row.type === 'page' && row.url.startsWith(`http://127.0.0.1:${address.port}/`)) ? rows : null;
    } catch {
      return null;
    }
  }, 'isolated harness page');
  const target = targets.find((row) => row.type === 'page' && row.url.startsWith(`http://127.0.0.1:${address.port}/`));
  const webSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    webSocket.addEventListener('open', resolve, { once: true });
    webSocket.addEventListener('error', reject, { once: true });
  });
  await cdpRequest(webSocket, 'Runtime.enable');
  await cdpRequest(webSocket, 'Page.enable');

  const scenarios = [
    { name: 'light-wide', theme: 'light', width: 1440, railMode: 'both', expectedSurface: 'rgb(255, 255, 255)' },
    { name: 'dark-wide', theme: 'dark', width: 1440, railMode: 'both', expectedSurface: 'rgb(24, 24, 24)' },
    { name: 'light-narrow', theme: 'light', width: 520, railMode: 'icons', expectedSurface: 'rgb(255, 255, 255)' },
    { name: 'dark-narrow', theme: 'dark', width: 520, railMode: 'icons', expectedSurface: 'rgb(24, 24, 24)' },
  ];
  const observations = [];

  for (const scenario of scenarios) {
    await cdpRequest(webSocket, 'Emulation.setDeviceMetricsOverride', {
      width: scenario.width,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const result = await cdpRequest(webSocket, 'Runtime.evaluate', {
      expression: `(async () => {
        document.documentElement.dataset.theme = ${JSON.stringify(scenario.theme)};
        const shell = document.querySelector('.app-shell');
        shell.className = 'app-shell app-shell--rail-${scenario.railMode}';
        const layout = document.querySelector('.app-layout');
        layout.className = 'app-layout app-layout--rail-${scenario.railMode} app-layout--route-settings';
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const main = document.querySelector('.app-content');
        const view = document.querySelector('.settings-view');
        const header = document.querySelector('.view-header');
        const close = document.querySelector('.settings-view__close');
        const cards = [...document.querySelectorAll('.settings-view__section')];
        const mainRect = main.getBoundingClientRect();
        const viewRect = view.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        const cardRect = cards[0].getBoundingClientRect();
        const mainStyle = getComputedStyle(main);
        const viewStyle = getComputedStyle(view);
        const cardStyle = getComputedStyle(cards[0]);
        return {
          main: { left: mainRect.left, right: mainRect.right, width: mainRect.width, background: mainStyle.backgroundColor },
          view: { left: viewRect.left, right: viewRect.right, width: viewRect.width, background: viewStyle.backgroundColor, overflowY: viewStyle.overflowY, clientHeight: view.clientHeight, scrollHeight: view.scrollHeight },
          header: { left: headerRect.left, right: headerRect.right },
          close: { left: closeRect.left, right: closeRect.right },
          card: { left: cardRect.left, right: cardRect.right, background: cardStyle.backgroundColor, borderRadius: cardStyle.borderRadius, borderStyle: cardStyle.borderTopStyle },
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const observed = result.result.value;
    const mainCenter = (observed.main.left + observed.main.right) / 2;
    const viewCenter = (observed.view.left + observed.view.right) / 2;
    const leftGutter = observed.view.left - observed.main.left;
    const rightGutter = observed.main.right - observed.view.right;

    assert(observed.main.background === scenario.expectedSurface, `${scenario.name} main surface color drifted`, observed);
    assert(observed.view.background === observed.main.background, `${scenario.name} inter-card surface does not match main`, observed);
    assert(scenario.theme !== 'light' || observed.view.background === 'rgb(255, 255, 255)', `${scenario.name} inter-card surface is not pure white`, observed);
    assert(Math.abs(viewCenter - mainCenter) <= 0.5, `${scenario.name} readable column is not centered on the actual main area`, { mainCenter, viewCenter, observed });
    assert(Math.abs(observed.header.left - observed.view.left) <= 0.5 && Math.abs(observed.header.right - observed.view.right) <= 0.5, `${scenario.name} header no longer aligns with the readable column`, observed);
    assert(Math.abs(observed.close.right - observed.view.right) <= 0.5, `${scenario.name} close button no longer aligns with the header edge`, observed);
    assert(observed.card.left === observed.view.left && observed.card.right === observed.view.right, `${scenario.name} card boundaries no longer follow the readable column`, observed);
    assert(observed.card.background !== 'rgba(0, 0, 0, 0)' && observed.card.borderRadius === '16px' && observed.card.borderStyle === 'solid', `${scenario.name} card appearance contract drifted`, observed);
    assert(observed.view.overflowY === 'auto' && observed.view.scrollHeight > observed.view.clientHeight, `${scenario.name} Settings scroll behavior drifted`, observed);
    if (scenario.width >= 1000) {
      assert(Math.abs(observed.view.width - 640) <= 0.5, `${scenario.name} readable max width drifted`, observed);
    } else {
      assert(observed.view.width < 640 && leftGutter >= 31 && rightGutter >= 31 && Math.abs(leftGutter - rightGutter) <= 0.5, `${scenario.name} responsive fill or safe gutters drifted`, { leftGutter, rightGutter, observed });
    }
    observations.push({ scenario: scenario.name, mainCenter, viewCenter, leftGutter, rightGutter, surface: observed.view.background });
  }

  webSocket.close();
  console.log(`Settings layout browser contract passed: ${JSON.stringify(observations)}`);
} finally {
  if (browser && browser.exitCode === null) browser.kill('SIGTERM');
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
