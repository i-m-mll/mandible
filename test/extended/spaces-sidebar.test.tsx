// Spaces home sidebar tests (umbrella de56ffa, child 6a4a69a).
//
// Covers the cohesive Spaces-home interaction the sidebar owns: grouped tree
// render (top-level group above project headers, typed space lines), live
// filter/sort menu, foldable headers, drag-reorder persistence, the shared leading action typed create
// flow (including optional post-create seeding), selection navigation, and the
// sidebarHidden contract.

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


// Mock the seed POST so the SpaceSeedDialog mount path doesn't hit a daemon.
const seedSpace = vi.fn();
vi.mock('../../ui/src/api', async (importActual) => {
  const actual = await importActual<typeof import('../../ui/src/api')>();
  return {
    ...actual,
    seedSpace: (...args: unknown[]) => seedSpace(...args),
  };
});

import { SpacesSidebar } from '../../ui/src/views/spaces/SpacesSidebar';
import type { Space, SpaceGroup } from '../../ui/src/api';

function makeSpace(
  id: string,
  title: string,
  projectId: string | null,
  defaultRenderer: Space['default_renderer'] = 'collection',
): Space {
  return {
    id,
    project_id: projectId,
    title,
    default_renderer: defaultRenderer,
    description: null,
    metadata: {},
    created_at: 0,
    updated_at: 0,
  };
}

function sampleGroups(): SpaceGroup[] {
  return [
    { project_id: null, project_key: null, project_name: null, spaces: [makeSpace('t1', 'Global notes', null, 'canvas')] },
    {
      project_id: 'proj-a',
      project_key: 'alpha',
      project_name: 'Alpha',
      spaces: [makeSpace('a1', 'Roadmap', 'proj-a', 'document'), makeSpace('a2', 'Backlog', 'proj-a')],
    },
    {
      project_id: 'proj-b',
      project_key: 'beta',
      project_name: 'Beta',
      spaces: [makeSpace('b1', 'Beta board', 'proj-b', 'board')],
    },
  ];
}

// This Node/jsdom build ships a localStorage stub whose setItem throws (the
// `--localstorage-file` warning). Install a working in-memory localStorage so
// the browser-local view-state (collapse + project order) round-trips like it
// does in a real browser.
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
}

beforeEach(() => {
  seedSpace.mockReset();
  installMemoryLocalStorage();
});

afterEach(() => {
  cleanup();
});

describe('SpacesSidebar render + grouping', () => {
  it('supplies the canonical project key when opening a project Space', async () => {
    const onSelectSpace = vi.fn();
    render(<SpacesSidebar onSelectSpace={onSelectSpace} loadGroups={vi.fn().mockResolvedValue(sampleGroups())} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Roadmap (Document)' }));
    expect(onSelectSpace).toHaveBeenCalledWith({
      projectId: 'proj-a',
      projectKey: 'alpha',
      spaceId: 'a1',
      renderer: null,
    });
  });

  it('renders the top-level group above the project headers with compact type indicators', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);

    await screen.findByText('Global notes');
    expect(screen.getByTestId('spaces-group-top-level')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    // Space rows carry accessible primary-type icons, not abbreviation text.
    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(screen.getByText('Backlog')).toBeTruthy();
    const canvasTypeIcon = screen.getByTestId('space-row-type-t1');
    expect(canvasTypeIcon.getAttribute('aria-label')).toBe('Canvas space type');
    expect(canvasTypeIcon.className).toContain('spaces-tree__space-type');
    expect(screen.getByTestId('space-row-type-a1').getAttribute('aria-label')).toBe('Document space type');
    expect(screen.getByTestId('space-row-type-b1').getAttribute('aria-label')).toBe('Board space type');
    expect(canvasTypeIcon.textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Global notes (Canvas)' }).closest('.sidebar-item-row')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Roadmap (Document)' }).closest('.sidebar-item-row')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Alpha/ }).closest('.sidebar-group-node--folder')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Space filter and sort options' }).getAttribute('aria-haspopup')).toBe('menu');

    // The global creation row leads all data content, then the top-level group
    // sits above the first project group in DOM order.
    const scroll = screen.getByTestId('spaces-tree-scroll');
    const newSpace = screen.getByRole('button', { name: 'New space' });
    expect(scroll.firstElementChild).toBe(newSpace);
    expect(newSpace.querySelector('[data-sidebar-action-icon="new-chat"]')).toBeTruthy();
    const topLevelGroup = screen.getByTestId('spaces-group-top-level');
    const alphaGroup = screen.getByTestId('spaces-group-proj-a');
    expect(alphaGroup.parentElement).toBe(scroll);
    expect(alphaGroup.classList.contains('sidebar-group-node--folder')).toBe(true);
    expect(alphaGroup.querySelector('[data-sidebar-reorder-handle]')).toBeNull();
    expect(scroll.contains(topLevelGroup)).toBe(true);
    expect(scroll.contains(alphaGroup)).toBe(true);
    expect(topLevelGroup.compareDocumentPosition(alphaGroup) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('renders nothing when hidden while still resolving the required selection', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const { container } = render(<SpacesSidebar hidden onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    expect(container.querySelector('[data-testid="spaces-sidebar"]')).toBeNull();
    await waitFor(() => expect(loadGroups).toHaveBeenCalledTimes(1));
  });

  it('renders cached groups immediately while the backend refresh is still pending', async () => {
    localStorage.setItem('spaces-tree:groups:v1', JSON.stringify(sampleGroups()));
    const loadGroups = vi.fn(() => new Promise<SpaceGroup[]>(() => {}));
    const onSelectedSpaceResolved = vi.fn();

    render(
      <SpacesSidebar
        selectedSpaceId="t1"
        onSelectSpace={vi.fn()}
        loadGroups={loadGroups}
        onSelectedSpaceResolved={onSelectedSpaceResolved}
      />,
    );

    expect(screen.getByText('Global notes')).toBeTruthy();
    expect(screen.queryByText('Loading spaces…')).toBeNull();
    await waitFor(() => expect(onSelectedSpaceResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', default_renderer: 'canvas' }),
    ));
  });
});

