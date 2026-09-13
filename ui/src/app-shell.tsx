import { createContext, type ComponentChildren, type Ref } from 'preact';
import { useCallback, useContext, useLayoutEffect, useRef } from 'preact/hooks';
import { IconTabList } from './components/shared/IconTabList';

type AppRightSidebarCommon = {
  id: string;
  ariaLabel: string;
  open: boolean;
  width: number;
  minWidth?: number;
  maxWidth?: number;
  /** Smallest width at which the owning main view remains usable beside the panel. */
  mainMinWidth?: number;
  /** The owning view renders the closed-state toggle in its canonical header. */
  togglePlacement?: 'app-overlay' | 'detail-header';
  onOpenChange(open: boolean): void;
  onWidthChange(width: number): void;
};

export type AppRightSidebarPresentation = 'dock' | 'overlay-drawer';

export type AppRightSidebarLayout = {
  presentation: AppRightSidebarPresentation;
  effectiveWidth: number;
  minWidth: number;
  maxWidth: number;
};

export const APP_RIGHT_SIDEBAR_DEFAULT_MIN_WIDTH = 300;
export const APP_RIGHT_SIDEBAR_DEFAULT_MAX_WIDTH = 720;
export const CHAT_DETAIL_PREVIEW_MIN_WIDTH = 360;
export const CHAT_MAIN_MIN_WIDTH = 560;

type HorizontalRect = Pick<DOMRect, 'left' | 'right'>;

export function appRightSidebarAvailableWidths(
  layout: HorizontalRect,
  content: HorizontalRect,
  viewSidebar: HorizontalRect | null,
  viewSidebarEndMargin = 0,
): { mainAndSidebarWidth: number; drawerWidth: number } {
  const detailStart = viewSidebar
    ? Math.max(content.left, viewSidebar.right + Math.max(0, viewSidebarEndMargin))
    : content.left;
  return {
    mainAndSidebarWidth: Math.max(0, Math.floor(layout.right - detailStart)),
    drawerWidth: Math.max(0, Math.floor(layout.right - content.left)),
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
  setRightSidebarOpen?(open: boolean): void;
  setViewSidebarWidth(width: number | null): void;
  viewSidebarWidth?: number | null;
  active: boolean;
};

const noopContext: AppShellContextValue = {
  rightSidebar: null,
  registerRightSidebar: () => () => undefined,
  updateRightSidebar: () => undefined,
  setRightSidebarOpen: () => undefined,
  setViewSidebarWidth: () => undefined,
  active: true,
};

const AppShellContext = createContext<AppShellContextValue>(noopContext);
const noopUpdateRightSidebar = () => undefined;

export function AppShellProvider({ value, children }: { value: AppShellContextValue; children: ComponentChildren }): JSX.Element {
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

export function useAppShell(): AppShellContextValue {
  return useContext(AppShellContext);
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
  descriptor: Pick<AppRightSidebarCommon, 'width' | 'minWidth' | 'maxWidth' | 'mainMinWidth'>,
  mainAndSidebarWidth: number,
  drawerWidth: number = mainAndSidebarWidth,
): AppRightSidebarLayout {
  const available = Math.max(0, Math.floor(mainAndSidebarWidth));
  const drawerAvailable = Math.max(0, Math.floor(drawerWidth));
  const bounds = appRightSidebarWidthBounds(descriptor.minWidth, descriptor.maxWidth, available);
  const mainMinWidth = descriptor.mainMinWidth ?? 480;
  const dockMax = Math.min(bounds.max, Math.max(0, available - mainMinWidth));
  if (dockMax >= bounds.min) {
    return {
      presentation: 'dock',
      effectiveWidth: Math.max(bounds.min, Math.min(dockMax, descriptor.width)),
      minWidth: bounds.min,
      maxWidth: dockMax,
    };
  }
  const drawerMax = Math.min(descriptor.maxWidth ?? APP_RIGHT_SIDEBAR_DEFAULT_MAX_WIDTH, drawerAvailable);
  const drawerMin = Math.min(bounds.min, drawerMax);
  return {
    presentation: 'overlay-drawer',
    effectiveWidth: Math.max(drawerMin, Math.min(drawerMax, descriptor.width)),
    minWidth: drawerMin,
    maxWidth: drawerMax,
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
