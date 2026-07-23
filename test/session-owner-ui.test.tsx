import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleSubTabBar } from '../ui/src/components/console/ConsoleSubTabBar';
import type { ConsoleSession } from '../ui/src/state';

afterEach(cleanup);

describe('console session ownership presentation', () => {
  it('shows the resolved owner in the session list', () => {
    const session = {
      id: 'session-1',
      label: 'Read surfaces',
      agent_type: 'codex',
      interaction_mode: 'both',
      pinned: false,
      status: 'running',
      is_operator: false,
      provider_session_id: 'provider-session-1',
      unread_count: 0,
      created_at: 1,
      started_at: 1,
      stopped_at: null,
      backend_type: 'sdk',
      transport_lane: 'sdk',
      owner: {
        id: 'owner-1',
        display_name: 'Session Owner',
        kind: 'agent',
      },
    } satisfies ConsoleSession;

    render(
      <ConsoleSubTabBar
        sessions={[session]}
        activeSessionId={session.id}
        onSelect={() => undefined}
        onClose={() => undefined}
        onNewSession={() => undefined}
        isConsoleActive
      />,
    );

    expect(screen.getByText('Session Owner')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Read surfaces/ }).getAttribute('title'))
      .toBe('Read surfaces · Session Owner');
  });
});
