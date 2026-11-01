// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { createMigratedDb, insertRawLedgerProject } from './helpers/ledger-fixtures.js';
import { addBinding, createUser } from '../src/users/store.js';
import { qualifiedRuntimeFixtureEnv } from './helpers/runtime-fixture.js';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';

it('runs tokenless local verification with canonical project, responsibility, and lifecycle guards', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-recovery-cli-'));
  const dbFile = path.join(home, 'mandible.db');
  const db = createMigratedDb({ path: dbFile });
  try {
    const user = createUser(db, { slug: 'recovery-cli-agent', kind: 'agent', display_name: 'Recovery CLI agent' });
    addBinding(db, user.id, { binding_type: 'provider_session_env', value: 'CODEX_THREAD_ID' });
    const project = insertRawLedgerProject(db, { name: 'recovery-cli', projectKey: 'recovery-cli', displayName: 'Recovery CLI' });
    const request = 'private-recovery-request';
    db.prepare(`INSERT INTO auth_requests (id,type,command,title,cwd,repo,status,created_at,updated_at,expires_at,execution_mode)
      VALUES (?, 'merge', 'never execute', 'Private boundary', ?, ?, 'pending', 1, 1, 1, 'daemon')`).run(request, home, project);
    const before = db.prepare('SELECT * FROM auth_requests WHERE id=?').get(request);
    const runtime = spawnSync('/bin/sh', ['scripts/bun-runtime.sh'], { encoding: 'utf8' }).stdout.trim();
    const invoke = () => spawnSync(runtime, ['scripts/verify-current-convergence.ts', request], {
      encoding: 'utf8', timeout: STATE_DEADLINE_MS,
      env: { ...process.env, ...qualifiedRuntimeFixtureEnv(), MANDIBLE_HOME: home, MANDIBLE_DB: dbFile, GIT_OPTIONAL_LOCKS: '0', CODEX_THREAD_ID: 'recovery-cli-session',
        CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', GEMINI_SESSION_ID: '', MANDIBLE_SESSION_ID: '', MANDIBLE_MANAGED_APP: '' },
    });
    const admitted = invoke();
    expect(admitted.status).toBe(1);
    // The lifecycle guard applies without a project grant.
    expect(admitted.stderr).toContain('Convergence retry applies only to a successfully executed request.');
    expect(db.prepare('SELECT * FROM auth_requests WHERE id=?').get(request)).toEqual(before);
    // A completed command request still cannot invent delivery custody. The
    // existing publication tests separately qualify merge receipt validation.
    db.prepare("UPDATE auth_requests SET type='commit',status='completed',exit_code=0 WHERE id=?").run(request);
    const completed = db.prepare('SELECT * FROM auth_requests WHERE id=?').get(request);
    const unowned = invoke();
    expect(unowned.status).toBe(1); expect(unowned.stderr).toContain('Explicitly assume current request responsibility before changing it.');
    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(user.id);
    const retired = invoke();
    expect(retired.status).toBe(1); expect(retired.stderr).toContain('An active local identity is required.');
    expect(db.prepare('SELECT * FROM auth_requests WHERE id=?').get(request)).toEqual(completed);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
