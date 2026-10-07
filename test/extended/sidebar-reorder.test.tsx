import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/preact';
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidebarItemRow } from '../../ui/src/components/shared/SidebarItemRow';
import {
  mergeSidebarSubsetOrder,
  reconcileSidebarOrder,
} from '../../ui/src/components/shared/sidebar-order';
import { useSidebarReorder } from '../../ui/src/hooks/useSidebarReorder';

afterEach(cleanup);

function ReorderList({
  initial = ['a', 'b', 'c'],
  onSelect = vi.fn(),
  onAction = vi.fn(),
  persistentActions = false,
  handleOnly = false,
}: {
  initial?: string[];
  onSelect?: (id: string) => void;
  onAction?: (id: string) => void;
  persistentActions?: boolean;
  handleOnly?: boolean;
}) {
  const [ids, setIds] = useState(initial);
  const reorder = useSidebarReorder({ ids, label: (id) => id.toUpperCase(), onCommit: setIds });
  return (
    <div data-testid="list" {...reorder.list}>
      {reorder.assistive}
      {ids.map((id) => (
        <SidebarItemRow
          key={id}
          label={id.toUpperCase()}
          selectionLabel={`Select ${id}`}
          trailingReveal={persistentActions ? 'persistent-pin' : 'interaction'}
          onSelect={() => onSelect(id)}
          actions={<button type="button" aria-label={`Action ${id}`} onClick={() => onAction(id)}>act</button>}
          reorder={reorder.binding(id, { handleOnly })}
        />
      ))}
    </div>
  );
}

function order(): string[] {
  return Array.from(screen.getByTestId('list').querySelectorAll<HTMLElement>('[data-sidebar-reorder-id]'))
    .map((row) => row.dataset.sidebarReorderId!);
}

