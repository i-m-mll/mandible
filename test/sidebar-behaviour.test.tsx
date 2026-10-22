// Shared sidebar behaviour: a reorder never loses hidden or new rows, the
// durable order preference survives rejected, concurrent and stale writes, and
// keyboard and Command-F ownership stays with the control the user is in.

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import { SidebarItemRow } from '../ui/src/components/shared/SidebarItemRow';
import { SidebarSearchFilterHeader } from '../ui/src/components/shared/SidebarSearchFilterHeader';
import { mergeSidebarSubsetOrder, reconcileSidebarOrder } from '../ui/src/components/shared/sidebar-order';
import { useSidebarListNavigation } from '../ui/src/hooks/useSidebarListNavigation';
import { useSidebarOrderPreference } from '../ui/src/hooks/useSidebarOrderPreference';
import { useSidebarReorder } from '../ui/src/hooks/useSidebarReorder';

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
  vi.restoreAllMocks();
});

function ReorderList() {
  const [ids, setIds] = useState(['a', 'b', 'c']);
  const reorder = useSidebarReorder({ ids, label: (id) => id.toUpperCase(), onCommit: setIds });
  return (
    <div data-testid="list" {...reorder.list}>
      {reorder.assistive}
      {ids.map((id) => (
        <SidebarItemRow
          key={id}
          label={id.toUpperCase()}
          selectionLabel={`Select ${id}`}
          onSelect={() => undefined}
          reorder={reorder.binding(id)}
        />
      ))}
    </div>
  );
}

function order(): string[] {
  return Array.from(screen.getByTestId('list').querySelectorAll<HTMLElement>('[data-sidebar-reorder-id]'))
    .map((row) => row.dataset.sidebarReorderId!);
}

function NavigableList() {
  const items = ['first', 'second', 'third'];
  const [selected, setSelected] = useState('first');
  const navigation = useSidebarListNavigation({
    items,
    getKey: (item) => item,
    selectedKey: selected,
    onSelect: setSelected,
  });
  return (
    <div>
      {items.map((item, index) => {
        const itemNavigation = navigation.getItemNavigationProps(item, index);
        return (
          <button
            key={item}
            ref={itemNavigation.ref}
            type="button"
            tabIndex={itemNavigation.tabIndex}
            aria-current={itemNavigation['aria-current']}
            onKeyDown={itemNavigation.onKeyDown}
          >
            {item}
          </button>
        );
      })}
    </div>
  );
}

function SearchHeader({ label, value = '' }: { label: string; value?: string }) {
  return (
    <SidebarSearchFilterHeader
      value={value}
      onValueChange={vi.fn()}
      placeholder={label}
      searchAriaLabel={label}
      clearAriaLabel={`Clear ${label}`}
    />
  );
}

function preference(value: api.SidebarOrderPreference['value'], revision: number): api.SidebarOrderPreference {
  return { version: 1, key: 'sidebar_order', value, revision };
}

describe('sidebar reorder', () => {
  it('reconciles newly available IDs and preserves hidden IDs while moving a visible subset', () => {
    expect(reconcileSidebarOrder(['a', 'b', 'c'], ['c', 'missing', 'a'])).toEqual(['c', 'a', 'b']);
    expect(mergeSidebarSubsetOrder(['a', 'hidden', 'b', 'c'], ['a', 'b', 'c'], ['c', 'a', 'b']))
      .toEqual(['c', 'hidden', 'a', 'b']);
  });

  it('moves with the keyboard while clamping the first and last positions', () => {
    render(<ReorderList />);
    const move = (id: string, key: string) =>
      fireEvent.keyDown(screen.getByRole('button', { name: `Select ${id}` }), { key, ctrlKey: true, shiftKey: true });
    move('a', 'ArrowUp');
    expect(order()).toEqual(['a', 'b', 'c']);
    move('a', 'ArrowDown');
    expect(order()).toEqual(['b', 'a', 'c']);
    move('c', 'ArrowDown');
    expect(order()).toEqual(['b', 'a', 'c']);
  });
});

