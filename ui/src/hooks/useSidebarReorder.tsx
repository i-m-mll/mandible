import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { moveSidebarItem, type SidebarReorderBinding } from '../components/shared/sidebar-order';

const DRAG_THRESHOLD_PX = 6;

type DragState = {
  itemId: string;
  pointerId: number;
  captureTarget: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
  overId: string;
  originOrder: string[];
  order: string[];
};

export function useSidebarReorder({
  ids,
  disabled = false,
  label,
  onCommit,
}: {
  ids: readonly string[];
  disabled?: boolean;
  label(id: string): string;
  onCommit(ids: string[]): void;
}) {
  const tokenRef = useRef(`sidebar-reorder-${Math.random().toString(36).slice(2)}`);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const suppressClickRef = useRef<{ itemId: string; until: number } | null>(null);

  const cancel = useCallback((announce = false) => {
    dragRef.current = null;
    setDrag(null);
    if (announce) setAnnouncement('Reorder cancelled.');
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragRef.current) return;
      event.preventDefault();
      cancel(true);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [cancel]);

  const idsSignature = ids.join('\0');
  useEffect(() => {
    if (disabled || (dragRef.current && dragRef.current.originOrder.join('\0') !== idsSignature)) cancel();
  }, [cancel, disabled, idsSignature]);

  const binding = (itemId: string, { handleOnly = false }: { handleOnly?: boolean } = {}): SidebarReorderBinding | undefined => {
    if (disabled) return undefined;
    const begin = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as Element | null;
      if (!handleOnly) {
        if (target?.closest('[data-sidebar-reorder-id]') !== event.currentTarget) return;
        const interactive = target?.closest<HTMLElement>('button, a, input, textarea, select, [contenteditable], [role="button"]');
        if (interactive && !interactive.matches('.sidebar-item-row__select, .sidebar-group-node__heading')) return;
      }
      // Capture the selection button so a sub-threshold gesture still clicks it.
      const captureTarget = handleOnly ? event.currentTarget
        : target?.closest<HTMLElement>('.sidebar-item-row__select, .sidebar-group-node__heading') ?? event.currentTarget;
      const originOrder = [...ids];
      dragRef.current = {
        itemId,
        pointerId: event.pointerId,
        captureTarget,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        overId: itemId,
        originOrder,
        order: originOrder,
      };
      captureTarget.setPointerCapture?.(event.pointerId);
    };
    const move = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD_PX) return;
      event.preventDefault();
      const list = event.currentTarget.closest<HTMLElement>('[data-sidebar-reorder-list]');
      const rows = Array.from(list?.querySelectorAll<HTMLElement>('[data-sidebar-reorder-id]') ?? [])
        .filter((row) => row.closest('[data-sidebar-reorder-list]') === list);
      const insertionIndex = rows.findIndex((row) => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
      const rawIndex = insertionIndex < 0 ? rows.length : insertionIndex;
      const without = current.originOrder.filter((id) => id !== current.itemId);
      const boundaryId = rows.slice(rawIndex).find(row => row.dataset.sidebarReorderId !== current.itemId)?.dataset.sidebarReorderId;
      const lastVisibleId = rows.filter(row => row.dataset.sidebarReorderId !== current.itemId).at(-1)?.dataset.sidebarReorderId;
      const adjustedIndex = boundaryId
        ? without.indexOf(boundaryId)
        : lastVisibleId ? without.indexOf(lastVisibleId) + 1 : without.length;
      const order = [...without];
      order.splice(Math.max(0, Math.min(without.length, adjustedIndex)), 0, current.itemId);
      const marker = rows[Math.min(rawIndex, rows.length - 1)];
      const targetId = marker?.dataset.sidebarReorderId ?? current.overId;
      const next = {
        ...current,
        active: true,
        overId: targetId,
        order,
      };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      cancel();
      current.captureTarget.releasePointerCapture?.(event.pointerId);
      if (!current.active) return;
      onCommit(current.order);
      suppressClickRef.current = { itemId, until: Date.now() + 500 };
      setAnnouncement(`${label(itemId)} moved to position ${current.order.indexOf(itemId) + 1} of ${current.order.length}.`);
    };
    const cancelPointer = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
      if (dragRef.current?.pointerId === event.pointerId) cancel();
    };
    const keyDown = (event: JSX.TargetedKeyboardEvent<HTMLElement>) => {
      const command = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
        && (event.key === 'ArrowUp' || event.key === 'ArrowDown');
      if (!command) return;
      event.preventDefault();
      const index = ids.indexOf(itemId);
      const target = Math.max(0, Math.min(ids.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
      if (index < 0 || index === target) {
        setAnnouncement(`${label(itemId)} is already at position ${Math.max(index, 0) + 1} of ${ids.length}.`);
        return;
      }
      const next = moveSidebarItem(ids, itemId, ids[target]);
      onCommit(next);
      setAnnouncement(`${label(itemId)} moved to position ${target + 1} of ${ids.length}.`);
    };
    const pointer = { onPointerDown: begin, onPointerMove: move, onPointerUp: finish, onPointerCancel: cancelPointer, onLostPointerCapture: cancelPointer };
    return {
      handleOnly,
      dragging: drag?.active === true && drag.itemId === itemId,
      dropTarget: drag?.active === true && drag.overId === itemId,
      root: {
        'data-sidebar-reorder-id': itemId,
        ...(!handleOnly ? pointer : {}),
        onClickCapture: (event) => {
          const suppressed = suppressClickRef.current;
          const target = event.target as Element;
          if (!handleOnly) {
            const interactive = target.closest('button, a, input, textarea, select, [contenteditable], [role="button"]');
            if (interactive && !interactive.matches('.sidebar-item-row__select, .sidebar-group-node__heading')) return;
          }
          const handleId = (event.target as Element).closest<HTMLElement>('[data-sidebar-reorder-handle]')
            ?.dataset.sidebarReorderHandle;
          if (suppressed?.itemId !== itemId || (handleOnly && handleId !== itemId) || Date.now() > suppressed.until) return;
          suppressClickRef.current = null;
          event.preventDefault();
          event.stopPropagation();
        },
      },
      control: {
        'aria-describedby': `${tokenRef.current}-instructions ${tokenRef.current}-status`,
        'aria-keyshortcuts': 'Control+Shift+ArrowUp Control+Shift+ArrowDown',
        onKeyDown: keyDown,
      },
      handle: {
        'aria-label': `Reorder ${label(itemId)}`,
        'aria-describedby': `${tokenRef.current}-instructions ${tokenRef.current}-status`,
        'aria-keyshortcuts': 'Control+Shift+ArrowUp Control+Shift+ArrowDown',
        'data-sidebar-reorder-handle': itemId,
        onKeyDown: keyDown,
        ...pointer,
      },
    };
  };

  return {
    list: { 'data-sidebar-reorder-list': tokenRef.current },
    binding,
    assistive: (
      <>
        <span id={`${tokenRef.current}-instructions`} className="sr-only">
          Drag to reorder, or press Control Shift Up Arrow or Control Shift Down Arrow.
        </span>
        <span id={`${tokenRef.current}-status`} className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </>
    ),
  };
}
