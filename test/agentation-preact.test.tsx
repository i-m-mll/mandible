import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { Agentation } from 'agentation';

afterEach(cleanup);

it('mounts the bundled Agentation toolbar through Mandible Preact compatibility', () => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });
  const view = render(<Agentation appName="Mandible" onSubmit={() => undefined} />);
  const host = view.container.ownerDocument.querySelector('agentation-toolbar');
  expect(host).not.toBeNull();
  expect(host?.shadowRoot?.querySelector('button')).not.toBeNull();
});
