// SpacesSidebar — the Spaces home interaction sidebar (umbrella de56ffa,
// child 6a4a69a).
//
// This is the cohesive entry point for the Spaces tab. It renders into the
// shared view-sidebar container (the `app-layout--view-sidebar-open` contract;
// see SpacesViewShell). Top-to-bottom it provides:
//   - a FIXED header row (outside the scroll region): a live search filter
//     input + the shared advanced filter/sort menu.
//   - a SCROLLING region: a leading New space action, then a top-level group
//     (null-project spaces) above the per-project foldable, drag-reorderable
//     headers, each with its own contextual create action.
//
// Create flow: each creation action opens the same typed create modal. Compatible types can opt
// into opening the seed dialog after creation. On success the new space is
// selected by navigating the URL hash (the single source of truth for selection).
//
// Per the project Dataful UX State rule:
//   - SELECTION is URL-canonical (driven from the `selectedSpaceId` prop, never
//     a separate local selection state).
//   - COLLAPSE state and project-header ORDER are browser-local view state
//     (localStorage, per workspace). They are deliberately NOT promoted to the
//     ledger — there is no project-order ledger field, and collapse is pure view
//     intent. Backend refreshes reconcile data without resetting them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSidebarReorder } from '../../hooks/useSidebarReorder';
import { useRouteLoad } from '../../app-shell';

import {
  listSpacesGrouped,
  listProjectsForPicker,
  createSpace,
  type Space,
  type SpaceGroup,
  type ProjectPickerItem,
  type SpaceRenderer,
} from '../../api';
import { SpaceSeedDialog } from './SpaceSeedDialog';
import type { SeedSpaceResult } from '../../api';
import { ViewSidebar } from '../../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../../view-sidebar-geometry';
import { SidebarSearchFilterHeader } from '../../components/shared/SidebarSearchFilterHeader';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { SidebarItemRow, SidebarLeadingActionRow } from '../../components/shared/SidebarItemRow';
import { SidebarGroupNode, SidebarNewChatIcon } from '../../components/shared/SidebarGroupNode';
import { ProjectsIcon } from '../../components/icons/TabIcons';
import { SpaceTypeIndicator, spaceTypeLabel } from './SpaceTypeIndicator';
import './SpacesSidebar.css';

const COLLAPSE_STORAGE_KEY = 'spaces-tree:collapsed';
const ORDER_STORAGE_KEY = 'spaces-tree:project-order';
const SORT_STORAGE_KEY = 'spaces-tree:space-sort';
const GROUPS_CACHE_KEY = 'spaces-tree:groups:v1';

/** Stable sentinel id for the top-level (null project) group. */
const TOP_LEVEL_GROUP_ID = '__top_level__';

export type SpacesSidebarProps = {
  /** Hide the whole sidebar (the shared view-sidebar toggle). */
  hidden?: boolean;
  /** Reconcile route selection only while the owning Spaces view is active. */
  selectionActive?: boolean;
  /** Currently selected space id (URL-canonical), or null. */
  selectedSpaceId?: string | null;
  /**
   * Navigate to open a space. Normal sidebar opens omit `renderer=` so the
   * selected Space's primary type resolves in the shell; explicit legacy
   * renderer links are owned by the route, not sidebar row clicks.
   */
  onSelectSpace: (args: {
    projectId: string | null;
    projectKey?: string | null;
    spaceId: string;
    renderer?: string | null;
  }) => void;
  /**
   * Injected loader (defaults to the real grouped read). Lets tests supply a
   * deterministic grouping without a daemon.
   */
  loadGroups?: () => Promise<SpaceGroup[]>;
  /** Injected create helper (defaults to the real `createSpace`). */
  createSpaceFn?: typeof createSpace;
  /**
   * Injected project-list loader for the space-creation project picker (issue
   * 6fdd924). Defaults to the real registry read; tests can supply a stub.
   */
  loadProjectsFn?: () => Promise<ProjectPickerItem[]>;
  /** Refresh nonce: bump to force a re-read after an external mutation. */
  refreshToken?: number;
  /** Notify the shell when grouped state already knows the selected Space. */
  onSelectedSpaceResolved?: (space: Space) => void;
};

