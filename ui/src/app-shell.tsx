import { createContext, type ComponentChildren, type Ref } from 'preact';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { IconTabList } from './components/shared/IconTabList';

type AppRightSidebarCommon = {
  id: string;
  ariaLabel: string;
  open: boolean;
  width: number;
  minWidth?: number;
  maxWidth?: number;
  /** The owning view renders the closed-state toggle in its canonical header. */
  togglePlacement?: 'app-overlay' | 'detail-header';
  onOpenChange(open: boolean): void;
  onWidthChange(width: number): void;
};

export type AppRightSidebarLayout = {
  presentation: 'dock';
  effectiveWidth: number;
  minWidth: number;
  maxWidth: number;
};

export const APP_RIGHT_SIDEBAR_DEFAULT_MIN_WIDTH = 300;
export const APP_RIGHT_SIDEBAR_DEFAULT_MAX_WIDTH = 720;
export const CHAT_DETAIL_PREVIEW_MIN_WIDTH = 360;
export const RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH = 1100;
export const VIEW_SIDEBAR_AUTO_COLLAPSE_WIDTH = 700;

export type ResponsiveSidebarThresholdState = {
  rightNarrow: boolean;
  viewNarrow: boolean;
};

export type ResponsiveSidebarThresholdTransition = {
  state: ResponsiveSidebarThresholdState;
  closeRight: boolean;
  closeView: boolean;
};

export const WIDE_RESPONSIVE_SIDEBAR_STATE: ResponsiveSidebarThresholdState = {
  rightNarrow: false,
  viewNarrow: false,
};

export function responsiveSidebarThresholdTransition(
  previous: ResponsiveSidebarThresholdState,
  viewportWidth: number,
  available: { right: boolean; view: boolean } = { right: true, view: true },
): ResponsiveSidebarThresholdTransition {
  const belowRightThreshold = viewportWidth < RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH;
  const belowViewThreshold = viewportWidth < VIEW_SIDEBAR_AUTO_COLLAPSE_WIDTH;
  const rightNarrow = belowRightThreshold
    ? available.right || previous.rightNarrow
    : false;
  const viewNarrow = belowViewThreshold
    ? available.view || previous.viewNarrow
    : false;
  return {
    state: { rightNarrow, viewNarrow },
    closeRight: belowRightThreshold && available.right && !previous.rightNarrow,
    closeView: belowViewThreshold && available.view && !previous.viewNarrow,
  };
}

export type AppRightSidebarDescriptor = AppRightSidebarCommon & (
  | { kind: 'panel'; title: string; icon?: ComponentChildren; content: ComponentChildren }
  | {
      kind: 'tabs';
      tabs: readonly {
        id: string;
        label: string;
        tooltip: string;
        icon: ComponentChildren;
        content: ComponentChildren;
        /** Detail content owns vertical scrolling; tabs and nested header remain anchored. */
        scrollOwner?: 'sidebar' | 'detail';
      }[];
      activeTab: string;
      onActiveTabChange(tab: string): void;
    }
);

export type AppShellContextValue = {
  rightSidebar: AppRightSidebarDescriptor | null;
  registerRightSidebar(ownerId: string): () => void;
  updateRightSidebar(ownerId: string, descriptor: AppRightSidebarDescriptor): void;
  registerInitialRouteLoad(promise: Promise<unknown>): void;
  setRightSidebarOpen?(open: boolean): void;
  setViewSidebarWidth(width: number | null): void;
  viewSidebarWidth?: number | null;
  active: boolean;
  /** The sole app-owned location for operational notices. */
  noticeHost?: HTMLElement | null;
  /** Register an active main detail pane as the operational notice outlet. */
  registerMainNoticeHost?(host: HTMLElement): () => void;
};

const noopContext: AppShellContextValue = {
  rightSidebar: null,
  registerRightSidebar: () => () => undefined,
  updateRightSidebar: () => undefined,
  registerInitialRouteLoad: () => undefined,
  setRightSidebarOpen: () => undefined,
  setViewSidebarWidth: () => undefined,
  active: true,
};

const AppShellContext = createContext<AppShellContextValue>(noopContext);
const noopUpdateRightSidebar = () => undefined;

