// @vitest-environment jsdom
import { useRef } from 'preact/hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from './helpers/dom';
import { usePersistedScrollPosition } from '../ui/src/hooks/usePersistedScrollPosition';

let maxScroll = 1000;
function Body({ scope, content = 'Review content' }: { scope: string; content?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  usePersistedScrollPosition(ref, scope);
  return <div ref={node => {
    ref.current = node;
    if (!node || Object.hasOwn(node, 'scrollHeight')) return;
    let top = 0;
    Object.defineProperties(node, {
      scrollHeight: { get: () => maxScroll + 300 },
      clientHeight: { get: () => 300 },
      scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, maxScroll)); } },
    });
  }} data-testid="body">{content}</div>;
}

beforeEach(() => {
  const rows = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  } });
  maxScroll = 1000;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('flushes actual movement synchronously and restores independent request/tab offsets across refetch, selection and remount', () => {
  const view = render(<Body scope="request-a:info" />);
  const body = view.getByTestId('body');
  body.scrollTop = 184;
  fireEvent.scroll(body);
  expect(window.localStorage.getItem('request-a:info')).toBe('184');
  view.rerender(<Body scope="request-a:info" content="Refetched content" />);
  expect(body.scrollTop).toBe(184);
  view.rerender(<Body scope="request-a:diff" />);
  expect(body.scrollTop).toBe(0);
  body.scrollTop = 72;
  fireEvent.scroll(body);
  view.rerender(<Body scope="request-b:info" />);
  body.scrollTop = 39;
  fireEvent.scroll(body);
  view.rerender(<Body scope="request-a:info" />);
  expect(body.scrollTop).toBe(184);
  view.rerender(<Body scope="request-a:diff" />);
  expect(body.scrollTop).toBe(72);
  body.scrollTop = 81;
  window.dispatchEvent(new Event('pagehide'));
  expect(window.localStorage.getItem('request-a:diff')).toBe('81');
  view.unmount();
  const reload = render(<Body scope="request-a:info" />);
  expect(reload.getByTestId('body').scrollTop).toBe(184);
  expect(window.localStorage.getItem('request-b:info')).toBe('39');
});

it('retains saved intent through initial clamping and restores when delayed content becomes tall enough', async () => {
  window.localStorage.setItem('delayed', '184');
  maxScroll = 0;
  const view = render(<Body scope="delayed" />);
  const body = view.getByTestId('body');
  expect(body.scrollTop).toBe(0);
  fireEvent.scroll(body);
  expect(window.localStorage.getItem('delayed')).toBe('184');
  maxScroll = 500;
  view.rerender(<Body scope="delayed" content="Delayed review arrived" />);
  await waitFor(() => expect(body.scrollTop).toBe(184));
});

it('lets new user movement supersede a pending restore instead of jumping when content arrives', async () => {
  window.localStorage.setItem('interrupted', '184');
  maxScroll = 100;
  const view = render(<Body scope="interrupted" />);
  const body = view.getByTestId('body');
  expect(body.scrollTop).toBe(100);
  fireEvent.scroll(body);
  expect(window.localStorage.getItem('interrupted')).toBe('184');
  body.scrollTop = 40;
  fireEvent.scroll(body);
  expect(window.localStorage.getItem('interrupted')).toBe('40');
  maxScroll = 500;
  view.rerender(<Body scope="interrupted" content="Later content" />);
  await waitFor(() => expect(body.textContent).toBe('Later content'));
  expect(body.scrollTop).toBe(40);
});
