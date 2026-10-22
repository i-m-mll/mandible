import { render } from 'preact';

import { AppRightSidebarSurface, AppShellProvider, type AppRightSidebarDescriptor } from '../../../ui/src/app-shell';
import { DetailPaneHeader } from '../../../ui/src/components/shared/DetailPaneHeader';
import { DetailPaneMenuTrigger } from '../../../ui/src/components/shared/DetailPaneMenuTrigger';

type Variant = 'standard' | 'compact' | 'versioned';

function descriptor(open: boolean): AppRightSidebarDescriptor {
  return {
    id: 'header-controls-preview',
    kind: 'panel',
    title: 'Preview',
    ariaLabel: 'Preview',
    content: null,
    open,
    width: 360,
    onOpenChange: () => undefined,
    onWidthChange: () => undefined,
  };
}

function HeaderCase({ variant, open }: { variant: Variant; open: boolean }): JSX.Element {
  const menu = (
    <DetailPaneMenuTrigger
      label={`${variant} actions`}
      expanded={false}
      onClick={() => undefined}
    />
  );
  const header = variant === 'standard'
    ? <DetailPaneHeader
      variant="standard"
      identity={{ entityLabel: 'Issue', displayRef: 'fcd536a', canonicalRef: 'mandible/fcd536a' }}
      title="Align visible header actions"
      status={<span data-header-control>Open</span>}
      actions={menu}
    />
    : variant === 'versioned'
      ? <DetailPaneHeader
        variant="versioned"
        identity={{ entityLabel: 'Artifact', displayRef: 'a19b3ef', canonicalRef: 'artifact:a19b3ef' }}
        title="Review artifact"
        state={<span data-header-control>Latest</span>}
        actions={menu}
      />
      : <DetailPaneHeader
        variant="compact"
        title="Chat conversation"
        menu={menu}
        menuLabel="Conversation detail actions"
      />;

  return (
    <AppShellProvider value={{
      active: true,
      rightSidebar: descriptor(open),
      registerRightSidebar: () => () => undefined,
      registerInitialRouteLoad: () => undefined,
      updateRightSidebar: () => undefined,
      setRightSidebarOpen: () => undefined,
      setViewSidebarWidth: () => undefined,
    }}>
      <section
        className="detail-pane-shell header-case"
        data-variant={variant}
        data-open={String(open)}
      >
        {header}
      </section>
    </AppShellProvider>
  );
}

function RightSidebarHeader(): JSX.Element {
  const sidebar: AppRightSidebarDescriptor = {
    id: 'header-controls-preview',
    kind: 'tabs',
    ariaLabel: 'Details',
    open: true,
    width: 360,
    tabs: [{
      id: 'graph',
      label: 'Graph',
      tooltip: 'Graph',
      icon: <span aria-hidden="true">G</span>,
      content: null,
    }],
    activeTab: 'graph',
    onActiveTabChange: () => undefined,
    onOpenChange: () => undefined,
    onWidthChange: () => undefined,
  };

  return (
    <div className="header-controls-sidebar">
      <AppRightSidebarSurface
        descriptor={sidebar}
        open
        onOpenChange={() => undefined}
        layout={{ presentation: 'dock', effectiveWidth: 360, minWidth: 300, maxWidth: 720 }}
      />
    </div>
  );
}

function Fixture(): JSX.Element {
  const cases = (['standard', 'compact', 'versioned'] as const).flatMap((variant) => [false, true].map((open) => ({ variant, open })));
  return (
    <main className="header-controls-fixture">
      {cases.map(({ variant, open }) => <HeaderCase key={`${variant}-${open}`} variant={variant} open={open} />)}
      <RightSidebarHeader />
    </main>
  );
}

if (new URLSearchParams(location.search).get('native') === '1') {
  document.body.classList.add('tauri-window');
}

render(<Fixture />, document.body);
document.title = 'ready';
