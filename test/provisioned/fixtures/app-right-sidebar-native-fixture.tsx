import { useAnchoredMenu } from '../../../ui/src/hooks/useAnchoredMenu';
import { DetailPaneMenuTrigger } from '../../../ui/src/components/shared/DetailPaneMenuTrigger';
import { render } from 'preact';
import { useCallback } from 'preact/hooks';
import { AppFrame } from '../../../ui/src/app-frame';
import { CHROME_SHADOW_DEFAULTS, normalizeChromeShadow } from '../../../ui/src/chrome-shadow';
import { ViewSidebar } from '../../../ui/src/components/ViewSidebar';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { ApiError } from '../../../ui/src/api';
import {
  AppRightSidebarSurface,
  APP_RAIL_WIDTHS,
  AppShellProvider,
  CHAT_DETAIL_PREVIEW_MIN_WIDTH,
  WIDE_RESPONSIVE_SIDEBAR_STATE,
  responsiveSidebarThresholdTransition,
  resolveAppFrameGeometry,
  type AppRightSidebarDescriptor,
} from '../../../ui/src/app-shell';
import { ChatActivity, ChatPreview, ChatSessionOverview } from '../../../ui/src/chat/ChatRightSidebar';
import { ArrowIcon } from '../../../ui/src/components/icons/ArrowIcon';
import { DetailPaneHeader } from '../../../ui/src/components/shared/DetailPaneHeader';
import { useIntrinsicOverflowGroup } from '../../../ui/src/hooks/useIntrinsicOverflowGroup';
import { useAppRightSidebarState } from '../../../ui/src/right-sidebar-state';
import { ChatComposerSubmitIcon, ChatDetailFrame, conversationLoadFailure } from '../../../ui/src/views/conversations';
import { GraphDetailPane } from '../../../ui/src/views/graph';
import { TimelineInspectorFrame } from '../../../ui/src/views/timeline';

type Surface = 'chat' | 'graph' | 'timeline' | 'console';

function TestIcon({ kind }: { kind: string }): JSX.Element {
  return <svg data-icon={kind} width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" /></svg>;
}

function ScrollFill(): JSX.Element {
  return <div aria-hidden="true" style={{ height: 900 }} />;
}

function DotsIcon(): JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>;
}

function RunOption({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <label className="session-controls__field">
      <span className="session-controls__label">{label}</span>
      <select className="session-controls__select" aria-label={label} value={value}>
        <option value={value}>{value}</option>
      </select>
    </label>
  );
}

function NativeComposer({ layoutKey }: { layoutKey: string }): JSX.Element {
  const geometry = useIntrinsicOverflowGroup(true, `Agent\u0000gpt-5.6-sol\u0000Medium\u0000${layoutKey}`);
  return (
    <div className="conv-compose" data-detail-pane-overlay-visual>
      <div className="conv-compose__controls">
        <div ref={geometry.containerRef} className={`conv-compose__runtime${geometry.overflowed ? ' conv-compose__runtime--run-options-overflow' : ''}`}>
          <div ref={geometry.contentRef} className="conv-compose__run-options-inline" aria-label="Run options" aria-hidden={geometry.overflowed ? 'true' : undefined} inert={geometry.overflowed || undefined}>
            <RunOption label="Mode" value="Agent" />
            <RunOption label="Model" value="gpt-5.6-sol" />
            <RunOption label="Reasoning effort" value="Medium" />
          </div>
          <span ref={geometry.fixedRef} className="conv-compose__runtime-actions">
            <button type="button" className="btn btn--ghost btn--sm conv-compose__run-options-trigger" data-overflow-trigger aria-label="Run options" title="Run options"><DotsIcon /></button>
            <span className="context-usage">42%</span>
            <button type="button" className="chat-circle-action conv-compose__send" aria-label="Send"><ChatComposerSubmitIcon /></button>
          </span>
        </div>
      </div>
    </div>
  );
}