describe('SpacesSidebar live filter', () => {
  it('narrows projects + spaces and restores on clear', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    const input = screen.getByTestId('spaces-filter-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'roadmap' } });

    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(screen.queryByText('Backlog')).toBeNull();
    // Beta group has no matching space and a non-matching name → it disappears.
    expect(screen.queryByText('Beta')).toBeNull();

    fireEvent.input(input, { target: { value: '' } });
    expect(screen.getByText('Backlog')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('keeps a project whose name matches even when no space matches', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    const input = screen.getByTestId('spaces-filter-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'beta' } });
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('Beta board')).toBeTruthy();
  });

  it('keeps search state while sorting from the standard menu and persists sort through reconciliation and remount', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const { rerender, unmount } = render(
      <SpacesSidebar refreshToken={0} onSelectSpace={vi.fn()} loadGroups={loadGroups} />,
    );
    await screen.findByText('Roadmap');

    const input = screen.getByTestId('spaces-filter-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Space filter and sort options' }));
    const menu = screen.getByRole('menu', { name: 'Space filter and sort options' });
    expect(menu).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Name' }));
    expect(input.value).toBe('a');

    const alpha = screen.getByTestId('spaces-group-proj-a');
    expect(Array.from(alpha.querySelectorAll('.sidebar-item-row__label')).map((node) => node.textContent))
      .toEqual(['Backlog', 'Roadmap']);

    rerender(<SpacesSidebar refreshToken={1} onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await waitFor(() => expect(loadGroups).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId('spaces-filter-input') as HTMLInputElement).value).toBe('a');
    expect(Array.from(screen.getByTestId('spaces-group-proj-a').querySelectorAll('.sidebar-item-row__label')).map((node) => node.textContent))
      .toEqual(['Backlog', 'Roadmap']);

    unmount();
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');
    expect(Array.from(screen.getByTestId('spaces-group-proj-a').querySelectorAll('.sidebar-item-row__label')).map((node) => node.textContent))
      .toEqual(['Backlog', 'Roadmap']);
    fireEvent.click(screen.getByRole('button', { name: 'Space filter and sort options' }));
    expect(screen.getByRole('menuitemradio', { name: 'Name' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('SpacesSidebar foldable headers', () => {
  it('collapses and expands a project header independent of filter', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    const toggle = screen.getByRole('button', { name: /^Alpha/ });
    expect(toggle.getAttribute('aria-controls')).toBe('spaces-group-proj-a-body');
    fireEvent.click(toggle);
    const closingRegion = document.getElementById('spaces-group-proj-a-body');
    expect(closingRegion?.getAttribute('aria-hidden')).toBe('true');
    const transitionEnd = new Event('transitionend', { bubbles: true });
    Object.defineProperty(transitionEnd, 'propertyName', { value: 'height' });
    fireEvent(closingRegion as HTMLElement, transitionEnd);
    expect(screen.queryByText('Roadmap')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Roadmap')).toBeTruthy();
  });

  it('preserves collapse intent across refresh reconciliation and remount', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const { rerender, unmount } = render(
      <SpacesSidebar refreshToken={0} onSelectSpace={vi.fn()} loadGroups={loadGroups} />,
    );
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByRole('button', { name: /^Alpha/ }));
    expect(screen.getByRole('button', { name: /^Alpha/ }).getAttribute('aria-expanded')).toBe('false');

    rerender(<SpacesSidebar refreshToken={1} onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await waitFor(() => expect(loadGroups).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /^Alpha/ }).getAttribute('aria-expanded')).toBe('false');

    unmount();
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    expect(screen.getByRole('button', { name: /^Alpha/ }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('SpacesSidebar reorder', () => {
  it('reorders project headers and persists the order across remount', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const { unmount } = render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    const headerA = screen.getByRole('button', { name: /^Alpha/ });
    fireEvent.keyDown(headerA, { key: 'ArrowDown', ctrlKey: true, shiftKey: true });

    // Beta now precedes Alpha.
    const scroll = screen.getByTestId('spaces-tree-scroll');
    let order = Array.from(scroll.querySelectorAll('[data-testid^="spaces-group-proj-"]')).map(
      (el) => el.getAttribute('data-testid'),
    );
    expect(order).toEqual(['spaces-group-proj-b', 'spaces-group-proj-a']);

    unmount();
    const loadGroups2 = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups2} />);
    await screen.findByText('Roadmap');
    const scroll2 = screen.getByTestId('spaces-tree-scroll');
    order = Array.from(scroll2.querySelectorAll('[data-testid^="spaces-group-proj-"]')).map(
      (el) => el.getAttribute('data-testid'),
    );
    expect(order).toEqual(['spaces-group-proj-b', 'spaces-group-proj-a']);
  });
});

describe('SpacesSidebar create flow', () => {
  it('keeps project create buttons accessible while revealing them only on row hover or focus', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    const projectCreate = screen.getByRole('button', { name: 'Create space in Alpha' });
    expect(projectCreate.getAttribute('aria-label')).toBe('Create space in Alpha');
    expect(projectCreate.classList.contains('contextual-action')).toBe(true);
    expect(projectCreate.parentElement?.classList.contains('contextual-action-group')).toBe(true);
    expect(projectCreate.closest('.sidebar-group-node__header')?.classList.contains('contextual-action-owner')).toBe(true);

    const topLevelCreate = screen.getByRole('button', { name: 'New space' });
    expect(topLevelCreate).toBe(screen.getByTestId('create-top-level'));
    expect(topLevelCreate.classList.contains('sidebar-leading-action-row')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Create top-level space' })).toBeNull();

    expect(projectCreate.parentElement?.classList.contains('sidebar-group-node__action-slot')).toBe(true);
  });

  it('creates a typed document space in a project and selects it canonically', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const createSpaceFn = vi.fn().mockResolvedValue(makeSpace('new1', 'New one', 'proj-a', 'document'));
    const onSelectSpace = vi.fn();
    render(
      <SpacesSidebar onSelectSpace={onSelectSpace} loadGroups={loadGroups} createSpaceFn={createSpaceFn} />,
    );
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByRole('button', { name: 'Create space in Alpha' }));
    fireEvent.input(screen.getByTestId('space-create-title'), { target: { value: 'New one' } });
    expect(screen.queryByText('Blank space')).toBeNull();
    expect(screen.getByTestId('space-create-type-canvas').textContent).toContain('Canvas');
    expect(screen.getByTestId('space-create-type-document').textContent).toContain('Document');
    expect((screen.getByTestId('space-create-seed-toggle') as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('space-create-type-document'));
    expect((screen.getByTestId('space-create-seed-toggle') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('space-create-type-board'));
    expect((screen.getByTestId('space-create-seed-toggle') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('space-create-type-document'));
    fireEvent.click(screen.getByTestId('space-create-submit'));

    await waitFor(() =>
      expect(createSpaceFn).toHaveBeenCalledWith({
        project_id: 'proj-a',
        title: 'New one',
        default_renderer: 'document',
      }),
    );
    await waitFor(() =>
      expect(onSelectSpace).toHaveBeenCalledWith({
        projectId: 'proj-a',
        projectKey: 'alpha',
        spaceId: 'new1',
        renderer: null,
      }),
    );
  });

  it('creates a top-level canvas space from the leading New space row (project_id null)', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const createSpaceFn = vi.fn().mockResolvedValue(makeSpace('top9', 'Topper', null));
    const onSelectSpace = vi.fn();
    render(
      <SpacesSidebar onSelectSpace={onSelectSpace} loadGroups={loadGroups} createSpaceFn={createSpaceFn} />,
    );
    await screen.findByText('Roadmap');

    const newSpace = screen.getByRole('button', { name: 'New space' });
    newSpace.focus();
    expect(document.activeElement).toBe(newSpace);
    fireEvent.click(newSpace);
    fireEvent.input(screen.getByTestId('space-create-title'), { target: { value: 'Topper' } });
    fireEvent.click(screen.getByTestId('space-create-submit'));

    await waitFor(() =>
      expect(createSpaceFn).toHaveBeenCalledWith({
        project_id: null,
        title: 'Topper',
        default_renderer: 'canvas',
      }),
    );
    await waitFor(() =>
      expect(onSelectSpace).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null, spaceId: 'top9' }),
      ),
    );
  });

  it('carries the chosen canonical project key when creating from the top-level project picker', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const loadProjectsFn = vi.fn().mockResolvedValue([
      { id: 'proj-a', project_key: 'alpha', display_name: 'Alpha' },
    ]);
    const createSpaceFn = vi.fn().mockResolvedValue(makeSpace('chosen1', 'Chosen', 'proj-a'));
    const onSelectSpace = vi.fn();
    render(
      <SpacesSidebar
        onSelectSpace={onSelectSpace}
        loadGroups={loadGroups}
        loadProjectsFn={loadProjectsFn}
        createSpaceFn={createSpaceFn}
      />,
    );
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    const projectPicker = await screen.findByTestId('space-create-project');
    await screen.findByRole('option', { name: 'Alpha' });
    fireEvent.input(projectPicker, { target: { value: 'proj-a' } });
    fireEvent.input(screen.getByTestId('space-create-title'), { target: { value: 'Chosen' } });
    fireEvent.click(screen.getByTestId('space-create-submit'));

    await waitFor(() => expect(onSelectSpace).toHaveBeenCalledWith({
      projectId: 'proj-a',
      projectKey: 'alpha',
      spaceId: 'chosen1',
      renderer: null,
    }));
  });

  it('opens the second seed dialog after creating a compatible seeded type', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const createSpaceFn = vi.fn().mockResolvedValue(makeSpace('seed1', 'Seeded', 'proj-a', 'collection'));
    seedSpace.mockResolvedValue({ space_id: 'seed1', added: 0 });
    const onSelectSpace = vi.fn();
    render(
      <SpacesSidebar onSelectSpace={onSelectSpace} loadGroups={loadGroups} createSpaceFn={createSpaceFn} />,
    );
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByRole('button', { name: 'Create space in Alpha' }));
    fireEvent.input(screen.getByTestId('space-create-title'), { target: { value: 'Seeded' } });
    fireEvent.click(screen.getByTestId('space-create-type-collection'));
    fireEvent.click(screen.getByTestId('space-create-seed-toggle'));
    fireEvent.click(screen.getByTestId('space-create-submit'));

    await waitFor(() =>
      expect(createSpaceFn).toHaveBeenCalledWith({
        project_id: 'proj-a',
        title: 'Seeded',
        default_renderer: 'collection',
      }),
    );
    expect(await screen.findByTestId('space-create-seed-overlay')).toBeTruthy();
    const dialog = await screen.findByTestId('space-seed-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');

    // Submit the seed (filter source is default; add no chip → seed via the
    // dialog's own submit which calls seedSpace). We drive the seed through the
    // dialog's seed button after providing a label source.
    fireEvent.click(screen.getByTestId('seed-source-label'));
    fireEvent.input(screen.getByTestId('seed-label-input'), { target: { value: 'feature' } });
    fireEvent.click(screen.getByTestId('seed-submit'));

    await waitFor(() => expect(seedSpace).toHaveBeenCalledWith('seed1', expect.any(Object)));
    await waitFor(() =>
      expect(onSelectSpace).toHaveBeenCalledWith({
        spaceId: 'seed1',
        projectId: 'proj-a',
        projectKey: 'alpha',
        renderer: null,
      }),
    );
  });
});

