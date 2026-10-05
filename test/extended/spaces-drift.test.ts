// Drift / status detection tests (Spaces child C13c, issue 21f36cb, umbrella
// de56ffa). Covers custody-doc §6:
//   - the pure status decision for every transition (clean / repo_changed /
//     worktree_dirty / conflict / stale);
//   - LIVE inspection (HEAD + working tree), NOT pinned artifact bytes — a real
//     post-export external edit is observed as drift, where artifact
//     materialization would always report clean;
//   - `last_seen_commit` / `last_seen_content_sha256` recorded on EVERY check;
//   - the drift read routes are registered + self-allowlisted on the file
//     transport (read-only, no blanket allow).
import SqliteDatabase from "../../src/sqlite.ts";
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate, setDb, type Db } from '../../src/db.js';
import { registerSpacesRoutes } from '../../src/routes/spaces.js';
import { Router } from '../../src/server.js';
import {
  defaultExportGitRunner,
  exportAndTrack,
  getSpaceExport,
  serializeSpaceDocument,
  type ExportGitRunner,
} from '../../src/spaces/export.js';
import {
  checkExportDrift,
  checkSpaceDrift,
  decideDriftStatus,
  docsWorktreeDir,
  type DriftGitRunner,
  type DriftObservation,
} from '../../src/spaces/drift.js';

let db: Db;
let router: Router;
let tmpRoot: string;
const PROJECT_ID = 'prj-drift';
const CHECKOUT_ID = 'chk-drift';