type CreateTarget =
  | { kind: 'project'; projectId: string; projectKey: string | null; projectName: string }
  | { kind: 'top-level' };

type CreateMode = 'create' | 'seed';
type SpaceSort = 'project-order' | 'title' | 'updated';

type CreatePopover = {
  target: CreateTarget;
  mode: CreateMode;
  /** Space id created for the seed path (so SpaceSeedDialog can mount). */
  seedSpaceId?: string;
  seedProjectId?: string | null;
  seedProjectKey?: string | null;
};

const SPACE_TYPE_OPTIONS: readonly SpaceRenderer[] = ['canvas', 'document', 'board', 'collection'];
const SEED_COMPATIBLE_RENDERERS = new Set<SpaceRenderer>(['canvas', 'collection']);

function canSeedRenderer(renderer: SpaceRenderer): boolean {
  return SEED_COMPATIBLE_RENDERERS.has(renderer);
}

function loadCollapseState(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function persistCollapseState(state: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best-effort view state
  }
}

function loadOrder(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]).filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function persistOrder(order: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // best-effort view state
  }
}

function loadSpaceSort(): SpaceSort {
  if (typeof localStorage === 'undefined') return 'project-order';
  try {
    const value = localStorage.getItem(SORT_STORAGE_KEY);
    return value === 'title' || value === 'updated' ? value : 'project-order';
  } catch {
    return 'project-order';
  }
}

function persistSpaceSort(sort: SpaceSort): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort);
  } catch {
    // best-effort view state
  }
}

function sortSpaces(spaces: Space[], sort: SpaceSort): Space[] {
  if (sort === 'project-order') return spaces;
  return [...spaces].sort((left, right) => {
    if (sort === 'updated') {
      return right.updated_at - left.updated_at || left.title.localeCompare(right.title);
    }
    return left.title.localeCompare(right.title);
  });
}

function isSpaceGroupArray(value: unknown): value is SpaceGroup[] {
  return Array.isArray(value) && value.every((group) => {
    if (!group || typeof group !== 'object') return false;
    const candidate = group as Partial<SpaceGroup>;
    return Array.isArray(candidate.spaces);
  });
}

