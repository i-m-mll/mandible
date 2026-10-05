import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Db } from '../db.js';
import { serializeSpaceDocument } from './export.js';

export function preserveLegacyDocuments(db: Db): void {
  const rows = db.prepare(`SELECT e.*, c.root FROM space_exports e
    LEFT JOIN ledger_project_checkouts c ON c.id=e.repo_id`).all() as Array<Record<string, unknown>>;
  const insert = db.prepare(`INSERT OR IGNORE INTO space_document_history
    (id,space_id,kind,content,blocks_json,artifact_ref,provenance_json,created_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    const id = String(row.id), space = String(row.space_id);
    if (db.prepare('SELECT 1 FROM space_document_history WHERE id=?').get(`${id}:managed`)) continue;
    const blocks = db.prepare('SELECT * FROM space_blocks WHERE space_id=? ORDER BY sort_key,id').all(space);
    insert.run(`${id}:managed`, space, 'managed-before-migration', serializeSpaceDocument(db, space), JSON.stringify(blocks), null, JSON.stringify(row), Date.now());
    for (const kind of ['pre_export', 'last_export'] as const) {
      const ref = row[`${kind === 'pre_export' ? 'pre_export_snapshot' : 'last_export'}_blob_id`];
      if (ref) insert.run(`${id}:${kind}`, space, kind, null, null, String(ref), JSON.stringify(row), Date.now());
    }
    const root = typeof row.root === 'string' ? row.root : null;
    const file = String(row.path);
    const safeBranch = String(row.branch).replace(/[^A-Za-z0-9._-]+/g, '_');
    const worktree = root ? path.join(root, '.git', 'mandible-docs-worktrees', safeBranch) : null;
    for (const [kind, commit] of [['published-git', row.last_export_commit], ['checkout-head', 'HEAD']] as const) {
      const cwd = kind === 'published-git' ? root : worktree;
      const read = cwd && commit ? spawnSync('git', ['show', `${commit}:${file}`], {
        cwd, encoding: 'utf8', timeout:10_000,maxBuffer:64*1024*1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }) : null;
      insert.run(`${id}:${kind}`, space, kind, read?.status === 0 ? read.stdout : null, null, null,
        JSON.stringify({ ...row, worktree, available: read?.status === 0, error: read?.status === 0 ? null : String(read?.error ?? read?.stderr ?? 'checkout unavailable') }), Date.now());
    }
    let content: string | null = null, error: string | null = null;
    try { if (!worktree) throw new Error('checkout unavailable'); content = fs.readFileSync(path.join(worktree, file), 'utf8'); }
    catch (failure) { error = String(failure); }
    insert.run(`${id}:checkout`, space, 'checkout-file', content, null, null,
      JSON.stringify({ ...row, worktree, error, checkout_preserved_in_place: true }), Date.now());
  }
}

export function listDocumentHistory(db: Db, spaceId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM space_document_history WHERE space_id=? ORDER BY created_at,id').all(spaceId) as Array<Record<string, unknown>>;
}

export function documentHistoryEntry(db: Db, spaceId: string, id: string): Record<string, unknown> | null {
  return db.prepare('SELECT * FROM space_document_history WHERE space_id=? AND id=?').get(spaceId,id) as Record<string, unknown> | null ?? null;
}
