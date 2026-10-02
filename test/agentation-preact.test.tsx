import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { Agentation, getStorageKey, loadAnnotations, type Annotation } from 'agentation';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'elementFromPoint');
  vi.unstubAllGlobals();
});

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

it('releases page input when hidden by unmounting and reloads saved notes', () => {
  const entries = new Map<string, string>();
  const pathname = window.location.pathname;
  const saved: Annotation = {
    id: 'saved-note', comment: 'Keep this note', elementPath: 'button',
    timestamp: Date.now(), x: 10, y: 20, element: 'button',
  };
  entries.set(getStorageKey(pathname), JSON.stringify([saved]));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });

  const view = render(<Agentation appName="Mandible" />);
  const launcher = view.container.ownerDocument.querySelector('agentation-toolbar')?.shadowRoot
    ?.querySelector<HTMLButtonElement>('button[aria-label="Start feedback mode"]');
  expect(launcher).not.toBeNull();
  fireEvent.click(launcher!);
  const target = document.createElement('button');
  document.body.appendChild(target);
  document.elementFromPoint = () => target;
  const activeClick = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(activeClick);
  expect(activeClick.defaultPrevented).toBe(true);

  view.unmount();
  const hiddenClick = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(hiddenClick);
  expect(hiddenClick.defaultPrevented).toBe(false);
  expect(loadAnnotations(pathname)).toEqual([saved]);

  const reopened = render(<Agentation appName="Mandible" />);
  expect(reopened.container.ownerDocument.querySelector('agentation-toolbar')).not.toBeNull();
  expect(loadAnnotations(pathname)).toEqual([saved]);
  target.remove();
});
