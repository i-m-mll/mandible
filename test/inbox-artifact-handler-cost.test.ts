import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDb, type Db } from '../src/db.js';
import { registerInboxRoutes } from '../src/routes/inbox.js';
import { registerProviderRoutes } from '../src/routes/providers.js';
import { listLedgerIssueSummaries, listLedgerOpenIssues } from '../src/ledger/issue-projection.js';
import { setupOperator } from '../src/users/store.js';
import type { WorkScanner } from '../src/work-scanner.js';
import { artifactRepo } from './helpers/artifact-repo-fixtures.js';
import { authenticatedTestRouter } from './helpers/authenticated-router.js';
import { recordArtifactVersion } from './helpers/artifact-http-write-fixtures.js';
import { longestEventLoopBlockMs, useSlowCommand } from './helpers/event-loop-blocking.js';
import { migratedMemoryDb, insertRawLedgerProject, insertRawLedgerCheckout, insertRawLedgerIssue } from './helpers/ledger-fixtures.js';

let db: Db;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-handler-cost-'));
  db = migratedMemoryDb();
  setDb(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('serves identical inbox rows without reading parent edges, closed issue bodies, or deleted labels', async () => {
  const repos = [];
  for (const name of ['zeta', 'alpha']) {
    const project = insertRawLedgerProject(db, { name, projectKey: name });
    for (const suffix of ['old', 'recent']) {
      const checkoutRoot = path.join(root, name, suffix);
      insertRawLedgerCheckout(db, { projectId: project, name: `${name}-${suffix}`, root: checkoutRoot });
      repos.push({ id: `${name}-${suffix}`, name: `${name}-${suffix}`, root: checkoutRoot,
        last_scanned_at: suffix === 'recent' ? '2026-10-23' : '2026-10-01' });
    }
    for (const [index, status] of ['open', 'closed', 'open'].entries()) {
      const id = insertRawLedgerIssue(db, { id: `${name}-issue-${index}`, shortId: `${name}-${index}`, projectId: project,
        body: 'body omitted from inbox'.repeat(1000), now: index + 1 });
      if (status === 'closed') db.prepare("UPDATE ledger_issues SET status='closed',resolution='delivered' WHERE id=?").run(id);
      for (const label of ['z', 'a', 'deleted']) {
        db.prepare('INSERT INTO ledger_labels(issue_id,label,created_at,deleted_at) VALUES (?,?,1,?)')
          .run(id, label, label === 'deleted' ? 2 : null);
      }
    }
  }
  const scanner = { getRepos: () => repos } as unknown as WorkScanner;
  const expected = listLedgerIssueSummaries(db, scanner).flatMap(summary => summary.issues
    .filter(issue => issue.status === 'open').map(issue => ({ id: issue.id, title: issue.title, labels: issue.labels,
      repo_id: summary.repo_id, repo_name: summary.repo_name })));
  const router = authenticatedTestRouter(setupOperator(db, { slug: 'cost-test' }));
  registerInboxRoutes(router, undefined, undefined, scanner);
  const prepared = vi.spyOn(db, 'prepare');
  for (let pass = 0; pass < 2; pass++) {
    const result = await router.invoke({ method: 'GET', url: '/api/inbox/global' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ open_issues: expected, total: expected.length });
  }
  const sql = prepared.mock.calls.map(([query]) => query).join('\n');
  expect(sql).not.toContain('ledger_relationship_edges');
  expect(sql).not.toMatch(/SELECT \* FROM ledger_issues/i);
  for (const filter of ['alpha', 'alpha-recent', path.join(root, 'alpha', 'recent')]) {
    expect(listLedgerOpenIssues(db, scanner, filter)).toEqual(expected.filter(issue => issue.repo_id === 'alpha'));
  }
});

it('yields to the event loop during every Git read in artifact check', async () => {
  const repo = path.join(root, 'repo');
  artifactRepo(repo, { 'report.md': 'committed bytes\n' });
  const project = insertRawLedgerProject(db, { name: 'report', projectKey: 'report' });
  insertRawLedgerCheckout(db, { projectId: project, name: 'report', root: repo });
  const artifact = recordArtifactVersion(db, { source_kind: 'tracked_repo', path: path.join(repo, 'report.md') });
  const router = authenticatedTestRouter(setupOperator(db, { slug: 'cost-test' }));
  registerProviderRoutes(router);
  const stub = useSlowCommand('git', 0.08);
  try {
    for (let pass = 0; pass < 2; pass++) {
      const gap = await longestEventLoopBlockMs(async () => {
        const result = await router.invoke({ method: 'POST', url: '/api/artifacts/check', body: { ref: artifact.version.id } });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ checks: [{ check: { materializable: true, hash_matches: true, recoverability: 'repo_commit' } }] });
      });
      expect(gap).toBeLessThan(50);
    }
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
});

it('declares the artifact check process effect in the operation catalog', () => {
  const router = authenticatedTestRouter(setupOperator(db, { slug: 'cost-test' }));
  registerProviderRoutes(router);
  expect(router.operationCatalog('test').routes.find(route => route.path === '/api/artifacts/check')?.effects)
    .toContain('process:external');
});
