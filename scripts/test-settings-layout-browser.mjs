import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const settingsSource = await readFile(path.join(repoRoot, 'ui/src/views/settings.tsx'), 'utf8');
const settingsStyles = await readFile(path.join(repoRoot, 'ui/src/styles/settings.css'), 'utf8');

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
                <h2>Settings</h2>
              </div>
              <div class="settings-view__layout">
                <nav class="settings-view__toc" aria-label="Settings sections">
                  <button type="button" class="settings-view__toc-link settings-view__toc-link--active" aria-current="location" aria-controls="settings-notifications">Notifications</button>
                  <button type="button" class="settings-view__toc-link" aria-controls="settings-appearance">Appearance</button>
                  <button type="button" class="settings-view__toc-link" aria-controls="settings-scrollable">Scrollable content</button>
                </nav>
                <div class="settings-view__content">
                  <section class="settings-view__section" id="settings-notifications" aria-labelledby="settings-notifications-title">
                    <div class="settings-view__section-header"><h3 id="settings-notifications-title" class="settings-view__section-title">Notifications</h3></div>
                    <div class="settings-view__section-body"><button type="button">Toggle notifications</button></div>
                  </section>
                  <section class="settings-view__section" id="settings-appearance" aria-labelledby="settings-appearance-title">
                    <div class="settings-view__section-header"><h3 id="settings-appearance-title" class="settings-view__section-title">Appearance</h3></div>
                    <div class="settings-view__section-body"><select aria-label="App theme"><option>System</option></select></div>
                  </section>
                  <section class="settings-view__section" id="settings-scrollable" aria-labelledby="settings-scrollable-title" style="min-height: 700px">
                    <div class="settings-view__section-header"><h3 id="settings-scrollable-title" class="settings-view__section-title">Scrollable content</h3></div>
                  </section>
                </div>
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

