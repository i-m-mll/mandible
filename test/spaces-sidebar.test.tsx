// Spaces home sidebar tests (umbrella de56ffa, child 6a4a69a).
//
// Covers the cohesive Spaces-home interaction the sidebar owns: grouped tree
// render (top-level group above project headers, typed space lines), live
// filter/sort menu, foldable headers, drag-reorder persistence, the shared leading action typed create
// flow (including optional post-create seeding), selection navigation, and the
// sidebarHidden contract.

import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const spaceOrder = (group: HTMLElement) =>
  within(group).getAllByText(/^(Backlog|Roadmap)$/).map((node) => node.textContent);

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
});

describe('SpacesSidebar live filter', () => {
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
    expect(spaceOrder(alpha))
      .toEqual(['Backlog', 'Roadmap']);

    rerender(<SpacesSidebar refreshToken={1} onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await waitFor(() => expect(loadGroups).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId('spaces-filter-input') as HTMLInputElement).value).toBe('a');
    expect(spaceOrder(screen.getByTestId('spaces-group-proj-a')))
      .toEqual(['Backlog', 'Roadmap']);

    unmount();
    render(<SpacesSidebar onSelectSpace={vi.fn()} loadGroups={loadGroups} />);
    await screen.findByText('Roadmap');
    expect(spaceOrder(screen.getByTestId('spaces-group-proj-a')))
      .toEqual(['Backlog', 'Roadmap']);
    fireEvent.click(screen.getByRole('button', { name: 'Space filter and sort options' }));
    expect(screen.getByRole('menuitemradio', { name: 'Name' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('SpacesSidebar foldable headers', () => {
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
});
