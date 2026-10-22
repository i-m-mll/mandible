import { cleanup, render, screen } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';

import { AppOperationalNoticeOutlet, AppShellProvider } from '../../ui/src/app-shell';
import { DetailPaneNotice } from '../../ui/src/components/shared/DetailPaneNotice';
import { DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell';
import { SessionOverviewView } from '../../ui/src/views/session-overview';

afterEach(() => cleanup());

function NoticeHarness({ children, active = true }: { children: ComponentChildren; active?: boolean }): JSX.Element {
  const [fallbackHost, setFallbackHost] = useState<HTMLElement | null>(null);
  const [mainHosts, setMainHosts] = useState<Array<{ id: number; host: HTMLElement }>>([]);
  const sequence = useRef(0);
  const registerMainNoticeHost = useCallback((host: HTMLElement) => {
    const id = ++sequence.current;
    setMainHosts((current) => [...current, { id, host }]);
    return () => setMainHosts((current) => current.filter((entry) => entry.id !== id));
  }, []);
  const value = useMemo(() => ({
    active,
    noticeHost: mainHosts[0]?.host ?? fallbackHost,
    registerMainNoticeHost,
    rightSidebar: null,
    registerRightSidebar: () => () => undefined,
    registerInitialRouteLoad: () => undefined,
    updateRightSidebar: () => undefined,
  }), [active, fallbackHost, mainHosts, registerMainNoticeHost]);

  return (
    <AppShellProvider value={value}>
      <div data-testid="fallback-notice-host" ref={setFallbackHost} />
      {children}
    </AppShellProvider>
  );
}

function renderOperationalNotices(active = true) {
  return render(
    <NoticeHarness active={active}>
      <DetailPaneShell header={<h1>Main content</h1>}>
        <aside aria-label="View sidebar">
          <DetailPaneNotice severity="warning" title="Sidebar order unavailable">Could not save the order.</DetailPaneNotice>
        </aside>
        <section aria-label="Selected detail">
          <DetailPaneNotice severity="error" title="Detail unavailable">The selected item could not load.</DetailPaneNotice>
          <DetailPaneNotice severity="info" source="local-access">Connecting to Mandible.</DetailPaneNotice>
          <DetailPaneNotice severity="success">Saved successfully.</DetailPaneNotice>
        </section>
        <DetailPaneShell as="aside" presentation="sidebar" header={<h2>Right preview</h2>}>
          <DetailPaneNotice severity="warning" title="Preview unavailable">The right preview could not load.</DetailPaneNotice>
        </DetailPaneShell>
      </DetailPaneShell>
      <div hidden data-testid="inactive-tab">
        <AppShellProvider value={{ active: false, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, updateRightSidebar: () => undefined }}>
          <DetailPaneShell header={<h1>Hidden tab</h1>}>
            <DetailPaneNotice severity="error" title="Stale hidden failure">Hidden failure.</DetailPaneNotice>
          </DetailPaneShell>
        </AppShellProvider>
      </div>
    </NoticeHarness>,
  );
}

describe('one app-owned operational notice outlet', () => {
  it('places app-wide warnings, errors, and connection status after the active main header', () => {
    const { container } = renderOperationalNotices();
    const host = container.querySelector<HTMLElement>('[data-detail-pane-slot="notice"]');
    const fallback = screen.getByTestId('fallback-notice-host');
    const header = container.querySelector('[data-detail-pane-slot="header"]');
    const body = container.querySelector('[data-detail-pane-slot="body"]');

    expect(host?.querySelectorAll('.detail-pane-notice')).toHaveLength(4);
    expect(fallback.querySelector('.detail-pane-notice')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'View sidebar' }).querySelector('.detail-pane-notice')).toBeNull();
    expect(host?.textContent).toContain('Sidebar order unavailable');
    expect(host?.textContent).toContain('Detail unavailable');
    expect(host?.textContent).toContain('Connecting to Mandible.');
    expect(host?.textContent).toContain('Preview unavailable');
    expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Detail unavailable');
    expect(Array.from(host?.querySelectorAll('[role="status"]') ?? []).map((notice) => notice.textContent))
      .toContain('Sidebar order unavailableCould not save the order.');
    expect(body?.querySelector('.detail-pane-notice--success')?.textContent).toContain('Saved successfully.');
    expect(header?.compareDocumentPosition(host!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host?.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('Hidden failure.')).toBeNull();
  });

  it('does not publish notices from a mounted inactive route', () => {
    const { container } = renderOperationalNotices(false);
    expect(container.querySelector('[data-testid="fallback-notice-host"] .detail-pane-notice')).toBeNull();
    expect(container.querySelectorAll('.detail-pane-notice')).toHaveLength(0);
  });

  it('registers the main outlet when a visited hidden tab becomes active again', () => {
    const view = (active: boolean) => (
      <NoticeHarness active={active}>
        <section hidden={!active}>
          <DetailPaneShell header={<h1>Visited tab</h1>}>
            <DetailPaneNotice severity="error" title="Current failure">The tab became active again.</DetailPaneNotice>
          </DetailPaneShell>
        </section>
      </NoticeHarness>
    );
    const { container, rerender } = render(view(false));

    expect(container.querySelector('[data-app-operational-notice-outlet="main"]')).toBeNull();
    rerender(view(true));

    const outlet = container.querySelector('[data-app-operational-notice-outlet="main"]');
    expect(outlet?.textContent).toContain('The tab became active again.');
    expect(container.querySelector('[data-testid="fallback-notice-host"] .detail-pane-notice')).toBeNull();
  });

  it('places notices first when a main shell explicitly has no header', () => {
    const { container } = render(
      <NoticeHarness>
        <DetailPaneShell header={null}>
          <DetailPaneNotice severity="error" title="No-header failure">The page has no content header.</DetailPaneNotice>
        </DetailPaneShell>
      </NoticeHarness>,
    );
    const shell = container.querySelector('.detail-pane-shell');
    const header = shell?.querySelector('[data-detail-pane-slot="header"]');
    const notice = shell?.querySelector('[data-detail-pane-slot="notice"]');
    const body = shell?.querySelector('[data-detail-pane-slot="body"]');

    expect(header).toBeNull();
    expect(notice?.textContent).toContain('The page has no content header.');
    expect(notice?.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lets a non-detail main view place the shared outlet after its own header', () => {
    const { container } = render(
      <NoticeHarness>
        <header><h1>Custom main header</h1></header>
        <AppOperationalNoticeOutlet registerAsMain />
        <main>
          <DetailPaneNotice severity="error" title="View failed">The selected view could not load.</DetailPaneNotice>
        </main>
      </NoticeHarness>,
    );
    const header = container.querySelector('header');
    const outlet = container.querySelector('[data-app-operational-notice-outlet="main"]');

    expect(header?.nextElementSibling).toBe(outlet);
    expect(outlet?.textContent).toContain('The selected view could not load.');
    expect(container.querySelector('[data-testid="fallback-notice-host"] .detail-pane-notice')).toBeNull();
  });

  it('keeps embedded Session Overview and explicit nested outlets out of main registration', () => {
    const { container } = render(
      <NoticeHarness>
        <div id="app-right-sidebar">
          <AppOperationalNoticeOutlet registerAsMain testId="sidebar-outlet">
            <DetailPaneNotice severity="error" title="Sidebar-only failure">The sidebar notice stays at the fallback.</DetailPaneNotice>
          </AppOperationalNoticeOutlet>
          <SessionOverviewView embedded initialSessionId={null} agentBinding={null} />
        </div>
      </NoticeHarness>,
    );

    expect(container.querySelector('#app-right-sidebar [data-app-operational-notice-outlet="main"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-outlet"] .detail-pane-notice')).toBeNull();
    expect(container.querySelector('[data-testid="fallback-notice-host"]')?.textContent).toContain('The sidebar notice stays at the fallback.');
  });
});
