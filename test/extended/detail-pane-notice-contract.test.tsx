import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { AppShellProvider } from '../../ui/src/app-shell';
import { DetailPaneNotice } from '../../ui/src/components/shared/DetailPaneNotice';

afterEach(() => cleanup());

function renderOperationalNotices(active = true): HTMLElement {
  const host = document.createElement('div');
  host.id = 'app-operational-notices';
  document.body.append(host);
  render(
    <AppShellProvider value={{
      active,
      noticeHost: host,
      rightSidebar: null,
      registerRightSidebar: () => () => undefined,
      updateRightSidebar: () => undefined,
    }}>
      <aside aria-label="View sidebar">
        <DetailPaneNotice severity="warning" title="Sidebar order unavailable">Could not save the order.</DetailPaneNotice>
      </aside>
      <section aria-label="Selected detail">
        <DetailPaneNotice severity="error" title="Detail unavailable">The selected item could not load.</DetailPaneNotice>
      </section>
    </AppShellProvider>,
  );
  return host;
}

describe('one app-owned operational notice outlet', () => {
  it('renders independent sidebar and detail failures together in the main outlet', () => {
    const host = renderOperationalNotices();
    expect(host.querySelectorAll('.detail-pane-notice')).toHaveLength(2);
    expect(screen.getByRole('complementary', { name: 'View sidebar' }).querySelector('.detail-pane-notice')).toBeNull();
    expect(screen.getByRole('region', { name: 'Selected detail' }).querySelector('.detail-pane-notice')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Detail unavailable');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Sidebar order unavailable');
  });

  it('does not publish stale failures from a mounted inactive route', () => {
    const host = renderOperationalNotices(false);
    expect(host.querySelector('.detail-pane-notice')).toBeNull();
  });
});
