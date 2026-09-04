import { render } from 'preact';
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

function ChatMain(): JSX.Element {
  return (
    <ChatDetailFrame
      state="conversation"
      header={<DetailPaneHeader variant="compact" title="Native Chat" />}
      footer={{ content: <div className="conv-compose"><button type="button">Run options</button><span>42%</span><button type="button">Send</button></div> }}
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
    toggleRef.current?.focus();
  }, [stored.open]);
  const descriptor = useMemo<AppRightSidebarDescriptor>(() => {
    if (surface === 'chat') return {
      id: scope, ariaLabel: 'Chat sidebar', kind: 'tabs', open: stored.open, width: stored.width,
      onOpenChange: setOpen, onWidthChange: (width) => updateStored({ width }), activeTab: tab,
      onActiveTabChange: setTab,
      tabs: [
        { id: 'overview', label: 'Session Overview', tooltip: 'Session Overview', icon: <TestIcon kind="overview" />, content: <><ChatSessionOverview providerSessionId={null} conversationId="native" /><ScrollFill /></> },
        { id: 'preview', label: 'Preview', tooltip: 'Preview', icon: <TestIcon kind="preview" />, content: <><ChatPreview target={null} onClear={() => undefined} /><ScrollFill /></> },
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
      <div className={`app-layout app-layout--right-sidebar-open app-layout--route-${surface}`} style={{ '--app-right-sidebar-width': `${stored.width}px` }}>
        <aside className="app-rail" inert={narrow ? true : undefined} />
        <main className={`app-content app-content--${surface}`} inert={narrow ? true : undefined}>
          {surface === 'chat' ? <ChatMain /> : <div className="native-main">{surface} main</div>}
          {surface === 'console' ? <button type="button" data-stream-update onClick={() => setStreamRevision((value) => value + 1)}>Stream update {streamRevision}</button> : null}
          {surface === 'chat' ? <div data-title-errors data-deterministic-retry={String(deterministic.retryable)} data-transient-retry={String(transient.retryable)}>{deterministic.message}|{transient.message}</div> : null}
        </main>
        {stored.open ? <AppRightSidebarSurface descriptor={descriptor} toggleRef={toggleRef} onOpenChange={setOpen} /> : (
          <AppRightSidebarToggleButton descriptor={descriptor} buttonRef={toggleRef} open={false} onOpenChange={setOpen} className="app-content__right-sidebar-toggle" />
        )}
      </div>
    </div>
  );
}

const surface = (new URLSearchParams(location.search).get('surface') ?? 'chat') as Surface;
render(<Harness surface={surface} />, document.body);
document.title = 'ready';