assert(!settingsSource.includes('Mandible configuration.'), 'Settings subtitle remains in production source');
assert(!settingsSource.includes('settings-view__close'), 'Settings close control remains in production source');
assert(settingsSource.includes('aria-label="Settings sections"'), 'Settings section navigation is not labelled');
assert(!settingsSource.includes('settings-view__toc-title'), 'Settings navigation still renders the obsolete visible title');
assert(!settingsStyles.includes('.settings-view__toc-title'), 'Settings navigation retains obsolete title-only styles');
assert(settingsSource.includes('aria-current={isActive ? \'location\' : undefined}'), 'Settings navigation does not expose the current section');
assert(settingsSource.includes('aria-controls={section.id}'), 'Settings navigation does not identify its controlled section');
assert(settingsSource.includes("scrollIntoView({ behavior: 'smooth', block: 'start' })"), 'Settings navigation does not scroll the selected section');
assert(!settingsSource.includes('href={`#${section.id}`}'), 'Settings section navigation would replace the app hash route');
assert(settingsSource.includes('SETTINGS_SECTION_LIST.map'), 'Settings navigation is not derived from the section source');
for (const selector of [
  '.settings-view__toc-link:hover',
  '.settings-view__toc-link:focus-visible',
  '.settings-view__toc-link:active',
  '.settings-view__toc-link--active',
]) {
  assert(settingsStyles.includes(selector), `Settings navigation state is missing ${selector}`);
}
const sectionRegistry = settingsSource.match(/const SETTINGS_SECTIONS = \{([\s\S]*?)\} as const;/)?.[1] ?? '';
const sectionKeys = [...sectionRegistry.matchAll(/^\s{2}([a-zA-Z]+): \{/gm)].map((match) => match[1]);
const renderedSectionKeys = [...settingsSource.matchAll(/section=\{SETTINGS_SECTIONS\.([a-zA-Z]+)\}/g)].map((match) => match[1]);
assert(sectionKeys.length >= 12, 'Settings section registry is unexpectedly incomplete', sectionKeys);
assert(new Set(renderedSectionKeys).size === sectionKeys.length && sectionKeys.every((key) => renderedSectionKeys.includes(key)), 'Rendered Settings sections do not match the navigation source', { sectionKeys, renderedSectionKeys });

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
        const layoutComposition = document.querySelector('.settings-view__layout');
        const toc = document.querySelector('.settings-view__toc');
        const links = [...document.querySelectorAll('.settings-view__toc-link')];
        const sections = [...document.querySelectorAll('.settings-view__section')];
        const content = document.querySelector('.settings-view__content');
        const mainRect = main.getBoundingClientRect();
        const viewRect = view.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const layoutRect = layoutComposition.getBoundingClientRect();
        const tocRect = toc.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const mainStyle = getComputedStyle(main);
        const viewStyle = getComputedStyle(view);
        const layoutStyle = getComputedStyle(layoutComposition);
        const tocStyle = getComputedStyle(toc);
        const linkStyle = getComputedStyle(links[0]);
        const sectionStyle = getComputedStyle(sections[0]);
        return {
          main: { left: mainRect.left, right: mainRect.right, width: mainRect.width, background: mainStyle.backgroundColor },
          view: { left: viewRect.left, right: viewRect.right, width: viewRect.width, background: viewStyle.backgroundColor, overflowY: viewStyle.overflowY, clientHeight: view.clientHeight, scrollHeight: view.scrollHeight },
          header: { left: headerRect.left, right: headerRect.right },
          layout: { left: layoutRect.left, right: layoutRect.right, width: layoutRect.width, display: layoutStyle.display, columns: layoutStyle.gridTemplateColumns },
          toc: { left: tocRect.left, right: tocRect.right, position: tocStyle.position },
          content: { left: contentRect.left, right: contentRect.right, width: contentRect.width },
          link: { color: linkStyle.color, background: linkStyle.backgroundColor, outlineStyle: linkStyle.outlineStyle },
          section: { background: sectionStyle.backgroundColor, borderRadius: sectionStyle.borderRadius, borderStyle: sectionStyle.borderTopStyle, boxShadow: sectionStyle.boxShadow },
          semantics: {
            navLabel: toc.getAttribute('aria-label'),
            current: links.filter((link) => link.getAttribute('aria-current') === 'location').length,
            targetsMatch: links.every((link) => document.getElementById(link.getAttribute('aria-controls'))),
            closeCount: document.querySelectorAll('.settings-view__close').length,
            subtitleCount: [...document.querySelectorAll('*')].filter((node) => node.textContent?.trim() === 'Mandible configuration.').length,
            controls: document.querySelectorAll('.settings-view__section button, .settings-view__section input, .settings-view__section select').length,
            visibleTitleCount: [...toc.children].filter((node) => node.textContent?.trim().toLowerCase() === 'on this page').length,
          },
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const observed = result.result.value;
    const mainCenter = (observed.main.left + observed.main.right) / 2;
    const viewCenter = (observed.view.left + observed.view.right) / 2;
    const leftGutter = observed.layout.left - observed.main.left;
    const rightGutter = observed.main.right - observed.layout.right;

    assert(observed.main.background === scenario.expectedSurface, `${scenario.name} main surface color drifted`, observed);
    assert(observed.view.background === observed.main.background, `${scenario.name} inter-card surface does not match main`, observed);
    assert(scenario.theme !== 'light' || observed.view.background === 'rgb(255, 255, 255)', `${scenario.name} inter-card surface is not pure white`, observed);
    assert(Math.abs(viewCenter - mainCenter) <= 0.5, `${scenario.name} readable column is not centered on the actual main area`, { mainCenter, viewCenter, observed });
    assert(observed.semantics.closeCount === 0 && observed.semantics.subtitleCount === 0, `${scenario.name} redundant header chrome remains`, observed);
    assert(observed.semantics.visibleTitleCount === 0, `${scenario.name} visible navigation title remains`, observed);
    assert(observed.semantics.navLabel === 'Settings sections' && observed.semantics.current === 1 && observed.semantics.targetsMatch, `${scenario.name} navigation semantics drifted`, observed);
    assert(observed.semantics.controls >= 2, `${scenario.name} representative Settings controls disappeared`, observed);
    assert(observed.section.background === observed.view.background && observed.section.borderRadius === '0px' && observed.section.borderStyle === 'none' && observed.section.boxShadow === 'none', `${scenario.name} section surface is not flat`, observed);
    assert(observed.view.overflowY === 'auto' && observed.view.scrollHeight > observed.view.clientHeight, `${scenario.name} Settings scroll behavior drifted`, observed);
    if (scenario.width >= 1000) {
      assert(observed.layout.display === 'grid' && observed.content.width <= 640 && observed.toc.right < observed.content.left, `${scenario.name} wide TOC/content composition drifted`, observed);
      assert(Math.abs((observed.layout.left + observed.layout.right) / 2 - mainCenter) <= 0.5, `${scenario.name} composition is not centered on the main area`, observed);
    } else {
      assert(observed.layout.display === 'block' && observed.content.width === observed.layout.width && leftGutter >= 15 && rightGutter >= 15, `${scenario.name} responsive stacking or safe gutters drifted`, { leftGutter, rightGutter, observed });
    }
    observations.push({ scenario: scenario.name, mainCenter, viewCenter, leftGutter, rightGutter, surface: observed.view.background, columns: observed.layout.columns });
  }

  webSocket.close();
  console.log(`Settings layout browser contract passed: ${JSON.stringify(observations)}`);
} finally {
  if (browser && browser.exitCode === null) browser.kill('SIGTERM');
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
