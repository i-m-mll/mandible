// SpacesSidebar — the Spaces home interaction sidebar (umbrella de56ffa,
// child 6a4a69a).
//
// This is the cohesive entry point for the Spaces tab. It renders into the
// shared view-sidebar container (the `app-layout--view-sidebar-open` contract;
// see SpacesViewShell). Top-to-bottom it provides:
//   - a FIXED header row (outside the scroll region): a live search filter
//     input + a bare "+" icon that creates a TOP-LEVEL (null-project) space.
//   - a SCROLLING region: a top-level group (null-project spaces) above the
//     per-project foldable, drag-reorderable headers, each with its own bare
//     "+" create icon. Spaces render as single name-only lines.
//
// Create flow: each "+" opens a typed create modal. Compatible types can opt
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
import { SidebarSearchFilterHeader } from '../../components/shared/SidebarSearchFilterHeader';
import { SpaceTypeIndicator, spaceTypeLabel } from './SpaceTypeIndicator';
import './SpacesSidebar.css';

const COLLAPSE_STORAGE_KEY = 'spaces-tree:collapsed';
const ORDER_STORAGE_KEY = 'spaces-tree:project-order';
const GROUPS_CACHE_KEY = 'spaces-tree:groups:v1';

/** Stable sentinel id for the top-level (null project) group. */
const TOP_LEVEL_GROUP_ID = '__top_level__';

export type SpacesSidebarProps = {
  /** Hide the whole sidebar (the shared view-sidebar toggle). */
  hidden?: boolean;
  /** Currently selected space id (URL-canonical), or null. */
  selectedSpaceId?: string | null;
  /**
   * Navigate to open a space. Normal sidebar opens omit `renderer=` so the
   * selected Space's primary type resolves in the shell; explicit legacy
   * renderer links are owned by the route, not sidebar row clicks.
   */
  onSelectSpace: (args: { projectId: string | null; spaceId: string; renderer?: string | null }) => void;
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
  | { kind: 'project'; projectId: string; projectName: string }
  | { kind: 'top-level' };

type CreateMode = 'create' | 'seed';

type CreatePopover = {
  target: CreateTarget;
  mode: CreateMode;
  /** Space id created for the seed path (so SpaceSeedDialog can mount). */
  seedSpaceId?: string;
  seedProjectId?: string | null;
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

const PlusIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
  </svg>
);

const CaretIcon = ({ open }: { open: boolean }): JSX.Element => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    aria-hidden="true"
    focusable="false"
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.12s' }}
  >
    <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" />
  </svg>
);

