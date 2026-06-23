// Linked-commit surface tests (Spaces child C13b, issue 8730bf9). The
// export-and-track docs-branch commit MUST go through `mandible commit linked`
// (never a bare `git commit`), so every docs commit carries a `Mandible-Issue:`
// trailer that the auth-merge promotion path requires. These tests drive the
// real `cli/commit.sh linked` against a throwaway git repo.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMIT_SH = path.resolve(HERE, '..', 'cli', 'commit.sh');

let repo: string;

function git(args: string[], cwd = repo): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function commitLinked(args: string[]): { status: number | null; stdout: string; stderr: string } {
  // Disable commit signing for the test repo so it runs without a key, but keep
  // the helper's own behavior intact (it never passes --no-gpg-sign itself).
  const r = spawnSync('bash', [COMMIT_SH, 'linked', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-commitlinked-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'agent@test']);
  git(['config', 'user.name', 'Agent']);
  git(['config', 'commit.gpgsign', 'false']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('mandible commit linked', () => {
  it('produces a commit carrying a Mandible-Issue trailer', () => {
    fs.writeFileSync(path.join(repo, 'doc.md'), '# hi\n');
    const r = commitLinked(['--add', 'doc.md', '-m', 'export doc', '--issue', '8730bf9']);
    expect(r.status).toBe(0);
    const msg = git(['log', '-1', '--format=%B']).stdout;
    expect(msg).toContain('export doc');
    expect(msg).toContain('Mandible-Issue: 8730bf9');
  });

  it('carries one trailer per repeated --issue', () => {
    fs.writeFileSync(path.join(repo, 'doc.md'), 'x\n');
    const r = commitLinked(['--add', 'doc.md', '-m', 'multi', '--issue', 'aaa111', '--issue', 'bbb222']);
    expect(r.status).toBe(0);
    const msg = git(['log', '-1', '--format=%B']).stdout;
    expect(msg).toContain('Mandible-Issue: aaa111');
    expect(msg).toContain('Mandible-Issue: bbb222');
  });

  it('falls back to the .issue helper file when no --issue is passed', () => {
    fs.writeFileSync(path.join(repo, '.issue'), '8730bf9\n');
    fs.writeFileSync(path.join(repo, 'doc.md'), 'y\n');
    const r = commitLinked(['--add', 'doc.md', '-m', 'auto-discovered']);
    expect(r.status).toBe(0);
    const msg = git(['log', '-1', '--format=%B']).stdout;
    expect(msg).toContain('Mandible-Issue: 8730bf9');
  });

  it('fails loudly when no issue ref can be resolved (no trailer => no commit)', () => {
    fs.writeFileSync(path.join(repo, 'doc.md'), 'z\n');
    const r = commitLinked(['--add', 'doc.md', '-m', 'no issue']);
    expect(r.status).not.toBe(0);
    // No commit was created.
    expect(git(['rev-parse', '--verify', '--quiet', 'HEAD']).status).not.toBe(0);
  });

  it('requires a message', () => {
    const r = commitLinked(['--issue', '8730bf9']);
    expect(r.status).not.toBe(0);
  });
});
