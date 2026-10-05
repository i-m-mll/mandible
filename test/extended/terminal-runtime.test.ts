// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import SqliteDatabase from '../../src/sqlite.js';
import { migrate, setDb } from '../../src/db.js';
import { SessionManager } from '../../src/session-manager.js';

it('runs real shell input, resize, and exit without managed provider identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mandible-terminal-proof-'));
  const db = new SqliteDatabase(':memory:'); migrate(db); setDb(db);
  const manager = new SessionManager(db, () => {});
  try {
    const session = manager.create({ label:'Owned shell proof', command:'/bin/sh', args:[], cwd:root, backend_type:'pty' });
    const backend = manager.get(session.id)!;
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Shell did not exit')),5000);
      backend.on('status', event => { if(event.kind==='exit') { clearTimeout(timer);resolve(); } });
    });
    manager.start(session.id); manager.resize(session.id,88,28);
    manager.write(session.id,"printf 'MANDIBLE_TERMINAL_READY\\n'; printf 'TOKEN=%s\\n' \"${MANDIBLE_TOKEN-unset}\"; exit 0\r");
    await exited;
    expect(backend.getBufferSnapshot().toString()).toContain('MANDIBLE_TERMINAL_READY');
    expect(backend.getBufferSnapshot().toString()).toContain('TOKEN=unset');
    expect(backend.meta).toMatchObject({ cols:88, rows:28, status:'stopped', exit_code:0, provider_session_id:null });
    expect(backend.getStreamEvents()).toEqual([]);
  } finally {manager.close();db.close();rmSync(root,{recursive:true,force:true});}
});
