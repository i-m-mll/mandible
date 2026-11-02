// @provisioned chromium
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium, webkit } from 'playwright-core';
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
    const paint = (selector: string) => page.locator(selector).evaluate(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, radius: style.borderRadius }; });
    const basePaint = await paint('#parent'); const baseBox = await parent.boundingBox();
    const plain = await page.locator('#plain').boundingBox();
    expect(await page.evaluate(() => document.getSelection()!.isCollapsed)).toBe(true);
    await page.locator('#plain').click({ button: 'right', position: { x: 10, y: 10 } });
    await menu.waitFor({ state: 'visible' });
    expect((await paint('#parent')).background).not.toBe(basePaint.background);
    expect((await paint('#parent')).radius).not.toBe(basePaint.radius);
    expect(await parent.boundingBox()).toEqual(baseBox);
    expect(await page.evaluate(() => document.getSelection()!.toString())).toBe(await page.locator('body').getAttribute('data-context-selection'));
    const bounds = await menu.boundingBox(); expect(bounds!.x).toBeCloseTo(plain!.x + 10, 1); expect(bounds!.y).toBeCloseTo(plain!.y + 10, 1);
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
