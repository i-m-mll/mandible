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
}: {
  initial?: string[];
  onSelect?: (id: string) => void;
  onAction?: (id: string) => void;
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

  it('moves by pointer, suppresses the post-drop click, and excludes action controls', () => {
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
    const root = document.createElement('div');
    vi.spyOn(root, 'closest').mockReturnValue(list);
    const control = document.createElement('button');
    control.dataset.sidebarReorderControl = 'a';
    const action = document.createElement('button');

    act(() => result.current.binding('a')!.root.onPointerDown({
      button: 0, pointerId: 7, clientX: 5, clientY: 5, target: control, currentTarget: root,
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    } as never));
    act(() => result.current.binding('a')!.root.onPointerMove({
      pointerId: 7, clientX: 5, clientY: 100, currentTarget: root, preventDefault: vi.fn(),
    } as never));
    expect(result.current.binding('a')?.dragging).toBe(true);
    act(() => result.current.binding('a')!.root.onPointerUp({
      pointerId: 7, currentTarget: root,
    } as never));
    expect(onCommit).toHaveBeenCalledWith(['b', 'c', 'a']);
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    result.current.binding('a')!.root.onClickCapture(click as never);
    expect(click.preventDefault).toHaveBeenCalled();

    result.current.binding('b')!.root.onPointerDown({
      button: 0, pointerId: 8, clientX: 5, clientY: 5, target: action, currentTarget: root,
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    } as never);
    result.current.binding('b')!.root.onPointerMove({
      pointerId: 8, clientX: 5, clientY: 100, currentTarget: root, preventDefault: vi.fn(),
    } as never);
    result.current.binding('b')!.root.onPointerUp({ pointerId: 8, currentTarget: root } as never);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
