import { spawnChromium } from '../test/helpers/chromium.ts';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const observeOnly = process.argv.includes('--observe');


const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mandible-timeline-layout-'));
const profile = path.join(temporaryRoot, 'chrome-profile');
let browser;
let server;

const html = `<!doctype html>
<html data-theme="dark">
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="/ui/src/style.css">
  </head>
  <body>
    <div class="app-shell app-shell--rail-icons app-shell--view-sidebar-open">
      <div class="app-layout app-layout--rail-icons app-layout--route-timeline app-layout--view-sidebar-open app-layout--bottom-panel-open">
        <aside class="app-rail" data-app-surface="chrome"></aside>
        <main class="app-content app-content--timeline app-content--view-sidebar" data-app-surface="main">
          <section class="app-tab-panel app-tab-panel--timeline">
            <section class="timeline-workspace" aria-label="Project timeline">
              <div class="timeline-layout">
                <aside class="view-sidebar timeline-sidebar" data-app-surface="chrome" aria-label="Timeline controls" style="width:var(--app-view-sidebar-width);flex-shrink:0">
                  <div class="sidebar-drag-handle view-sidebar__resize-handle" role="separator"></div>
                  <div class="view-sidebar__body"><div class="timeline-toolbar">
                    <label class="timeline-control"><span>Project</span><select><option>mandible</option></select></label>
                    <label class="timeline-control"><span>Roots</span><select><option>Coordination + explicit</option></select></label>
                    <label class="timeline-control timeline-control--wide"><span>Explicit</span><input value="e564de9,83bf59f"></label>
                    <label class="timeline-control"><span>Density</span><select><option>Comfortable</option></select></label>
                    <label class="timeline-control"><span>From</span><input type="date" value="2026-08-01"></label>
                    <label class="timeline-control"><span>To</span><input type="date" value="2026-08-19"></label>
                    <div class="timeline-toggle-group"><button class="timeline-chip">Body</button><button class="timeline-chip">Comment</button><button class="timeline-chip">State</button></div>
                    <button class="timeline-diagnostics-button">Diagnostics<span>12</span></button>
                    <div class="timeline-status-row"></div>
                  </div>
                  <div class="timeline-diagnostics-panel"><span><strong>missing</strong>One diagnostic</span></div></div>
                </aside>
                <div class="timeline-canvas"><div class="timeline-grid"><div class="timeline-main">Timeline canvas</div></div></div>
              </div>
            </section>
          </section>
        </main>
        <aside class="app-bottom-panel app-bottom-panel--anchored-detail" aria-label="Timeline inspector" style="height:240px">
          <div class="app-bottom-panel__resize" role="separator"></div>
          <div class="app-bottom-panel__content">Inspector</div>
        </aside>
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
  if (!condition) throw new Error(`${message}: ${JSON.stringify(observed)}`);
}

try {
  await writeFile(path.join(temporaryRoot, 'index.html'), html);
  server = http.createServer((request, response) => {
    const requestPath = request.url === '/' ? '/index.html' : request.url;
    const filePath = requestPath === '/index.html' ? path.join(temporaryRoot, 'index.html') : path.join(repoRoot, requestPath);
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

  browser = spawnChromium([
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
  await waitFor(async () => {
    const ready = await cdpRequest(webSocket, 'Runtime.evaluate', {
      expression: `document.readyState === 'complete'
        && document.querySelector('.timeline-sidebar') !== null
        && document.querySelector('.view-sidebar__body') !== null
        && document.querySelector('.app-bottom-panel') !== null`,
      returnByValue: true,
    });
    return ready.result?.value === true;
  }, 'Timeline layout harness DOM');

  const scenarios = [
    { name: 'shown-min', sidebarWidth: 260, hidden: false },
    { name: 'shown-default', sidebarWidth: 320, hidden: false },
    { name: 'shown-wide', sidebarWidth: 480, hidden: false },
    { name: 'hidden', sidebarWidth: 320, hidden: true },
  ];
  const observations = [];

  for (const scenario of scenarios) {
    const result = await cdpRequest(webSocket, 'Runtime.evaluate', {
      expression: `(async () => {
        const layout = document.querySelector('.app-layout');
        const shell = document.querySelector('.app-shell');
        const sidebar = document.querySelector('.timeline-sidebar');
        const sidebarBody = document.querySelector('.view-sidebar__body');
        const panel = document.querySelector('.app-bottom-panel');
        layout.style.setProperty('--app-view-sidebar-width', '${scenario.sidebarWidth}px');
        shell.style.setProperty('--app-view-sidebar-width', '${scenario.sidebarWidth}px');
        layout.classList.toggle('app-layout--view-sidebar-open', ${!scenario.hidden});
        shell.classList.toggle('app-shell--view-sidebar-open', ${!scenario.hidden});
        sidebar.style.display = ${scenario.hidden} ? 'none' : '';
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const main = document.querySelector('.app-content');
        const canvas = document.querySelector('.timeline-canvas');
        const sidebarRect = sidebar.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const sidebarStyle = getComputedStyle(sidebar);
        const sidebarBodyStyle = getComputedStyle(sidebarBody);
        const descendants = [...sidebar.querySelectorAll('*')].map((element) => {
          const rect = element.getBoundingClientRect();
          return { selector: element.className || element.tagName.toLowerCase(), left: rect.left, right: rect.right, width: rect.width };
        }).sort((a, b) => b.right - a.right);
        const handle = sidebar.querySelector('.view-sidebar__resize-handle');
        const handleRect = handle.getBoundingClientRect();
        const handleBefore = getComputedStyle(handle, '::before');
        const pseudoLeft = handleRect.left + Number.parseFloat(handleBefore.left || '0');
        const pseudoWidth = Number.parseFloat(handleBefore.width || '0');
        sidebar.scrollLeft = 5;
        const sidebarScrollLeft = sidebar.scrollLeft;
        sidebar.scrollLeft = 0;
        return {
          sidebar: { left: sidebarRect.left, right: sidebarRect.right, width: sidebarRect.width, clientWidth: sidebar.clientWidth, scrollWidth: sidebar.scrollWidth, clientHeight: sidebar.clientHeight, scrollHeight: sidebar.scrollHeight, overflowX: sidebarStyle.overflowX, overflowY: sidebarStyle.overflowY },
          sidebarScrollLeft,
          scrollBody: { clientWidth: sidebarBody.clientWidth, scrollWidth: sidebarBody.scrollWidth, clientHeight: sidebarBody.clientHeight, scrollHeight: sidebarBody.scrollHeight, overflowX: sidebarBodyStyle.overflowX, overflowY: sidebarBodyStyle.overflowY },
          overflowOwner: sidebarBodyStyle.overflowY === 'auto' ? 'view-sidebar__body' : null,
          furthestDescendant: descendants[0],
          resizeHandlePseudo: { left: pseudoLeft, right: pseudoLeft + pseudoWidth, width: pseudoWidth },
          canvas: { left: canvasRect.left, right: canvasRect.right },
          main: { left: mainRect.left, right: mainRect.right },
          inspector: { left: panelRect.left, right: panelRect.right },
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    observations.push({ scenario: scenario.name, ...result.result.value });
  }

  console.log(JSON.stringify(observations, null, 2));
  if (!observeOnly) {
    for (const observed of observations) {
      if (observed.scenario !== 'hidden') {
        assert(observed.sidebarScrollLeft === 0, `${observed.scenario} outer sidebar has a horizontal range`, observed);
        assert(observed.scrollBody.scrollWidth === observed.scrollBody.clientWidth, `${observed.scenario} scroll body has a horizontal range`, observed);
        assert(observed.scrollBody.scrollHeight > observed.scrollBody.clientHeight, `${observed.scenario} sidebar lost vertical scrolling`, observed);
        assert(Math.abs(observed.inspector.left - observed.sidebar.right) <= 0.5, `${observed.scenario} inspector is not anchored to sidebar edge`, observed);
      } else {
        assert(Math.abs(observed.inspector.left - observed.main.left) <= 0.5, 'hidden inspector is not anchored to main edge', observed);
      }
      assert(Math.abs(observed.inspector.right - observed.main.right) <= 0.5, `${observed.scenario} inspector does not end at main edge`, observed);
    }
    console.log('Timeline layout browser contract passed.');
  }
  webSocket.close();
} finally {
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await new Promise((resolve) => browser.once('exit', resolve));
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