export function SpacesSidebar({
  hidden = false,
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapseState());
  const [order, setOrder] = useState<string[]>(() => loadOrder());
  const [dragKey, setDragKey] = useState<string | null>(null);
  // Mirror dragKey in a ref so the drop handler reads the live source without
  // nesting one setState updater inside another (which preact may batch/drop).
  const dragKeyRef = useRef<string | null>(null);
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

  const containerRef = useRef<HTMLElement>(null);

  // --- data load (grouped read) ---
  useEffect(() => {
    if (hidden) return undefined;
    let active = true;
    setLoading(true);
    setLoadError(null);
    loadGroups()
      .then((next) => {
        if (active) {
          setGroups(next);
          persistGroups(next);
        }
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [hidden, loadGroups, refreshToken, internalRefresh]);

  const refresh = useCallback(() => setInternalRefresh((n) => n + 1), []);

  useEffect(() => {
    if (!selectedSpaceId || !onSelectedSpaceResolved) return;
    for (const group of groups) {
      const match = group.spaces.find((space) => space.id === selectedSpaceId);
      if (match) {
        onSelectedSpaceResolved(match);
        return;
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

  // --- live filter (case-insensitive substring over project + space names) ---
  const needle = filter.trim().toLowerCase();
  const matchSpace = useCallback(
    (space: Space) => !needle || space.title.toLowerCase().includes(needle),
    [needle],
  );

  const filteredTopLevel = useMemo(() => {
    if (!topLevelGroup) return [] as Space[];
    if (!needle) return topLevelGroup.spaces;
    return topLevelGroup.spaces.filter(matchSpace);
  }, [topLevelGroup, needle, matchSpace]);

  const filteredProjectGroups = useMemo(() => {
    if (!needle) return orderedProjectGroups;
    return orderedProjectGroups
      .map((kg) => {
        const projectMatches = (kg.group.project_name ?? '').toLowerCase().includes(needle);
        // A project header stays visible if its name matches (then show all its
        // spaces) or any of its spaces match (then show only the matches).
        const spaces = projectMatches ? kg.group.spaces : kg.group.spaces.filter(matchSpace);
        if (!projectMatches && spaces.length === 0) return null;
        return { key: kg.key, group: { ...kg.group, spaces } } as KeyedGroup;
      })
      .filter((kg): kg is KeyedGroup => kg !== null);
  }, [orderedProjectGroups, needle, matchSpace]);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      persistCollapseState(next);
      return next;
    });
  }, []);

  // --- drag reorder of project headers ---
  const beginDrag = useCallback((key: string) => {
    dragKeyRef.current = key;
    setDragKey(key);
  }, []);

  const endDrag = useCallback(() => {
    dragKeyRef.current = null;
    setDragKey(null);
  }, []);

  const handleDrop = useCallback(
    (targetKey: string) => {
      const sourceKey = dragKeyRef.current;
      endDrag();
      if (!sourceKey || sourceKey === targetKey) return;
      // Compute the next order from the current displayed (ordered) groups.
      const currentKeys = orderedProjectGroups.map((kg) => kg.key);
      const from = currentKeys.indexOf(sourceKey);
      const to = currentKeys.indexOf(targetKey);
      if (from === -1 || to === -1) return;
      const nextKeys = [...currentKeys];
      nextKeys.splice(from, 1);
      nextKeys.splice(to, 0, sourceKey);
      setOrder(nextKeys);
      persistOrder(nextKeys);
    },
    [orderedProjectGroups, endDrag],
  );

  // --- create affordance ---
  const openChooser = useCallback(
    (target: CreateTarget) => {
      setBlankTitle('');
      setCreateError(null);
      setChooserProjectId(null);
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
        const space = await createSpaceFn({ project_id: projectId, title: trimmed, default_renderer: renderer });
        if (shouldSeed && canSeedRenderer(renderer)) {
          setPopover({
            target,
            mode: 'seed',
            seedSpaceId: space.id,
            seedProjectId: space.project_id,
          });
        } else {
          setPopover(null);
          refresh();
          onSelectSpace({
            projectId: space.project_id,
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

  const renderSpaceRow = (space: Space): JSX.Element => {
    const active = selectedSpaceId === space.id;
    return (
      <button
        key={space.id}
        type="button"
        className={`spaces-tree__space${active ? ' spaces-tree__space--active' : ''}`}
        aria-current={active ? 'true' : undefined}
        aria-label={`${space.title || 'Untitled space'} (${spaceTypeLabel(space.default_renderer)})`}
        data-testid={`space-row-${space.id}`}
        onClick={() =>
          onSelectSpace({
            projectId: space.project_id,
            spaceId: space.id,
            renderer: null,
          })
        }
      >
        <SpaceTypeIndicator
          renderer={space.default_renderer}
          className="spaces-tree__space-type"
          data-testid={`space-row-type-${space.id}`}
        />
        <span className="spaces-tree__space-title">{space.title || 'Untitled space'}</span>
      </button>
    );
  };

  const createButton = (target: CreateTarget, ariaLabel: string, testId: string): JSX.Element => (
    <button
      type="button"
      className="spaces-tree__create"
      aria-label={ariaLabel}
      title={ariaLabel}
      data-testid={testId}
      onClick={(event) => {
        event.stopPropagation();
        openChooser(target);
      }}
    >
      <PlusIcon />
    </button>
  );

  const renderChooser = (): JSX.Element | null => {
    if (!popover || popover.mode !== 'create') return null;
    const isTopLevel = popover.target.kind === 'top-level';
    const label = isTopLevel
      ? 'New space'
      : `New space in ${popover.target.projectName}`;
    const selectedTypeLabel = spaceTypeLabel(createRenderer);
    const seedCompatible = canSeedRenderer(createRenderer);
    const createWithSeed = seedCompatible && seedAfterCreate;
    return (
      <div className="spaces-tree__chooser" role="dialog" aria-label={label} data-testid="space-create-chooser">
        <div className="spaces-tree__chooser-title">{label}</div>
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
              onChange={(event) => {
                const val = (event.currentTarget as HTMLSelectElement).value;
                setChooserProjectId(val || null);
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
        {createError ? (
          <p className="spaces-tree__chooser-error" role="alert" data-testid="space-create-error">
            {createError}
          </p>
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
    <SidebarSearchFilterHeader
      value={filter}
      onValueChange={setFilter}
      placeholder="Filter spaces..."
      searchAriaLabel="Filter spaces"
      clearAriaLabel="Clear spaces filter"
      inputType="text"
      actionSlot={createButton({ kind: 'top-level' }, 'Create top-level space', 'create-top-level')}
      testId="spaces-sidebar"
      inputTestId="spaces-filter-input"
    />
  );

  return (
    <ViewSidebar
      hidden={hidden}
      storageKey="sidebar-width:spaces"
      defaultWidth={300}
      minWidth={220}
      ariaLabel="Spaces"
      className="spaces-tree"
      as="div"
      containerRef={containerRef}
      header={header}
    >
      {/* SCROLLING region — the `.view-sidebar__body` owns overflow; this just
          carries the test-id + content padding (no own scroll, no double bar). */}
      <div className="spaces-tree__scroll" data-testid="spaces-tree-scroll">
        {/* keep test-id + content; scroll lives on .view-sidebar__body */}
        {loading && groups.length === 0 ? (
          <p className="spaces-tree__status">Loading spaces…</p>
        ) : null}
        {loadError ? (
          <p className="spaces-tree__status spaces-tree__status--error" role="alert" data-testid="spaces-tree-error">
            {loadError}
          </p>
        ) : null}

        {/* TOP-LEVEL GROUP (null-project spaces) above the project headers. */}
        {filteredTopLevel.length > 0 ? (
          <div className="spaces-tree__group spaces-tree__group--top" data-testid="spaces-group-top-level">
            <div className="spaces-tree__group-label">Top level</div>
            <div className="spaces-tree__group-spaces">
              {filteredTopLevel.map(renderSpaceRow)}
            </div>
          </div>
        ) : null}

        {/* FOLDABLE, DRAG-REORDERABLE PROJECT HEADERS */}
        {filteredProjectGroups.map((kg) => {
          const isCollapsed = Boolean(collapsed[kg.key]) && !needle;
          const projectName = kg.group.project_name ?? 'Project';
          return (
            <div
              key={kg.key}
              className={`spaces-tree__group${dragKey === kg.key ? ' spaces-tree__group--dragging' : ''}`}
              data-testid={`spaces-group-${kg.key}`}
            >
              <div
                className="spaces-tree__group-header"
                draggable
                data-testid={`spaces-group-header-${kg.key}`}
                onDragStart={() => beginDrag(kg.key)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  handleDrop(kg.key);
                }}
                onDragEnd={endDrag}
              >
                <button
                  type="button"
                  className="spaces-tree__group-caret"
                  aria-label={isCollapsed ? `Expand ${projectName}` : `Collapse ${projectName}`}
                  aria-expanded={!isCollapsed}
                  data-testid={`spaces-group-toggle-${kg.key}`}
                  onClick={() => toggleCollapse(kg.key)}
                >
                  <CaretIcon open={!isCollapsed} />
                </button>
                <span className="spaces-tree__group-name" title={projectName}>
                  {projectName}
                </span>
                {createButton(
                  { kind: 'project', projectId: kg.key, projectName },
                  `Create space in ${projectName}`,
                  `create-in-${kg.key}`,
                )}
              </div>
              {/* Empty projects render as a compact foldable header row only —
                  no per-project "No spaces yet" filler. Projects WITH spaces
                  show their space lines here. (Stage 3 polish, issue e29a8c5.) */}
              {!isCollapsed && kg.group.spaces.length > 0 ? (
                <div className="spaces-tree__group-spaces">
                  {kg.group.spaces.map(renderSpaceRow)}
                </div>
              ) : null}
            </div>
          );
        })}

        {!loading
          && !loadError
          && filteredTopLevel.length === 0
          && filteredProjectGroups.length === 0 ? (
          <p className="spaces-tree__status" data-testid="spaces-tree-empty">
            {needle ? 'No spaces match.' : 'No spaces yet. Use + to create one.'}
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
