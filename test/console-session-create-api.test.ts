import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConsoleSession } from '../ui/src/api';

afterEach(() => vi.unstubAllGlobals());

describe('console session creation payload', () => {
  it('posts the exact registered cwd only for scoped creation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ session: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createConsoleSession('Scoped', 'codex', 'agent', 'acp', { cwd: '/registered/project' });
    await createConsoleSession('Unscoped', 'codex', 'agent', 'acp');

    const scopedBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const unscopedBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(scopedBody).toMatchObject({ label: 'Scoped', command: 'codex', cwd: '/registered/project' });
    expect(unscopedBody).toMatchObject({ label: 'Unscoped', command: 'codex' });
    expect(unscopedBody).not.toHaveProperty('cwd');
  });
});