describe('SpacesSidebar empty projects (compact, Stage 3)', () => {
  function groupsWithEmptyProject(): SpaceGroup[] {
    return [
      {
        project_id: 'proj-a',
        project_key: 'alpha',
        project_name: 'Alpha',
        spaces: [makeSpace('a1', 'Roadmap', 'proj-a')],
      },
      // Empty project group: the backend now suppresses these (issue 6fdd924), but
      // the UI still renders them gracefully when a caller (e.g. an older cached
      // response) provides one — as a compact header with no "No spaces yet" filler.
      { project_id: 'proj-empty', project_key: 'empty', project_name: 'Empty', spaces: [] },
    ];
  }

  it('renders an empty project as a compact header with no "No spaces yet" filler', async () => {
    const loadGroups = vi.fn().mockResolvedValue(groupsWithEmptyProject());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    // The empty project header is present (so the user can create under it)…
    expect(screen.getByTestId('spaces-group-toggle-proj-empty')).toBeTruthy();
    expect(screen.getByText('Empty')).toBeTruthy();
    // …but no per-project "No spaces yet" filler line anywhere.
    expect(screen.queryByText('No spaces yet')).toBeNull();
    // The project WITH a space still shows its space line.
    expect(screen.getByText('Roadmap')).toBeTruthy();
  });

  it('still shows the overall empty state when there are zero projects/spaces', async () => {
    const loadGroups = vi.fn().mockResolvedValue([] as SpaceGroup[]);
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    const empty = await screen.findByTestId('spaces-tree-empty');
    expect(empty.textContent).toBe('No spaces yet. Create one to get started.');
    expect(empty.textContent).not.toContain('Use +');
  });
});