function sha(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function seedProjectAndCheckout(root: string): void {
  db.prepare(
    `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(PROJECT_ID, 'Drift', 'github.com/test/drift', Date.now(), Date.now());
  db.prepare(
    `INSERT INTO ledger_project_checkouts (id, project_id, root, name, default_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(CHECKOUT_ID, PROJECT_ID, root, 'drift', 'main', Date.now(), Date.now());
}

async function call(method: string, url: string, body?: unknown) {
  return router.invoke({ method, url, body });
}

function allowsFileRpcRoute(method: string, url: string): boolean {
  return router.resolveFileRpcPolicy(method, url);
}

async function makeSpaceWithBlocks(title = 'Doc'): Promise<string> {
  const spaceId = (
    (await call('POST', '/api/spaces', { project_id: PROJECT_ID, title })).body as {
      space: { id: string };
    }
  ).space.id;
  await call('POST', `/api/spaces/${spaceId}/blocks`, { block_type: 'heading', markdown: '# Results' });
  await call('POST', `/api/spaces/${spaceId}/blocks`, { block_type: 'paragraph', markdown: 'Body prose.' });
  return spaceId;
}

/** Insert a tracked `space_exports` row directly so the pure check can run without a real worktree. */
function insertExportRow(spaceId: string, overrides: Record<string, unknown> = {}): string {
  const id = `spxp_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const base = {
    id,
    space_id: spaceId,
    repo_id: CHECKOUT_ID,
    branch: 'docs/spaces',
    path: 'docs/spaces/doc.md',
    authority: 'repo',
    status: 'clean',
    last_export_commit: 'c-export',
    last_export_blob_sha: 'b-export',
    last_export_content_sha256: sha('EXPORTED'),
    last_seen_commit: 'c-export',
    last_seen_content_sha256: sha('EXPORTED'),
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO space_exports (
       id, space_id, repo_id, branch, path, authority, status,
       last_export_commit, last_export_blob_sha, last_export_content_sha256,
       last_seen_commit, last_seen_content_sha256, created_at, updated_at
     ) VALUES (
       @id, @space_id, @repo_id, @branch, @path, @authority, @status,
       @last_export_commit, @last_export_blob_sha, @last_export_content_sha256,
       @last_seen_commit, @last_seen_content_sha256, @created_at, @updated_at
     )`,
  ).run(base);
  return id;
}

/**
 * A stub {@link DriftGitRunner} whose live observations are explicitly set. The
 * runner returns TEXT (the module hashes it), so the `texts` map is keyed by
 * commit and yields the raw committed bytes for that commit.
 */
function stubRunner(obs: {
  head?: string | null;
  texts?: Record<string, string | null>;
  worktreeText?: string | null;
  dirty?: boolean;
  exists?: boolean;
}): DriftGitRunner {
  return {
    worktreeExists: () => obs.exists ?? true,
    headCommit: () => obs.head ?? 'c-head',
    blobTextAt: (_wt, commit) => obs.texts?.[commit] ?? null,
    worktreeFileText: () => obs.worktreeText ?? null,
    isPathDirty: () => obs.dirty ?? false,
  };
}

beforeEach(() => {
  db = new SqliteDatabase(':memory:');
  migrate(db);
  setDb(db);
  router = new Router();
  registerSpacesRoutes(router);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-drift-'));
  seedProjectAndCheckout(tmpRoot);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// --- pure status decision (every §6 transition) ------------------------------

describe('decideDriftStatus (§6 status table)', () => {
  const exported = sha('EXPORTED');
  const base: DriftObservation = {
    exportedHash: exported,
    headHash: exported,
    worktreeHash: exported,
    dirty: false,
    mandibleMoved: false,
  };

  it('clean: HEAD == export and working tree clean', () => {
    expect(decideDriftStatus(base)).toBe('clean');
  });

  it('repo_changed: HEAD path hash differs from last-export hash', () => {
    expect(decideDriftStatus({ ...base, headHash: sha('REPO-EDIT'), worktreeHash: sha('REPO-EDIT') })).toBe(
      'repo_changed',
    );
  });

  it('worktree_dirty: working-tree hash differs from HEAD', () => {
    expect(decideDriftStatus({ ...base, worktreeHash: sha('WT-EDIT'), dirty: true })).toBe('worktree_dirty');
  });

  it('conflict: repo moved AND Mandible-side moved divergently', () => {
    expect(
      decideDriftStatus({
        ...base,
        headHash: sha('REPO-EDIT'),
        worktreeHash: sha('REPO-EDIT'),
        mandibleMoved: true,
      }),
    ).toBe('conflict');
  });

  it('stale: only Mandible-side edits pending, repo unchanged', () => {
    expect(decideDriftStatus({ ...base, mandibleMoved: true })).toBe('stale');
  });

  it('repo_changed wins over a coincident worktree edit (precedence)', () => {
    // The committed repo moved AND the working tree is also dirty: the more
    // severe repo divergence is reported.
    expect(
      decideDriftStatus({ ...base, headHash: sha('REPO'), worktreeHash: sha('WT'), dirty: true }),
    ).toBe('repo_changed');
  });
});

// --- check side effects + persistence ----------------------------------------

describe('checkExportDrift (persistence + last_seen)', () => {
  it('records last_seen_commit/last_seen_content_sha256 on every check', async () => {
    const spaceId = await makeSpaceWithBlocks();
    // The exported text IS the current Mandible serialization → no Mandible move.
    const exportedText = serializeSpaceDocument(db, spaceId, 2000);
    const exportId = insertExportRow(spaceId, {
      last_seen_commit: 'old-head',
      last_seen_content_sha256: 'old-sha',
    });

    const head = 'c-head-now';
    const headText = 'HEAD-BYTES';
    const result = checkExportDrift(db, exportId, {
      now: 2000,
      git: stubRunner({
        head,
        texts: { 'c-export': exportedText, [head]: headText },
        worktreeText: headText,
        dirty: false,
      }),
    });

    // HEAD bytes moved away from the export → repo_changed.
    expect(result.status).toBe('repo_changed');
    expect(result.last_seen_commit).toBe(head);
    expect(result.last_seen_content_sha256).toBe(sha(headText));

    // Persisted onto the row.
    const row = getSpaceExport(db, exportId)!;
    expect(row.status).toBe('repo_changed');
    expect(row.last_seen_commit).toBe(head);
    expect(row.last_seen_content_sha256).toBe(sha(headText));
    expect(row.updated_at).toBe(2000);
  });

  it('reports stale when only the Mandible side moved (repo unchanged)', async () => {
    const spaceId = await makeSpaceWithBlocks();
    // The exported/committed text is an OLDER doc body; the current Mandible
    // serialization has different prose → Mandible-side moved, repo unchanged.
    const olderDoc = 'mandible_format: spaces-doc.v1\nmandible_exported_at: x\n\n# Old body\n';
    const exportId = insertExportRow(spaceId);
    const result = checkExportDrift(db, exportId, {
      now: 3000,
      git: stubRunner({
        head: 'c-export',
        texts: { 'c-export': olderDoc },
        worktreeText: olderDoc,
        dirty: false,
      }),
    });
    expect(result.status).toBe('stale');
    expect(getSpaceExport(db, exportId)!.status).toBe('stale');
  });

  it('ignores the volatile export timestamp when deciding stale (no false stale)', async () => {
    const spaceId = await makeSpaceWithBlocks();
    // Same document content, but the exported copy was stamped at a DIFFERENT
    // time. The only difference is `mandible_exported_at` → must NOT be stale.
    const exportedAtDifferentTime = serializeSpaceDocument(db, spaceId, 111111);
    const exportId = insertExportRow(spaceId);
    const result = checkExportDrift(db, exportId, {
      now: 999999, // current serialization stamps a new time
      git: stubRunner({
        head: 'c-export',
        texts: { 'c-export': exportedAtDifferentTime },
        worktreeText: exportedAtDifferentTime,
        dirty: false,
      }),
    });
    expect(result.status).toBe('clean');
  });

  it('does not claim a repo move when the docs worktree was never provisioned', async () => {
    const spaceId = await makeSpaceWithBlocks();
    const exportId = insertExportRow(spaceId);
    const result = checkExportDrift(db, exportId, {
      now: 4000,
      git: stubRunner({ exists: false }),
    });
    expect(result.status).toBe('clean');
  });

  it('checkSpaceDrift refreshes every tracked export of a space', async () => {
    const spaceId = await makeSpaceWithBlocks();
    const exportedText = serializeSpaceDocument(db, spaceId, 5000);
    insertExportRow(spaceId, { path: 'docs/a.md' });
    insertExportRow(spaceId, { path: 'docs/b.md' });
    const results = checkSpaceDrift(db, spaceId, {
      now: 5000,
      git: stubRunner({ head: 'c-export', texts: { 'c-export': exportedText }, worktreeText: exportedText }),
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'clean')).toBe(true);
  });
});

// --- LIVE inspection over real git (the §6 anti-materialization point) --------

describe('live drift over real git (not pinned artifact bytes)', () => {
  function gitEnv() {
    return { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  }

  async function exportRealDoc(): Promise<{ spaceId: string; exportId: string; wt: string }> {
    const env = gitEnv();
    const g = (args: string[], cwd = tmpRoot) => spawnSync('git', args, { cwd, encoding: 'utf8', env });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 'agent@test']);
    g(['config', 'user.name', 'Agent']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# repo\n');
    g(['add', 'README.md']);
    g(['commit', '-q', '-m', 'init']);

    const spaceId = await makeSpaceWithBlocks('Live');
    const result = await exportAndTrack(
      db,
      { spaceId, path: 'docs/spaces/live.md', branch: 'docs/spaces', issues: ['21f36cb'] },
      { git: defaultExportGitRunner },
    );
    const wt = docsWorktreeDir(tmpRoot, 'docs/spaces');
    return { spaceId, exportId: result.export.id, wt };
  }

  it('reports clean immediately after export, then observes a later external commit as repo_changed', async () => {
    const { exportId, wt } = await exportRealDoc();
    const env = gitEnv();
    const g = (args: string[]) => spawnSync('git', args, { cwd: wt, encoding: 'utf8', env });

    // Right after export: clean (the live HEAD == the exported bytes).
    expect(checkExportDrift(db, exportId).status).toBe('clean');

    // An external edit COMMITTED on the docs branch — the kind of change
    // artifact materialization (pinned to the export commit) could never see.
    fs.appendFileSync(path.join(wt, 'docs/spaces/live.md'), '\nexternal edit\n');
    g(['add', 'docs/spaces/live.md']);
    g(['commit', '-q', '-m', 'external edit']);

    const after = checkExportDrift(db, exportId);
    expect(after.status).toBe('repo_changed');
    // last_seen advanced to the new HEAD.
    expect(after.last_seen_commit).toBe(g(['rev-parse', 'HEAD']).stdout.trim());
  });

  it('observes an uncommitted working-tree edit as worktree_dirty', async () => {
    const { exportId, wt } = await exportRealDoc();
    expect(checkExportDrift(db, exportId).status).toBe('clean');

    // Dirty the file WITHOUT committing.
    fs.appendFileSync(path.join(wt, 'docs/spaces/live.md'), '\nuncommitted\n');

    expect(checkExportDrift(db, exportId).status).toBe('worktree_dirty');
  });
});

// --- route registration + file-transport allowlist ---------------------------

describe('drift read routes + allowlist', () => {
  it('GET drift route returns 200 with no tracked exports', async () => {
    const spaceId = await makeSpaceWithBlocks();
    const res = await call('GET', `/api/spaces/${spaceId}/exports/drift`);
    expect(res.status).toBe(200);
    expect((res.body as { drift: unknown[] }).drift).toHaveLength(0);
  });

  it('per-export drift route 404s on an unknown export id', async () => {
    const spaceId = await makeSpaceWithBlocks();
    const res = await call('GET', `/api/spaces/${spaceId}/exports/nope/drift`);
    expect(res.status).toBe(404);
  });

  it('drift reads are self-allowlisted on the file transport, with no write authority', () => {
    expect(allowsFileRpcRoute('GET', '/api/spaces/abc/exports/drift')).toBe(true);
    expect(allowsFileRpcRoute('GET', '/api/spaces/abc/exports/xyz/drift')).toBe(true);
    // Read-only: no write verb opens through the drift surface, and there is no
    // blanket `/api/spaces*` allow.
    expect(allowsFileRpcRoute('POST', '/api/spaces/abc/exports/drift')).toBe(false);
    expect(allowsFileRpcRoute('DELETE', '/api/spaces/abc/exports/xyz/drift')).toBe(false);
  });
});
