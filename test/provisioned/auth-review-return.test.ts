// @provisioned chromium
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { computeAuthMergeReviewMetadata } from '../../src/auth-context';
import { createUser } from '../../src/users/store';
import { AUTH_MERGE_REVIEW, commitOnBranch } from '../helpers/auth-queue-fixtures';
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
    await page.goto(`${harness.base}/auth/${request.id.slice(0, 8)}`);

    const returnButton = page.getByRole('button', { name: 'Return', exact: true });
    await returnButton.click({ trial: true });
    const description = page.getByLabel('Request description', { exact: true });
    await description.focus();
    await page.keyboard.press('Home');
    for (const _ of 'Exercise') await page.keyboard.press('Shift+ArrowRight');
    await page.getByRole('button', { name: 'Comment on selection', exact: true }).first().click();
    const comment = 'Name the intended operator-facing change.';
    const commentDialog = page.getByRole('dialog');
    await commentDialog.getByRole('textbox').fill(comment);
    await commentDialog.getByRole('button', { name: 'Save comment' }).click();
    await page.getByText(comment, { exact: true }).waitFor();

    await returnButton.click();
    const returnDialog = page.getByRole('dialog');
    const reason = 'Revise the wording before trying again.';
    await returnDialog.getByRole('textbox').fill(reason);
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/return'));
    await returnDialog.getByRole('button', { name: 'Return', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const { submission_id } = await response.json();
    await returnDialog.waitFor({ state: 'hidden' });

    const token = harness.auth.mintApiToken(requester.id).token;
    const read = await harness.mandible(['auth', 'review', 'show', request.id.slice(0, 8), '--json'], { env: { MANDIBLE_TOKEN: token } }).done;
    expect(read.code, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      submission_id, status: 'returned', reason,
      comments: [{ quote: 'Exercise', body: comment, source: { kind: 'request_description' } }],
    });
    expect(r.main()).toBe(originalTarget);
    expect(r.signer.touches).toEqual([]);
  } finally {
    await browser.close().finally(() => harness.close());
  }
});
