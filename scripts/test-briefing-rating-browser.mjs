import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const checkoutRoot = path.resolve(repoRoot, '../..');
const dependencyRoot = [repoRoot, checkoutRoot]
  .map((root) => path.join(root, 'node_modules'))
  .find((candidate) => existsSync(path.join(candidate, 'esbuild', 'lib', 'main.js')));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!dependencyRoot) throw new Error('Unable to locate the existing repository node_modules toolchain.');
if (!existsSync(chrome)) throw new Error(`Chrome is unavailable at ${chrome}`);

const { build } = await import(pathToFileURL(path.join(dependencyRoot, 'esbuild', 'lib', 'main.js')).href);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mandible-briefing-rating-'));
const profile = path.join(temporaryRoot, 'chrome-profile');
let browser;
let server;

const definitions = [
  { key: 'verdict', type: 'verdict', prompt: 'Keep this?', options: [] },
  { key: 'single', type: 'single_choice', prompt: 'Choose one', options: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }] },
  { key: 'multi', type: 'multi_choice', prompt: 'Choose evidence', options: [{ key: 'first', label: 'First' }, { key: 'second', label: 'Second' }, { key: 'third', label: 'Third' }] },
  { key: 'short', type: 'short_text', prompt: 'Short rationale', options: [] },
  { key: 'long', type: 'long_text', prompt: 'Long rationale', options: [] },
  { key: 'rating', type: 'rating', prompt: 'Confidence rating', options: [] },
];
let source = '# Browser regression\n';
const directives = definitions.map((definition, position) => {
  const startOffset = source.length;
  const header = `:::spec-item{key="${definition.key}" type="${definition.type}" required="true"}\n`;
  const optionSource = definition.options.map((option) => `\n::option[${option.label}]{key="${option.key}"}`).join('');
  const block = `${header}${definition.prompt}${optionSource}\n:::`;
  const bodyStartOffset = startOffset + header.length;
  source += `${block}\n`;
  return {
    id: `item-${definition.key}`,
    directive_key: definition.key,
    position,
    definition_digest: createHash('sha256').update(block).digest('hex'),
    response_type: definition.type,
    required: 1,
    prompt: definition.prompt,
    options: definition.options,
    start_offset: startOffset,
    end_offset: startOffset + block.length,
    body_start_offset: bodyStartOffset,
    body_end_offset: bodyStartOffset + definition.prompt.length,
  };
});
const initialValues = {
  verdict: { verdict: 'keep' },
  single: { option_key: 'b' },
  multi: { option_keys: ['first', 'third'] },
  short: { text: 'Short answer' },
  long: { text: 'Long answer' },
};
const detail = {
  briefing: {
    id: 'briefing-browser', briefing_key: 'browser-regression', title: 'Browser regression',
    latest_round_id: 'round-browser', round_count: 1, created_at: 1, updated_at: 1,
  },
  rounds: [{ id: 'round-browser', ordinal: 1, artifact_version_id: 'artifact-version:browser', created_at: 1, origin: null }],
  selected_round: {
    id: 'round-browser', ordinal: 1, artifact_version_id: 'artifact-version:browser', previous_round_id: null,
    profile: 'mandible-briefing.v2', binding_digest: 'binding-browser', created_at: 1,
    document: { artifact_version_id: 'artifact-version:browser', previous_round_id: null, profile: 'mandible-briefing.v2' },
    binding: { status: 'valid' }, items: directives, answers: [],
    annotations: [], latest_submission: null, latest_frozen_membership: null,
  },
};
const rendererPath = path.join(repoRoot, 'ui/src/views/feedback/BriefingDocumentRenderer.tsx');
const appShellPath = path.join(repoRoot, 'ui/src/app-shell.tsx');
const cssPath = path.join(repoRoot, 'ui/src/styles/briefing.css');

