// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../src-tauri/src/acceptance-interaction.js', import.meta.url), 'utf8');

function interaction() {
  const workUntil = 1000;
  let now = 100;
  let reloads = 0;
  const state = { setup: undefined as string | undefined, theme: 'dark', revision: 1 };
  const storage = new Map<string, string>();
  const reports: Array<Record<string, unknown>> = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const bodyEntered = Promise.withResolvers<AbortSignal>();
  let blockBody = false;
  const fetches: string[] = [];
  const page = async () => {
    const dom = new JSDOM(`<a aria-label="Settings" href="#/settings">Settings</a>
      <select id="settings-app-theme"><option>dark</option><option>light</option></select>
      <button aria-label="Complete optional integrations">Complete</button>
      ${state.setup === undefined ? '<div role="region" aria-label="Welcome to Mandible"><button aria-label="Skip optional integrations">Skip</button></div>' : ''}`);
    const document = dom.window.document;
    const location = { hash: '#/', href: 'https://app.mandible.localhost:60408/#/settings', reload: () => { reloads += 1; } };
    document.querySelector('a')!.addEventListener('click', event => { event.preventDefault(); location.hash = '#/settings'; });
    const theme = document.querySelector('select')!;
    theme.value = state.theme;
    theme.addEventListener('change', () => { state.theme = theme.value; state.revision += 1; });
    const complete = document.querySelector('button[aria-label="Complete optional integrations"]') as HTMLButtonElement;
    complete.disabled = state.setup === 'complete';
    complete.addEventListener('click', () => { state.setup = 'complete'; complete.disabled = true; });
    document.querySelector('button[aria-label="Skip optional integrations"]')?.addEventListener('click', () => {
      state.setup = 'skipped'; document.querySelector('[role="region"]')!.remove();
    });
    try {
      await vm.runInNewContext(source.replace('__MANDIBLE_ACCEPTANCE_NONCE__', JSON.stringify('nonce'))
        .replace('__MANDIBLE_ACCEPTANCE_WORK_UNTIL__', String(workUntil)), {
        window: { __TAURI__: { core: { invoke: async (_command: string, { evidence }: { evidence: Record<string, unknown> }) => { reports.push(evidence); } } } },
        document, location, Event: dom.window.Event, AbortController,
        sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
        Date: { now: () => now },
        setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout: (id: number) => timers.delete(id),
        fetch: async (path: string, { signal }: { signal: AbortSignal }) => {
          fetches.push(path);
          const value = path === '/api/settings' ? { 'integrations.setup': state.setup }
            : path === '/api/settings/integrations' ? { available: true, items: [{ id: 'fixture', status: 'absent', destination: null }] }
            : path === '/api/settings/instructions-delivery' ? { targets: [] }
            : { value: state.theme, revision: state.revision };
          return { ok: true, json: () => {
            if (!blockBody) return Promise.resolve(structuredClone(value));
            const result = new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            bodyEntered.resolve(signal);
            return result;
          } };
        },
      });
    } finally { dom.window.close(); }
  };
  return { page, reports, state, timers, fetches, bodyEntered, workUntil,
    get reloads() { return reloads; }, set now(value: number) { now = value; },
    blockBody: () => { blockBody = true; } };
}

it('preserves the persistence checks while both reloads retain the owned absolute deadline', async () => {
  const complete = interaction();
  await complete.page();
  await complete.page();
  await complete.page();
  expect(complete.reloads).toBe(2);
  expect(complete.state).toEqual({ setup: 'complete', theme: 'light', revision: 2 });
  expect(complete.reports).toMatchObject([{ passed: true, rendered: true,
    edit: { before: 'dark', after: 'light', revision: 2 },
    setup: { skipped: 'skipped', completed: 'complete', reloads: 2, promptDismissedAfterReload: true, integrationsUnchanged: true } }]);
  for (const reload of [1, 2]) {
    const expired = interaction();
    for (let page = 0; page < reload; page += 1) await expired.page();
    const requests = expired.fetches.length;
    expired.now = expired.workUntil;
    await expired.page();
    expect(expired.reloads).toBe(reload);
    expect(expired.fetches).toHaveLength(requests);
    expect(expired.reports).toMatchObject([{ passed: false, error: expect.stringContaining('deadline exceeded') }]);
  }
});

it('bounds an unfinished response body by the same remaining work budget', async () => {
  const f = interaction();
  f.now = 975;
  f.blockBody();
  const page = f.page();
  const signal = await f.bodyEntered.promise;
  expect([...f.timers.values()].map(timer => timer.delay)).toEqual([25]);
  f.now = f.workUntil;
  [...f.timers.values()][0].callback();
  await page;
  expect(signal.aborted).toBe(true);
  expect(f.reports).toMatchObject([{ passed: false, error: expect.stringContaining('deadline exceeded') }]);
  expect(f.timers.size).toBe(0);
  expect(f.reloads).toBe(0);
});
