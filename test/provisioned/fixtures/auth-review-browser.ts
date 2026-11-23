import { buildSync } from 'esbuild';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { computeAuthMergeReviewMetadata } from '../../../src/auth-context';
import { createUser } from '../../../src/users/store';
import { AUTH_MERGE_REVIEW, commitOnBranch } from '../../helpers/auth-queue-fixtures';
import { operatorCliRig } from '../../helpers/operator-cli-rig';

export async function startAuthReviewBrowser() {
  const bundle = buildSync({ entryPoints: ['test/provisioned/fixtures/auth-return-fixture.tsx'], outdir: 'fixture-assets',
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
    logOverride: { 'empty-import-meta': 'silent' },
    jsx: 'automatic', jsxImportSource: 'preact', external: ['@pierre/diffs/worker/worker-portable.js?url'] });
  const styles = buildSync({ entryPoints: ['ui/src/style.css'], bundle: true, write: false,
    loader: { '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' } }).outputFiles[0]!.text.replace(/^@import[^\n]*\n/gm, '');
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text.replaceAll('</script', '<\\/script');
  const browserPage = `<!doctype html><style>${styles}${bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')}
    html,body,#root,.auth-sidebar-layout{height:100%;margin:0}#root{display:flex;flex-direction:column}
  </style><div id="root"></div><script>${script}</script>`;
  const harness = await operatorCliRig({ browserPage });
  const repo = realpathSync(harness.r.repo);
  const requester = createUser(harness.r.db, { slug: 'browser-review-agent', kind: 'agent', display_name: 'Requester' });
  async function submit(branch: string, title: string, file: string, narrative?: string) {
    commitOnBranch(repo, branch, { [file]: '# Proposed wording\n' });
    const { changeReport } = await computeAuthMergeReviewMetadata(repo, 'main', branch);
    return harness.r.queue.submit({ ...AUTH_MERGE_REVIEW, type: 'merge', cwd: repo, target_repo_root: repo,
      repo: path.basename(repo), head_branch: branch, base_branch: 'main', merge_head_sha: changeReport.comparison.head_sha,
      command: `mandible auth merge ${branch} --into main`, title, change_report: changeReport, narrative,
    }, requester.id);
  }
  return { ...harness, repo, requester, submit };
}
