import type { ComponentChildren, JSX, Ref } from 'preact';
import { useCallback } from 'preact/hooks';
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
   * `children`. When omitted, `children` fill the frame directly unless
   * `scrollBody` opts a headerless sidebar into the shared body scroll owner.
   */
  header?: ComponentChildren;

  /** Optional class added to the shared scroll-owner body wrapper. */
  bodyClassName?: string;

  /** Shared content treatment for form/control sidebars with an even inset. */
  contentLayout?: 'inset-controls';

  /**
   * Wrap headerless content in the shared scroll-owner body. Use this when the
   * resize rail must remain outside the vertical scroll container but the view
   * has no fixed header slot.
   */
  scrollBody?: boolean;

  /** Optional fixed footer slot rendered below the scroll-owner body. */
  footer?: ComponentChildren;

  /** Optional class added to the shared fixed footer wrapper. */
  footerClassName?: string;

  /** Scrollable body content, or direct frame content without a body wrapper. */
  children: ComponentChildren;
};

export function ViewSidebar(props: ViewSidebarProps): JSX.Element | null {
  const { setViewSidebarWidth, viewSidebarWidth } = useAppShell();
  const shellControlled = viewSidebarWidth !== undefined;
  const { width, handleMouseDown, setWidth } = useSidebarResize({
    defaultWidth: props.defaultWidth,
    minWidth: props.minWidth,
    storageKey: props.storageKey,
    controlledWidth: viewSidebarWidth,
    onWidthChange: shellControlled ? setViewSidebarWidth : undefined,
  });

  // Keyboard resize: Left/Right arrows nudge the width through the same clamped
  // setter as mouse drag. The standalone hook persists locally; the app's
  // controlled setter persists the active route's shell-owned value.
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
  const bodyCls = [
    'view-sidebar__body',
    props.contentLayout ? `view-sidebar__body--${props.contentLayout}` : '',
    props.bodyClassName ?? '',
  ].filter(Boolean).join(' ');
  const footerCls = props.footerClassName ? `view-sidebar__footer ${props.footerClassName}` : 'view-sidebar__footer';
  const style = shellControlled
    ? { width: 'var(--app-view-sidebar-width)', flexShrink: 0 }
    : width !== null ? { width: `${width}px`, flexShrink: 0 } : undefined;

  return (
    <Frame
      ref={props.containerRef as Ref<HTMLDivElement> & Ref<HTMLElement>}
      className={cls}
      data-app-surface="sidebar"
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
      {props.header !== undefined || props.scrollBody || props.contentLayout ? (
        <>
          {props.header !== undefined ? (
            <div className="view-sidebar__header">{props.header}</div>
          ) : null}
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
