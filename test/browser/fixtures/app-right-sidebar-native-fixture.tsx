import { render, type Ref } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { ApiError } from '../../../ui/src/api';
import {
  AppRightSidebarSurface,
  AppRightSidebarToggleButton,
  type AppRightSidebarDescriptor,
} from '../../../ui/src/app-shell';
import { ChatPreview, ChatSessionOverview } from '../../../ui/src/chat/ChatRightSidebar';
import { MessageInfoPanel } from '../../../ui/src/components/console/MessageInfoPanel';
import { SessionControls } from '../../../ui/src/components/console/SessionControls';
import { DetailPaneHeader } from '../../../ui/src/components/shared/DetailPaneHeader';
import { useIntrinsicOverflowGroup } from '../../../ui/src/hooks/useIntrinsicOverflowGroup';
import { useAppRightSidebarState } from '../../../ui/src/right-sidebar-state';
import { ChatDetailFrame, conversationLoadFailure } from '../../../ui/src/views/conversations';
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

function NativeComposer(): JSX.Element {
  const geometry = useIntrinsicOverflowGroup(true, 'Agent\u0000gpt-5.6-sol\u0000Medium');
  return (
    <div className="conv-compose">
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
            <button type="button" className="conv-compose__send">Send</button>
          </span>
        </div>
      </div>
    </div>
  );
}

function ChatMain({ descriptor, toggleRef, setOpen }: {
  descriptor: AppRightSidebarDescriptor;
  toggleRef: Ref<HTMLButtonElement>;
  setOpen(open: boolean): void;
}): JSX.Element {
  return (
    <ChatDetailFrame
      state="conversation"
      header={(
        <DetailPaneHeader
          variant="compact"
          title="Native Chat"
          metadata={<span>Codex <span className="conv-attach-badge">Stopped</span></span>}
          actions={!descriptor.open ? (
            <AppRightSidebarToggleButton descriptor={descriptor} buttonRef={toggleRef} open={false} onOpenChange={setOpen} />
          ) : undefined}
          actionsLabel="Chat sidebar"
        />
      )}
      overlayControl={<NativeComposer />}
    >
      <div className="conv-transcript">{Array.from({ length: 30 }, (_, index) => <p key={index}>Transcript row {index}</p>)}</div>
    </ChatDetailFrame>
  );
}

function Harness({ surface }: { surface: Surface }): JSX.Element {
  const scope = `native-${surface}`;
  const [stored, updateStored] = useAppRightSidebarState(scope, { open: true, width: 380 });
  const [tab, setTab] = useState(surface === 'console' ? 'settings' : 'overview');
  const [streamRevision, setStreamRevision] = useState(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const transferFocus = useRef(false);
  const setOpen = (open: boolean) => {
    transferFocus.current = true;
    updateStored({ open });
  };
  useLayoutEffect(() => {
    if (!transferFocus.current) return;
    transferFocus.current = false;
    const timer = window.setTimeout(() => {
      const toggle = document.querySelector<HTMLButtonElement>(
        '.app-right-sidebar-toggle[aria-controls="app-right-sidebar"]',
      );
      toggle?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [stored.open]);
  const descriptor = useMemo<AppRightSidebarDescriptor>(() => {
    if (surface === 'chat') return {
      id: scope, ariaLabel: 'Chat sidebar', kind: 'tabs', open: stored.open, width: stored.width,
      togglePlacement: 'detail-header',
      onOpenChange: setOpen, onWidthChange: (width) => updateStored({ width }), activeTab: tab,
      onActiveTabChange: setTab,
      tabs: [
        { id: 'overview', label: 'Session Overview', tooltip: 'Session Overview', icon: <TestIcon kind="overview" />, content: <><ChatSessionOverview providerSessionId={null} conversationId="native" /><ScrollFill /></> },
        { id: 'preview', label: 'Preview', tooltip: 'Preview', icon: <TestIcon kind="preview" />, content: <><ChatPreview target={null} /><ScrollFill /></> },
        { id: 'activity', label: 'Activity', tooltip: 'Subagents and workflow runs', icon: <TestIcon kind="activity" />, content: <ScrollFill /> },
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
        { id: 'settings', label: 'Session Settings', tooltip: 'Session Settings', icon: <TestIcon kind="settings" />, content: <><SessionControls sessionId="native" runOptions={{ revision: 1, options: [] }} /><ScrollFill /></> },
        { id: 'info', label: 'Message Info', tooltip: 'Message Info', icon: <TestIcon kind="info" />, content: <><MessageInfoPanel selectedMessageId={null} streamEvents={[]} /><ScrollFill /></> },
      ],
    };
  }, [stored.open, stored.width, surface, tab, streamRevision]);
  const deterministic = conversationLoadFailure(new ApiError('raw', 409, 'provider_metadata_missing'), true);
  const transient = conversationLoadFailure(new ApiError('raw', 503, 'provider_metadata_unavailable'), true);
  const narrow = window.innerWidth <= 760;
  return (
    <div className={`app-shell native-fixture native-fixture--${surface}`}>
      <div className={`app-layout app-layout--route-${surface}${stored.open ? ' app-layout--right-sidebar-open' : ''}`} style={{ '--app-right-sidebar-width': `${stored.width}px` }}>
        <aside className="app-rail" inert={narrow && stored.open} />
        <main className={`app-content app-content--${surface}`} inert={narrow && stored.open}>
          {surface === 'chat' ? <ChatMain descriptor={descriptor} toggleRef={toggleRef} setOpen={setOpen} /> : <div className="native-main">{surface} main</div>}
          {surface === 'console' ? <button type="button" data-stream-update onClick={() => setStreamRevision((value) => value + 1)}>Stream update {streamRevision}</button> : null}
          {surface === 'chat' ? <div data-title-errors data-deterministic-retry={String(deterministic.retryable)} data-transient-retry={String(transient.retryable)}>{deterministic.message}|{transient.message}</div> : null}
        </main>
        {stored.open ? <AppRightSidebarSurface descriptor={descriptor} toggleRef={toggleRef} onOpenChange={setOpen} /> : surface !== 'chat' ? (
          <AppRightSidebarToggleButton descriptor={descriptor} buttonRef={toggleRef} open={false} onOpenChange={setOpen} className="app-content__right-sidebar-toggle" />
        ) : null}
      </div>
    </div>
  );
}

const surface = (new URLSearchParams(location.search).get('surface') ?? 'chat') as Surface;
render(<Harness surface={surface} />, document.body);
document.title = 'ready';
