// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from './helpers/dom';
import { DiffView, parseUnifiedDiffSections } from '../ui/src/components/DiffView';
import { diffFileKey } from '../ui/src/components/diff-file-identity';
import { authReviewHash } from '../ui/src/views/auth-review-navigation';
import { parseRouteFromHash } from '../ui/src/routing';

afterEach(cleanup);

it('keeps ordinary artifact unified diffs and omission diagnostics visible', () => {
  const ordinary = '--- a/source.md\n+++ b/result.md\n@@ -1 +1 @@\n-old artifact text\n+new artifact text';
  expect(parseUnifiedDiffSections(ordinary)[0]).toMatchObject({ oldPath: 'a/source.md', newPath: 'b/result.md' });
  const view = render(<DiffView diffText={ordinary} />);
  expect(screen.getByRole('button', { name: 'b/result.md' })).toBeTruthy();
  expect(view.container.textContent).toContain('new artifact text');
  const diagnostic = '# diff omitted: content too large for an inline comparison';
  view.rerender(<DiffView diffText={diagnostic} />);
  expect(view.container.textContent).toContain(diagnostic);
});

it('round-trips exact identities and routing context for every Git file shape', () => {
  const sections = parseUnifiedDiffSections([
    'diff --git a/new file b/new file\nnew file mode 100644\n--- /dev/null\n+++ b/new file\n@@ -0,0 +1 @@\n+new',
    'diff --git a/deleted b/deleted\ndeleted file mode 100644\n--- a/deleted\n+++ /dev/null\n@@ -1 +0,0 @@\n-old',
    'diff --git a/old space b/new space\nsimilarity index 100%\nrename from old space\nrename to new space',
    'diff --git a/source b/copy\nsimilarity index 100%\ncopy from source\ncopy to copy',
    'diff --git "a/caf\\303\\251\\tname" "b/caf\\303\\251\\tname"\nBinary files differ',
    'diff --git a/mode only b/mode only\nold mode 100644\nnew mode 100755',
    'diff --git a/dir b/name b/dir b/name\nBinary files differ',
  ].join('\n'));
  const expected = [
    [null, 'new file'], ['deleted', null], ['old space', 'new space'], ['source', 'copy'],
    ['café\tname', 'café\tname'], ['mode only', 'mode only'], ['dir b/name', 'dir b/name'],
  ];
  expect(sections.map(section => [section.oldPath, section.newPath])).toEqual(expected);
  sections.forEach((section, index) => {
    const hash = authReviewHash('#/auth?sidebar=hidden&agent_session=abc&filter=mine', 'request-1', 'diff', section);
    const route = parseRouteFromHash(hash);
    expect(route.params).toMatchObject({ request: 'request-1', view: 'diff', sidebar: 'hidden', agent_session: 'abc', filter: 'mine' });
    expect([route.params.diff_old ?? null, route.params.diff_new ?? null]).toEqual(expected[index]);
    expect(diffFileKey(section)).toBe(JSON.stringify(expected[index]));
  });
  const manual = parseRouteFromHash(authReviewHash('#/auth?diff_old=old&diff_new=new&sidebar=hidden', 'request-2', 'console'));
  expect(manual.params.diff_old).toBeUndefined();
  expect(manual.params.diff_new).toBeUndefined();
});

it('opens a collapsed exact pair once, preserves sibling choices, and waits for confirmed content', () => {
  const text = ['one/file.ts', 'two/file.ts'].map(path => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`).join('\n');
  const ready = vi.fn();
  const target = { oldPath: 'two/file.ts', newPath: 'two/file.ts', navigationToken: 'visit-1' };
  const view = render(<DiffView diffText={text} onTargetReady={ready} />);
  fireEvent.click(screen.getByRole('button', { name: 'one/file.ts' }));
  fireEvent.click(screen.getByRole('button', { name: 'two/file.ts' }));
  view.rerender(<DiffView diffText={text} target={target} onTargetReady={ready} />);
  expect(screen.getByRole('button', { name: 'two/file.ts' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'one/file.ts' }).getAttribute('aria-expanded')).toBe('false');
  expect(ready).toHaveBeenCalledTimes(1);
  expect(ready.mock.calls[0]![1]).toEqual({ kind: 'file', element: screen.getByRole('button', { name: 'two/file.ts' }) });
  fireEvent.click(screen.getByRole('button', { name: 'two/file.ts' }));
  view.rerender(<DiffView diffText={`${text}\n`} target={target} onTargetReady={ready} />);
  expect(screen.getByRole('button', { name: 'two/file.ts' }).getAttribute('aria-expanded')).toBe('false');
  expect(ready).toHaveBeenCalledTimes(1);
  view.rerender(<DiffView diffText="" contentReady={false} target={{ ...target, navigationToken: 'visit-2' }} onTargetReady={ready} />);
  expect(ready).toHaveBeenCalledTimes(1);
  view.rerender(<DiffView diffText={text} target={{ ...target, navigationToken: 'visit-2' }} onTargetReady={ready} />);
  expect(ready).toHaveBeenCalledTimes(2);
  const mismatched = { oldPath: 'one/file.ts', newPath: 'two/file.ts', navigationToken: 'visit-3' };
  view.rerender(<DiffView diffText={text} target={mismatched} onTargetReady={ready} />);
  expect(ready.mock.calls[2]).toEqual(['visit-3', { kind: 'unavailable' }]);
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<DiffView diffText={`${text}\n`} target={mismatched} onTargetReady={ready} />);
  expect(ready).toHaveBeenCalledTimes(3);
  const rename = 'diff --git a/one/file.ts b/two/file.ts\nsimilarity index 100%\nrename from one/file.ts\nrename to two/file.ts';
  view.rerender(<DiffView diffText={rename} target={mismatched} onTargetReady={ready} />);
  expect(ready.mock.calls[3]).toEqual(['visit-3', { kind: 'file', element: screen.getByRole('button', { name: 'two/file.ts' }) }]);
});
