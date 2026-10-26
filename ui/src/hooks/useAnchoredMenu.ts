import { useAppShell } from '../app-shell';
import type { JSX, RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export type AnchoredMenuPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export type UseAnchoredMenuOptions = {
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  menuRef: RefObject<HTMLElement>;
  focusRef?: RefObject<HTMLElement>;
  onDismiss: () => void;
  placement?: AnchoredMenuPlacement;
  gap?: number;
  gutter?: number;
  anchorInset?: number;
  matchAnchorWidth?: boolean;
};

const HIDDEN_STYLE: JSX.CSSProperties = {
  position: 'fixed',
  zIndex: 'var(--z-anchored-menu)',
  top: 0,
  right: 'auto',
  bottom: 'auto',
  left: 0,
  visibility: 'hidden',
};

/**
 * Positions an anchored menu in the viewport layer while leaving its DOM,
 * focus order, and dismissal ownership with the calling component.
 */
export function useAnchoredMenu({
  open,
  anchorRef,
  menuRef,
  focusRef,
  onDismiss,
  placement = 'bottom-end',
  gap = 6,
  gutter = 8,
  anchorInset = 0,
  matchAnchorWidth = false,
}: UseAnchoredMenuOptions): JSX.CSSProperties | undefined {
  const { active } = useAppShell();
  const [style, setStyle] = useState<JSX.CSSProperties>(HIDDEN_STYLE);
  const positionKeyRef = useRef('');
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    if (!open || !active) return undefined;
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return undefined;
    const topLayerMenu = menu as HTMLElement & {
      showPopover?: () => void;
      hidePopover?: () => void;
    };
    try {
      topLayerMenu.showPopover?.();
    } catch {
      // A concurrently closing menu may already have left the top layer.
    }

    const position = () => {
      const anchorBounds = anchor.getBoundingClientRect();
      const intendedWidth = matchAnchorWidth
        ? Math.max(0, anchorBounds.width - (anchorInset * 2))
        : undefined;
      if (intendedWidth !== undefined) menu.style.width = `${intendedWidth}px`;
      const menuBounds = menu.getBoundingClientRect();
      const width = intendedWidth ?? menuBounds.width;
      const height = menuBounds.height;
      const viewportRight = window.innerWidth - gutter;
      const viewportBottom = window.innerHeight - gutter;
      const anchorLeft = anchorBounds.left + anchorInset;
      const anchorRight = anchorBounds.right - anchorInset;
      const preferredLeft = placement.endsWith('end')
        ? anchorRight - width
        : anchorLeft;
      const left = Math.min(Math.max(gutter, preferredLeft), Math.max(gutter, viewportRight - width));
      const belowTop = anchorBounds.bottom + gap;
      const aboveBottom = anchorBounds.top - gap;
      const availableBelow = Math.max(0, viewportBottom - belowTop);
      const availableAbove = Math.max(0, aboveBottom - gutter);
      const preferTop = placement.startsWith('top');
      const placeAbove = preferTop
        ? height <= availableAbove || availableAbove >= availableBelow
        : !(height <= availableBelow || availableBelow >= availableAbove);
      const maxHeight = Math.max(0, placeAbove ? availableAbove : availableBelow);
      const top = placeAbove
        ? Math.max(gutter, aboveBottom - Math.min(height, maxHeight))
        : belowTop;

      const nextStyle: JSX.CSSProperties = {
        position: 'fixed',
        zIndex: 'var(--z-anchored-menu)',
        top,
        right: 'auto',
        bottom: 'auto',
        left,
        width: intendedWidth,
        maxHeight,
        overflowY: height > maxHeight ? 'auto' : undefined,
        visibility: 'visible',
      };
      const positionKey = JSON.stringify(nextStyle);
      if (positionKey !== positionKeyRef.current) {
        positionKeyRef.current = positionKey;
        setStyle(nextStyle);
      }
    };

    position();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(position);
    resizeObserver?.observe(anchor);
    resizeObserver?.observe(menu);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || anchor.contains(target) || menu.contains(target)) return;
      dismissRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A nested popover owns Escape before its containing menu does.
      const focusedMenu = (event.target as Element | null)?.closest?.('.app-anchored-menu');
      if (focusedMenu && focusedMenu !== menu && menu.contains(focusedMenu)) return;
      event.preventDefault();
      dismissRef.current();
      (focusRef?.current ?? anchor).focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      try {
        topLayerMenu.hidePopover?.();
      } catch {
        // Removal from the DOM also dismisses a top-layer popover.
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [active, anchorInset, anchorRef, focusRef, gap, gutter, matchAnchorWidth, menuRef, open, placement]);

  return open && active ? style : undefined;
}
