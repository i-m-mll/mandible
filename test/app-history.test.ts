// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAppHistory } from '../ui/src/app-history';

let owner: ReturnType<typeof createAppHistory> | undefined;
beforeEach(() => { window.sessionStorage.clear(); window.history.replaceState({ unrelated: 'preserved' }, '', '/a'); });
afterEach(() => { owner?.dispose(); vi.restoreAllMocks(); });

it('tracks known entry identities through push, replacement, repeated URLs and refresh without changing History methods', () => {
  const push = window.history.pushState;
  const replace = window.history.replaceState;
  owner = createAppHistory(window);
  expect(owner.snapshot()).toMatchObject({ canBack: false, canForward: false });
  expect(window.history.state.unrelated).toBe('preserved');
  owner.push('/b', { payload: 1 });
  const first = owner.snapshot().entryId;
  owner.push('/b', { payload: 2 });
  expect(owner.snapshot().entryId).not.toBe(first);
  const current = owner.snapshot().entryId;
  owner.replace('/c');
  expect(owner.snapshot()).toMatchObject({ entryId: current, canBack: true, canForward: false });
  expect(window.history.state.payload).toBe(2);
  owner.dispose(); owner = createAppHistory(window);
  expect(owner.snapshot()).toMatchObject({ entryId: current, canBack: true, canForward: false });
  expect(window.history.pushState).toBe(push);
  expect(window.history.replaceState).toBe(replace);
});

it('resets unknown history to a safe boundary and does not escape through app traversal', () => {
  owner = createAppHistory(window);
  owner.push('/b');
  const back = vi.spyOn(window.history, 'back');
  window.history.replaceState({ outside: true }, '', '/unknown');
  window.dispatchEvent(new PopStateEvent('popstate'));
  owner.back();
  expect(back).not.toHaveBeenCalled();
  expect(owner.snapshot()).toMatchObject({ canBack: false, canForward: false });
  expect(window.history.state.outside).toBe(true);
});

it('does not queue repeated traversal requests before the browser activates the first destination', () => {
  owner = createAppHistory(window); owner.push('/b');
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
  owner.back(); owner.back();
  expect(back).toHaveBeenCalledTimes(1);
});

it('intercepts normal anchors to same-origin app paths and leaves server paths and modified clicks to the browser', () => {
  owner = createAppHistory(window);
  const anchor = document.createElement('a'); anchor.innerHTML = '<span>Open</span>'; document.body.append(anchor);
  const clickHandled = (init: MouseEventInit = {}) => {
    let handled = true;
    document.addEventListener('click', event => { handled = event.defaultPrevented; event.preventDefault(); }, { once: true });
    anchor.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
    return handled;
  };
  anchor.href = '/issue/abc1234?sidebar=hidden';
  expect(clickHandled()).toBe(true);
  expect(`${window.location.pathname}${window.location.search}`).toBe('/issue/abc1234?sidebar=hidden');
  for (const href of ['/api/issues', '/dist/app.js', '/r/abc', 'https://example.com/issue/x']) {
    anchor.href = href;
    expect(clickHandled()).toBe(false);
  }
  anchor.href = '/c';
  expect(clickHandled({ ctrlKey: true })).toBe(false);
  anchor.target = '_blank';
  expect(clickHandled()).toBe(false);
  anchor.target = ''; anchor.setAttribute('download', 'file');
  expect(clickHandled()).toBe(false);
  expect(window.location.pathname).toBe('/issue/abc1234');
  anchor.remove();
});
