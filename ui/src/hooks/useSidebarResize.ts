import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// Bug: d472f7f — interactive sidebar resize

export type SidebarResizeOptions = {
  /** Initial width in pixels (default: 280) */
  defaultWidth?: number;
  /** Minimum allowed width in pixels (default: 190) */
  minWidth?: number;
  /** Viewport width at or below which CSS should own the sidebar width (default: 700) */
  mobileBreakpoint?: number;
  /** localStorage key to persist width across sessions */
  storageKey?: string;
};

export type SidebarResizeResult = {
  /** Current sidebar width in px, or null on small screens (let CSS media queries take over). */
  width: number | null;
  handleMouseDown: (e: MouseEvent) => void;
  /**
   * Imperatively set the width, clamped to `minWidth`..50% viewport. Drives the
   * same live state + localStorage persistence as a drag, so keyboard resize
   * (Arrow keys) and any programmatic resize stay consistent with mouse drag
   * without synthesizing fake mouse events. Returns the clamped value applied.
   */
  setWidth: (next: number) => number;
};

/**
 * Hook that adds drag-to-resize behaviour to a sidebar.
 *
 * Returns the current `width` (px) and a `handleMouseDown` handler to attach
 * to the drag handle element.  Max width is clamped to 50 % of the viewport
 * dynamically so the drag handle always has room to move.
 *
 * Width is persisted to localStorage via `storageKey` so it survives refresh.
 */
export function useSidebarResize(options: SidebarResizeOptions = {}): SidebarResizeResult {
  const {
    defaultWidth = 280,
    minWidth = 190,
    mobileBreakpoint = 700,
    storageKey,
  } = options;

  const isSmallViewport = useCallback(() => (
    typeof window !== 'undefined' && window.innerWidth <= mobileBreakpoint
  ), [mobileBreakpoint]);

  const [width, setWidthState] = useState<number>(() => {
    if (storageKey && typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!Number.isNaN(parsed) && parsed >= minWidth) {
          return parsed;
        }
      }
    }
    return defaultWidth;
  });
  const [isMobile, setIsMobile] = useState<boolean>(isSmallViewport);

  // Keep a ref so event handlers always see fresh value without re-registering
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const rafId = useRef<number | null>(null);
  const latestWidth = useRef(width);

  useEffect(() => {
    latestWidth.current = width;
  }, [width]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const updateViewportMode = () => {
      setIsMobile(isSmallViewport());
    };

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);
    return () => {
      window.removeEventListener('resize', updateViewportMode);
    };
  }, [isSmallViewport]);

  // Persist on change
  useEffect(() => {
    if (storageKey && typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(storageKey, String(width));
    }
  }, [width, storageKey]);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = latestWidth.current;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        const delta = ev.clientX - startX.current;
        const maxWidth = Math.floor(window.innerWidth * 0.5);
        const next = Math.max(minWidth, Math.min(maxWidth, startWidth.current + delta));
        setWidthState(next);
      });
    };

    const onMouseUp = () => {
      dragging.current = false;
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [minWidth]);

  // Imperative clamped setter for keyboard / programmatic resize. Clamps to the
  // same min..50%-viewport range as the drag handler and updates the same state,
  // so the persist effect on `width` writes localStorage exactly once.
  const setWidth = useCallback((next: number): number => {
    const maxWidth = typeof window !== 'undefined'
      ? Math.floor(window.innerWidth * 0.5)
      : Number.POSITIVE_INFINITY;
    const clamped = Math.max(minWidth, Math.min(maxWidth, Math.round(next)));
    setWidthState(clamped);
    return clamped;
  }, [minWidth]);

  // Bug: d472f7f — on small screens the inline width overrides CSS media queries
  // (e.g. width: 100%). Return null on mobile so the inline style is omitted and
  // CSS takes over. Mobile breakpoint matches the app's @media (max-width: 700px).
  const effectiveWidth = isMobile ? null : width;

  return { width: effectiveWidth, handleMouseDown, setWidth };
}