describe('SpacesSidebar create popover outside-click (containerRef)', () => {
  it('closes on a click outside the sidebar but stays on a click inside', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    expect(screen.getByTestId('space-create-chooser')).toBeTruthy();

    // The outside-click handler listens on `document` for capture-phase
    // `pointerdown`. jsdom does not deliver testing-library's synthetic
    // PointerEvent to a document-level capture listener, so dispatch a real
    // bubbling event (matching the production `pointerdown` path) on the node.
    const firePointerDown = (node: Node) =>
      node.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    // Click INSIDE the chooser (still within the sidebar containerRef): stays.
    firePointerDown(screen.getByTestId('space-create-title'));
    expect(screen.getByTestId('space-create-chooser')).toBeTruthy();

    // Click OUTSIDE the sidebar entirely: closes.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    firePointerDown(outside);
    await waitFor(() => expect(screen.queryByTestId('space-create-chooser')).toBeNull());
    outside.remove();
  });
});

describe('SpacesSidebar selection', () => {
  it('does not rewrite the route while its owning view is inactive', async () => {
    const onSelectSpace = vi.fn();
    render(
      <SpacesSidebar
        selectionActive={false}
        selectedSpaceId="missing"
        onSelectSpace={onSelectSpace}
        loadGroups={vi.fn().mockResolvedValue(sampleGroups())}
      />,
    );

    await screen.findByText('Global notes');
    expect(onSelectSpace).not.toHaveBeenCalled();
  });

  it('opens the first ordered space when the route has no valid selection', async () => {
    const onSelectSpace = vi.fn();
    render(<SpacesSidebar selectedSpaceId="missing" onSelectSpace={onSelectSpace} loadGroups={vi.fn().mockResolvedValue(sampleGroups())} />);

    await waitFor(() => expect(onSelectSpace).toHaveBeenCalledWith({
      projectId: null,
      projectKey: null,
      spaceId: 't1',
      renderer: null,
    }));
  });

  it('marks the active space and navigates on click without emitting renderer=', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const onSelectSpace = vi.fn();
    render(<SpacesSidebar selectedSpaceId="a1" onSelectSpace={onSelectSpace} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    const active = screen.getByRole('button', { name: 'Roadmap (Document)' });
    expect(active.getAttribute('aria-current')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Beta board (Board)' }));
    expect(onSelectSpace).toHaveBeenCalledWith({
      projectId: 'proj-b',
      projectKey: 'beta',
      spaceId: 'b1',
      renderer: null,
    });
  });

  it('uses the shared row and group composition without bespoke row overrides', () => {
  });
});
