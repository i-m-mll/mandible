import { render } from 'preact';

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

function ProductionSurface({ surface }: { surface: Surface }): JSX.Element {
  if (surface === 'chat') {
    return (
      <ChatDetailFrame
        state="no-selection"
        header={<DetailPaneHeader variant="compact" title="Chat" />}
      >
        <div className="chat-history-detail__empty">Select a conversation to view it</div>
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

function FixtureCase({ rail, sidebar, surface }: {
  rail: RailMode;
  sidebar: SidebarMode;
  surface: Surface;
}): JSX.Element {
  const sidebarShown = sidebar === 'shown';
  const panelSurface = surface !== 'chat';
  return (
    <div className="fixture-case" data-rail={rail} data-sidebar={sidebar} data-surface={surface}>
      <div className={`app-shell${sidebarShown ? ' app-shell--view-sidebar-open' : ''}${rail === 'icons' ? ' app-shell--rail-icons' : ''}`}>
        <header className={`app-header${sidebarShown ? '' : ' app-header--sidebar-hidden'}`}>
          <div className="app-header__identity" />
        </header>
        <div className={`app-layout${sidebarShown ? ' app-layout--view-sidebar-open' : ''}${rail === 'icons' ? ' app-layout--rail-icons' : ''}${panelSurface ? ' app-layout--bottom-panel-open' : ''}`}>
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
                <ProductionSurface surface={surface} />
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