export function AppShellProvider({ value, children }: { value: AppShellContextValue; children: ComponentChildren }): JSX.Element {
  const parent = useContext(AppShellContext);
  return <AppShellContext.Provider value={{
    ...value,
    noticeHost: value.noticeHost === undefined ? parent.noticeHost : value.noticeHost,
    registerMainNoticeHost: value.registerMainNoticeHost ?? parent.registerMainNoticeHost,
  }}>{children}</AppShellContext.Provider>;
}

export function useAppShell(): AppShellContextValue {
  return useContext(AppShellContext);
}

function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/**
 * True while this view is active: its tab is the current route and the document is visible.
 * A view holds live data (polling, SSE-driven refetches, on-demand loads) only while active,
 * and reloads once each time it becomes active again (see `useRouteLoad`).
 */
export function useViewActive(): boolean {
  const { active } = useAppShell();
  const [visible, setVisible] = useState(documentVisible);
  useEffect(() => {
    const update = () => setVisible(documentVisible());
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return active && visible;
}

/** Counts this view's activations (inactive to active); unchanged while it is active or inactive. */
function useViewActivation(active: boolean): number {
  const activations = useRef(0);
  const wasActive = useRef(active);
  if (active && !wasActive.current) activations.current += 1;
  wasActive.current = active;
  return activations.current;
}

/**
 * Register this mounted view's one bounded initial read with the app warmup barrier.
 * For reads that are already gated on `useViewActive`, such as an enabled query's function;
 * a view's own load effect uses `useRouteLoad`, which registers through this.
 */
export function useRegisterInitialRouteLoad(): (promise: Promise<unknown>) => void {
  const { active, registerInitialRouteLoad } = useAppShell();
  const activeRef = useRef(active);
  const registerInitialRouteLoadRef = useRef(registerInitialRouteLoad);
  activeRef.current = active;
  registerInitialRouteLoadRef.current = registerInitialRouteLoad;
  const registered = useRef(false);
  return useCallback((promise: Promise<unknown>) => {
    if (!activeRef.current || registered.current) return;
    registered.current = true;
    registerInitialRouteLoadRef.current(promise);
  }, []);
}

/**
 * A view's load effect, run only while the view is active (`useViewActive`): when it becomes
 * active (on mount, or later if mounted inactive), when `deps` change while it is active, and
 * once on each later activation. It never runs while the view is inactive; a `deps` change
 * then waits for activation. `register` hands the load's promise to the app warmup barrier.
 */
export function useRouteLoad(
  load: (register: (promise: Promise<unknown>) => void) => void | (() => void),
  deps: readonly unknown[],
): void {
  const active = useViewActive();
  const activation = useViewActivation(active);
  const register = useRegisterInitialRouteLoad();
  const activeRef = useRef(active);
  activeRef.current = active;
  const loadRef = useRef(load);
  loadRef.current = load;
  useLayoutEffect(() => (activeRef.current ? loadRef.current(register) : undefined), [activation, ...deps]);
}

/**
 * Live updates for an active view: runs `refresh` every `intervalMs` (when given) and on each
 * call of the returned signal, only while the view is active. Signals while inactive are
 * dropped, because activation reloads the view through `useRouteLoad`.
 */
export function useLiveRefresh(refresh: () => void, intervalMs?: number): () => void {
  const active = useViewActive();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!active || intervalMs === undefined) return undefined;
    const timer = window.setInterval(() => refreshRef.current(), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return useCallback(() => {
    if (activeRef.current) refreshRef.current();
  }, []);
}

/** One structural target for the shared DetailPaneNotice portal. */
export function AppOperationalNoticeOutlet({
  className = 'app-operational-notice-slot',
  detailPaneSlot = false,
  registerAsMain,
  testId,
  children,
}: {
  className?: string;
  detailPaneSlot?: boolean;
  /** Main-view registration is explicit so embedded surfaces cannot claim it by default. */
  registerAsMain: boolean;
  testId?: string;
  children?: ComponentChildren;
}): JSX.Element {
  const { active, registerMainNoticeHost } = useAppShell();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [registeredAsMain, setRegisteredAsMain] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const setHostNode = useCallback((node: HTMLDivElement | null) => {
    if (hostRef.current === node) return;
    hostRef.current = node;
    setHost(node);
  }, []);

  useLayoutEffect(() => {
    if (!active || !registerAsMain || !host || !registerMainNoticeHost) {
      setRegisteredAsMain(false);
      return undefined;
    }
    const ownerShell = host.closest('.detail-pane-shell');
    const nestedInDetailPane = Boolean(ownerShell?.parentElement?.closest('.detail-pane-shell'));
    const forbiddenSurface = host.closest('#app-right-sidebar, .view-sidebar, [hidden]');
    if (nestedInDetailPane || forbiddenSurface) {
      setRegisteredAsMain(false);
      return undefined;
    }
    const unregister = registerMainNoticeHost(host);
    setRegisteredAsMain(true);
    return unregister;
  }, [active, host, registerAsMain, registerMainNoticeHost]);

  return (
    <div
      className={className}
      data-app-operational-notice-outlet={active && registeredAsMain ? 'main' : undefined}
      data-detail-pane-slot={detailPaneSlot ? 'notice' : undefined}
      data-testid={testId}
      ref={setHostNode}
    >
      {children}
    </div>
  );
}

export function useRegisterAppRightSidebar(descriptor: AppRightSidebarDescriptor | null): void {
  const { active, registerRightSidebar, updateRightSidebar: updateSidebar } = useAppShell();
  const updateRightSidebar = updateSidebar ?? noopUpdateRightSidebar;
  const descriptorRef = useRef(descriptor);
  descriptorRef.current = descriptor;
  const ownerId = descriptor?.id ?? null;
  useLayoutEffect(() => {
    if (!active || !ownerId) return undefined;
    const unregister = registerRightSidebar(ownerId);
    const current = descriptorRef.current;
    if (current?.id === ownerId) updateRightSidebar(ownerId, current);
    return unregister;
  }, [active, ownerId, registerRightSidebar, updateRightSidebar]);
  useLayoutEffect(() => {
    if (!active || !descriptor) return;
    updateRightSidebar(descriptor.id, descriptor);
  }, [active, descriptor, updateRightSidebar]);
}

export function RightSidebarIcon({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  );
}

export function appRightSidebarWidthBounds(
  minWidth: number | undefined,
  maxWidth: number | undefined,
  viewportWidth: number,
): { min: number; max: number } {
  const min = minWidth ?? APP_RIGHT_SIDEBAR_DEFAULT_MIN_WIDTH;
  const configuredMax = maxWidth ?? APP_RIGHT_SIDEBAR_DEFAULT_MAX_WIDTH;
  return { min, max: Math.max(min, Math.min(configuredMax, Math.floor(viewportWidth * 0.6))) };
}

export function resolveAppRightSidebarLayout(
  descriptor: Pick<AppRightSidebarCommon, 'width' | 'minWidth' | 'maxWidth'>,
  viewportWidth: number,
): AppRightSidebarLayout {
  const bounds = appRightSidebarWidthBounds(descriptor.minWidth, descriptor.maxWidth, viewportWidth);
  return {
    presentation: 'dock',
    effectiveWidth: Math.max(bounds.min, Math.min(bounds.max, descriptor.width)),
    minWidth: bounds.min,
    maxWidth: bounds.max,
  };
}

export function AppRightSidebarToggleButton({
  descriptor,
  buttonRef,
  open,
  onOpenChange,
  className = '',
}: {
  descriptor: AppRightSidebarDescriptor;
  buttonRef?: Ref<HTMLButtonElement>;
  open: boolean;
  onOpenChange(open: boolean): void;
  className?: string;
}): JSX.Element {
  const label = `${open ? 'Hide' : 'Show'} ${descriptor.ariaLabel}`;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`app-right-sidebar-toggle${className ? ` ${className}` : ''}`}
      aria-label={label}
      aria-controls="app-right-sidebar"
      aria-pressed={open}
      title={label}
      onClick={() => onOpenChange(!open)}
    >
      <RightSidebarIcon />
    </button>
  );
}

