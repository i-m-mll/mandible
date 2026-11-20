// @provisioned chromium
/**
 * The interface-notes embed on another app's React page records the React
 * components of the element a note is made on. Agentation does so only in a
 * development build on a page it detects as React, so a package bump that
 * breaks either condition shows here as a note without components.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, buildSync } from 'esbuild';
import { chromium } from 'playwright-core';
import { afterAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../helpers/chromium';
import { testRuntimeRoot } from '../helpers/runtime-isolation';
// @ts-expect-error The build module is plain JavaScript.
import { embedBuildOptions } from '../../ui/embed-build.mjs';

const PREACT_ALIAS = { react: 'preact/compat', 'react-dom': 'preact/compat', 'react-dom/client': 'preact/compat/client', 'react/jsx-runtime': 'preact/jsx-runtime' };
const directory = mkdtempSync(join(testRuntimeRoot, 'notes-embed-'));
const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A daemon origin that serves the embed and a bridge answering with a fixed identity and recording created notes. */
const BRIDGE = `<!doctype html><script>
const created = [];
addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.kind !== 'mandible-interface-notes') return;
  const reply = (message) => event.source.postMessage({ kind: 'mandible-interface-notes', ...message }, event.origin);
  if (data.type === 'hello') return reply({ type: 'identity', identity: { app: 'studio:web', project: { id: 'prj_studio', key: 'studio', name: 'Studio' } } });
  if (data.type !== 'call') return;
  if (data.operation === 'create') {
    const input = data.args[0];
    const note = { ...input, app: 'studio:web', comment_id: null, issue_id: null, issue_ref: null, created_at: 1, updated_at: 1 };
    created.push(note);
    parent.postMessage({ kind: 'test-created', note }, '*');
    return reply({ type: 'result', id: data.id, ok: true, value: note });
  }
  reply({ type: 'result', id: data.id, ok: true, value: data.operation === 'listUnfiled' || data.operation === 'listIssuesWithNotes' ? [] : null });
});
</script>`;

async function listen(server: Server, host: string): Promise<number> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, host, done));
  return (server.address() as AddressInfo).port;
}

it('records the React components of the element a note is made on', async () => {
  await build({ ...embedBuildOptions({ outdir: directory, alias: PREACT_ALIAS }), logLevel: 'silent', minify: false });
  const embed = readFileSync(join(directory, 'interface-notes-embed.js'));
  const daemonPort = await listen(createServer((req, res) => {
    if (req.url === '/embed/notes.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' }).end(embed);
    } else if (req.url === '/embed/bridge') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(BRIDGE);
    } else res.writeHead(404).end();
  }), '127.0.0.1');

  const host = buildSync({
    entryPoints: [resolve('test/provisioned/fixtures/interface-notes-react-host.tsx')], bundle: true, write: false, format: 'iife',
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  }).outputFiles[0].text;
  const page = `<!doctype html><body><div id="root"></div><script src="/host.js"></script>`
    + `<script type="module" src="http://127.0.0.1:${daemonPort}/embed/notes.js"></script></body>`;
  const hostPort = await listen(createServer((req, res) => {
    if (req.url === '/host.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(host);
    else res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  }), '127.0.0.1');

  const browser = await launchTestBrowser(chromium);
  try {
    const tab = await browser.newPage();
    tab.setDefaultTimeout(5000);
    const created = new Promise<{ target: { react_components?: string | null } }>((done) => {
      void tab.exposeFunction('testCreated', done);
    });
    await tab.addInitScript(() => addEventListener('message', (event) => {
      if (event.data?.kind === 'test-created') (window as unknown as { testCreated(note: unknown): void }).testCreated(event.data.note);
    }));
    await tab.goto(`http://localhost:${hostPort}/`);
    await tab.locator('[aria-label="Start feedback mode"]').click();
    await tab.locator('#panel-title').click();
    await tab.getByPlaceholder('What should change?').fill('Make this bolder');
    await tab.keyboard.press('Enter');
    expect((await created).target.react_components).toContain('StudioPanel');
  } finally {
    await browser.close();
  }
});