const entry = `
  import { render } from 'preact';
  import { AppShellProvider } from ${JSON.stringify(appShellPath)};
  import { BriefingDocumentRenderer } from ${JSON.stringify(rendererPath)};
  import ${JSON.stringify(cssPath)};

  const detail = ${JSON.stringify(detail)};
  const source = ${JSON.stringify(source)};
  const storageKey = ['human-browser', 'briefing-browser', 'round-browser', 'artifact-version:browser', 'mandible-briefing.v2']
    .map(encodeURIComponent).join(':');
  if (!localStorage.getItem('mandible.briefing.draft:v2:' + storageKey)) {
    localStorage.setItem('mandible.briefing.draft:v2:' + storageKey, JSON.stringify({ version: 2, answers: ${JSON.stringify(Object.fromEntries(Object.entries(initialValues).map(([key, value]) => [`item-${key}`, value])))} }));
  }
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  window.__briefingEvents = [];
  window.__detailReads = 0;
  window.fetch = async (input, init = {}) => {
    const url = String(input);
    if ((init.method ?? 'GET') !== 'GET') throw new Error('The browser regression must not submit answers.');
    if (url === '/api/client-auth/whoami') return json({ authenticated: true, user: { id: 'human-browser', kind: 'human' } });
    if (url === '/api/briefings/briefing-browser?round=round-browser') {
      window.__detailReads += 1;
      return json(detail);
    }
    if (url.includes('/api/artifacts/') && url.endsWith('/content')) return json({ content: {
      artifact_id: 'artifact:browser', status: 'available', kind: 'markdown', media_type: 'text/markdown',
      size_bytes: new TextEncoder().encode(source).byteLength, source: null,
      preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false },
      download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'browser.md' },
    } });
    throw new Error('Unexpected browser regression request: ' + url);
  };
  for (const type of ['click', 'input', 'change']) {
    document.addEventListener(type, (event) => {
      if (event.target instanceof HTMLInputElement && event.target.value === '4' && event.target.closest('.briefing-directive__rating')) {
        window.__briefingEvents.push(type + ':' + event.target.checked);
      }
    }, true);
  }
  const shell = { active: true, bottomPanel: null, registerBottomPanel: () => () => undefined, setViewSidebarWidth: () => undefined };
  const instance = { role: 'preview', operational_mutations: 'reject', operational_mutations_overridden: true,
    briefing_response_mutations: 'allow', db_path: '/private/browser.db', db_path_source: 'start_options' };
  const mountRenderer = (root) => render(<AppShellProvider value={shell}><BriefingDocumentRenderer briefingId="briefing-browser" roundId="round-browser" instance={instance} /></AppShellProvider>, root);
  mountRenderer(document.getElementById('root'));
  window.__mountDuplicateRenderer = () => mountRenderer(document.getElementById('duplicate-root'));
`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch {
      // Navigation temporarily invalidates the Runtime execution context.
    }
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