export function AppRightSidebarSurface({
  descriptor,
  toggleRef,
  onOpenChange,
  layout,
  open = true,
}: {
  descriptor: AppRightSidebarDescriptor;
  toggleRef?: Ref<HTMLButtonElement>;
  onOpenChange(open: boolean): void;
  layout?: AppRightSidebarLayout;
  open?: boolean;
}): JSX.Element {
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const resolvedLayout = layout ?? resolveAppRightSidebarLayout(descriptor, viewportWidth);
  const bounds = { min: resolvedLayout.minWidth, max: resolvedLayout.maxWidth };
  const detailOwnsScroll = descriptor.kind === 'tabs'
    && descriptor.tabs.find((tab) => tab.id === descriptor.activeTab)?.scrollOwner === 'detail';
  const startResize = useCallback((event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: resolvedLayout.effectiveWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [resolvedLayout.effectiveWidth]);
  const moveResize = useCallback((event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = drag.startWidth + drag.startX - event.clientX;
    descriptor.onWidthChange(Math.max(bounds.min, Math.min(bounds.max, next)));
  }, [bounds.max, bounds.min, descriptor]);
  const stopResize = useCallback((event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);
  const resizeByKeyboard = useCallback((event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home'
      ? bounds.min
      : event.key === 'End'
        ? bounds.max
        : resolvedLayout.effectiveWidth + (event.key === 'ArrowLeft' ? 16 : -16);
    descriptor.onWidthChange(Math.max(bounds.min, Math.min(bounds.max, next)));
  }, [bounds.max, bounds.min, descriptor, resolvedLayout.effectiveWidth]);
  return (
    <aside
      id="app-right-sidebar"
      className={`app-right-sidebar app-right-sidebar--${resolvedLayout.presentation}${detailOwnsScroll ? ' app-right-sidebar--detail-scroll' : ''}`}
      aria-label={descriptor.ariaLabel}
      hidden={!open}
      data-presentation={resolvedLayout.presentation}
      style={{ '--app-right-sidebar-effective-width': `${resolvedLayout.effectiveWidth}px` } as JSX.CSSProperties}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onOpenChange(false);
      }}
    >
      <div
        className="app-right-sidebar__resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={`Resize ${descriptor.ariaLabel}`}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={resolvedLayout.effectiveWidth}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onKeyDown={resizeByKeyboard}
      />
      <header className="app-right-sidebar__header">
        {descriptor.kind === 'panel' ? (
          descriptor.icon ? (
            <span className="app-right-sidebar__panel-icon" aria-hidden="true" title={descriptor.title}>
              {descriptor.icon}
            </span>
          ) : <h2>{descriptor.title}</h2>
        ) : (
          <IconTabList
            ariaLabel={descriptor.ariaLabel}
            tabs={descriptor.tabs}
            activeTab={descriptor.activeTab}
            onActiveTabChange={descriptor.onActiveTabChange}
            idPrefix="app-right-sidebar"
            className="app-right-sidebar__tabs"
          />
        )}
        {open ? (
          <AppRightSidebarToggleButton
            descriptor={descriptor}
            buttonRef={toggleRef}
            open
            onOpenChange={onOpenChange}
            className="app-right-sidebar__toggle"
          />
        ) : null}
      </header>
      <div className="app-right-sidebar__body">
        {descriptor.kind === 'panel' ? descriptor.content : descriptor.tabs.map((tab) => (
          <div key={tab.id} id={`app-right-sidebar-panel-${tab.id}`} role="tabpanel" aria-labelledby={`app-right-sidebar-tab-${tab.id}`} hidden={descriptor.activeTab !== tab.id}>
            {tab.content}
          </div>
        ))}
      </div>
    </aside>
  );
}

export function ViewSidebarIcon({ open, size = 18 }: { open: boolean; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {open ? <path d="M9 4v16" /> : null}
      <path d={open ? 'M12 12h5' : 'M8 12h8'} />
      <path d={open ? 'm14.5 9.5 2.5 2.5-2.5 2.5' : 'm10.5 9.5-2.5 2.5 2.5 2.5'} />
    </svg>
  );
}
