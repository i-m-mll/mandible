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
}: {
  initial?: string[];
  onSelect?: (id: string) => void;
  onAction?: (id: string) => void;
  persistentActions?: boolean;
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

  it('keeps title and action clicks independent from the dedicated pointer handle', () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    render(<ReorderList onSelect={onSelect} onAction={onAction} />);
    const title = screen.getByRole('button', { name: 'Select a' });
    const handle = screen.getByRole('button', { name: 'Reorder A' });
    expect(title.hasAttribute('data-sidebar-reorder-handle')).toBe(false);
    expect(handle.dataset.sidebarReorderHandle).toBe('a');

    fireEvent.pointerDown(title, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(title, { pointerId: 1, clientX: 5, clientY: 100 });
    fireEvent.pointerUp(title, { pointerId: 1 });
    fireEvent.click(title);
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(order()).toEqual(['a', 'b', 'c']);

    fireEvent.click(screen.getByRole('button', { name: 'Action a' }));
    expect(onAction).toHaveBeenCalledWith('a');
  });

  it('keeps the reorder handle hover-only when a neighboring action is persistent', () => {
    render(<ReorderList initial={['a']} persistentActions />);
    const row = screen.getByRole('button', { name: 'Select a' }).closest('.sidebar-item-row')!;
    expect(row.querySelector('.sidebar-item-row__reorder')?.classList.contains('contextual-action-group--persistent'))
      .toBe(false);
    expect(row.querySelector('.sidebar-item-row__actions')?.classList.contains('contextual-action-group--persistent'))
      .toBe(true);
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

    act(() => result.current.binding('a')!.handle.onPointerDown({
      button: 0, pointerId: 7, clientX: 5, clientY: 5, currentTarget: handle,
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    } as never));
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
    act(() => result.current.binding('a')!.handle.onPointerMove({
      pointerId: 7, clientX: 5, clientY: 100, currentTarget: handle, preventDefault: vi.fn(),
    } as never));
    expect(result.current.binding('a')?.dragging).toBe(true);
    act(() => result.current.binding('a')!.handle.onPointerUp({
      pointerId: 7, currentTarget: handle,
    } as never));
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onCommit).toHaveBeenCalledWith(['b', 'c', 'a']);
    const click = { target: handle, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    result.current.binding('a')!.root.onClickCapture(click as never);
    expect(click.preventDefault).toHaveBeenCalled();

    const title = document.createElement('button');
    const titleClick = { target: title, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    result.current.binding('a')!.root.onClickCapture(titleClick as never);
    expect(titleClick.preventDefault).not.toHaveBeenCalled();

    expect(result.current.binding('b')?.root).not.toHaveProperty('onPointerDown');
  });
});
