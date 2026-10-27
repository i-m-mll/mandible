// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAppHistory } from '../ui/src/app-history';

let owner: ReturnType<typeof createAppHistory> | undefined;
beforeEach(() => { window.sessionStorage.clear(); window.history.replaceState({ unrelated: 'preserved' }, '', '#/A'); });
afterEach(() => { owner?.dispose(); vi.restoreAllMocks(); });

it('tracks known entry identities through push, replacement, repeated URLs and refresh without changing History methods', () => {
  const push = window.history.pushState;
  const replace = window.history.replaceState;
  owner = createAppHistory(window);
  expect(owner.snapshot()).toMatchObject({ canBack: false, canForward: false });
  expect(window.history.state.unrelated).toBe('preserved');
  owner.push('#/B', { payload: 1 });
  const first = owner.snapshot().entryId;
  owner.push('#/B', { payload: 2 });
  expect(owner.snapshot().entryId).not.toBe(first);
  const current = owner.snapshot().entryId;
  owner.replace('#/C');
  expect(owner.snapshot()).toMatchObject({ entryId: current, canBack: true, canForward: false });
  expect(window.history.state.payload).toBe(2);
  owner.dispose(); owner = createAppHistory(window);
  expect(owner.snapshot()).toMatchObject({ entryId: current, canBack: true, canForward: false });
  expect(window.history.pushState).toBe(push);
  expect(window.history.replaceState).toBe(replace);
});

it('resets unknown history to a safe boundary and does not escape through app traversal', () => {
  owner = createAppHistory(window);
  owner.push('#/B');
  const back = vi.spyOn(window.history, 'back');
  window.history.replaceState({ outside: true }, '', '#/unknown');
  window.dispatchEvent(new PopStateEvent('popstate'));
  const changed = vi.fn(); owner.subscribe(changed);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  expect(changed).not.toHaveBeenCalled();
  owner.back();
  expect(back).not.toHaveBeenCalled();
  expect(owner.snapshot()).toMatchObject({ canBack: false, canForward: false });
  expect(window.history.state.outside).toBe(true);
});

it('does not queue repeated traversal requests before the browser activates the first destination', () => {
  owner = createAppHistory(window); owner.push('#/B');
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
  owner.back(); owner.back();
  expect(back).toHaveBeenCalledTimes(1);
});

it('intercepts only normal same-document app hash anchors', () => {
  owner = createAppHistory(window);
  const anchor = document.createElement('a'); anchor.href = '#/B'; anchor.innerHTML = '<span>Open</span>'; document.body.append(anchor);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  anchor.firstElementChild!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(window.location.hash).toBe('#/B');
  for (const mode of ['modified', 'target', 'download']) {
    anchor.href = '#/C'; anchor.target = mode === 'target' ? '_blank' : '';
    if (mode === 'download') anchor.setAttribute('download', 'file'); else anchor.removeAttribute('download');
    let handled = true;
    document.addEventListener('click', event => { handled = event.defaultPrevented; event.preventDefault(); }, { once: true });
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: mode === 'modified' }));
    expect(handled).toBe(false);
    expect(window.location.hash).toBe('#/B');
  }
  anchor.remove();
});
