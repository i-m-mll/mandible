// An explicit legacy renderer link still mounts that renderer, and the user can
// navigate back to the Space's primary type.
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { render } from './helpers/notice-test-render';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import type { Space } from '../ui/src/api';

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

afterEach(() => {
  cleanup();
});

describe('SpacesViewShell renderer routing', () => {
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

    fireEvent.click(screen.getByTestId('spaces-shell-open-primary'));
    expect(onNavigate).toHaveBeenCalledWith({ renderer: null });
  });
});
