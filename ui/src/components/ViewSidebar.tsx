import type { ComponentChildren, JSX, Ref } from 'preact';
import { useCallback, useLayoutEffect } from 'preact/hooks';
import { useAppShell } from '../app-shell';
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

  /** Optional class added to the shared scroll-owner body wrapper. */
  bodyClassName?: string;

  /** Optional fixed footer slot rendered below the scroll-owner body. */
  footer?: ComponentChildren;

  /** Optional class added to the shared fixed footer wrapper. */
  footerClassName?: string;

  /** Scrollable body content (or the whole frame content when `header` omitted). */
  children: ComponentChildren;
};

export function ViewSidebar(props: ViewSidebarProps): JSX.Element | null {
  const { active, setViewSidebarWidth } = useAppShell();
  const { width, handleMouseDown, setWidth } = useSidebarResize({
    defaultWidth: props.defaultWidth,
    minWidth: props.minWidth,
    storageKey: props.storageKey,
  });

  // Width stays owned by the existing resize hook. Publish that exact value to
  // the app-shell CSS variable in the layout phase so the header boundary and
  // sidebar boundary move in the same paint (including route restores).
  useLayoutEffect(() => {
    if (!active || props.hidden) return;
    setViewSidebarWidth(width);
  }, [active, props.hidden, setViewSidebarWidth, width]);

  // Keyboard resize: Left/Right arrows nudge the width directly through the
  // hook's clamped `setWidth` (min..50% viewport, persisted to storageKey by
  // the hook's own effect). No synthetic mouse events — keyboard and mouse drag
  // share one width path. Shift = larger step.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? 32 : 8;
    const delta = e.key === 'ArrowLeft' ? -step : step;
    const current = width ?? props.defaultWidth;
    setWidth(current + delta);
  }, [width, props.defaultWidth, setWidth]);

  if (props.hidden) return null;

  const Frame = props.as ?? 'aside';
  const cls = props.className ? `view-sidebar ${props.className}` : 'view-sidebar';
  const bodyCls = props.bodyClassName ? `view-sidebar__body ${props.bodyClassName}` : 'view-sidebar__body';
  const footerCls = props.footerClassName ? `view-sidebar__footer ${props.footerClassName}` : 'view-sidebar__footer';
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
          <div className={bodyCls}>{props.children}</div>
          {props.footer !== undefined ? (
            <div className={footerCls}>{props.footer}</div>
          ) : null}
        </>
      ) : (
        <>
          {props.children}
          {props.footer !== undefined ? (
            <div className={footerCls}>{props.footer}</div>
          ) : null}
        </>
      )}
    </Frame>
  );
}
