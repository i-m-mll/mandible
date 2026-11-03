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
      const bluePixels = await page.evaluate(async ({ visible, hidden }) => {
        const pixels = async (data: string) => {
          const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data;
        };
        const shown = await pixels(visible); const baseline = await pixels(hidden);
        let count = 0;
        for (let i = 0; i < shown.length; i += 4) if ((shown[i + 2] - shown[i]) - (baseline[i + 2] - baseline[i]) > 20) count++;
        return count;
      }, { visible: visible.toString('base64'), hidden: hidden.toString('base64') });
      expect(bluePixels, `${engine.name()} must actually paint the blue message ring`).toBeGreaterThan(20);
    };
    const paint = (selector: string) => page.locator(selector).evaluate(node => { const style = getComputedStyle(node, '::before'); return { background: style.backgroundColor, radius: style.borderRadius }; });
    const basePaint = await paint('#parent'); const baseBox = await parent.boundingBox();
    const plain = await page.locator('#plain').boundingBox();
    expect(await page.evaluate(() => document.getSelection()!.isCollapsed)).toBe(true);
    await page.locator('#plain').click({ button: 'right', position: { x: 10, y: 10 } });
    await menu.waitFor({ state: 'visible' });
    expect((await paint('#parent')).background).not.toBe(basePaint.background);
    expect((await paint('#parent')).radius).not.toBe(basePaint.radius);
    for (const theme of ['codex', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const colors = await parent.evaluate(node => ({ paint: getComputedStyle(node, '::before').backgroundColor, previous: getComputedStyle(node).getPropertyValue('--neutral-alpha-05').trim() }));
      const alpha = (color: string) => Number(color.match(/,\s*([\d.]+)\)$/)![1]);
      expect(Math.abs(alpha(colors.paint) - alpha(colors.previous) / 2)).toBeLessThan(1 / 255);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'codex'; });
    expect(await parent.boundingBox()).toEqual(baseBox);
    expect(await page.evaluate(() => document.getSelection()!.toString())).toBe(await page.locator('body').getAttribute('data-context-selection'));
    const bounds = await menu.boundingBox(); expect(bounds!.x).toBeCloseTo(plain!.x + 10, 1); expect(bounds!.y).toBeCloseTo(plain!.y + 10, 1);
    const copyItem = menu.getByRole('menuitem', { name: 'Copy all', exact: true });
    const infoItem = menu.getByRole('menuitem', { name: 'Info', exact: true });
    const infoBox = await infoItem.boundingBox(); await infoItem.hover();
    expect(await infoItem.evaluate(node => document.activeElement === node)).toBe(true);
    await page.waitForFunction(() => { const active = document.activeElement; const copy = document.querySelector('[role="menu"] [aria-label="Copy all"]'); return active && copy && getComputedStyle(active).backgroundColor !== getComputedStyle(copy).backgroundColor; });
    expect(await copyItem.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(await infoItem.evaluate(node => getComputedStyle(node).backgroundColor));
    expect(await infoItem.boundingBox()).toEqual(infoBox);
    await page.locator('#specific').click(); await menu.waitFor({ state: 'detached' });
    expect(await paint('#parent')).toEqual(basePaint);
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await page.locator('#plain').click({ button: 'right', position: { x: 10, y: 10 } }); await menu.waitFor({ state: 'visible' });
    await menu.getByRole('menuitem', { name: 'Info', exact: true }).click(); await menu.waitFor({ state: 'detached' });
    expect(await page.locator('body').getAttribute('data-called')).toBe('parent');
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await page.locator('#child-plain').click({ button: 'right' }); await menu.waitFor({ state: 'visible' });
    expect((await paint('#child')).background).not.toBe(basePaint.background); expect(await paint('#parent')).toEqual(basePaint);
    expect(await menu.count()).toBe(1); await menu.getByRole('menuitem', { name: 'Info', exact: true }).click();
    expect(await page.locator('body').getAttribute('data-called')).toBe('child');
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await page.locator('.compact-activity__row').click({ button: 'right' }); await menu.waitFor({ state: 'visible' });
    expect(await paint('#tool')).toEqual(basePaint);
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
    expect(await page.locator('#parent > .message-actions button').count()).toBe(0);
    expect(await page.locator('#footer').getByRole('button', { name: 'Copy all' }).isVisible()).toBe(true);
    await page.locator('#footer').getByRole('button', { name: 'More actions' }).click(); await menu.waitFor({ state: 'visible' });
    expect(await paint('#footer')).toEqual(basePaint); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    await page.locator('#plain').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    const selected = await page.evaluate(() => document.getSelection()!.toString());
    await page.locator('#plain').click({ button: 'right', position: { x: 10, y: 10 } });
    expect(await menu.count()).toBe(0); expect(await page.locator('body').getAttribute('data-prevented')).toBe('false');
    expect(await paint('#parent')).toEqual(basePaint);
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
        expect(await message.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle === 'none')).toBe(true);
        const focusBounds = await message.locator('.message-focus-paint rect').boundingBox();
        if (width === 1000 && id === 'short-message') await assertRingPainted(message);
        await page.keyboard.press('Shift+F10'); await menu.waitFor({ state: 'visible' });
        expect(await snapshot()).toEqual(before);
        const painted = await message.evaluate(node => {
          const style = getComputedStyle(node, '::before'); const bounds = node.getBoundingClientRect();
          const rects: DOMRect[] = []; const walker = document.createTreeWalker(node.querySelector('.msg-text-block')!, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) { if (walker.currentNode.parentElement?.closest('pre')) continue; const range = document.createRange(); range.selectNodeContents(walker.currentNode); rects.push(...Array.from(range.getClientRects())); }
          for (const block of node.querySelectorAll('pre')) rects.push(block.getBoundingClientRect());
          const inkRight = Math.max(...rects.map(r => r.right)); const inkLeft = Math.min(...rects.map(r => r.left));
          return { left: bounds.left + parseFloat(style.left) - parseFloat(style.boxShadow.split(' ').at(-1)!), right: bounds.left + parseFloat(style.left) + parseFloat(style.width) + parseFloat(style.boxShadow.split(' ').at(-1)!), inkLeft, inkRight, ownerRight: bounds.right, radius: parseFloat(style.borderRadius), padding: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-3')) };
        });
        expect(Math.abs(painted.left - (painted.inkLeft - painted.padding))).toBeLessThan(1 / 32);
        expect(Math.abs(painted.right - (painted.inkRight + painted.padding))).toBeLessThan(1 / 32);
        expect(painted.radius).toBeGreaterThan(0);
        expect(Math.abs(focusBounds!.x + 1 - painted.left)).toBeLessThan(1 / 32);
        expect(Math.abs(focusBounds!.x + focusBounds!.width - 1 - painted.right)).toBeLessThan(1 / 32);
        if (width === 1000) expect(painted.right).toBeLessThan(painted.ownerRight - 20);
        await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
        expect(await message.getAttribute('data-message-menu-paint')).toBeNull();
        expect(await snapshot()).toEqual(before);
      }
    }
    const finalMessage = page.locator('#footer'); await finalMessage.scrollIntoViewIfNeeded();
    const finalBoxes = () => finalMessage.evaluate(node => Array.from(node.querySelectorAll('*')).filter(child => !child.closest('.message-focus-paint')).map(child => { const r = child.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, child.scrollWidth, child.scrollHeight]; }));
    const finalBefore = await finalBoxes(); await finalMessage.focus();
    await finalMessage.locator('.message-focus-paint').waitFor({ state: 'attached' });
    expect(await finalMessage.getAttribute('data-message-menu-paint')).toBeNull();
    expect(await finalBoxes()).toEqual(finalBefore);
    await assertRingPainted(finalMessage);
    await page.locator('#link').focus();
    expect(await finalMessage.getAttribute('data-message-focus-paint')).toBeNull();
    expect(await parent.getAttribute('data-message-focus-paint')).toBeNull();
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
