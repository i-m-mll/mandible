// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium, webkit } from 'playwright-core';
import { expect, it } from 'vitest';
import { launchTestBrowser } from '../helpers/chromium';
import { testRuntimeRoot } from '../helpers/runtime-isolation';

it.each([chromium, webkit].map(engine => ({ name: engine.name(), engine })))('renders the current source through A to B to A after native scrolling in $name', async ({ engine }) => {
  const directory = mkdtempSync(join(testRuntimeRoot, 'reading-scope-'));
  const browser = await launchTestBrowser(engine);
  try {
    const bundled = buildSync({ entryPoints: [resolve('test/provisioned/fixtures/chat-reading-scope-fixture.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact', alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' }, loader: { '.css': 'empty' } });
    const styles = ['tokens', 'base', 'contextual-action', 'message-blocks', 'console'].map(name => readFileSync(resolve(`ui/src/styles/${name}.css`), 'utf8')).join('\n');
    const file = join(directory, 'fixture.html');
    writeFileSync(file, `<!doctype html><html data-theme="codex"><style>${styles}#root{width:700px;height:500px}.stream-renderer{height:100%}</style><div id="root"></div><script>${bundled.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></html>`);
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.goto(pathToFileURL(file).href);
    for (const [index, conversationId] of ['A', 'B', 'A'].entries()) {
      if (index > 0) await page.evaluate(id => window.openChat(id), conversationId);
      await page.waitForFunction(id => {
        const scroller = document.querySelector('.stream-renderer__scroll');
        const canvas = scroller?.querySelector('.stream-renderer__virtual-canvas');
        return scroller?.getAttribute('aria-busy') === 'false' && canvas?.textContent?.includes(`${id}:`) && getComputedStyle(canvas).visibility === 'visible';
      }, conversationId);
      const scroller = page.locator('.stream-renderer__scroll');
      expect(await scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      if (index < 2) await scroller.evaluate(node => { node.scrollTop = node.scrollHeight / 2; });
    }
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});