async function evaluate(webSocket, expression, awaitPromise = false) {
  const result = await cdpRequest(webSocket, 'Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

const snapshotExpression = `(() => {
  const primary = document.getElementById('root');
  const duplicate = document.getElementById('duplicate-root');
  const ratings = [...primary.querySelectorAll('.briefing-directive__rating input[type=radio]')];
  const rating4 = ratings.find((input) => input.value === '4');
  const stored = Object.entries(localStorage).map(([key, value]) => [key, JSON.parse(value)]).find(([key]) => key.startsWith('mandible.briefing.draft:v2:'));
  const single = primary.querySelector('.briefing-directive__choices input[type=radio]:checked');
  const multi = [...primary.querySelectorAll('.briefing-directive__choices input[type=checkbox]:checked')].map((input) => input.value);
  const duplicateRating4 = [...duplicate.querySelectorAll('.briefing-directive__rating input[type=radio]')].find((input) => input.value === '4');
  const duplicateSingle = duplicate.querySelector('.briefing-directive__choices input[type=radio]:checked');
  const duplicateMulti = [...duplicate.querySelectorAll('.briefing-directive__choices input[type=checkbox]:checked')].map((input) => input.value);
  return {
    ratingCheckedValues: ratings.filter((input) => input.checked).map((input) => input.value),
    rating4Checked: rating4?.checked ?? null,
    rating4OuterHTML: rating4?.outerHTML ?? null,
    submitDisabled: document.querySelector('.briefing-primary')?.getAttribute('aria-disabled'),
    storedRating: stored?.[1]?.answers?.['item-rating']?.rating ?? null,
    storedRatingType: typeof stored?.[1]?.answers?.['item-rating']?.rating,
    singleChecked: single?.value ?? null,
    multiChecked: multi,
    duplicateRating4Checked: duplicateRating4?.checked ?? null,
    duplicateSingleChecked: duplicateSingle?.value ?? null,
    duplicateMultiChecked: duplicateMulti,
    radioNames: [rating4?.name ?? null, duplicateRating4?.name ?? null],
    singleNames: [single?.name ?? null, duplicateSingle?.name ?? null],
    events: [...window.__briefingEvents],
    detailReads: window.__detailReads,
  };
})()`;

function assertSelected(snapshot, phase) {
  if (snapshot.rating4Checked !== true || snapshot.ratingCheckedValues.join(',') !== '4') {
    throw new Error(`${phase}: rating 4 was not the sole checked radio: ${JSON.stringify(snapshot)}`);
  }
  if (snapshot.submitDisabled !== 'false') throw new Error(`${phase}: Submit was not enabled: ${JSON.stringify(snapshot)}`);
  if (snapshot.storedRating !== 4 || snapshot.storedRatingType !== 'number') {
    throw new Error(`${phase}: stored draft did not contain numeric rating 4: ${JSON.stringify(snapshot)}`);
  }
  if (snapshot.singleChecked !== 'b' || snapshot.multiChecked.join(',') !== 'first,third') {
    throw new Error(`${phase}: existing single/multi controlled state changed: ${JSON.stringify(snapshot)}`);
  }
}

try {
  await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: repoRoot, sourcefile: 'briefing-rating-browser.tsx' },
    outfile: path.join(temporaryRoot, 'bundle.js'), bundle: true, format: 'iife', target: 'chrome120',
    jsx: 'automatic', jsxImportSource: 'preact', nodePaths: [dependencyRoot],
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' },
    logLevel: 'silent',
  });
  await writeFile(path.join(temporaryRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><div id="duplicate-root" hidden></div><script src="/bundle.js"></script>');

  server = http.createServer(async (request, response) => {
    const file = request.url === '/bundle.js' ? 'bundle.js' : request.url === '/bundle.css' ? 'bundle.css' : 'index.html';
    response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(path.join(temporaryRoot, file)));
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
    } catch { return null; }
  }, 'Chrome DevTools port');
  const targets = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json`);
      const rows = await response.json();
      return rows.find((row) => row.type === 'page' && row.url.startsWith(`http://127.0.0.1:${address.port}/`)) ? rows : null;
    } catch { return null; }
  }, 'isolated harness page');
  const target = targets.find((row) => row.type === 'page' && row.url.startsWith(`http://127.0.0.1:${address.port}/`));
  const webSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    webSocket.addEventListener('open', resolve, { once: true });
    webSocket.addEventListener('error', reject, { once: true });
  });
  await cdpRequest(webSocket, 'Runtime.enable');
  await cdpRequest(webSocket, 'Page.enable');
  await cdpRequest(webSocket, 'Accessibility.enable');

  const initial = await waitFor(async () => {
    const snapshot = await evaluate(webSocket, snapshotExpression);
    return snapshot.rating4Checked === false && snapshot.singleChecked === 'b'
      && snapshot.multiChecked.join(',') === 'first,third' && snapshot.submitDisabled === 'true' ? snapshot : null;
  }, 'renderer-owned initial draft');
  const center = await evaluate(webSocket, `(() => { const input = [...document.querySelectorAll('.briefing-directive__rating input')].find((row) => row.value === '4'); const label = input.closest('label'); label.scrollIntoView({ block: 'center' }); const rect = label.getBoundingClientRect(); const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, labelRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, hit: hit?.outerHTML ?? null }; })()`);
  await cdpRequest(webSocket, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 });
  await cdpRequest(webSocket, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 });

  let immediate;
  try {
    immediate = await waitFor(async () => {
      const snapshot = await evaluate(webSocket, snapshotExpression);
      return snapshot.storedRating === 4 ? snapshot : null;
    }, 'numeric renderer-owned rating draft');
  } catch (error) {
    const diagnostic = await evaluate(webSocket, snapshotExpression);
    throw new Error(`${error.message} Click target: ${JSON.stringify(center)} Last renderer snapshot: ${JSON.stringify(diagnostic)}`);
  }
  assertSelected(immediate, 'immediate render');
  const animationFrames = await evaluate(webSocket, `(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return ${snapshotExpression}; })()`, true);
  assertSelected(animationFrames, 'two animation frames');

  await evaluate(webSocket, 'window.__mountDuplicateRenderer()');
  const duplicateHydrated = await waitFor(async () => {
    const snapshot = await evaluate(webSocket, snapshotExpression);
    return snapshot.duplicateRating4Checked !== null ? snapshot : null;
  }, 'same-document duplicate renderer hydration');
  assertSelected(duplicateHydrated, 'same-document renderer isolation');
  if (duplicateHydrated.duplicateRating4Checked !== true || duplicateHydrated.duplicateSingleChecked !== 'b'
      || duplicateHydrated.duplicateMultiChecked.join(',') !== 'first,third') {
    throw new Error(`duplicate renderer did not hydrate the controlled draft: ${JSON.stringify(duplicateHydrated)}`);
  }
  if (duplicateHydrated.radioNames[0] === duplicateHydrated.radioNames[1]) {
    throw new Error(`mounted renderer radio groups share a browser-global name: ${JSON.stringify(duplicateHydrated.radioNames)}`);
  }
  if (duplicateHydrated.singleNames[0] === duplicateHydrated.singleNames[1]) {
    throw new Error(`mounted single-choice groups share a browser-global name: ${JSON.stringify(duplicateHydrated.singleNames)}`);
  }

  const accessibility = await cdpRequest(webSocket, 'Accessibility.getFullAXTree');
  const rating4Node = accessibility.nodes.find((node) => node.role?.value === 'radio' && node.name?.value === '4');
  const checkedProperty = rating4Node?.properties?.find((property) => property.name === 'checked')?.value?.value;
  if (checkedProperty !== 'true') throw new Error(`accessibility tree did not expose rating 4 as checked: ${JSON.stringify(rating4Node)}`);

  const readsBeforeReconcile = duplicateHydrated.detailReads;
  await evaluate(webSocket, `window.dispatchEvent(new CustomEvent('briefing:sse', { detail: { type: 'briefing:answer-set', data: { briefing_id: 'briefing-browser' } } }));`);
  const reconciled = await waitFor(async () => {
    const snapshot = await evaluate(webSocket, snapshotExpression);
    return snapshot.detailReads > readsBeforeReconcile ? snapshot : null;
  }, 'SSE reconciliation');
  assertSelected(reconciled, 'persistence reconciliation');

  const lifecycle = reconciled.events;
  if (lifecycle.join(',') !== 'click:true,input:true,change:true') {
    throw new Error(`native lifecycle was not click → input → change: ${JSON.stringify(lifecycle)}`);
  }
  await cdpRequest(webSocket, 'Page.reload', { ignoreCache: true });
  const reloaded = await waitFor(async () => {
    const snapshot = await evaluate(webSocket, snapshotExpression);
    return snapshot.detailReads >= 1 && snapshot.storedRating === 4 ? snapshot : null;
  }, 'full harness reload');
  assertSelected(reloaded, 'full harness reload');
  webSocket.close();
  console.log(`Briefing rating renderer regression passed: ${JSON.stringify({ initial, immediate, animationFrames, duplicateHydrated, reconciled, reloaded, accessibilityChecked: checkedProperty, lifecycle })}`);
} finally {
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), wait(2_000)]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
