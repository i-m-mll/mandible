// Spaces home sidebar tests (umbrella de56ffa, child 6a4a69a).
//
// Covers the cohesive Spaces-home interaction the sidebar owns: grouped tree
// render (top-level group above project headers, typed space lines), live
// filter, foldable headers, drag-reorder persistence, the bare "+" typed create
// flow (including optional post-create seeding), selection navigation, and the
// sidebarHidden contract.
import { readFileSync } from 'node:fs';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

// Mock the seed POST so the SpaceSeedDialog mount path doesn't hit a daemon.
const seedSpace = vi.fn();
vi.mock('../ui/src/api', async (importActual) => {
  const actual = await importActual<typeof import('../ui/src/api')>();
  return {
    ...actual,
    seedSpace: (...args: unknown[]) => seedSpace(...args),
  };
});

import { SpacesSidebar } from '../ui/src/views/spaces/SpacesSidebar';
import type { Space, SpaceGroup } from '../ui/src/api';

const spacesSidebarStylesheet = readFileSync('ui/src/views/spaces/SpacesSidebar.css', 'utf8');

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
    expect(screen.getByTestId('space-row-type-t1').getAttribute('aria-label')).toBe('Canvas space type');
    expect(screen.getByTestId('space-row-type-a1').getAttribute('aria-label')).toBe('Document space type');
    expect(screen.getByTestId('space-row-type-b1').getAttribute('aria-label')).toBe('Board space type');
    expect(screen.getByTestId('space-row-type-t1').textContent).toBe('');

    // Top-level group sits above the first project group in DOM order.
    const scroll = screen.getByTestId('spaces-tree-scroll');
    const topIdx = Array.from(scroll.children).indexOf(screen.getByTestId('spaces-group-top-level'));
    const alphaIdx = Array.from(scroll.children).indexOf(screen.getByTestId('spaces-group-proj-a'));
    expect(topIdx).toBeGreaterThanOrEqual(0);
    expect(topIdx).toBeLessThan(alphaIdx);
  });

  it('renders nothing when hidden', () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const { container } = render(<SpacesSidebar hidden onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    expect(container.querySelector('[data-testid="spaces-sidebar"]')).toBeNull();
    expect(loadGroups).not.toHaveBeenCalled();
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
});

describe('SpacesSidebar foldable headers', () => {
  it('collapses and expands a project header independent of filter', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByTestId('spaces-group-toggle-proj-a'));
    expect(screen.queryByText('Roadmap')).toBeNull();
    fireEvent.click(screen.getByTestId('spaces-group-toggle-proj-a'));
    expect(screen.getByText('Roadmap')).toBeTruthy();
  });
});

