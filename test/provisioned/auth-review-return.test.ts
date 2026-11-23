// @provisioned chromium
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { git } from '../helpers/auth-queue-fixtures';
import { launchTestBrowser } from '../helpers/chromium';
import { startAuthReviewBrowser } from './fixtures/auth-review-browser';

it('returns a quoted review through the CLI and signs a separately frozen edit on confirmation', async () => {
  const harness = await startAuthReviewBrowser();
  const browser = await launchTestBrowser(chromium).catch(async error => { await harness.close(); throw error; });
  try {
    const { r, repo, requester } = harness;
    const request = await harness.submit('feature/browser-return', 'Review the browser proposal', 'proposal.md');
    const originalTarget = r.main();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const reviewLoaded = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/review'));
    await page.goto(`${harness.base}/auth/${request.id.slice(0, 8)}`);
    const reviewResponse = await reviewLoaded;
    expect(reviewResponse.ok(), await reviewResponse.text()).toBe(true);

    const returnButton = page.getByRole('button', { name: 'Return', exact: true });
    await returnButton.waitFor();
    expect(await returnButton.isDisabled()).toBe(true);
    const description = page.locator('.document-comment-surface__text [aria-label="Request description"]');
    await description.focus();
    await page.keyboard.press('Home');
    for (const _ of 'Exercise') await page.keyboard.press('Shift+ArrowRight');
    await page.getByRole('toolbar', { name: 'Selection actions' }).getByRole('button', { name: 'Comment', exact: true }).click();
    const comment = 'Name the intended operator-facing change.';
    await page.getByRole('textbox', { name: 'Add a comment…' }).fill(comment);
    expect(await page.getByRole('dialog').count()).toBe(0);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const commentsButton = page.getByRole('button', { name: 'Comments (1)', exact: true });
    await commentsButton.waitFor();
    expect(await returnButton.getAttribute('aria-description')).toBe('1 unsent');
    const thread = page.getByRole('article', { name: 'Comment thread' }).filter({ hasText: comment }).first();
    await thread.hover();
    await thread.getByRole('button', { name: 'Resolve', exact: true }).click();
    await page.getByRole('button', { name: 'Comments', exact: true }).waitFor();
    expect(await returnButton.getAttribute('aria-description')).toBeNull();
    expect(await returnButton.isEnabled()).toBe(true);
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/return'));
    await returnButton.click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const { submission_id } = await response.json();
    await returnButton.waitFor({ state: 'hidden' });
    expect(await page.getByRole('dialog').count()).toBe(0);

    const token = harness.auth.mintApiToken(requester.id).token;
    const read = await harness.mandible(['auth', 'review', 'show', request.id.slice(0, 8), '--json'], { env: { MANDIBLE_TOKEN: token } }).done;
    expect(read.code, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      submission_id, status: 'returned',
      comments: [{ quote: 'Exercise', body: comment, source: { kind: 'request_description' } }],
    });
    expect(r.main()).toBe(originalTarget);
    expect(r.signer.touches).toEqual([]);

    const editableRequest = await harness.submit('feature/browser-approve', 'Approve the edited proposal', 'proposal.md',
      'Clarify the proposal.\n\n:::change{path="proposal.md"}\nProposed wording\n:::\n');

    await page.goto(`${harness.base}/auth/${editableRequest.id.slice(0, 8)}`);
    await page.getByRole('tab', { name: 'Diff', exact: true }).click();
    const proposal = page.locator('.document-comment-surface__text [aria-label="proposal.md after"]');
    await proposal.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    for (const _ of 'wording') await page.keyboard.press('Shift+ArrowLeft');
    await page.getByRole('toolbar', { name: 'Selection actions' }).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('[contenteditable="true"][aria-label="proposal.md after"]');
    await editor.waitFor();
    await page.waitForFunction(() => {
      const selection = window.getSelection();
      return selection?.toString() === 'wording' &&
        selection.anchorNode?.parentElement?.closest('[contenteditable="true"]')?.getAttribute('aria-label') === 'proposal.md after';
    });
    await page.keyboard.type('language');

    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    const freeze = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/review/freeze'));
    await approve.click();
    const prepared = await freeze;
    expect(prepared.ok(), await prepared.text()).toBe(true);
    const frozen = r.queue.getRequestExact(editableRequest.id)!;
    expect(frozen.merge_effective_head_sha).toBeTruthy();
    expect(git(repo, ['show', `${frozen.merge_effective_head_sha}:proposal.md`])).toBe('# Proposed language');
    expect(harness.posts('approve')).toBe(0);
    expect(r.signer.touches).toEqual([]);
    await page.locator('.markdown-document').getByText('language', { exact: true }).waitFor();

    const approval = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/approve'));
    await approve.click();
    const approved = await approval;
    expect(approved.status(), await approved.text()).toBe(202);
    expect(r.signer.touches).toHaveLength(1);
  } finally {
    await browser.close().finally(() => harness.close());
  }
});
