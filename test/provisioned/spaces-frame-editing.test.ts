// @provisioned chromium
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { expect, it } from 'vitest';
import { setDb } from '../../src/db';
import { migrate } from '../../src/db-migrations';
import { createSpace } from '../../src/ledger/spaces';
import { getSpaceDocument } from '../../src/spaces/document-store';
import { parseSpaceSource } from '../../src/spaces/document-source';
import { registerSpacesRoutes } from '../../src/routes/spaces';
import { Router } from '../../src/server';
import { launchTestBrowser } from '../helpers/chromium';
import { testRuntimeRoot } from '../helpers/runtime-isolation';
import { migrateFixtureThrough } from '../helpers/schema-snapshot';
import type {} from './fixtures/spaces-frame-editing-fixture';

it('recovers a legacy draft and saves caret edits, pasted addresses and orphaned children in a migrated Space', async () => {
  const directory = mkdtempSync(join(testRuntimeRoot, 'spaces-frame-editing-'));
  const db = migrateFixtureThrough(248);
  const space = createSpace(db, { title: 'Frame editing', default_renderer: 'document' });
  const insert = db.prepare(`INSERT INTO space_blocks
    (id,space_id,parent_id,block_type,sort_key,markdown,metadata_json,created_at,updated_at)
    VALUES (?,?,?,'paragraph',?,?,'{"original":true}',3,9)`);
  const parentText = 'Alpha';
  const childText = 'Recovered child 😀\r\nkeeps its lines';
  insert.run('parent', space.id, null, 'a', parentText);
  insert.run('child', space.id, 'parent', 'b', 'Child 😀\r\nkeeps its lines');
  migrate(db);
  setDb(db);
  const instance = {
    role: 'test' as const, instance_id: 'space-frames', backend_generation: 'fixture',
    installation_id: 'private', public_origin: 'http://127.0.0.1',
    allowed_effects: ['ledger:read', 'ledger:write'] as const, writable_roots: [], db_path: null, db_path_source: null,
  };
  const router = new Router({ instance: { ...instance, allowed_effects: [...instance.allowed_effects] } });
  registerSpacesRoutes(router);
  const fixture = { instance, spaceId: space.id, operations: router.operationCatalog('test') };
  const script = await build({
    entryPoints: ['test/provisioned/fixtures/spaces-frame-editing-fixture.tsx'],
    outfile: join(directory, 'fixture.js'), write: false, bundle: true, format: 'esm',
    platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact',
    plugins: [{ name: 'unused-diff-worker', setup(context) {
      context.onResolve({ filter: /worker-portable\.js\?url$/ }, () => ({ path: 'worker', namespace: 'test' }));
      context.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export default "/unused-diff-worker.js";' }));
    } }],
  });
  const documentPath = `/api/spaces/${space.id}/document`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/') return new Response(
      `<!doctype html><style>html,body,#root{height:100%;margin:0}${script.outputFiles.find(file => file.path.endsWith('.css'))!.text}</style><div id="root"></div><script>window.spaceFixture=${JSON.stringify(fixture)}</script><script type="module" src="/fixture.js"></script>`,
      { headers: { 'content-type': 'text/html' } },
    );
    if (pathname === '/fixture.js') return new Response(script.outputFiles.find(file => file.path.endsWith('.js'))!.text,
      { headers: { 'content-type': 'text/javascript' } });
    if (pathname === '/api/client-auth/whoami') return Response.json({ authenticated: true, session: { csrf_token: 'test' } });
    const body = request.method === 'PATCH' ? await request.json() : undefined;
    const result = await router.invoke({ method: request.method, url: pathname, body });
    return Response.json(result.body, { status: result.status });
  } });
  let browser: Browser | undefined;
  try {
    browser = await launchTestBrowser(chromium);
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const legacyKey = `mandible.spaces.blockEditor:_:${space.id}`;
    await page.addInitScript(({ key, markdown }) => {
      localStorage.setItem(key, JSON.stringify({ editingId: 'child', drafts: { child: markdown } }));
    }, { key: legacyKey, markdown: childText });
    const saved = (fullEdit?: string) => page.waitForResponse(response => response.request().method() === 'PATCH'
      && response.url().endsWith(documentPath) && (!fullEdit || response.request().postDataJSON().source.includes(fullEdit)));
    const read = () => {
      const document = getSpaceDocument(db, space.id);
      return parseSpaceSource(space.id, document.source, document.generation).map(span => span.block);
    };
    const recoverySaved = saved(childText);
    await page.goto(server.url.href);
    const editor = page.getByRole('textbox', { name: 'Space document' });
    await editor.getByText('Recovered child 😀', { exact: true }).waitFor();
    expect((await recoverySaved).ok()).toBe(true);
    expect(read()[1]).toMatchObject({ id: 'child', parent_id: 'parent', markdown: childText });
    await page.waitForFunction(key => localStorage.getItem(key) === null, legacyKey);

    const editedParent = '!A\n:::\n!l!p!h!a!';
    const editsSaved = saved(editedParent);
    for (let offset = parentText.length; offset >= 0; offset--) {
      await page.evaluate(offset => window.selectSpaceFrame('parent', offset), offset);
      expect(await editor.innerText()).not.toContain('state="');
      await page.keyboard.insertText('!');
    }
    await page.evaluate(() => window.selectSpaceFrame('parent', 2));
    await page.keyboard.press('Enter');
    await page.keyboard.insertText(':::');
    await page.keyboard.press('Enter');
    expect((await editsSaved).ok()).toBe(true);
    expect(read()[0]).toMatchObject({ id: 'parent', markdown: editedParent, metadata: { original: true } });

    const prefix = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
    await page.evaluate(() => window.selectSpaceFrame('parent'));
    await page.keyboard.press(prefix + '+c');
    await page.evaluate(offset => window.selectSpaceFrame('child', offset), childText.length);
    const pasteSaved = saved();
    await page.keyboard.press(prefix + '+v');
    expect((await pasteSaved).ok()).toBe(true);
    const [parent, child, copy] = read();
    expect([parent.id, child.id]).toEqual(['parent', 'child']);
    expect(copy.id).not.toBe(parent.id);
    expect(copy.markdown).toBe(parent.markdown);
    expect(copy.metadata).toEqual(parent.metadata);

    await page.evaluate(() => window.selectSpaceFrame('parent'));
    const deletionSaved = saved();
    await page.keyboard.press('Backspace');
    expect((await deletionSaved).ok()).toBe(true);
    expect(read().map(({ id, parent_id, markdown }) => ({ id, parent_id, markdown }))).toEqual([
      { id: 'child', parent_id: null, markdown: childText },
      { id: copy.id, parent_id: null, markdown: copy.markdown },
    ]);
  } finally {
    await browser?.close();
    server.stop(true);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
