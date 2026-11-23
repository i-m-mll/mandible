// @provisioned chromium
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { computeAuthMergeReviewMetadata } from '../../src/auth-context';
import { createUser } from '../../src/users/store';
import { AUTH_MERGE_REVIEW, commitOnBranch, git } from '../helpers/auth-queue-fixtures';
import { launchTestBrowser } from '../helpers/chromium';
import { operatorCliRig } from '../helpers/operator-cli-rig';

it('returns a Chromium review and lets the requester read its saved range through the CLI', async () => {
  const bundle = buildSync({ entryPoints: ['test/provisioned/fixtures/auth-return-fixture.tsx'], outdir: 'fixture-assets',
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
    jsx: 'automatic', jsxImportSource: 'preact', external: ['@pierre/diffs/worker/worker-portable.js?url'] });
  const styles = buildSync({ entryPoints: ['ui/src/style.css'], bundle: true, write: false,
    loader: { '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' } }).outputFiles[0]!.text.replace(/@import[^;]+;/g, '');
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text.replaceAll('</script', '<\\/script');
  const browserPage = `<!doctype html><style>${styles}${bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')}
    html,body,#root,.auth-sidebar-layout{height:100%;margin:0}#root{display:flex;flex-direction:column}
  </style><div id="root"></div><script>${script}</script>`;
  const harness = await operatorCliRig({ browserPage });
  const browser = await launchTestBrowser(chromium).catch(async error => { await harness.close(); throw error; });
  try {
    const { r } = harness;
    const repo = realpathSync(r.repo);
    const branch = 'feature/browser-return';
    const requester = createUser(r.db, { slug: 'browser-return-agent', kind: 'agent', display_name: 'Requester' });
    commitOnBranch(repo, branch, { 'proposal.md': '# Proposed wording\n' });
    const { changeReport } = await computeAuthMergeReviewMetadata(repo, 'main', branch);
    const request = await r.queue.submit({ ...AUTH_MERGE_REVIEW, type: 'merge', cwd: repo, target_repo_root: repo,
      repo: path.basename(r.repo), head_branch: branch, base_branch: 'main', merge_head_sha: changeReport.comparison.head_sha,
      command: `mandible auth merge ${branch} --into main`, title: 'Review the browser proposal', change_report: changeReport,
    }, requester.id);
    const originalTarget = r.main();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const reviewLoaded = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/review'));
    await page.goto(`${harness.base}/auth/${request.id.slice(0, 8)}`);
    const reviewResponse = await reviewLoaded;
    expect(reviewResponse.ok(), await reviewResponse.text()).toBe(true);

    const returnButton = page.getByRole('button', { name: 'Return to requester', exact: true });
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

    const editBranch = 'feature/browser-approve';
    commitOnBranch(repo, editBranch, { 'proposal.md': '# Proposed wording\n' });
    const { changeReport: editReport } = await computeAuthMergeReviewMetadata(repo, 'main', editBranch);
    const editableRequest = await r.queue.submit({ ...AUTH_MERGE_REVIEW, type: 'merge', cwd: repo, target_repo_root: repo,
      repo: path.basename(r.repo), head_branch: editBranch, base_branch: 'main', merge_head_sha: editReport.comparison.head_sha,
      command: `mandible auth merge ${editBranch} --into main`, title: 'Approve the edited proposal', change_report: editReport,
      narrative: 'Clarify the proposal.\n\n:::change{path="proposal.md"}\nProposed wording\n:::\n',
    }, requester.id);

    await page.goto(`${harness.base}/auth/${editableRequest.id.slice(0, 8)}`);
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    const proposal = page.locator('.document-comment-surface__text [aria-label="proposal.md after"]');
    await proposal.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    for (const _ of 'wording') await page.keyboard.press('Shift+ArrowLeft');
    await page.getByRole('toolbar', { name: 'Selection actions' }).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Review draft for proposal.md' });
    await editor.waitFor();
    await page.waitForFunction(() => {
      const selection = window.getSelection();
      return selection?.toString() === 'wording' &&
        selection.anchorNode?.parentElement?.closest('[contenteditable="true"]')?.getAttribute('aria-label') === 'Review draft for proposal.md';
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