describe('shared sidebar reorder', () => {
  it('reconciles newly available IDs and preserves hidden IDs while moving a visible subset', () => {
    expect(reconcileSidebarOrder(['a', 'b', 'c'], ['c', 'missing', 'a'])).toEqual(['c', 'a', 'b']);
    expect(mergeSidebarSubsetOrder(['a', 'hidden', 'b', 'c'], ['a', 'b', 'c'], ['c', 'a', 'b']))
      .toEqual(['c', 'hidden', 'a', 'b']);
  });

  it('moves with the keyboard while clamping the first and last positions', () => {
    render(<ReorderList />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Select a' }), {
      key: 'ArrowUp', ctrlKey: true, shiftKey: true,
    });
    expect(order()).toEqual(['a', 'b', 'c']);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Select a' }), {
      key: 'ArrowDown', ctrlKey: true, shiftKey: true,
    });
    expect(order()).toEqual(['b', 'a', 'c']);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Select c' }), {
      key: 'ArrowDown', ctrlKey: true, shiftKey: true,
    });
    expect(order()).toEqual(['b', 'a', 'c']);
  });

  it('keeps ordinary selection and action buttons independent without adding a handle', () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    render(<ReorderList onSelect={onSelect} onAction={onAction} />);
    expect(screen.queryByRole('button', { name: 'Reorder A' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Action a' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a');
    expect(onAction).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('applies the row threshold and post-drop suppression while ignoring action and nested-row origins', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useSidebarReorder({ ids: ['a', 'b', 'c'], label: id => id, onCommit }));
    const list = document.createElement('div');
    list.dataset.sidebarReorderList = 'test';
    const rows = ['a', 'b', 'c'].map((id, index) => {
      const row = document.createElement('div');
      row.dataset.sidebarReorderId = id;
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: index * 30, height: 30 } as DOMRect);
      list.append(row);
      return row;
    });
    const title = document.createElement('button');
    title.className = 'sidebar-item-row__select';
    title.setPointerCapture = vi.fn();
    title.releasePointerCapture = vi.fn();
    rows[0].append(title);
    const pointer = (target: HTMLElement, y: number) => ({ target, currentTarget: rows[0],
      button: 0, pointerId: 7, clientX: 5, clientY: y, preventDefault: vi.fn() });
    act(() => result.current.binding('a')!.root.onPointerDown!(pointer(title, 5) as never));
    expect(title.setPointerCapture).toHaveBeenCalledWith(7);
    act(() => result.current.binding('a')!.root.onPointerMove!(pointer(title, 9) as never));
    act(() => result.current.binding('a')!.root.onPointerUp!(pointer(title, 9) as never));
    expect(onCommit).not.toHaveBeenCalled();
    const click = { target: title, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    result.current.binding('a')!.root.onClickCapture(click as never);
    expect(click.preventDefault).not.toHaveBeenCalled();
    act(() => result.current.binding('a')!.root.onPointerDown!(pointer(title, 5) as never));
    act(() => result.current.binding('a')!.root.onPointerMove!(pointer(title, 100) as never));
    act(() => result.current.binding('a')!.root.onPointerUp!(pointer(title, 100) as never));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a']);
    result.current.binding('a')!.root.onClickCapture(click as never);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(title.releasePointerCapture).toHaveBeenCalledWith(7);
    const action = document.createElement('button');
    rows[0].append(action);
    const nested = document.createElement('div');
    nested.dataset.sidebarReorderId = 'nested';
    rows[0].append(nested);
    for (const origin of [action, nested]) {
      act(() => result.current.binding('a')!.root.onPointerDown!(pointer(origin, 5) as never));
      act(() => result.current.binding('a')!.root.onPointerMove!(pointer(origin, 100) as never));
      act(() => result.current.binding('a')!.root.onPointerUp!(pointer(origin, 100) as never));
    }
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Moving within the dragged row, or past the last row when already last,
    // must not treat the removed row as a missing insertion boundary.
    for (const [id, rowIndex, fromY, toY] of [['b', 1, 32, 40], ['c', 2, 65, 100]] as const) {
      const heading = document.createElement('button');
      heading.className = 'sidebar-item-row__select';
      rows[rowIndex].append(heading);
      const event = (y: number) => ({ ...pointer(heading, y), currentTarget: rows[rowIndex] });
      act(() => result.current.binding(id)!.root.onPointerDown!(event(fromY) as never));
      act(() => result.current.binding(id)!.root.onPointerMove!(event(toY) as never));
      act(() => result.current.binding(id)!.root.onPointerUp!(event(toY) as never));
      expect(onCommit).toHaveBeenLastCalledWith(['a', 'b', 'c']);
    }

  });

  it('keeps explicit handle-only rows inspectable and keyboard reorderable', () => {
    const onSelect = vi.fn();
    render(<ReorderList handleOnly onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select a' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a');
    expect(screen.getByRole('button', { name: 'Reorder A' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder A' }), {
      key: 'ArrowDown', ctrlKey: true, shiftKey: true,
    });
    expect(order()).toEqual(['b', 'a', 'c']);
  });

  it('moves only from the pointer handle and suppresses its post-drop click', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useSidebarReorder({
      ids: ['a', 'b', 'c'], label: (id) => id.toUpperCase(), onCommit,
    }));
    const rows = ['a', 'b', 'c'].map((id, index) => {
      const row = document.createElement('div');
      row.dataset.sidebarReorderId = id;
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: index * 30, top: index * 30, left: 0, right: 200, bottom: index * 30 + 30,
        width: 200, height: 30, toJSON: () => ({}),
      });
      return row;
    });
    const list = document.createElement('div');
    vi.spyOn(list, 'querySelectorAll').mockReturnValue(rows as unknown as NodeListOf<Element>);
    const handle = document.createElement('button');
    handle.dataset.sidebarReorderHandle = 'a';
    vi.spyOn(handle, 'closest').mockImplementation((selector) => (
      selector === '[data-sidebar-reorder-handle]' ? handle : list
    ));
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    act(() => result.current.binding('a', { handleOnly: true })!.handle.onPointerDown({
      button: 0, pointerId: 7, clientX: 5, clientY: 5, currentTarget: handle,
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    } as never));
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
    act(() => result.current.binding('a', { handleOnly: true })!.handle.onPointerMove({
      pointerId: 7, clientX: 5, clientY: 100, currentTarget: handle, preventDefault: vi.fn(),
    } as never));
    expect(result.current.binding('a', { handleOnly: true })?.dragging).toBe(true);
    act(() => result.current.binding('a', { handleOnly: true })!.handle.onPointerUp({
      pointerId: 7, currentTarget: handle,
    } as never));
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onCommit).toHaveBeenCalledWith(['b', 'c', 'a']);
    const click = { target: handle, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    result.current.binding('a', { handleOnly: true })!.root.onClickCapture(click as never);
    expect(click.preventDefault).toHaveBeenCalled();

    const title = document.createElement('button');
    const titleClick = { target: title, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    result.current.binding('a', { handleOnly: true })!.root.onClickCapture(titleClick as never);
    expect(titleClick.preventDefault).not.toHaveBeenCalled();

    expect(result.current.binding('b', { handleOnly: true })?.root).not.toHaveProperty('onPointerDown');
  });
});
