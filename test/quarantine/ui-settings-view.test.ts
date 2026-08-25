// Quarantined: c317f8e — SettingsView renders a sixteenth button.

import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import {
  getWorkCompare,
  getSettings,
  invalidateApiGetCache,
  patchSession,
  updateConversation,
  type InstanceInfo,
} from '../../ui/src/api';

import { __resetSharedSseForTests } from '../../ui/src/sse-shared';

import { SettingsView } from '../../ui/src/views/settings';

type ReactFlowMockNode = {
  id: string
  data?: {
    node?: {
      label?: string
    }
  }
}

type ReactFlowMockProps = {
  children?: JSX.Element | JSX.Element[]
  nodes?: ReactFlowMockNode[]
  defaultNodes?: ReactFlowMockNode[]
  onNodeClick?: (event: MouseEvent, node: ReactFlowMockNode) => void
}

const reactFlowMockState = vi.hoisted(() => ({
  mountCount: 0,
  unmountCount: 0,
}));

let restoreTestLocalStorage: (() => void) | null = null;

vi.mock('@xyflow/react', async () => {
  const { Component, h } = await vi.importActual<typeof import('preact')>('preact');

  class MockReactFlow extends Component<ReactFlowMockProps> {
    componentDidMount(): void {
      reactFlowMockState.mountCount += 1;
    }

    componentWillUnmount(): void {
      reactFlowMockState.unmountCount += 1;
    }

    render(props: ReactFlowMockProps): JSX.Element {
      const nodes = props.nodes ?? props.defaultNodes ?? [];
      return h(
        'div',
        { 'data-testid': 'react-flow-mock' },
        ...nodes.map((node) => h(
          'button',
          {
            type: 'button',
            'aria-label': `Select graph node ${node.id}`,
            onClick: (event: MouseEvent) => props.onNodeClick?.(event, node),
          },
          node.data?.node?.label ?? node.id,
        )),
        props.children,
      );
    }
  }

  return {
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    ReactFlow: MockReactFlow,
    ViewportPortal: (props: { children?: JSX.Element | JSX.Element[] }) => props.children ?? null,
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(): void {}
    clear(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

beforeEach(() => {
  reactFlowMockState.mountCount = 0;
  reactFlowMockState.unmountCount = 0;
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
});

afterEach(() => {
  invalidateApiGetCache();
  cleanup();
  __resetSharedSseForTests();
  window.localStorage.removeItem?.('mandible:artifacts:list-controls:v1');
  restoreTestLocalStorage?.();
  restoreTestLocalStorage = null;
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
  delete (window as Window & { __MANDIBLE_BOOTSTRAP__?: unknown }).__MANDIBLE_BOOTSTRAP__;
  document.head.querySelector('[data-test-compact-header-styles]')?.remove();
});

describe('SettingsView', () => {

  it('keeps onClose API compatibility while rendering sourced section navigation without redundant chrome', () => {
    const onClose = vi.fn();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.history.replaceState(null, '', '#/settings');
    render(
      h(SettingsView, {
        settings: {},
        onSave: async () => undefined,
        onClose,
      }),
    );

    expect(screen.queryByLabelText('Close settings')).toBeNull();
    expect(screen.queryByText('Mandible configuration.')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    const sectionButtons = within(navigation).getAllByRole('button');
    expect(sectionButtons).toHaveLength(15);
    expect(sectionButtons.filter((button) => button.getAttribute('aria-current') === 'location')).toHaveLength(1);
    for (const button of sectionButtons) {
      const target = button.getAttribute('aria-controls');
      expect(target).toBeTruthy();
      expect(document.getElementById(target!)).toBeTruthy();
    }

    const appearanceButton = within(navigation).getByRole('button', { name: 'Appearance' });
    fireEvent.click(appearanceButton);
    expect(appearanceButton.getAttribute('aria-current')).toBe('location');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(window.location.hash).toBe('#/settings');
  });

});