describe('sidebar order preference', () => {
  it('serializes optimistic writes without losing either field', async () => {
    vi.spyOn(api, 'getSidebarOrderPreference')
      .mockResolvedValue(preference({ pinnedConversationIds: ['old'], briefingTopLevelIds: null }, 4));
    const update = vi.spyOn(api, 'updateSidebarOrderPreference')
      .mockImplementation(async (value, revision) => preference(value, revision + 1));
    const { result } = renderHook(() => useSidebarOrderPreference());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.patch({ pinnedConversationIds: ['new'] }));
    act(() => result.current.patch({ briefingTopLevelIds: ['group:one'] }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));

    const both = { pinnedConversationIds: ['new'], briefingTopLevelIds: ['group:one'] };
    expect(update.mock.calls).toEqual([[both, 4], [both, 5]]);
    expect(result.current.value).toEqual(both);
    expect(result.current.notice).toBeNull();
  });

  it('rolls back a rejected write to the last durable value and exposes a failure', async () => {
    const durable = { pinnedConversationIds: ['durable'], briefingTopLevelIds: null };
    vi.spyOn(api, 'getSidebarOrderPreference').mockResolvedValue(preference(durable, 2));
    vi.spyOn(api, 'updateSidebarOrderPreference').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSidebarOrderPreference());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.patch({ pinnedConversationIds: ['optimistic'] }));
    expect(result.current.value.pinnedConversationIds).toEqual(['optimistic']);
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(result.current.value).toEqual(durable);
  });

  it('does not let a focus refresh overwrite a newer in-flight write with an older snapshot', async () => {
    let resolveWrite!: (value: api.SidebarOrderPreference) => void;
    let resolveRefresh!: (value: api.SidebarOrderPreference) => void;
    const write = new Promise<api.SidebarOrderPreference>((resolve) => { resolveWrite = resolve; });
    const refresh = new Promise<api.SidebarOrderPreference>((resolve) => { resolveRefresh = resolve; });
    vi.spyOn(api, 'getSidebarOrderPreference')
      .mockResolvedValueOnce(preference({ pinnedConversationIds: ['old'], briefingTopLevelIds: null }, 4))
      .mockReturnValueOnce(refresh);
    const update = vi.spyOn(api, 'updateSidebarOrderPreference')
      .mockReturnValueOnce(write)
      .mockImplementation(async (value, revision) => preference(value, revision + 1));
    const { result } = renderHook(() => useSidebarOrderPreference());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.patch({ pinnedConversationIds: ['new'] }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(api.getSidebarOrderPreference).toHaveBeenCalledTimes(2));
    await act(async () => resolveWrite(preference({ pinnedConversationIds: ['new'], briefingTopLevelIds: null }, 5)));
    await act(async () => resolveRefresh(preference({ pinnedConversationIds: ['old'], briefingTopLevelIds: null }, 4)));

    expect(result.current.value.pinnedConversationIds).toEqual(['new']);
    act(() => result.current.patch({ briefingTopLevelIds: ['group:one'] }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]?.[1]).toBe(5);
  });
});

describe('sidebar keyboard ownership', () => {
  it('owns arrow keys at list boundaries without changing selection', () => {
    render(<NavigableList />);
    const first = screen.getByRole('button', { name: 'first' });
    first.focus();
    const boundary = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    first.dispatchEvent(boundary);

    expect(boundary.defaultPrevented).toBe(true);
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(first);
  });

  it('captures Command-F and Control-F for the view search, but not from another editable control', () => {
    render(
      <div>
        <textarea aria-label="Document editor" />
        <SearchHeader label="Search artifacts" value="artifact" />
      </div>,
    );
    const input = screen.getByRole('searchbox', { name: 'Search artifacts' }) as HTMLInputElement;
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'artifact'.length]);

    input.blur();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(input);

    const editor = screen.getByRole('textbox', { name: 'Document editor' });
    editor.focus();
    fireEvent.keyDown(editor, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(editor);
  });

  it('lets only a visible header own find, and leaves native find alone when none is visible', () => {
    const view = render(
      <div>
        <section hidden aria-hidden="true">
          <SearchHeader label="Search auth requests" />
        </section>
        <section>
          <SearchHeader label="Filter issues" />
        </section>
      </div>,
    );
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Filter issues' }));
    view.unmount();

    render(
      <section hidden aria-hidden="true">
        <SearchHeader label="Search artifacts" />
      </section>,
    );
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});
