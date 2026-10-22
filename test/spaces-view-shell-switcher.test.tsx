// SpacesViewShell switcher + sidebar wiring tests (umbrella de56ffa, child 6a4a69a).
//
// The home lane adds the home sidebar and typed-primary selected Space header.
// These tests pin that normal selected Spaces no longer show all renderers as
// equivalent tabs while explicit legacy renderer links still mount.
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { render } from './helpers/notice-test-render';
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
import type { InstanceInfo, Space } from '../ui/src/api';

function Mount(props: SpaceRendererMountProps): JSX.Element {
  return <div data-testid="mount">{props.renderer}</div>;
}

function makeSpace(defaultRenderer: Space['default_renderer'] = 'document'): Space {
  return {
    id: 's1',
    project_id: 'p1',
    title: 'Typed workspace',
    default_renderer: defaultRenderer,
    description: null,
    metadata: {},
    created_at: 0,
    updated_at: 0,
  };
}

const previewInstance: InstanceInfo = {
  role: 'preview',
  instance_id: 'preview-readonly',
  installation_id: 'install-1',
  public_origin: 'http://localhost:19420',
  backend_generation: 'test-generation',
  allowed_effects: [],
  writable_roots: [],
  db_path: '/tmp/mandible-preview.db',
  db_path_source: 'iab-preview-copy',
};

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

  it('opens the selected Space primary type without showing renderer tabs', async () => {
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        onNavigate={vi.fn()}
        renderers={{ document: Mount, canvas: Mount }}
        loadSpace={vi.fn().mockResolvedValue(makeSpace('document'))}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('mount').textContent).toBe('document'));
    const typeIcon = screen.getByTestId('spaces-shell-type');
    expect(typeIcon.getAttribute('aria-label')).toBe('Document space type');
    expect(typeIcon.className).toContain('spaces-shell__type-icon');
    expect(typeIcon.className).not.toContain('spaces-shell__type-badge');
    expect(typeIcon.textContent).toBe('');
    expect(screen.getByText('Typed workspace')).toBeTruthy();
    expect(screen.queryByTestId('spaces-shell-switcher')).toBeNull();
    expect(screen.queryByTestId('spaces-renderer-canvas')).toBeNull();
  });

  it('keeps explicit legacy renderer links working without restoring the full tablist', async () => {
    const onNavigate = vi.fn();
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderer="canvas"
        onNavigate={onNavigate}
        renderers={{ document: Mount, canvas: Mount }}
        loadSpace={vi.fn().mockResolvedValue(makeSpace('document'))}
      />,
    );

    expect(screen.getByTestId('mount').textContent).toBe('canvas');
    await waitFor(() => expect(screen.getByTestId('spaces-shell-legacy-renderer')).toBeTruthy());
    expect(screen.queryByTestId('spaces-shell-switcher')).toBeNull();

    fireEvent.click(screen.getByTestId('spaces-shell-open-primary'));
    expect(onNavigate).toHaveBeenCalledWith({ renderer: null });
  });

  it('mounts the active renderer for a selected space', () => {
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderer="canvas"
        onNavigate={vi.fn()}
        renderers={{ canvas: Mount }}
        loadSpace={vi.fn().mockResolvedValue(makeSpace('canvas'))}
      />,
    );
    expect(screen.getByTestId('mount').textContent).toBe('canvas');
  });

  it('shows the shared preview-disabled notice above the active renderer', () => {
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderer="canvas"
        instance={previewInstance}
        onNavigate={vi.fn()}
        renderers={{ canvas: Mount }}
        loadSpace={vi.fn().mockResolvedValue(makeSpace('canvas'))}
      />,
    );

    const notice = screen.getByText('Saving disabled in copied preview instance.').closest('.detail-pane-notice')!;
    const main = notice.parentElement;
    const header = document.querySelector('.spaces-shell__header');
    const body = screen.getByTestId('spaces-shell-body');
    expect(notice.getAttribute('data-severity')).toBe('warning');
    expect(notice.textContent).toContain('Saving disabled in copied preview instance.');
    expect(main?.id).toBe('app-operational-notices');
    expect(main?.firstElementChild).toBe(notice);
    expect(header?.contains(notice)).toBe(false);
    expect(body.contains(notice)).toBe(false);
  });

  it('hides the sidebar when sidebarHidden is true', () => {
    render(<SpacesViewShell projectId="p1" sidebarHidden onNavigate={vi.fn()} />);
    expect(screen.queryByTestId('spaces-sidebar')).toBeNull();
  });
});
