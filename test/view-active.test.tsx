// @vitest-environment jsdom
import { act, cleanup, render, screen } from './helpers/dom.js';
import { afterEach, expect, it } from 'vitest';
import { h } from 'preact';
import { AppShellProvider, useAppShell, useViewActive } from '../ui/src/app-shell';

function setDocumentVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function Probe(): JSX.Element {
  return <output data-testid="probe">{useViewActive() ? 'active' : 'inactive'}</output>;
}

function Shell({ active }: { active: boolean }): JSX.Element {
  const parent = useAppShell();
  return <AppShellProvider value={{ ...parent, active }}><Probe /></AppShellProvider>;
}

afterEach(() => {
  cleanup();
  setDocumentVisibility('visible');
});

it('is active only while the tab is the current route and the document is visible', () => {
  setDocumentVisibility('visible');
  const view = render(<Shell active />);
  expect(screen.getByTestId('probe').textContent).toBe('active');

  act(() => setDocumentVisibility('hidden'));
  expect(screen.getByTestId('probe').textContent).toBe('inactive');

  act(() => setDocumentVisibility('visible'));
  expect(screen.getByTestId('probe').textContent).toBe('active');

  view.rerender(<Shell active={false} />);
  expect(screen.getByTestId('probe').textContent).toBe('inactive');
});
