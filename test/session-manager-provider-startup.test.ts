import SqliteDatabase from '../src/sqlite.js';
import { describe, expect, it } from 'vitest';
import { migrate, setDb } from '../src/db.js';
import { SessionManager } from '../src/session-manager.js';

describe('terminal and historical provider separation', () => {
  it('preserves historical managed sessions but refuses terminal control or new legacy providers', () => {
    const db = new SqliteDatabase(':memory:'); migrate(db); setDb(db);
    const seed = new SessionManager(db, () => {});
    const terminal = seed.create({ label:'History', command:'/bin/sh', backend_type:'pty' });
    db.prepare("UPDATE console_sessions SET command = 'claude', backend_type = 'sdk', transport_lane = 'sdk', provider_session_id = 'exact-native', run_options_json = ? WHERE id = ?")
      .run(JSON.stringify({ model:'retained', thinking_effort:'high' }),terminal.id);
    seed.close();
    const manager = new SessionManager(db, () => {}); manager.init();
    expect(manager.get(terminal.id)?.meta).toMatchObject({ backend_type:'sdk', provider_session_id:'exact-native', run_options:{ model:'retained', thinking_effort:'high' } });
    expect(() => manager.start(terminal.id)).toThrow('no owned terminal');
    expect(() => manager.create({ label:'Forbidden', command:'claude', backend_type:'sdk' })).toThrow('ConversationControlService');
    expect(db.prepare('SELECT COUNT(*) AS count FROM console_sessions').get()).toEqual({ count:1 });
    manager.close(); db.close();
  });
});
