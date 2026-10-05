/** @vitest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SqliteDatabase from '../src/sqlite.ts';
import { resolveCanonicalArtifactRepoForRoot } from '../src/artifact-repo-resolution.js';

let db: SqliteDatabase;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-repo-'));
  db = new SqliteDatabase(':memory:');
  db.exec(`CREATE TABLE ledger_projects(id TEXT, project_key TEXT, display_name TEXT, remote_identity TEXT, upstream_identity TEXT);
    CREATE TABLE ledger_project_checkouts(project_id TEXT, root TEXT, name TEXT, default_branch TEXT, work_repo_id TEXT, remote_url TEXT, updated_at INTEGER);`);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function register(id: string, root: string, remote = '') {
  db.prepare('INSERT INTO ledger_projects VALUES (?, ?, ?, ?, ?)').run(id, id, id, remote, '');
  db.prepare('INSERT INTO ledger_project_checkouts VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, root, id, 'main', id, remote, 1);
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', timeout: 3000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

it('resolves relevant ancestry without touching an unrelated registered filesystem root', () => {
  const source = path.join(dir, 'source'); fs.mkdirSync(source);
  const unrelated = path.join(dir, 'unrelated'); register('other', unrelated);
  register('source', dir);
  const realpath = fs.realpathSync;
  const calls: string[] = [];
  vi.spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
    calls.push(String(target));
    if (String(target) === unrelated) throw new Error('Unrelated metadata boundary must not be entered');
    return realpath(target, options as never);
  }) as typeof fs.realpathSync);
  expect(resolveCanonicalArtifactRepoForRoot(db, source)).toMatchObject({ ok: true, project_id: 'source', matched_by: 'checkout_ancestry' });
  expect(calls).toContain(source);
  expect(calls).not.toContain(unrelated);
  expect(calls.every((called) => source === called || source.startsWith(called.endsWith(path.sep) ? called : called + path.sep))).toBe(true);
});

it('resolves requested symlinks and exact registered aliases, without reverse alias guessing', () => {
  const target = path.join(dir, 'target'); fs.mkdirSync(target);
  const alias = path.join(dir, 'alias'); fs.symlinkSync(target, alias);
  register('target', target);
  expect(resolveCanonicalArtifactRepoForRoot(db, alias)).toMatchObject({ ok: true, project_id: 'target' });
  register('alias', alias);
  expect(resolveCanonicalArtifactRepoForRoot(db, alias)).toEqual({ ok: false, reason: 'ambiguous_repo', candidates: ['alias', 'target'] });
  db.exec('DELETE FROM ledger_project_checkouts; DELETE FROM ledger_projects');
  register('alias', alias);
  expect(resolveCanonicalArtifactRepoForRoot(db, alias)).toMatchObject({ ok: true, project_id: 'alias' });
  expect(resolveCanonicalArtifactRepoForRoot(db, target)).toEqual({ ok: false, reason: 'unknown_repo' });
});

it('resolves a linked worktree through the requested Git repository even with an external git directory', () => {
  const main = path.join(dir, 'main'); fs.mkdirSync(main);
  git(main, 'init', '-b', 'main', '--separate-git-dir', path.join(dir, 'git-data'));
  git(main, 'config', 'core.worktree', fs.realpathSync(main));
  git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(main, 'report.md'), 'report'); git(main, 'add', '.');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const linked = path.join(dir, 'linked'); git(main, 'worktree', 'add', '-b', 'feature', linked);
  register('project', main);
  expect(resolveCanonicalArtifactRepoForRoot(db, linked)).toMatchObject({ ok: true, project_id: 'project', matched_by: 'git_common_dir' });
  git(main, 'config', '--unset', 'core.worktree');
  expect(resolveCanonicalArtifactRepoForRoot(db, linked)).toEqual({ ok: false, reason: 'unknown_repo' });
  register('object-store', path.join(dir, 'git-data'));
  expect(resolveCanonicalArtifactRepoForRoot(db, linked)).toEqual({ ok: false, reason: 'unknown_repo' });
  register('conflicting', linked);
  // An exact checkout registration remains stronger than common repository evidence.
  expect(resolveCanonicalArtifactRepoForRoot(db, linked)).toMatchObject({ ok: true, project_id: 'conflicting', matched_by: 'checkout_root' });
});

it('fails closed for ambiguous remote identities and exact path registrations', () => {
  const source = path.join(dir, 'source'); fs.mkdirSync(source); git(source, 'init', '-b', 'main');
  const remote = 'https://example.invalid/group/repo.git'; git(source, 'remote', 'add', 'origin', remote);
  register('a', path.join(dir, 'a'), 'example.invalid/group/repo');
  register('b', path.join(dir, 'b'), 'example.invalid/group/repo');
  expect(resolveCanonicalArtifactRepoForRoot(db, source)).toEqual({ ok: false, reason: 'ambiguous_repo', candidates: ['a', 'b'] });
  db.prepare('UPDATE ledger_project_checkouts SET root = ?').run(source);
  expect(resolveCanonicalArtifactRepoForRoot(db, source)).toEqual({ ok: false, reason: 'ambiguous_repo', candidates: ['a', 'b'] });
});

it('matches an ordinary linked worktree to its registered main checkout', () => {
  const main = path.join(dir, 'main'); fs.mkdirSync(main); git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(main, 'report.md'), 'report'); git(main, 'add', '.');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const linked = path.join(dir, 'linked'); git(main, 'worktree', 'add', '-b', 'feature', linked);
  register('project', main);
  expect(resolveCanonicalArtifactRepoForRoot(db, linked)).toMatchObject({ ok: true, project_id: 'project', matched_by: 'git_common_dir' });
});

it('uses the observed file directory only for alias evidence, preserving exact checkout priority', () => {
  const root = path.join(dir, 'repo'); const nested = path.join(root, 'subdir'); fs.mkdirSync(nested, { recursive: true });
  register('repo', root); register('nested', nested);
  expect(resolveCanonicalArtifactRepoForRoot(db, root, nested)).toMatchObject({ ok: true, project_id: 'repo', matched_by: 'checkout_root' });
});