describe('SpacesSidebar drag-reorder', () => {
  it('reorders project headers and persists the order across remount', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const { unmount } = render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    const headerA = screen.getByTestId('spaces-group-header-proj-a');
    const headerB = screen.getByTestId('spaces-group-header-proj-b');
    fireEvent.dragStart(headerA);
    fireEvent.dragOver(headerB);
    fireEvent.drop(headerB);

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

    const projectCreate = screen.getByTestId('create-in-proj-a');
    expect(projectCreate.getAttribute('aria-label')).toBe('Create space in Alpha');

    const topLevelCreate = screen.getByTestId('create-top-level');
    expect(topLevelCreate.getAttribute('aria-label')).toBe('Create top-level space');

    expect(spacesSidebarStylesheet).toMatch(
      /\.spaces-tree__group-header\s+\.spaces-tree__create\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(spacesSidebarStylesheet).toMatch(
      /\.spaces-tree__group-header:hover\s+\.spaces-tree__create,\s*\.spaces-tree__group-header:focus-within\s+\.spaces-tree__create\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
    );
    expect(spacesSidebarStylesheet).not.toMatch(
      /\.spaces-tree__header\s+\.spaces-tree__create\s*\{[^}]*opacity:\s*0;/s,
    );
  });

  it('creates a typed document space in a project and selects it canonically', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const createSpaceFn = vi.fn().mockResolvedValue(makeSpace('new1', 'New one', 'proj-a', 'document'));
    const onSelectSpace = vi.fn();
    render(
      <SpacesSidebar onSelectSpace={onSelectSpace} loadGroups={loadGroups} createSpaceFn={createSpaceFn} />,
    );
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByTestId('create-in-proj-a'));
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
        spaceId: 'new1',
        renderer: null,
      }),
    );
  });

  it('creates a top-level canvas space from the search-bar + (project_id null)', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const createSpaceFn = vi.fn().mockResolvedValue(makeSpace('top9', 'Topper', null));
    const onSelectSpace = vi.fn();
    render(
      <SpacesSidebar onSelectSpace={onSelectSpace} loadGroups={loadGroups} createSpaceFn={createSpaceFn} />,
    );
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByTestId('create-top-level'));
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

  it('opens the second seed dialog after creating a compatible seeded type', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const createSpaceFn = vi.fn().mockResolvedValue(makeSpace('seed1', 'Seeded', 'proj-a', 'collection'));
    seedSpace.mockResolvedValue({ space_id: 'seed1', added: 0 });
    const onSelectSpace = vi.fn();
    render(
      <SpacesSidebar onSelectSpace={onSelectSpace} loadGroups={loadGroups} createSpaceFn={createSpaceFn} />,
    );
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByTestId('create-in-proj-a'));
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
      expect(onSelectSpace).toHaveBeenCalledWith(
        expect.objectContaining({ spaceId: 'seed1', projectId: 'proj-a' }),
      ),
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
    expect(screen.getByTestId('spaces-group-header-proj-empty')).toBeTruthy();
    expect(screen.getByText('Empty')).toBeTruthy();
    // …but no per-project "No spaces yet" filler line anywhere.
    expect(screen.queryByText('No spaces yet')).toBeNull();
    // The project WITH a space still shows its space line.
    expect(screen.getByText('Roadmap')).toBeTruthy();
  });

  it('still shows the overall empty state when there are zero projects/spaces', async () => {
    const loadGroups = vi.fn().mockResolvedValue([] as SpaceGroup[]);
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    expect(await screen.findByTestId('spaces-tree-empty')).toBeTruthy();
  });
});

describe('SpacesSidebar create popover outside-click (containerRef)', () => {
  it('closes on a click outside the sidebar but stays on a click inside', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    fireEvent.click(screen.getByTestId('create-top-level'));
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
  it('marks the active space and navigates on click without emitting renderer=', async () => {
    const loadGroups = vi.fn().mockResolvedValue(sampleGroups());
    const onSelectSpace = vi.fn();
    render(<SpacesSidebar selectedSpaceId="a1" onSelectSpace={onSelectSpace} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');

    const active = screen.getByTestId('space-row-a1');
    expect(active.getAttribute('aria-current')).toBe('true');

    fireEvent.click(screen.getByTestId('space-row-b1'));
    expect(onSelectSpace).toHaveBeenCalledWith({
      projectId: 'proj-b',
      spaceId: 'b1',
      renderer: null,
    });
  });

  it('keeps project child rows aligned with project title text without bolding selection', () => {
    expect(spacesSidebarStylesheet).toMatch(
      /\.spaces-tree__space\s*\{[^}]*padding:\s*0\.28rem 0\.75rem 0\.28rem 2rem;/s,
    );
    expect(spacesSidebarStylesheet).toMatch(
      /\.spaces-tree__space\s*\{[^}]*font-weight:\s*400;/s,
    );
    expect(spacesSidebarStylesheet).toMatch(/\.spaces-tree__space--active\s*\{[^}]*background:\s*var\(--overlay-selected\)/s);
    expect(spacesSidebarStylesheet).not.toMatch(
      /\.spaces-tree__space--active\s*\{[^}]*font-weight:\s*600/s,
    );
  });
});
