import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConsolePermissionRequest } from '../../ui/src/api';
import { AppShellProvider, type AppShellContextValue } from '../../ui/src/app-shell';
import { PermissionDialog } from '../../ui/src/components/console/PermissionDialog';

const request: ConsolePermissionRequest = {
  id: 'permission-1',
  session_id: 'session-1',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  created_at: 0,
  expires_at: Date.now() + 60_000,
};

function shell(active: boolean): AppShellContextValue {
  return {
    active,
    bottomPanel: null,
    registerBottomPanel: () => () => undefined,
    setViewSidebarWidth: () => undefined,
  };
}

afterEach(cleanup);

describe('PermissionDialog keyboard shortcuts', () => {
  it('stops approval and denial shortcuts when its keep-alive view becomes inactive', () => {
    const onRespond = vi.fn();
    const result = render(
      <AppShellProvider value={shell(true)}>
        <PermissionDialog request={request} onRespond={onRespond} />
      </AppShellProvider>,
    );

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onRespond).toHaveBeenCalledWith('permission-1', 'allow');
    onRespond.mockClear();

    result.rerender(
      <AppShellProvider value={shell(false)}>
        <PermissionDialog request={request} onRespond={onRespond} />
      </AppShellProvider>,
    );
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'A', shiftKey: true });

    expect(onRespond).not.toHaveBeenCalled();
  });

  it('preserves approval and denial shortcuts while active', () => {
    const onRespond = vi.fn();
    render(
      <AppShellProvider value={shell(true)}>
        <PermissionDialog request={request} onRespond={onRespond} />
      </AppShellProvider>,
    );

    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'A', shiftKey: true });

    expect(onRespond.mock.calls).toEqual([
      ['permission-1', 'allow'],
      ['permission-1', 'deny'],
      ['permission-1', 'allow_always'],
    ]);
  });
});
