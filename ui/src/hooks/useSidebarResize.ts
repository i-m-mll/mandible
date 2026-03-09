import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// Bug: d472f7f — interactive sidebar resize

export type SidebarResizeOptions = {
  /** Initial width in pixels (default: 280) */
  defaultWidth?: number;
  /** Minimum allowed width in pixels (default: 190) */
  minWidth?: number;
  /** localStorage key to persist width across sessions */
  storageKey?: string;
};

export type SidebarResizeResult = {
  width: number;
  handleMouseDown: (e: MouseEvent) => void;
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
    storageKey,
  } = options;

  const [width, setWidth] = useState<number>(() => {
    if (storageKey) {
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

  // Keep a ref so event handlers always see fresh value without re-registering
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const rafId = useRef<number | null>(null);
  const latestWidth = useRef(width);

  useEffect(() => {
    latestWidth.current = width;
  }, [width]);

  // Persist on change
  useEffect(() => {
    if (storageKey) {
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
        setWidth(next);
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

  return { width, handleMouseDown };
}
