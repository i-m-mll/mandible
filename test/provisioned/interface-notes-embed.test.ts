// @provisioned chromium
/**
 * The interface-notes embed on another app's React page records the React
 * components of the element a note is made on. Agentation does so only in a
 * development build on a page it detects as React, so a package bump that
 * breaks either condition shows here as a note without components. The Send
 * menu, in the embed's shadow root, is the toolbar's own interface: a click in
 * it acts on the menu and never reaches Agentation as a click on the page.
 * The toolbar and the menu stay above whatever the host page opens over itself:
 * a modal dialog, a fixed overlay at the highest z-index, a later popover.
 * Keys typed into the embed never reach the host's own key handling.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, buildSync } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../helpers/chromium';
import { testRuntimeRoot } from '../helpers/runtime-isolation';
// @ts-expect-error The build module is plain JavaScript.
import { embedBuildOptions } from '../../ui/embed-build.mjs';

const PREACT_ALIAS = { react: 'preact/compat', 'react-dom': 'preact/compat', 'react-dom/client': 'preact/compat/client', 'react/jsx-runtime': 'preact/jsx-runtime' };
const directory = mkdtempSync(join(testRuntimeRoot, 'notes-embed-'));
const servers: Server[] = [];
let browser: Browser;
let hostUrl: string;
afterAll(async () => {
  await browser?.close();
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
  const value = data.operation === 'listUnfiled' ? created : data.operation === 'listIssuesWithNotes' ? [] : null;
  reply({ type: 'result', id: data.id, ok: true, value });
});
</script>`;

async function listen(server: Server, host: string): Promise<number> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, host, done));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
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
  hostUrl = `http://localhost:${hostPort}/`;
  browser = await launchTestBrowser(chromium);
});

type CreatedNote = { text: string; target: Record<string, unknown> & { react_components?: string | null } };

/** The host page, and the notes the bridge records from it in order. */
async function openHost(): Promise<{ tab: Page; created: CreatedNote[] }> {
  const tab = await browser.newPage();
  tab.setDefaultTimeout(5000);
  const created: CreatedNote[] = [];
  await tab.exposeFunction('testCreated', (note: CreatedNote) => { created.push(note); });
  await tab.addInitScript(() => addEventListener('message', (event) => {
    if (event.data?.kind === 'test-created') (window as unknown as { testCreated(note: unknown): void }).testCreated(event.data.note);
  }));
  await tab.goto(hostUrl);
  await tab.locator(LAUNCHER).waitFor();
  return { tab, created };
}

const LAUNCHER = '[aria-label="Start feedback mode"]';

/** Makes a note on `target` through the toolbar, then opens Send's New issue title field. */
async function noteAndSend(tab: Page, created: CreatedNote[], target: string, text: string): Promise<CreatedNote> {
  await tab.locator(LAUNCHER).click();
  await tab.locator(target).click();
  await tab.getByPlaceholder('What should change?').fill(text);
  await tab.keyboard.press('Enter');
  await expect.poll(() => created.find((note) => note.text === text)).toBeTruthy();
  await tab.locator('[aria-label="Send Annotations"]').click();
  await tab.getByRole('menuitem', { name: 'New issue' }).click();
  await expect.poll(() => tab.getByLabel('New issue title').isVisible()).toBe(true);
  return created.find((note) => note.text === text)!;
}

it('records the React components of the element a note is made on, and keeps Send menu clicks off the page', async () => {
  const { tab, created } = await openHost();
  // Feedback mode stays on; the menu opens over the page, and one click on New issue opens its title field.
  const note = await noteAndSend(tab, created, '#panel-title', 'Make this bolder');
  expect(note.target.react_components).toContain('StudioPanel');
  expect(await tab.locator('[data-annotation-popup]').count()).toBe(0);
  await tab.close();
});

it('takes Source and Reference from the nearest stamped ancestor of an element React gives no source for', async () => {
  const { tab, created } = await openHost();
  await tab.locator(LAUNCHER).click();
  await tab.locator('#error-text').click();
  await tab.getByPlaceholder('What should change?').fill('Where is this from?');
  await tab.keyboard.press('Enter');
  await expect.poll(() => created.find((note) => note.text === 'Where is this from?')).toBeTruthy();
  expect(created.find((note) => note.text === 'Where is this from?')!.target)
    .toMatchObject({ source_file: 'studio/ErrorBox.tsx:42', reference: 'error-7' });
  await tab.close();
});

/** Covers the viewport with an element of the given kind, holding a heading `#cover-title`. */
function cover(kind: 'modal' | 'overlay' | 'popover'): void {
  const element = document.createElement(kind === 'modal' ? 'dialog' : 'div');
  element.id = 'cover';
  element.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;'
    + 'padding:0;border:0;background:white;z-index:2147483647';
  element.innerHTML = '<h2 id="cover-title">Run settings</h2>';
  if (kind === 'popover') element.setAttribute('popover', 'manual');
  document.body.appendChild(element);
  if (element instanceof HTMLDialogElement) element.showModal();
  else if (kind === 'popover') element.showPopover();
}

it.each(['modal', 'overlay', 'popover'] as const)('keeps the toolbar and the Send menu above a host %s', async (kind) => {
  const { tab, created } = await openHost();
  await tab.evaluate(cover, kind);
  const note = await noteAndSend(tab, created, '#cover-title', `Note under ${kind}`);
  expect(JSON.stringify(note.target)).toContain('Run settings');
  if (kind === 'modal') {
    // Once the dialog closes, the toolbar is back on the page and still takes clicks.
    await tab.evaluate(() => (document.getElementById('cover') as HTMLDialogElement).close());
    await tab.locator('[aria-label="Exit"]').click();
    await tab.locator(LAUNCHER).click();
    expect(await tab.evaluate(() => document.querySelector('[data-agentation-portal]')?.parentElement === document.body)).toBe(true);
  }
  await tab.close();
});

it.each(['a document Escape listener', 'its native cancel'] as const)('keeps Escape typed in a note from closing a host dialog through %s', async (closer) => {
  const { tab, created } = await openHost();
  await tab.evaluate(cover, 'modal');
  if (closer === 'a document Escape listener') {
    await tab.evaluate(() => {
      const dialog = document.getElementById('cover') as HTMLDialogElement;
      dialog.addEventListener('cancel', (event) => event.preventDefault());
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') dialog.close(); });
    });
  }
  await tab.locator(LAUNCHER).click();
  await tab.locator('#cover-title').click();
  const field = tab.getByPlaceholder('What should change?');
  await field.fill('Draft');
  await field.press('Escape');
  await expect.poll(() => field.count()).toBe(0);
  const open = () => tab.evaluate(() => (document.getElementById('cover') as HTMLDialogElement).open);
  expect(await open()).toBe(true);

  // Nor does Escape typed in the Send menu's title field.
  await tab.locator('[aria-label="Exit"]').click();
  await noteAndSend(tab, created, '#cover-title', `Note under ${closer}`);
  await tab.getByLabel('New issue title').press('Escape');
  await expect.poll(() => tab.getByLabel('New issue title').count()).toBe(0);
  expect(await open()).toBe(true);

  // Escape on the page itself still reaches the host, once the menu and feedback mode have taken theirs.
  await tab.locator('[aria-label="Exit"]').click();
  await tab.locator('#cover-title').click();
  await tab.keyboard.press('Escape');
  await expect.poll(open).toBe(false);
  await tab.close();
});
