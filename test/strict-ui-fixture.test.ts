// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { render } from './helpers/ui-workspace-fixture';
import { cleanup, screen } from './helpers/dom';
import { jsonFixture, PENDING_RESPONSE, StrictUiFixture } from './helpers/strict-ui-fixture';

function ReadFixture({ request = '/api/model', init, onCaught }: { request?: RequestInfo | URL; init?: RequestInit; onCaught?: () => void }) {
  const [model, setModel] = useState<{ planner: { enabled: boolean } } | null>(null);
  const [caught, setCaught] = useState(false);
  useEffect(() => {
    void fetch(request, init).then(response => response.json()).then(setModel).catch(() => { setCaught(true); onCaught?.(); });
  }, []);
  return h('p', {}, caught ? 'network error handled' : model ? String(model.planner.enabled) : 'pending');
}

describe('strict UI fixtures', () => {
  it('fails a render wait and completion even when the application catches a missing endpoint', async () => {
    const fixture = new StrictUiFixture('caught request scenario', [
      { name: 'read model', method: 'GET', path: '/api/model', respond: () => jsonFixture({ planner: { enabled: true } }) },
    ]).install();
    expect((await fetch(new URL('/api/model', window.location.href))).status).toBe(200);
    let signalCaught!: () => void;
    const caughtByApplication = new Promise<void>(resolve => { signalCaught = resolve; });
    render(h(ReadFixture, {
      request: new Request(new URL('/api/missing?unmodeled=1', window.location.href), { method: 'POST' }),
      init: { method: 'put' },
      onCaught: signalCaught,
    }));
    await expect(screen.findByText('network error handled')).rejects.toThrow(
      '[caught request scenario] unhandled request PUT http://localhost:3000/api/missing?unmodeled=1',
    );
    await caughtByApplication;
    cleanup();
    expect(() => fixture.finish()).toThrow('unhandled request PUT');
  });

  it('does not answer a Request mutation with the modeled GET response', async () => {
    const fixture = new StrictUiFixture('method matching scenario', [
      { name: 'read model', method: 'GET', path: '/api/model', respond: () => jsonFixture({ planner: { enabled: true } }) },
    ]).install();
    const url = new URL('/api/model?fixture=mutation', window.location.href);
    await expect(fetch(new Request(url, { method: 'POST' }))).rejects.toThrow(`[method matching scenario] unhandled request POST ${url.href}`);
    expect(() => fixture.finish()).toThrow('unhandled request POST');
  });

  it('terminates an asynchronous render with its original cause and named request context', async () => {
    const fixture = new StrictUiFixture('incompatible payload scenario', [
      { name: 'broken planner model', method: 'GET', path: '/api/model', respond: () => jsonFixture([]) },
    ]).install();
    render(h(ReadFixture, {}));
    const failure = await screen.findByText('true').then(
      () => { throw new Error('The incompatible model rendered successfully'); },
      error => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('[incompatible payload scenario] render failed');
    expect(failure.message).toContain('broken planner model: GET http://localhost:3000/api/model');
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(failure.cause).toMatchObject({ message: expect.stringContaining('enabled') });
    cleanup();
    expect(() => fixture.finish()).toThrow(failure);
  });

  it('disposes controlled pending requests and restores a clean fixture boundary', async () => {
    const previousFetch = fetch;
    const fixture = new StrictUiFixture('pending scenario', [
      { name: 'pending model', method: 'GET', path: '/api/model', respond: () => PENDING_RESPONSE },
    ]).install();
    const pending = fetch(new Request(new URL('/api/model', window.location.href)));
    const disposed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await fixture.guard(Promise.resolve());
    fixture.finish();
    await disposed;
    expect(fetch).toBe(previousFetch);

    const next = new StrictUiFixture('next scenario', [
      { name: 'deliberate server error', method: 'DELETE', path: '/api/model', respond: () => jsonFixture({ error: 'deliberate' }, 500) },
      { name: 'healthy model', method: 'GET', path: '/api/model', respond: () => jsonFixture({ planner: { enabled: true } }) },
    ]).install();
    expect((await fetch(new Request(new URL('/api/model', window.location.href), { method: 'DELETE' }))).status).toBe(500);
    render(h(ReadFixture, {}));
    expect(await screen.findByText('true')).toBeTruthy();
    cleanup();
    next.finish();
  });
});
