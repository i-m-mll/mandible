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

const source = ':::spec-item{key="rating" type="rating" required="true"}\nRate confidence\n:::';
const bodyStart = source.indexOf('Rate confidence');
const bodyEnd = bodyStart + 'Rate confidence'.length;
const definitionDigest = createHash('sha256').update(source).digest('hex');
const panelPath = path.join(repoRoot, 'ui/src/views/feedback/BriefingDocumentPanel.tsx');

const entry = `
  import { render } from 'preact';
  import { useState } from 'preact/hooks';
  import { BriefingDocumentPanel } from ${JSON.stringify(panelPath)};

  const source = ${JSON.stringify(source)};
  const round = {
    round_id: 'round-browser', state: 'open', briefing_key: 'browser-regression',
    binding_digest: 'binding', created_at: 1, latest_submission_for_actor: null,
    document: { artifact_version_id: 'artifact-version:browser', previous_round_id: null, profile: 'mandible-briefing.v2' },
    directive_binding: { status: 'valid' },
    latest_frozen_membership: { answer_event_ids: [], annotation_event_ids: [] },
    annotations: [], valid: true,
    items: [{
      id: 'rating', client_item_key: 'rating', parent_item_id: null, item_kind: 'item',
      revision: { id: 'revision-rating', ordinal: 1, title: 'rating', prompt: 'Rate confidence', description: null, response_type: 'rating', required: true, position: 5, options: [] },
      effective_response: null, responseVisible: true,
      directive: { key: 'rating', definition_digest: ${JSON.stringify(definitionDigest)}, start_offset: 0, end_offset: source.length, body_start_offset: ${bodyStart}, body_end_offset: ${bodyEnd} },
    }],
  };
  const content = {
    content: {
      artifact_id: 'artifact:browser', status: 'available', kind: 'markdown', media_type: 'text/markdown',
      size_bytes: new TextEncoder().encode(source).byteLength, source: null,
      preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false },
      download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'browser.md' },
    },
  };
  window.fetch = async () => new Response(JSON.stringify(content), { status: 200, headers: { 'content-type': 'application/json' } });
  window.__briefingEvents = [];
  for (const type of ['click', 'input', 'change']) {
    document.addEventListener(type, (event) => {
      if (event.target instanceof HTMLInputElement && event.target.value === '4') {
        window.__briefingEvents.push(type + ':' + event.target.checked);
      }
    }, true);
  }
  function Harness() {
    const [draft, setDraft] = useState({
      verdict: { verdict: 'keep' }, single: { option_key: 'a' }, multi: { option_keys: ['first'] },
      short: { text: 'short' }, long: { text: 'long' },
    });
    const complete = ['verdict', 'single', 'multi', 'short', 'long', 'rating'].every((key) => draft[key]);
    return <>
      <BriefingDocumentPanel briefingId="briefing-browser" briefingTitle="Browser regression" roundId="round-browser"
        round={round} canMutate draft={draft} onRefresh={async () => null}
        onDirectiveValue={(id, value) => setDraft((current) => ({ ...current, [id]: value }))} />
      <button id="submit" disabled={!complete}>Submit</button>
    </>;
  }
  render(<Harness />, document.getElementById('root'));
`;

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

try {
  await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: repoRoot, sourcefile: 'briefing-rating-browser.tsx' },
    outfile: path.join(temporaryRoot, 'bundle.js'), bundle: true, format: 'iife', target: 'chrome120',
    jsx: 'automatic', jsxImportSource: 'preact', nodePaths: [dependencyRoot],
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' },
    logLevel: 'silent',
  });
  await writeFile(path.join(temporaryRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');

  server = http.createServer(async (request, response) => {
    const file = request.url === '/bundle.js' ? 'bundle.js' : 'index.html';
    response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
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
  const center = await waitFor(async () => {
    const result = await cdpRequest(webSocket, 'Runtime.evaluate', {
      expression: `(() => { const input = [...document.querySelectorAll('input[type=radio]')].find((row) => row.value === '4'); if (!input) return null; const rect = input.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`,
      returnByValue: true,
    });
    return result.result.value;
  }, 'compiled rating control');
  await cdpRequest(webSocket, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 });
  await cdpRequest(webSocket, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 });
  await wait(100);
  const result = await cdpRequest(webSocket, 'Runtime.evaluate', {
    expression: `(() => { const input = [...document.querySelectorAll('input[type=radio]')].find((row) => row.value === '4'); return { checked: input.checked, submitDisabled: document.getElementById('submit').disabled, events: window.__briefingEvents }; })()`,
    returnByValue: true,
  });
  webSocket.close();
  const observed = result.result.value;
  if (!observed.checked || observed.submitDisabled) {
    throw new Error(`rating draft was lost after the native click: ${JSON.stringify(observed)}`);
  }
  console.log(`Briefing rating native-event regression passed: ${JSON.stringify(observed)}`);
} finally {
  if (browser && browser.exitCode === null) browser.kill('SIGTERM');
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
