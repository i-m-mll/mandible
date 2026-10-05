import { describe, expect, it } from 'vitest';
import { assessLogs } from '../scripts/candidate-acceptance.mjs';

describe('production acceptance evidence', () => {
  it('rejects closed-database shutdown errors and event storms', () => {
    const stopped = JSON.stringify({ level: 'info', message: 'server_stopped' });
    const closedDb = JSON.stringify({ level: 'error', message: 'work_scanner_repo_scan_failed', error: 'The database connection is not open' });
    expect(assessLogs(`${stopped}\n${closedDb}`)).toEqual([closedDb]);
    expect(assessLogs(Array(101).fill(JSON.stringify({ level: 'info', message: 'work:scan:completed' })).join('\n'))).toContain('Repeated event storm: work:scan:completed (101)');
    expect(assessLogs(`${stopped}\n${JSON.stringify({ level: 'info', message: 'daemon_ready' })}`)).toEqual([]);
  });
});
