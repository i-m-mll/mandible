import type { ComponentChildren, JSX, Ref } from 'preact';
import { useCallback } from 'preact/hooks';
import { useSidebarResize } from '../hooks/useSidebarResize';

// Shared view-sidebar container (issue e29a8c5). Owns the frame element, the
// resize handle + useSidebarResize call, the inline width style, the hidden
// contract, and the shared `.view-sidebar` class. Views supply only their
// content and a per-view storage key + dimensions + an optional content
// className. See docs/view-sidebar-design-e29a8c5.md.

export type ViewSidebarProps = {
  /**
   * Per-view localStorage key for width persistence. REQUIRED and must equal the
   * view's existing key so widths do not reset on migration (Dataful UX state).
   */
  storageKey: string;

  /** Width defaults — preserve each view's current values exactly. */
  defaultWidth: number;
  minWidth: number;

  /**
   * When true the sidebar is removed from layout. The container owns the hidden
   * contract: it renders nothing (returns null) AND drops the resize handle, so
   * a hidden sidebar can never leave an orphaned drag strip.
   */
  hidden?: boolean;

  /** Accessible name for the rail. e.g. "Graph controls", "Issues". */
  ariaLabel: string;

  /**
   * Frame tag. Defaults to 'aside' (semantically correct for a complementary
   * controls rail). Issues/Spaces historically used <div>; passing 'div' keeps
   * byte-identical DOM for those two if any selector or test depends on it.
   */
  as?: 'aside' | 'div';

  /**
   * Optional view-specific class added ALONGSIDE the shared `.view-sidebar`
   * class, for content-level tweaks only (NOT for container/resize/position).
   */
  className?: string;

  /**
   * Optional ref forwarded to the frame element. Spaces' outside-click handler
   * needs `containerRef.current.contains(...)` against the whole sidebar.
   */
  containerRef?: Ref<HTMLElement>;

  /**
   * Optional fixed (non-scrolling) header slot. When provided, the container
   * renders it as `.view-sidebar__header` (flex:0 0 auto) above a
   * `.view-sidebar__body` (flex:1; min-height:0; overflow-y:auto) wrapping
   * `children`. When omitted, `children` fill the frame directly and the frame
   * itself is the single scroll owner.
   */
  header?: ComponentChildren;

  /** Scrollable body content (or the whole frame content when `header` omitted). */
  children: ComponentChildren;
};

export function ViewSidebar(props: ViewSidebarProps): JSX.Element | null {
  const { width, handleMouseDown } = useSidebarResize({
    defaultWidth: props.defaultWidth,
    minWidth: props.minWidth,
    storageKey: props.storageKey,
  });

  // Keyboard resize: Left/Right arrows nudge the width by the same hook math
  // (clamp to min..50% viewport). Re-uses handleMouseDown by synthesizing the
  // drag math here so mouse + keyboard stay consistent.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? 32 : 8;
    const delta = e.key === 'ArrowLeft' ? -step : step;
    const max = typeof window !== 'undefined' ? Math.floor(window.innerWidth * 0.5) : Infinity;
    const current = width ?? props.defaultWidth;
    const next = Math.max(props.minWidth, Math.min(max, current + delta));
    if (props.storageKey && typeof localStorage !== 'undefined') {
      // Persist immediately; useSidebarResize re-reads storageKey on mount but
      // also tracks live state, so dispatch a synthetic resize to re-sync state.
      try { localStorage.setItem(props.storageKey, String(next)); } catch { /* ignore */ }
    }
    // Drive the live width through the hook by simulating a 1px-equivalent drag
    // from the current width to `next`. We do this with a fake mousedown +
    // mousemove + mouseup sequence on the document.
    if (typeof document !== 'undefined') {
      const down = new MouseEvent('mousedown', { bubbles: true, clientX: 0 });
      handleMouseDown(down);
      const move = new MouseEvent('mousemove', { bubbles: true, clientX: next - current });
      document.dispatchEvent(move);
      const up = new MouseEvent('mouseup', { bubbles: true });
      document.dispatchEvent(up);
    }
  }, [width, props.defaultWidth, props.minWidth, props.storageKey, handleMouseDown]);

  if (props.hidden) return null;

  const Frame = props.as ?? 'aside';
  const cls = props.className ? `view-sidebar ${props.className}` : 'view-sidebar';
  const style = width !== null ? { width: `${width}px`, flexShrink: 0 } : undefined;

  return (
    <Frame
      ref={props.containerRef as Ref<HTMLDivElement> & Ref<HTMLElement>}
      className={cls}
      aria-label={props.ariaLabel}
      style={style}
    >
      {/* Handle is the FIRST child and absolutely positioned on the right edge
          (via `.view-sidebar__resize-handle`), so it never participates in flex
          layout and never orphans when hidden. */}
      <div
        className="sidebar-drag-handle view-sidebar__resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${props.ariaLabel} sidebar`}
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
      />
      {props.header !== undefined ? (
        <>
          <div className="view-sidebar__header">{props.header}</div>
          <div className="view-sidebar__body">{props.children}</div>
        </>
      ) : (
        props.children
      )}
    </Frame>
  );
}
