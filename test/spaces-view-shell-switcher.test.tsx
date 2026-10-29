import { clearPersistedDetailCache } from '../ui/src/detail-cache';
import { queryClient } from '../ui/src/query/client';
// @vitest-environment jsdom
// An explicit legacy renderer link still mounts that renderer, and the user can
// navigate back to the Space's primary type.
import { act, screen, cleanup, fireEvent, waitFor } from './helpers/dom.js';
import { render } from './helpers/notice-test-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => { queryClient.clear(); clearPersistedDetailCache(); });

afterEach(() => {
  queryClient.clear();
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
        loadSpaceFactPacket={vi.fn().mockResolvedValue({ space: makeSpace('document'), items: [], occurrences: [], edges: [] })}
      />,
    );

    expect((await screen.findByTestId('mount')).textContent).toBe('canvas');
    await waitFor(() => expect(screen.getByTestId('spaces-shell-legacy-renderer')).toBeTruthy());

    fireEvent.click(screen.getByTestId('spaces-shell-open-primary'));
    expect(onNavigate).toHaveBeenCalledWith({ renderer: null });
  });
it('keeps mounted space targets through absent groups and ignores superseded detail responses', async () => {
  let finishB!: (space: Space) => void;
  const pendingB = new Promise<Space>((resolve) => { finishB = resolve; });
  const loadSpaceFactPacket = vi.fn(async (id: string) => ({ space: await (id === 'B' ? pendingB : { ...makeSpace(), id, title: `Space ${id}` }), items: [], occurrences: [], edges: [] }));
  const onNavigate = vi.fn();
  const props = { projectId: 'p1', onNavigate, loadSpaceFactPacket, renderers: { document: Mount } };
  const view = render(<SpacesViewShell {...props} spaceId="A" />);
  await screen.findByText('Space A');
  view.rerender(<SpacesViewShell {...props} spaceId="B" />);
  expect(screen.queryByText('Space A')).toBeNull();
  await waitFor(() => expect(loadSpaceFactPacket).toHaveBeenCalledWith('B', expect.objectContaining({ signal: expect.any(AbortSignal) })));
  view.rerender(<SpacesViewShell {...props} spaceId="C" />);
  await screen.findByText('Space C');
  await act(async () => finishB({ ...makeSpace(), id: 'B', title: 'Space B' }));
  expect(screen.queryByText('Space B')).toBeNull();
  expect(screen.getByText('Space C')).toBeTruthy();
  expect(onNavigate).not.toHaveBeenCalled();
});

});
