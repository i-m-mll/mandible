// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { setDb } from '../src/db.js';
import { SessionManager } from '../src/session-manager.js';
import { migratedMemoryDb } from './helpers/ledger-fixtures.js';
import { waitUntil } from './helpers/wait-until.js';

it('runs real shell input, resize, and exit without managed provider identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mandible-terminal-proof-'));
  const db = migratedMemoryDb(); setDb(db);
  const manager = new SessionManager(db, () => {});
  try {
    const session = manager.create({ label:'Owned shell proof', command:'/bin/sh', args:[], cwd:root, backend_type:'pty' });
    const backend = manager.get(session.id)!;
    let exited = false;
    backend.on('status', event => { if (event.kind === 'exit') exited = true; });
    manager.start(session.id); manager.resize(session.id,88,28);
    manager.write(session.id,"printf 'MANDIBLE_TERMINAL_READY\\n'; printf 'TOKEN=%s\\n' \"${MANDIBLE_TOKEN-unset}\"; exit 0\r");
    await waitUntil(() => exited, 'the shell to exit');
    expect(backend.getBufferSnapshot().toString()).toContain('MANDIBLE_TERMINAL_READY');
    expect(backend.getBufferSnapshot().toString()).toContain('TOKEN=unset');
    expect(backend.meta).toMatchObject({ cols:88, rows:28, status:'stopped', exit_code:0, provider_session_id:null });
    expect(backend.getStreamEvents()).toEqual([]);
  } finally {manager.close();db.close();rmSync(root,{recursive:true,force:true});}
});
