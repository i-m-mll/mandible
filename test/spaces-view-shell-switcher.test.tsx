// SpacesViewShell switcher + sidebar wiring tests (umbrella de56ffa, child 6a4a69a).
//
// The home lane adds three things to the shell: the home sidebar, an interactive
// renderer switcher (shown only when a space is selected), and removal of the
// redundant hardcoded "Spaces" title. These tests pin that behavior.
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

// The shell renders SpacesSidebar, which loads grouped spaces. Stub the grouped
// read so the shell mounts without a daemon.
vi.mock('../ui/src/api', async (importActual) => {
  const actual = await importActual<typeof import('../ui/src/api')>();
  return {
    ...actual,
    listSpacesGrouped: vi.fn().mockResolvedValue([]),
  };
});

import { SpacesViewShell, type SpaceRendererMountProps } from '../ui/src/views/spaces/SpacesViewShell';

function Mount(props: SpaceRendererMountProps): JSX.Element {
  return <div data-testid="mount">{props.renderer}</div>;
}

afterEach(() => {
  cleanup();
});

describe('SpacesViewShell home polish', () => {
  it('removes the redundant hardcoded "Spaces" title', () => {
    render(<SpacesViewShell projectId="p1" onNavigate={vi.fn()} />);
    // The old `.spaces-shell__title` literal text is gone.
    expect(screen.queryByText('Spaces', { selector: '.spaces-shell__title' })).toBeNull();
  });

  it('shows no renderer switcher when no space is selected', () => {
    render(<SpacesViewShell projectId="p1" onNavigate={vi.fn()} renderers={{ collection: Mount, canvas: Mount }} />);
    expect(screen.queryByTestId('spaces-shell-switcher')).toBeNull();
    // The empty-state prompts the user toward the sidebar create affordance.
    expect(screen.getByTestId('spaces-shell-empty')).toBeTruthy();
  });

  it('shows the switcher only for REGISTERED renderers when a space is selected', () => {
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderer="collection"
        onNavigate={vi.fn()}
        renderers={{ collection: Mount, canvas: Mount }}
      />,
    );
    const switcher = screen.getByTestId('spaces-shell-switcher');
    expect(switcher).toBeTruthy();
    expect(screen.getByTestId('spaces-renderer-collection')).toBeTruthy();
    expect(screen.getByTestId('spaces-renderer-canvas')).toBeTruthy();
    // board/document are not registered here → not offered.
    expect(screen.queryByTestId('spaces-renderer-board')).toBeNull();
    expect(screen.queryByTestId('spaces-renderer-document')).toBeNull();
  });

  it('highlights the active renderer and navigates renderer= on click', () => {
    const onNavigate = vi.fn();
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderer="collection"
        onNavigate={onNavigate}
        renderers={{ collection: Mount, canvas: Mount }}
      />,
    );
    const active = screen.getByTestId('spaces-renderer-collection');
    expect(active.getAttribute('data-active')).toBe('true');

    fireEvent.click(screen.getByTestId('spaces-renderer-canvas'));
    expect(onNavigate).toHaveBeenCalledWith({ renderer: 'canvas' });
  });

  it('mounts the active renderer for a selected space', () => {
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderer="canvas"
        onNavigate={vi.fn()}
        renderers={{ canvas: Mount }}
      />,
    );
    expect(screen.getByTestId('mount').textContent).toBe('canvas');
  });

  it('hides the sidebar when sidebarHidden is true', () => {
    render(<SpacesViewShell projectId="p1" sidebarHidden onNavigate={vi.fn()} />);
    expect(screen.queryByTestId('spaces-sidebar')).toBeNull();
  });
});
