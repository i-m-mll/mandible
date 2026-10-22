import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerControllerAdapter } from '../../src/conversation-control/codex-controller';
import { SessionManager } from '../../src/session-manager';
import { createMigratedDb } from '../helpers/ledger-fixtures';

const adapters: CodexAppServerControllerAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
function adapter(env: Record<string, string> = {}) {
  const result = new CodexAppServerControllerAdapter({ codexExecutable: process.execPath,
    spawnProcess: (_command, args, options) => spawn(process.execPath,
      ['test/fixtures/structured-controller-process.mjs', 'codex', ...args],
      { ...options, env: { ...options.env, FAKE_CODEX_ARCHIVED: '1', ...env } }) as ChildProcessWithoutNullStreams,
  });
  adapters.push(result); return result;
}
const request = { kind: 'resume-provider-session' as const, conversation_id: 'chat', generation: 1,
  controller_instance_id: 'controller', provider_session_id: 'thread-archived' };

describe('archived Codex continuation through the managed controller', () => {
  it('restores the exact native archived thread before resume', async () => {
    expect(await adapter().acquire(request)).toEqual({ ok: true, value: {
      controller_instance_id: 'controller', provider_session_id: 'thread-archived', pid: expect.any(Number) } });
  });
  it.each([{ FAKE_CODEX_UNARCHIVE_FAIL: '1' }, { FAKE_CODEX_RESTORED_ID: 'wrong-thread' }])
    ('refuses failed or mismatched native restoration without creating another thread', async env => {
      expect((await adapter(env).acquire(request)).ok).toBe(false);
    });
  it('refuses managed archive/resume through the real-terminal SessionManager', () => {
    const db = createMigratedDb({ setGlobal: true });
    try {
      const manager = new SessionManager(db, () => undefined);
      expect(() => manager.create({ label: 'Resume Codex', command: 'codex', backend_type: 'spawn',
        provider_session_id: 'thread-archived' })).toThrow('Managed conversations use ConversationControlService');
    } finally { db.close(); }
  });
});
