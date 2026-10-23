import type { JSX } from 'preact';

export type SidebarReorderBinding = {
  handleOnly: boolean;
  dragging: boolean;
  dropTarget: boolean;
  root: {
    'data-sidebar-reorder-id': string;
    onClickCapture(event: JSX.TargetedMouseEvent<HTMLElement>): void;
    onPointerDown?: SidebarReorderBinding['handle']['onPointerDown'];
    onPointerMove?: SidebarReorderBinding['handle']['onPointerMove'];
    onPointerUp?: SidebarReorderBinding['handle']['onPointerUp'];
    onPointerCancel?: SidebarReorderBinding['handle']['onPointerCancel'];
    onLostPointerCapture?: SidebarReorderBinding['handle']['onLostPointerCapture'];
  };
  control: {
    'aria-describedby': string;
    'aria-keyshortcuts': string;
    onKeyDown(event: JSX.TargetedKeyboardEvent<HTMLElement>): void;
  };
  handle: {
    'aria-label': string;
    'aria-describedby': string;
    'aria-keyshortcuts': string;
    'data-sidebar-reorder-handle': string;
    onKeyDown(event: JSX.TargetedKeyboardEvent<HTMLElement>): void;
    onPointerDown(event: JSX.TargetedPointerEvent<HTMLElement>): void;
    onPointerMove(event: JSX.TargetedPointerEvent<HTMLElement>): void;
    onPointerUp(event: JSX.TargetedPointerEvent<HTMLElement>): void;
    onPointerCancel(event: JSX.TargetedPointerEvent<HTMLElement>): void;
    onLostPointerCapture(event: JSX.TargetedPointerEvent<HTMLElement>): void;
  };
};

/** Keep saved known IDs in user order, then append newly available IDs canonically. */
export function reconcileSidebarOrder(
  availableIds: readonly string[],
  savedIds: readonly string[] | null,
): string[] {
  if (savedIds === null) return [...availableIds];
  const available = new Set(availableIds);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of savedIds) {
    if (!available.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of availableIds) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

export function moveSidebarItem(
  ids: readonly string[],
  itemId: string,
  targetId: string,
): string[] {
  const from = ids.indexOf(itemId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, itemId);
  return next;
}

/** Reorder one visible subset without discarding saved IDs hidden by filters or refresh. */
export function mergeSidebarSubsetOrder(
  savedIds: readonly string[] | null,
  visibleIds: readonly string[],
  reorderedVisibleIds: readonly string[],
): string[] {
  const base = [...(savedIds ?? [])];
  const baseSet = new Set(base);
  for (const id of visibleIds) {
    if (!baseSet.has(id)) {
      baseSet.add(id);
      base.push(id);
    }
  }
  const visible = new Set(visibleIds);
  let index = 0;
  return base.map((id) => visible.has(id) ? reorderedVisibleIds[index++] ?? id : id);
}
