// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from './helpers/dom';
import { ChangeList, type ChangeListFile } from '../ui/src/components/ChangeList';
import { authReviewHref } from '../ui/src/views/auth-review-navigation';
import { routeFromUrl } from '../ui/src/routing';

const routeOf = (href: string) => routeFromUrl(new URL(href, window.location.origin));
afterEach(() => { cleanup(); window.localStorage.clear(); });

it('round-trips exact identities and routing context for Git file shapes', () => {
  const paths = [
    [null, 'new file'], ['deleted', null], ['old space', 'new space'], ['source', 'copy'],
    ['café\tname', 'café\tname'], ['mode only', 'mode only'], ['dir b/name', 'dir b/name'],
  ];
  window.history.replaceState(null, '', '/auth?sidebar=hidden&agent_session=abc&filter=mine');
  for (const [oldPath, newPath] of paths) {
    const route = routeOf(authReviewHref('request-1', 'diff', { oldPath: oldPath!, newPath: newPath! }));
    expect(route).toMatchObject({ entity: { kind: 'auth', ref: 'request-1' }, params: { view: 'diff', sidebar: 'hidden', agent_session: 'abc', filter: 'mine' } });
    expect([route.params.diff_old ?? null, route.params.diff_new ?? null]).toEqual([oldPath, newPath]);
  }
  window.history.replaceState(null, '', '/auth/request-1?diff_old=old&diff_new=new&sidebar=hidden');
  const manual = routeOf(authReviewHref('request-2', 'console'));
  expect(manual.params.diff_old).toBeUndefined();
  expect(manual.params.diff_new).toBeUndefined();
});

it('opens a collapsed exact pair once, preserves sibling choices, and waits for confirmed content', () => {
  const files: ChangeListFile[] = ['one/file.ts', 'two/file.ts'].map(path => ({
    old_path: path, new_path: path, change_kind: 'modified', additions: null, deletions: null,
  }));
  const ready = vi.fn();
  const props = { scope: 'auth:request-1', ariaLabel: 'Changes', onTargetReady: ready };
  const target = { oldPath: 'two/file.ts', newPath: 'two/file.ts', navigationToken: 'visit-1' };
  const view = render(<ChangeList {...props} files={files} />);
  fireEvent.click(screen.getByRole('button', { name: 'one/file.ts' }));
  view.rerender(<ChangeList {...props} files={files} target={target} />);
  expect(screen.getByRole('button', { name: 'two/file.ts' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'one/file.ts' }).getAttribute('aria-expanded')).toBe('false');
  expect(ready.mock.calls).toEqual([['visit-1', { kind: 'file', element: screen.getByRole('button', { name: 'two/file.ts' }) }]]);
  fireEvent.click(screen.getByRole('button', { name: 'two/file.ts' }));
  view.rerender(<ChangeList {...props} files={[...files]} target={target} />);
  expect(screen.getByRole('button', { name: 'two/file.ts' }).getAttribute('aria-expanded')).toBe('false');
  expect(ready).toHaveBeenCalledTimes(1);

  const newTarget = { ...target, navigationToken: 'visit-2' };
  view.rerender(<ChangeList {...props} contentReady={false} target={newTarget} />);
  expect(ready).toHaveBeenCalledTimes(1);
  view.rerender(<ChangeList {...props} files={files} target={newTarget} />);
  expect(ready).toHaveBeenCalledTimes(2);

  const mismatched = { oldPath: 'one/file.ts', newPath: 'two/file.ts', navigationToken: 'visit-3' };
  view.rerender(<ChangeList {...props} files={files} target={mismatched} />);
  expect(ready.mock.calls[2]).toEqual(['visit-3', { kind: 'unavailable' }]);
  view.rerender(<ChangeList {...props} files={[...files]} target={mismatched} />);
  expect(ready).toHaveBeenCalledTimes(3);
  const rename = [{ ...files[0]!, new_path: 'two/file.ts', change_kind: 'renamed' as const }];
  view.rerender(<ChangeList {...props} files={rename} target={mismatched} />);
  expect(ready.mock.calls[3]).toEqual(['visit-3', { kind: 'file', element: screen.getByRole('button', { name: 'one/file.ts → two/file.ts' }) }]);
});
