import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDb, type Db } from '../src/db.js';
import { registerInboxRoutes } from '../src/routes/inbox.js';
import { registerProviderRoutes } from '../src/routes/providers.js';
import { listLedgerOpenIssues } from '../src/ledger/issue-projection.js';
import { setupOperator } from '../src/users/store.js';
import type { WorkScanner } from '../src/work-scanner.js';
import { artifactRepo } from './helpers/artifact-repo-fixtures.js';
import { authenticatedTestRouter } from './helpers/authenticated-router.js';
import { recordArtifactVersion } from './helpers/artifact-http-write-fixtures.js';
import { longestEventLoopBlockMs, useSlowCommand, SYNCHRONOUS_WAIT_MS } from './helpers/event-loop-blocking.js';
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

it('serves open issues with current labels under canonical project and checkout filters', async () => {
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
  const expected = ['alpha', 'zeta'].flatMap(name => [2, 0].map(index => ({
    id: name + '-' + index, title: 'Issue ' + name + '-issue-' + index,
    labels: ['a', 'z'], repo_id: name, repo_name: name + '-recent',
  })));
  const router = authenticatedTestRouter(setupOperator(db, { slug: 'cost-test' }));
  registerInboxRoutes(router, undefined, undefined, scanner, inlineLedgerReader());
  for (let pass = 0; pass < 2; pass++) {
    const result = await router.invoke({ method: 'GET', url: '/api/inbox/global' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ open_issues: expected, total: expected.length });
  }
  for (const filter of ['alpha', 'alpha-recent', path.join(root, 'alpha', 'recent')]) {
    expect(listLedgerOpenIssues(db, scanner, filter)).toEqual(expected.filter(issue => issue.repo_id === 'alpha'));
    const scoped = await router.invoke({ method: 'GET', url: `/api/inbox?repo=${encodeURIComponent(filter)}` });
    expect(scoped.status).toBe(200);
    expect(scoped.body).toMatchObject({
      open_issues: expected.filter(issue => issue.repo_id === 'alpha').map(({ id, title, labels }) => ({ id, title, labels })),
      total: 2,
    });
    expect((scoped.body as { open_issues: object[] }).open_issues[0]).not.toHaveProperty('repo_id');
  }
});

it('yields to the event loop during every Git read in artifact check', async () => {
  const repo = path.join(root, 'repo');
  artifactRepo(repo, { 'report.md': 'committed bytes\n' });
  const project = insertRawLedgerProject(db, { name: 'report', projectKey: 'report' });
  insertRawLedgerCheckout(db, { projectId: project, name: 'report', root: repo });
  const artifact = recordArtifactVersion(db, { source_kind: 'tracked_repo', path: path.join(repo, 'report.md') });
  const router = authenticatedTestRouter(setupOperator(db, { slug: 'cost-test' }));
  registerProviderRoutes(router, inlineLedgerReader());
  const stub = useSlowCommand('git');
  try {
    for (let pass = 0; pass < 2; pass++) {
      const gap = await longestEventLoopBlockMs(async () => {
        const result = await router.invoke({ method: 'POST', url: '/api/artifacts/check', body: { ref: artifact.version.id } });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ checks: [{ check: { materializable: true, hash_matches: true, recoverability: 'repo_commit' } }] });
      });
      expect(gap).toBeLessThan(SYNCHRONOUS_WAIT_MS);
    }
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
});