function NativeTranscript(): JSX.Element {
  return (
    <div className="conv-transcript">
      <div className="chat-entity-link-boundary">
        <div className="stream-renderer">
          <div className="stream-renderer__scroll">
            <div style={{ height: 900 }} />
            <div data-transcript-final-content style={{ height: 24 }}>Final transcript line</div>
          </div>
          <button type="button" className="chat-circle-action stream-renderer__scroll-btn" aria-label="Jump to latest" title="Jump to latest">
            <ArrowIcon direction="down" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMain({ descriptor }: { descriptor: AppRightSidebarDescriptor }): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useAnchoredMenu({ open: menuOpen, anchorRef, menuRef, onDismiss: () => setMenuOpen(false) });
  return (
    <ChatDetailFrame
      state="conversation"
      header={(
        <DetailPaneHeader
          variant="compact"
          title="A long conversation title that must yield space to the adjacent menu and persistent frame controls"
          supportingMetadata={<span>Workspace</span>}
          menu={<><DetailPaneMenuTrigger buttonRef={anchorRef} label="Conversation actions" expanded={menuOpen} onClick={() => setMenuOpen(open => !open)} />{menuOpen ? <div className="app-anchored-menu" ref={menuRef} role="menu" popover="manual" style={menuStyle}><button role="menuitem">Inspect conversation</button></div> : null}</>}
          actionsLabel="Chat sidebar"
        />
      )}
      overlayControl={<NativeComposer layoutKey={`${descriptor.open}\u0000${descriptor.width}`} />}
    >
      <NativeTranscript />
    </ChatDetailFrame>
  );
}

function Harness({ surface }: { surface: Surface }): JSX.Element {
  const scope = `native-${surface}`;
  const [stored, updateStored] = useAppRightSidebarState(scope, { open: true, width: 380 });
  const [tab, setTab] = useState(surface === 'console' ? 'settings' : 'overview');
  const [streamRevision, setStreamRevision] = useState(0);
  const [viewSidebarOpen, setViewSidebarOpen] = useState(true);
  const responsiveState = useRef(WIDE_RESPONSIVE_SIDEBAR_STATE);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [headerOwners, setHeaderOwners] = useState(0);
  const registerFrameHeader = useCallback(() => { setHeaderOwners(n => n + 1); return () => setHeaderOwners(n => n - 1); }, []);
  const [leftWidth, setLeftWidth] = useState(280);
  const setOpen = (open: boolean) => updateStored({ open });
  useLayoutEffect(() => {
    const reconcile = () => {
      const transition = responsiveSidebarThresholdTransition(responsiveState.current, window.innerWidth);
      responsiveState.current = transition.state;
      if (transition.closeRight) updateStored({ open: false });
      if (transition.closeView) setViewSidebarOpen(false);
    };
    reconcile();
    window.addEventListener('resize', reconcile);
    return () => window.removeEventListener('resize', reconcile);
  }, [updateStored]);
  const descriptor = useMemo<AppRightSidebarDescriptor>(() => {
    if (surface === 'chat') return {
      id: scope, ariaLabel: 'Chat sidebar', kind: 'tabs', open: stored.open, width: stored.width,
      minWidth: CHAT_DETAIL_PREVIEW_MIN_WIDTH, maxWidth: 720,
      onOpenChange: setOpen, onWidthChange: (width) => updateStored({ width }), activeTab: tab,
      onActiveTabChange: setTab,
      tabs: [
        { id: 'overview', label: 'Session Overview', tooltip: 'Session Overview', icon: <TestIcon kind="overview" />, scrollOwner: 'detail', content: <ChatSessionOverview providerSessionId={null} conversationId="native" /> },
        { id: 'preview', label: 'Preview', tooltip: 'Preview', icon: <TestIcon kind="preview" />, scrollOwner: 'detail', content: <ChatPreview target={null} /> },
        { id: 'activity', label: 'Activity', tooltip: 'Activity', icon: <TestIcon kind="activity" />, scrollOwner: 'detail', content: <ChatActivity items={[]} /> },
      ],
    };
    if (surface === 'graph') return {
      id: scope, ariaLabel: 'Graph detail', kind: 'panel', title: 'Graph detail', open: stored.open, width: stored.width,
      onOpenChange: setOpen, onWidthChange: (width) => updateStored({ width }),
      content: <><GraphDetailPane node={null} edges={[]} onNavigate={() => undefined} /><ScrollFill /></>,
    };
    if (surface === 'timeline') return {
      id: scope, ariaLabel: 'Timeline inspector', kind: 'panel', title: 'Timeline inspector', open: stored.open, width: stored.width,
      onOpenChange: setOpen, onWidthChange: (width) => updateStored({ width }),
      content: <><TimelineInspectorFrame><div className="timeline-inspector__content">Timeline selection</div></TimelineInspectorFrame><ScrollFill /></>,
    };
    return {
      id: scope, ariaLabel: 'Console details', kind: 'tabs', open: stored.open, width: stored.width,
      onOpenChange: setOpen, onWidthChange: (width) => updateStored({ width }), activeTab: tab,
      onActiveTabChange: setTab,
      tabs: [
        { id: 'settings', label: 'Session Settings', tooltip: 'Session Settings', icon: <TestIcon kind="settings" />, content: <><p>Terminal settings</p><ScrollFill /></> },
        { id: 'info', label: 'Message Info', tooltip: 'Message Info', icon: <TestIcon kind="info" />, content: <><p>Message details</p><ScrollFill /></> },
      ],
    };
  }, [stored.open, stored.width, surface, tab, streamRevision]);
  const deterministic = conversationLoadFailure(new ApiError('raw', 409, 'provider_metadata_missing'), true);
  const transient = conversationLoadFailure(new ApiError('raw', 503, 'provider_metadata_unavailable'), true);
  const shadowOverride = new URLSearchParams(location.search).get('shadow');
  const chromeShadows = shadowOverride ? { light: normalizeChromeShadow(JSON.parse(shadowOverride), CHROME_SHADOW_DEFAULTS.light), dark: normalizeChromeShadow(JSON.parse(shadowOverride), CHROME_SHADOW_DEFAULTS.dark) } : undefined;
  const railMode = new URLSearchParams(location.search).has('fullRail') ? 'both' : 'icons';
  const railWidth = APP_RAIL_WIDTHS[railMode];
  const [nativeControlsReservation, setNativeControlsReservation] = useState(document.documentElement.dataset.framePresentation === 'macos-overlay' ? 88 : 0);
  useLayoutEffect(() => {
    const changeReservation = (event: Event) => setNativeControlsReservation((event as CustomEvent<number>).detail);
    window.addEventListener('fixture-native-reservation', changeReservation);
    return () => window.removeEventListener('fixture-native-reservation', changeReservation);
  }, []);
  const { rightSidebarLayout: layout, viewSidebarWidth: effectiveLeft } = resolveAppFrameGeometry({ viewportWidth: window.innerWidth, railWidth, viewSidebarWidth: leftWidth, rightSidebar: descriptor, rightSidebarOpen: stored.open, nativeControlsReservation });
  return (
    <div className={`app-shell ${railMode === 'icons' ? 'app-shell--rail-icons' : ''} native-fixture native-fixture--${surface}`} style={{ '--app-native-controls-reservation': `${nativeControlsReservation}px`, '--app-rail-width': `${railWidth}px`, '--app-view-sidebar-width': `${effectiveLeft}px`, '--app-right-sidebar-width': `${stored.open ? layout.effectiveWidth : 0}px` }}>
      <AppShellProvider value={{ active: true, rightSidebar: descriptor, frameHeaderHost: host, registerFrameHeader, registerRightSidebar: () => () => undefined, updateRightSidebar: () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: setLeftWidth, viewSidebarWidth: effectiveLeft }}>
      <AppFrame chromeShadows={chromeShadows} nativeControlsReservation={nativeControlsReservation} headerHostRef={setHost} hasMainHeader={headerOwners > 0} viewSidebarAvailable viewSidebarOpen={viewSidebarOpen} onViewSidebarToggle={() => setViewSidebarOpen(open => !open)} rightSidebar={descriptor} rightSidebarOpen={stored.open} onRightSidebarOpenChange={setOpen} rightToggleRef={toggleRef} rail={<aside className="app-rail"><nav className="app-rail__nav" aria-label="Main navigation"><a className="app-rail__item" href="#/chat" aria-label="Chats"><TestIcon kind="chat" />{railMode === 'both' ? <span>Chats</span> : null}</a></nav></aside>}>
        <main className={`app-content app-content--${surface}`}>
          <div className="fixture-split">
          <ViewSidebar storageKey="fixture-left" defaultWidth={280} minWidth={118} hidden={!viewSidebarOpen} ariaLabel="Fixture"><div data-paint-probe-content>Left content</div></ViewSidebar>
          {surface === 'chat' ? <ChatMain descriptor={descriptor} /> : <div className="native-main">{surface} main</div>}
          </div>
          {surface === 'console' ? <button type="button" data-stream-update onClick={() => setStreamRevision(value => value + 1)}>Stream update {streamRevision}</button> : null}
          {surface === 'chat' ? <div data-title-errors data-deterministic-retry={String(deterministic.retryable)} data-transient-retry={String(transient.retryable)}>{deterministic.message}|{transient.message}</div> : null}
        </main>
        <AppRightSidebarSurface closeFocusRef={toggleRef} descriptor={descriptor} onOpenChange={setOpen} layout={layout} open={stored.open} />
      </AppFrame>
      </AppShellProvider>
    </div>
  );
}

const surface = (new URLSearchParams(location.search).get('surface') ?? 'chat') as Surface;
render(<Harness surface={surface} />, document.body);
document.title = 'ready';
