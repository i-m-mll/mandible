import { render } from 'preact';
import { useState } from 'preact/hooks';

import { DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE } from '../../../src/contracts';
import { ChatBottomShelf } from '../../../ui/src/chat/ChatBottomShelf';
import { ChatEntityLinkBoundary } from '../../../ui/src/chat/ChatEntityLinkBoundary';
import { ChatSurface } from '../../../ui/src/chat/ChatSurface';
import { DetailPaneHeader } from '../../../ui/src/components/shared/DetailPaneHeader';
import { ChatDetailFrame } from '../../../ui/src/views/conversations';
import { GraphDetailPane } from '../../../ui/src/views/graph';
import { TimelineInspectorFrame } from '../../../ui/src/views/timeline';

type RailMode = 'expanded' | 'icons';
type SidebarMode = 'shown' | 'hidden';
type Surface = 'chat' | 'graph' | 'timeline';

const railModes: RailMode[] = ['expanded', 'icons'];
const sidebarModes: SidebarMode[] = ['shown', 'hidden'];
const surfaces: Surface[] = ['chat', 'graph', 'timeline'];
const chatEvents = Array.from({ length: 30 }, (_, index) => ({
  type: 'user',
  uuid: `user-${index}`,
  session_id: 'geometry-session',
  parent_tool_use_id: null,
  message: {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `Rendered transcript row ${index}` }],
  },
}));

function ProductionSurface({ surface }: { surface: Surface }): JSX.Element {
  if (surface === 'chat') {
    return (
      <ChatDetailFrame
        state="no-selection"
        header={<DetailPaneHeader variant="compact" title="Chat" />}
        footer={{ content: <div className="conv-compose">Composer</div> }}
      >
        <div className="conv-transcript">
          <ChatEntityLinkBoundary defaultAction="preview" onPreview={() => undefined}>
            <ChatSurface
              events={chatEvents}
              streaming={false}
              sessionInfo={{ sessionId: 'geometry-session', backend: 'codex' }}
            />
          </ChatEntityLinkBoundary>
        </div>
      </ChatDetailFrame>
    );
  }
  if (surface === 'graph') {
    return <GraphDetailPane node={null} edges={[]} onNavigate={() => undefined} />;
  }
  return (
    <TimelineInspectorFrame>
      <div className="timeline-inspector__content">Timeline selection</div>
    </TimelineInspectorFrame>
  );
}

function ProductionChatBottomShelf(): JSX.Element {
  const [preference, setPreference] = useState({ ...DEFAULT_CHAT_BOTTOM_SHELF_PREFERENCE });
  return (
    <ChatEntityLinkBoundary defaultAction="preview" onPreview={() => undefined}>
      <ChatBottomShelf
        preference={preference}
        preferenceReady
        preferenceError={null}
        providerSessionId={null}
        conversationId="geometry-conversation"
        previewTarget={null}
        onPreferenceChange={setPreference}
        onClearPreview={() => undefined}
      />
    </ChatEntityLinkBoundary>
  );
}

function FixtureCase({ rail, sidebar, surface }: {
  rail: RailMode;
  sidebar: SidebarMode;
  surface: Surface;
}): JSX.Element {
  const sidebarShown = sidebar === 'shown';
  const panelSurface = true;
  return (
    <div className="fixture-case" data-rail={rail} data-sidebar={sidebar} data-surface={surface}>
      <div className={`app-shell${sidebarShown ? ' app-shell--view-sidebar-open' : ''}${rail === 'icons' ? ' app-shell--rail-icons' : ''}`}>
        <header className={`app-header${sidebarShown ? '' : ' app-header--sidebar-hidden'}`}>
          <div className="app-header__identity" />
        </header>
        <div className={`app-layout app-layout--route-console${sidebarShown ? ' app-layout--view-sidebar-open' : ''}${rail === 'icons' ? ' app-layout--rail-icons' : ''}${panelSurface ? ' app-layout--bottom-panel-open' : ''}`}>
          <aside className="app-rail" />
          <main className="app-content app-content--console app-content--view-sidebar">
            <div className="app-tab-panel">
              <div className="chat-history-view">
                {sidebarShown ? (
                  <aside className="view-sidebar chat-history-sidebar" style={{ width: 'var(--app-view-sidebar-width)', flexShrink: 0 }} />
                ) : null}
                <div className="chat-history-detail">
                  {surface === 'chat' ? <ProductionSurface surface={surface} /> : null}
                </div>
              </div>
            </div>
          </main>
          {panelSurface ? (
            <aside className="app-bottom-panel">
              <div className="app-bottom-panel__content">
                {surface === 'chat' ? <ProductionChatBottomShelf /> : <ProductionSurface surface={surface} />}
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Fixture(): JSX.Element {
  return (
    <>
      {railModes.flatMap((rail) => sidebarModes.flatMap((sidebar) => surfaces.map((surface) => (
        <FixtureCase key={`${rail}:${sidebar}:${surface}`} rail={rail} sidebar={sidebar} surface={surface} />
      ))))}
    </>
  );
}

render(<Fixture />, document.body);
document.title = 'ready';
