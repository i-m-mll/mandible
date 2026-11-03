// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium, webkit, type Locator } from 'playwright-core';
import { expect, it } from 'vitest';
import { launchTestBrowser } from '../helpers/chromium';
import { testRuntimeRoot } from '../helpers/runtime-isolation';

it.each([chromium, webkit].map(engine => ({ name: engine.name(), engine })))('keeps shared event menus subordinate to native selection and specific controls in $name', async ({ engine }) => {
  const directory = mkdtempSync(join(testRuntimeRoot, 'event-menu-'));
  const browser = await launchTestBrowser(engine);
  try {
    const bundled = buildSync({ entryPoints: [resolve('test/provisioned/fixtures/chat-event-menu-fixture.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact', alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' }, loader: { '.css': 'empty' } });
    const styles = ['tokens', 'base', 'contextual-action', 'message-blocks', 'console'].map(name => readFileSync(resolve(`ui/src/styles/${name}.css`), 'utf8')).join('\n');
    const file = join(directory, 'fixture.html');
    writeFileSync(file, `<!doctype html><style>${styles}#root{width:700px;transform:translate(90px,70px)}#parent{padding:10px}#parent>span{display:block;padding:5px}</style><div id="root"></div><script>${bundled.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
    const page = await browser.newPage(); page.setDefaultTimeout(5000); await page.goto(pathToFileURL(file).href);
    const menu = page.getByRole('menu'); const parent = page.locator('#parent');
    await parent.waitFor({ state: 'visible' });
    const assertRingPainted = async (message: Locator) => {
      const svg = message.locator('.message-focus-paint');
      const rect = (await svg.locator('rect').boundingBox())!;
      const clip = { x: Math.floor(rect.x - 2), y: Math.floor(rect.y - 2), width: Math.ceil(rect.width + 4), height: Math.ceil(rect.height + 4) };
      const visible = await page.screenshot({ clip });
      await svg.evaluate(node => { (node as SVGElement).style.opacity = '0'; });
      const hidden = await page.screenshot({ clip });
      await svg.evaluate(node => { (node as SVGElement).style.removeProperty('opacity'); });
      const changedPixels = await page.evaluate(async ({ visible, hidden }) => {
        const pixels = async (data: string) => {
          const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data;
        };
        const shown = await pixels(visible); const baseline = await pixels(hidden);
        let count = 0;
        for (let i = 0; i < shown.length; i += 4) if (Math.abs(shown[i] - baseline[i]) + Math.abs(shown[i + 1] - baseline[i + 1]) + Math.abs(shown[i + 2] - baseline[i + 2]) > 20) count++;
        return count;
      }, { visible: visible.toString('base64'), hidden: hidden.toString('base64') });
      expect(changedPixels, `${engine.name()} must actually paint the message ring`).toBeGreaterThan(20);
    };
    await page.locator('#plain').click({ button: 'right', position: { x: 10, y: 10 } });
    await menu.waitFor({ state: 'visible' });
    const copyItem = menu.getByRole('menuitem', { name: 'Copy all', exact: true });
    await page.locator('#specific').click(); await menu.waitFor({ state: 'detached' });
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await page.locator('#plain').click({ button: 'right', position: { x: 10, y: 10 } }); await menu.waitFor({ state: 'visible' });
    await menu.getByRole('menuitem', { name: 'Info', exact: true }).click(); await menu.waitFor({ state: 'detached' });
    expect(await page.locator('body').getAttribute('data-called')).toBe('parent');
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await page.locator('#child-plain').click({ button: 'right' }); await menu.waitFor({ state: 'visible' });
    expect(await menu.count()).toBe(1); await menu.getByRole('menuitem', { name: 'Info', exact: true }).click();
    expect(await page.locator('body').getAttribute('data-called')).toBe('child');
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await page.locator('.compact-activity__row').click({ button: 'right' }); await menu.waitFor({ state: 'visible' });
    expect(await page.locator('.compact-activity__row').getAttribute('aria-expanded')).toBe('false');
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    expect(await page.locator('#tool').evaluate(node => document.activeElement === node)).toBe(true);
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    const beforeControlClick = Number(await page.locator('body').getAttribute('data-context-count'));
    await page.locator('#plain').click({ modifiers: ['Control'], position: { x: 10, y: 10 } });
    if (Number(await page.locator('body').getAttribute('data-context-count')) > beforeControlClick) {
      await menu.waitFor({ state: 'visible' }); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    } else expect(await menu.count()).toBe(0);
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    for (const key of ['Shift+F10', 'ContextMenu']) {
      await parent.focus(); await page.keyboard.press(key); await menu.waitFor({ state: 'visible' });
      expect(await copyItem.evaluate(node => document.activeElement === node)).toBe(true);
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    }
    await page.locator('#footer').getByRole('button', { name: 'More actions' }).click(); await menu.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    await page.locator('#plain').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    const selected = await page.evaluate(() => document.getSelection()!.toString());
    await page.locator('#plain').click({ button: 'right', position: { x: 10, y: 10 } });
    expect(await menu.count()).toBe(0); expect(await page.locator('body').getAttribute('data-prevented')).toBe('false');
    expect(await page.evaluate(() => document.getSelection()!.toString())).toBe(selected);
    await page.keyboard.press('Escape'); await parent.focus(); await page.keyboard.press('Shift+F10');
    expect(await menu.count()).toBe(0);
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    for (const width of [1000, 452.203125]) {
      await page.locator('#root').evaluate((node, value) => { (node as HTMLElement).style.width = `${value}px`; }, width);
      for (const id of ['short-message', 'paragraph-message', 'code-message']) {
        const message = page.locator(`#${id}`);
        await message.scrollIntoViewIfNeeded();
        const snapshot = () => page.evaluate(() => {
          const box = (node: Element) => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, node.scrollWidth, node.scrollHeight]; };
          const glyphs: number[][] = [];
          const walker = document.createTreeWalker(document.getElementById('paint-cases')!, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            for (let i = 0; i < (walker.currentNode.textContent?.length ?? 0); i++) {
              const range = document.createRange(); range.setStart(walker.currentNode, i); range.setEnd(walker.currentNode, i + 1);
              for (const r of range.getClientRects()) glyphs.push([r.x, r.y, r.width, r.height]);
            }
          }
          return { scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], boxes: Array.from(document.querySelectorAll('#paint-cases, #paint-cases *')).filter(node => !node.closest('.message-focus-paint')).map(box), glyphs };
        });
        const before = await snapshot();
        await message.focus();
        await message.locator('.message-focus-paint').waitFor({ state: 'attached' });
        expect(await snapshot()).toEqual(before);
        if (width === 1000 && id === 'short-message') await assertRingPainted(message);
        await page.keyboard.press('Shift+F10'); await menu.waitFor({ state: 'visible' });
        expect(await snapshot()).toEqual(before);
        await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
        expect(await snapshot()).toEqual(before);
      }
    }
    const finalMessage = page.locator('#footer'); await finalMessage.scrollIntoViewIfNeeded();
    const finalBoxes = () => finalMessage.evaluate(node => Array.from(node.querySelectorAll('*')).filter(child => !child.closest('.message-focus-paint')).map(child => { const r = child.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, child.scrollWidth, child.scrollHeight]; }));
    const finalBefore = await finalBoxes(); await finalMessage.focus();
    await finalMessage.locator('.message-focus-paint').waitFor({ state: 'attached' });
    expect(await finalBoxes()).toEqual(finalBefore);
    await assertRingPainted(finalMessage);
    await page.locator('#link').focus();
    expect(await page.locator('#link').evaluate(node => document.activeElement === node)).toBe(true);
    await page.close();
    for (const selector of ['#prevented', '#stopped', '#link', '#input', '#textarea', '#editable', '#specific', '#media']) {
      const nativePage = await browser.newPage(); nativePage.setDefaultTimeout(5000);
      try {
        await nativePage.goto(pathToFileURL(file).href); await nativePage.locator(selector).click({ button: 'right' });
        expect(await nativePage.getByRole('menu').count(), `${engine.name()} ${selector}`).toBe(0);
        expect(await nativePage.locator('body').getAttribute('data-context-count'), `${engine.name()} ${selector}: context event did not reach the page`).toBe('1');
        if (selector !== '#prevented') expect(await nativePage.locator('body').getAttribute('data-prevented')).toBe('false');
      } finally { await nativePage.close(); }
    }
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});