function loadCachedGroups(): SpaceGroup[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(GROUPS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return isSpaceGroupArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistGroups(groups: SpaceGroup[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(GROUPS_CACHE_KEY, JSON.stringify(groups));
  } catch {
    // best-effort view cache
  }
}

/** A group keyed for stable per-group state (collapse, order, drag). */
type KeyedGroup = { key: string; group: SpaceGroup };

function groupKey(group: SpaceGroup): string {
  return group.project_id ?? TOP_LEVEL_GROUP_ID;
}

/**
 * Apply the local drag-reorder ordering to the project groups (top-level group
 * is pinned first and never reordered). Unknown ids fall back to server order.
 */
function applyOrder(projectGroups: KeyedGroup[], order: string[]): KeyedGroup[] {
  if (order.length === 0) return projectGroups;
  const byKey = new Map(projectGroups.map((kg) => [kg.key, kg]));
  const ordered: KeyedGroup[] = [];
  for (const key of order) {
    const kg = byKey.get(key);
    if (kg) {
      ordered.push(kg);
      byKey.delete(key);
    }
  }
  // Append any groups not present in the persisted order (new projects) in
  // their server order.
  for (const kg of projectGroups) {
    if (byKey.has(kg.key)) ordered.push(kg);
  }
  return ordered;
}

export function defaultInitialSpaceId(groups: readonly SpaceGroup[]): string | null {
  const topLevel = groups.find((group) => group.project_id === null);
  const projectGroups = groups
    .filter((group) => group.project_id !== null)
    .map((group) => ({ key: groupKey(group), group }));
  const orderedProjects = applyOrder(projectGroups, loadOrder());
  return topLevel?.spaces[0]?.id
    ?? orderedProjects.flatMap(({ group }) => group.spaces)[0]?.id
    ?? null;
}

const PlusIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
  </svg>
);

export function SpacesSidebar({
  hidden = false,
  selectionActive = true,
  selectedSpaceId = null,
  onSelectSpace,
  loadGroups = listSpacesGrouped,
  createSpaceFn = createSpace,
  loadProjectsFn = listProjectsForPicker,
  refreshToken,
  onSelectedSpaceResolved,
}: SpacesSidebarProps): JSX.Element | null {
  const [groups, setGroups] = useState<SpaceGroup[]>(() => loadCachedGroups());
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [spaceSort, setSpaceSort] = useState<SpaceSort>(() => loadSpaceSort());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapseState());
  const [order, setOrder] = useState<string[]>(() => loadOrder());
  const [popover, setPopover] = useState<CreatePopover | null>(null);
  const [blankTitle, setBlankTitle] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createRenderer, setCreateRenderer] = useState<SpaceRenderer>('canvas');
  const [seedAfterCreate, setSeedAfterCreate] = useState(false);
  const [internalRefresh, setInternalRefresh] = useState(0);
  // Project picker for the "top-level" create chooser (issue 6fdd924). Loaded
  // lazily from the registry when the chooser opens so projects with zero spaces
  // are still enumerable. `chooserProjectId === null` means "top-level (no project)".
  const [chooserProjects, setChooserProjects] = useState<ProjectPickerItem[]>([]);
  const [chooserProjectId, setChooserProjectId] = useState<string | null>(null);
  const chooserProjectKeyRef = useRef<string | null>(null);

  const containerRef = useRef<HTMLElement>(null);
  const lastFallbackSelectionRef = useRef<string | null>(null);

  // --- data load (grouped read) ---
  useRouteLoad((registerInitialRouteLoad) => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    const initialLoad = loadGroups()
      .then((next) => {
        if (active) {
          setGroups(next);
          persistGroups(next);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    registerInitialRouteLoad(initialLoad);
    return () => {
      active = false;
    };
  }, [internalRefresh, loadGroups, refreshToken]);

  const refresh = useCallback(() => setInternalRefresh((n) => n + 1), []);

  useEffect(() => {
    if (!selectedSpaceId || !onSelectedSpaceResolved) return;
    for (const group of groups) {
      for (const space of group.spaces) {
        if (space.id === selectedSpaceId) {
          onSelectedSpaceResolved(space);
          return;
        }
      }
    }
  }, [groups, selectedSpaceId, onSelectedSpaceResolved]);

  // --- close create popover on outside pointer / Escape ---
  useEffect(() => {
    if (!popover) return undefined;
    const onPointer = (event: PointerEvent) => {
      const node = containerRef.current;
      if (!node || node.contains(event.target as Node)) return;
      setPopover(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopover(null);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [popover]);

  // Split the server groups into the top-level group + the project groups.
  const { topLevelGroup, projectGroups } = useMemo(() => {
    let top: SpaceGroup | null = null;
    const projects: KeyedGroup[] = [];
    for (const group of groups) {
      if (group.project_id === null) {
        top = group;
      } else {
        projects.push({ key: groupKey(group), group });
      }
    }
    return { topLevelGroup: top, projectGroups: projects };
  }, [groups]);

  const orderedProjectGroups = useMemo(
    () => applyOrder(projectGroups, order),
    [projectGroups, order],
  );

  useEffect(() => {
    if (!loaded || !selectionActive) return;
    const allSpaces = [
      ...(topLevelGroup?.spaces ?? []),
      ...orderedProjectGroups.flatMap(({ group }) => group.spaces),
    ];
    if (selectedSpaceId) {
      lastFallbackSelectionRef.current = null;
      return;
    }
    if (allSpaces.length === 0) return;
    const fallback = allSpaces[0];
    if (lastFallbackSelectionRef.current === fallback.id) return;
    lastFallbackSelectionRef.current = fallback.id;
    const owner = fallback.project_id === null
      ? null
      : orderedProjectGroups.find(({ group }) => group.project_id === fallback.project_id)?.group ?? null;
    onSelectSpace({
      projectId: fallback.project_id,
      projectKey: owner?.project_key ?? null,
      spaceId: fallback.id,
      renderer: null,
    });
  }, [loaded, onSelectSpace, orderedProjectGroups, selectedSpaceId, selectionActive, topLevelGroup]);

  // --- live filter (case-insensitive substring over project + space names) ---
  const needle = filter.trim().toLowerCase();
  const matchSpace = useCallback(
    (space: Space) => !needle || space.title.toLowerCase().includes(needle),
    [needle],
  );

  const filteredTopLevel = useMemo(() => {
    if (!topLevelGroup) return [] as Space[];
    const spaces = needle ? topLevelGroup.spaces.filter(matchSpace) : topLevelGroup.spaces;
    return sortSpaces(spaces, spaceSort);
  }, [topLevelGroup, needle, matchSpace, spaceSort]);

  const filteredProjectGroups = useMemo(() => {
    return orderedProjectGroups
      .map((kg) => {
        const projectMatches = (kg.group.project_name ?? '').toLowerCase().includes(needle);
        // A project header stays visible if its name matches (then show all its
        // spaces) or any of its spaces match (then show only the matches).
        const visibleSpaces = !needle || projectMatches ? kg.group.spaces : kg.group.spaces.filter(matchSpace);
        const spaces = sortSpaces(visibleSpaces, spaceSort);
        if (!projectMatches && spaces.length === 0) return null;
        return { key: kg.key, group: { ...kg.group, spaces } } as KeyedGroup;
      })
      .filter((kg): kg is KeyedGroup => kg !== null);
  }, [orderedProjectGroups, needle, matchSpace, spaceSort]);

  const updateSpaceSort = useCallback((next: SpaceSort) => {
    setSpaceSort(next);
    persistSpaceSort(next);
  }, []);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      persistCollapseState(next);
      return next;
    });
  }, []);

  const projectReorder = useSidebarReorder({
    ids: orderedProjectGroups.map((group) => group.key),
    disabled: Boolean(needle),
    label: (id) => orderedProjectGroups.find((group) => group.key === id)?.group.project_name ?? id,
    onCommit: (ids) => {
      setOrder(ids);
      persistOrder(ids);
    },
  });

  // --- create affordance ---
  const openChooser = useCallback(
    (target: CreateTarget) => {
      setBlankTitle('');
      setCreateError(null);
      setChooserProjectId(null);
      chooserProjectKeyRef.current = null;
      setCreateRenderer('canvas');
      setSeedAfterCreate(false);
      setPopover({ target, mode: 'create' });
      // For the top-level kind, eagerly load projects from the registry so the
      // user can pick a project for their first space in that project (issue
      // 6fdd924). Project-scoped buttons don't need the picker.
      if (target.kind === 'top-level') {
        loadProjectsFn()
          .then(setChooserProjects)
          .catch(() => setChooserProjects([]));
      }
    },
    [loadProjectsFn],
  );

  const doCreate = useCallback(
    async (target: CreateTarget, title: string, renderer: SpaceRenderer, shouldSeed: boolean) => {
      const trimmed = title.trim();
      if (!trimmed || creating) return;
      setCreating(true);
      setCreateError(null);
      try {
        // For the top-level chooser, respect the user's project selection from the
        // registry picker. A null chooserProjectId means "create as top-level".
        const projectId =
          target.kind === 'project' ? target.projectId : chooserProjectId;
        const projectKey = target.kind === 'project'
          ? target.projectKey
          : chooserProjectKeyRef.current;
        const space = await createSpaceFn({ project_id: projectId, title: trimmed, default_renderer: renderer });
        if (shouldSeed && canSeedRenderer(renderer)) {
          setPopover({
            target,
            mode: 'seed',
            seedSpaceId: space.id,
            seedProjectId: space.project_id,
            seedProjectKey: projectKey,
          });
        } else {
          setPopover(null);
          refresh();
          onSelectSpace({
            projectId: space.project_id,
            projectKey,
            spaceId: space.id,
            renderer: null,
          });
        }
      } catch (error: unknown) {
        setCreateError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreating(false);
      }
    },
    [creating, createSpaceFn, chooserProjectId, refresh, onSelectSpace],
  );

  const handleSeeded = useCallback(
    (_result: SeedSpaceResult) => {
      const current = popover;
      setPopover(null);
      refresh();
      if (current?.seedSpaceId) {
        onSelectSpace({
          projectId: current.seedProjectId ?? null,
          projectKey: current.seedProjectKey ?? null,
          spaceId: current.seedSpaceId,
          renderer: null,
        });
      }
    },
    [popover, refresh, onSelectSpace],
  );

  const handleSeedClose = useCallback(() => {
    // The empty space already exists; just dismiss + refresh so it appears.
    setPopover(null);
    refresh();
  }, [refresh]);

  const renderSpaceRow = (space: Space, projectKey: string | null = null): JSX.Element => {
    const active = selectedSpaceId === space.id;
    const title = space.title || 'Untitled space';
    return (
      <SidebarItemRow
        key={space.id}
        className="spaces-tree__space"
        label={title}
        selectionLabel={`${title} (${spaceTypeLabel(space.default_renderer)})`}
        selected={active}
        ariaCurrent={active ? 'true' : undefined}
        leading={(
          <SpaceTypeIndicator
            renderer={space.default_renderer}
            className="spaces-tree__space-type"
            data-testid={`space-row-type-${space.id}`}
          />
        )}
        onSelect={() =>
          onSelectSpace({
            projectId: space.project_id,
            projectKey,
            spaceId: space.id,
            renderer: null,
          })
        }
      />
    );
  };

  const renderChooser = (): JSX.Element | null => {
    if (!popover || popover.mode !== 'create') return null;
    const target = popover.target;
    const isTopLevel = target.kind === 'top-level';
    const label = target.kind === 'top-level'
      ? 'New space'
      : `New space in ${target.projectName}`;
    const selectedTypeLabel = spaceTypeLabel(createRenderer);
    const seedCompatible = canSeedRenderer(createRenderer);
    const createWithSeed = seedCompatible && seedAfterCreate;
    return (
      <div className="spaces-tree__chooser" role="dialog" aria-label={label} data-testid="space-create-chooser">
        <div className="spaces-tree__chooser-title">{label}</div>
        {createError && <DetailPaneNotice severity="error" density="compact" testId="space-create-error">{createError}</DetailPaneNotice>}
        <label className="spaces-tree__chooser-field">
          <span>Title</span>
          <input
            type="text"
            value={blankTitle}
            autoFocus
            data-testid="space-create-title"
            placeholder="Space title"
            onInput={(event) => setBlankTitle((event.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && blankTitle.trim()) {
                void doCreate(popover.target, blankTitle, createRenderer, createWithSeed);
              }
            }}
          />
        </label>
        <div className="spaces-tree__chooser-field">
          <span>Type</span>
          <div className="spaces-tree__type-options" role="group" aria-label="Space type">
            {SPACE_TYPE_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                className="spaces-tree__type-option"
                data-active={createRenderer === value}
                data-testid={`space-create-type-${value}`}
                aria-pressed={createRenderer === value}
                onClick={() => {
                  setCreateRenderer(value);
                  if (!canSeedRenderer(value)) {
                    setSeedAfterCreate(false);
                  }
                }}
              >
                <SpaceTypeIndicator renderer={value} showLabel className="spaces-tree__type-indicator" />
              </button>
            ))}
          </div>
        </div>
        <label className="spaces-tree__seed-option" data-disabled={seedCompatible ? 'false' : 'true'}>
          <input
            type="checkbox"
            checked={seedAfterCreate}
            disabled={!seedCompatible}
            data-testid="space-create-seed-toggle"
            onChange={(event) => setSeedAfterCreate((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>Seed after creation</span>
        </label>
        {/* Project picker: only shown for the top-level create button (issue 6fdd924).
            Lets the user place the new space in any project from the registry, including
            projects that own zero existing spaces. Default (empty value) = top-level. */}
        {isTopLevel ? (
          <label className="spaces-tree__chooser-field">
            <span>Project</span>
            <select
              className="spaces-tree__chooser-select"
              data-testid="space-create-project"
              value={chooserProjectId ?? ''}
              onInput={(event) => {
                const val = (event.currentTarget as HTMLSelectElement).value;
                setChooserProjectId(val || null);
                chooserProjectKeyRef.current =
                  chooserProjects.find((project) => project.id === val)?.project_key ?? null;
              }}
            >
              <option value="">Top level (no project)</option>
              {chooserProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name || p.project_key || p.id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="spaces-tree__chooser-actions">
          <button
            type="button"
            className="spaces-tree__chooser-action"
            disabled={!blankTitle.trim() || creating}
            data-testid="space-create-submit"
            onClick={() => void doCreate(popover.target, blankTitle, createRenderer, createWithSeed)}
          >
            {creating
              ? 'Creating...'
              : createWithSeed
                ? `Create and seed ${selectedTypeLabel}`
                : `Create ${selectedTypeLabel}`}
          </button>
        </div>
      </div>
    );
  };

  const renderSeedDialog = (): JSX.Element | null => {
    if (!popover || popover.mode !== 'seed' || !popover.seedSpaceId) return null;
    return (
      <div className="spaces-tree__seed-overlay" data-testid="space-create-seed-overlay">
        <SpaceSeedDialog
          spaceId={popover.seedSpaceId}
          projectId={popover.seedProjectId ?? ''}
          onSeeded={handleSeeded}
          onClose={handleSeedClose}
        />
      </div>
    );
  };

  // FIXED header row (the container renders it as `.view-sidebar__header`,
  // outside the single scroll owner `.view-sidebar__body`).
  const header = (
    <>
    <SidebarSearchFilterHeader
      value={filter}
      onValueChange={setFilter}
      placeholder="Filter spaces..."
      searchAriaLabel="Filter spaces"
      clearAriaLabel="Clear spaces filter"
      inputType="text"
      filterTrigger={{
        ariaLabel: 'Space filter and sort options',
        title: 'Space filter and sort options',
        kind: 'menu',
        open: filterMenuOpen,
        active: spaceSort !== 'project-order',
        count: spaceSort !== 'project-order' ? 1 : 0,
        onToggle: () => setFilterMenuOpen((open) => !open),
      }}
      panel={filterMenuOpen ? {
        id: 'spaces-filter-sort-panel',
        role: 'menu',
        ariaLabel: 'Space filter and sort options',
        onDismiss: () => setFilterMenuOpen(false),
        children: (
          <div className="sidebar-search-filter__section">
            <span className="sidebar-search-filter__label">Space order</span>
            <div className="sidebar-search-filter__options" role="group" aria-label="Space order">
              {([
                ['project-order', 'Project order'],
                ['title', 'Name'],
                ['updated', 'Recently updated'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={spaceSort === value}
                  className={`sidebar-search-filter__option${spaceSort === value ? ' sidebar-search-filter__option--active' : ''}`}
                  onClick={() => updateSpaceSort(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ),
      } : undefined}
      testId="spaces-sidebar"
      inputTestId="spaces-filter-input"
    />
    {loadError && <DetailPaneNotice severity="error" density="compact" title="Spaces could not be loaded" testId="spaces-tree-error">{loadError}</DetailPaneNotice>}
    </>
  );

  return (
    <ViewSidebar
      hidden={hidden}
      {...VIEW_SIDEBAR_GEOMETRY.spaces}
      ariaLabel="Spaces"
      className="spaces-tree"
      as="div"
      containerRef={containerRef}
      header={header}
    >
      {/* SCROLLING region — the `.view-sidebar__body` owns overflow; this just
          carries the test-id + content padding (no own scroll, no double bar). */}
      <div className="spaces-tree__scroll" data-testid="spaces-tree-scroll" {...projectReorder.list}>
        {/* keep test-id + content; scroll lives on .view-sidebar__body */}
        <SidebarLeadingActionRow
          label="New space"
          icon={<SidebarNewChatIcon size={16} />}
          testId="create-top-level"
          onPress={() => openChooser({ kind: 'top-level' })}
        />
        {projectReorder.assistive}

        {loading && groups.length === 0 ? (
          <p className="spaces-tree__status">Loading spaces…</p>
        ) : null}

        {/* TOP-LEVEL GROUP (null-project spaces) above the project headers. */}
        {filteredTopLevel.length > 0 ? (
          <div className="spaces-tree__group spaces-tree__group--top" data-testid="spaces-group-top-level">
            <div className="spaces-tree__group-label">Top level</div>
            <div className="spaces-tree__group-spaces">
              {filteredTopLevel.map((space) => renderSpaceRow(space))}
            </div>
          </div>
        ) : null}

        {/* FOLDABLE, DRAG-REORDERABLE PROJECT HEADERS */}
        {filteredProjectGroups.map((kg) => {
          const isCollapsed = Boolean(collapsed[kg.key]) && !needle;
          const projectName = kg.group.project_name ?? 'Project';
          return (
            <SidebarGroupNode
              key={kg.key}
              id={`spaces-group-${kg.key}`}
              presentation="folder"
              label={projectName}
              count={kg.group.spaces.length}
              countLabel={`${kg.group.spaces.length} space${kg.group.spaces.length === 1 ? '' : 's'} in ${projectName}`}
              countVisibility="interaction"
              expanded={!isCollapsed}
              onToggle={() => toggleCollapse(kg.key)}
              leadingIcon={<ProjectsIcon size={13} />}
              testIds={{
                root: `spaces-group-${kg.key}`,
                heading: `spaces-group-toggle-${kg.key}`,
                action: `create-in-${kg.key}`,
              }}
              action={{
                label: `Create space in ${projectName}`,
                icon: <PlusIcon />,
                onPress: () => openChooser({
                  kind: 'project',
                  projectId: kg.key,
                  projectKey: kg.group.project_key,
                  projectName,
                }),
              }}
              reorder={projectReorder.binding(kg.key)}
            >
              {kg.group.spaces.map((space) => renderSpaceRow(space, kg.group.project_key))}
            </SidebarGroupNode>
          );
        })}

        {!loading
          && !loadError
          && filteredTopLevel.length === 0
          && filteredProjectGroups.length === 0 ? (
          <p className="spaces-tree__status" data-testid="spaces-tree-empty">
            {needle ? 'No spaces match.' : 'No spaces yet. Create one to get started.'}
          </p>
        ) : null}
      </div>

      {/* Popover/overlay stay INSIDE the frame so the containerRef-based
          outside-click handler treats clicks within them as "inside". */}
      {renderChooser()}
      {renderSeedDialog()}
    </ViewSidebar>
  );
}

export default SpacesSidebar;
