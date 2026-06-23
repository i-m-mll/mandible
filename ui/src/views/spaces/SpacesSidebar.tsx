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
// Create flow: each "+" opens a small chooser offering a Blank space (inline
// title input → createSpace) or a Seeded space (createSpace, then mount the
// otherwise-orphaned SpaceSeedDialog). On success the new space is selected by
// navigating the URL hash (the single source of truth for selection).
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
  createSpace,
  type Space,
  type SpaceGroup,
} from '../../api';
import { SpaceSeedDialog } from './SpaceSeedDialog';
import type { SeedSpaceResult } from '../../api';
import './SpacesSidebar.css';

const COLLAPSE_STORAGE_KEY = 'spaces-tree:collapsed';
const ORDER_STORAGE_KEY = 'spaces-tree:project-order';

/** Stable sentinel id for the top-level (null project) group. */
const TOP_LEVEL_GROUP_ID = '__top_level__';

export type SpacesSidebarProps = {
  /** Hide the whole sidebar (the shared view-sidebar toggle). */
  hidden?: boolean;
  /** Currently selected space id (URL-canonical), or null. */
  selectedSpaceId?: string | null;
  /**
   * Navigate to open a space. Receives the space's nullable project id, the
   * space id, and the default renderer to open it with. The host (app.tsx)
   * rebuilds the `#/spaces?...` hash, preserving the `?sidebar=` param.
   */
  onSelectSpace: (args: { projectId: string | null; spaceId: string; renderer: string }) => void;
  /**
   * Injected loader (defaults to the real grouped read). Lets tests supply a
   * deterministic grouping without a daemon.
   */
  loadGroups?: () => Promise<SpaceGroup[]>;
  /** Injected create helper (defaults to the real `createSpace`). */
  createSpaceFn?: typeof createSpace;
  /** Refresh nonce: bump to force a re-read after an external mutation. */
  refreshToken?: number;
  /**
   * Controlled sidebar width in pixels. Lifted from the shell (which owns
   * useSidebarResize) so the resize handle can be a flex sibling. When omitted,
   * no inline width is applied (CSS controls sizing, useful for tests).
   */
  width?: number | null;
};

type CreateTarget =
  | { kind: 'project'; projectId: string; projectName: string }
  | { kind: 'top-level' };

type CreateMode = 'chooser' | 'blank' | 'seed';

type CreatePopover = {
  target: CreateTarget;
  mode: CreateMode;
  /** Space id created for the seed path (so SpaceSeedDialog can mount). */
  seedSpaceId?: string;
  seedProjectId?: string | null;
};

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
  refreshToken,
  width: sidebarWidth = null,
}: SpacesSidebarProps): JSX.Element | null {
  const [groups, setGroups] = useState<SpaceGroup[]>([]);
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
  const [internalRefresh, setInternalRefresh] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);

  // --- data load (grouped read) ---
  useEffect(() => {
    if (hidden) return undefined;
    let active = true;
    setLoading(true);
    setLoadError(null);
    loadGroups()
      .then((next) => {
        if (active) setGroups(next);
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
  const openChooser = useCallback((target: CreateTarget) => {
    setBlankTitle('');
    setCreateError(null);
    setPopover({ target, mode: 'chooser' });
  }, []);

  const targetProjectId = useCallback((target: CreateTarget): string | null => {
    return target.kind === 'project' ? target.projectId : null;
  }, []);

  const doCreate = useCallback(
    async (target: CreateTarget, title: string, then: 'select' | 'seed') => {
      const trimmed = title.trim();
      if (!trimmed || creating) return;
      setCreating(true);
      setCreateError(null);
      try {
        const projectId = targetProjectId(target);
        const space = await createSpaceFn({ project_id: projectId, title: trimmed });
        if (then === 'seed') {
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
            renderer: space.default_renderer,
          });
        }
      } catch (error: unknown) {
        setCreateError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreating(false);
      }
    },
    [creating, createSpaceFn, targetProjectId, refresh, onSelectSpace],
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
          renderer: 'collection',
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

  if (hidden) return null;

  const renderSpaceRow = (space: Space): JSX.Element => {
    const active = selectedSpaceId === space.id;
    return (
      <button
        key={space.id}
        type="button"
        className={`spaces-tree__space${active ? ' spaces-tree__space--active' : ''}`}
        aria-current={active ? 'true' : undefined}
        data-testid={`space-row-${space.id}`}
        onClick={() =>
          onSelectSpace({
            projectId: space.project_id,
            spaceId: space.id,
            renderer: space.default_renderer,
          })
        }
      >
        {space.title || 'Untitled space'}
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
    if (!popover || popover.mode !== 'chooser') return null;
    const label =
      popover.target.kind === 'top-level'
        ? 'New top-level space'
        : `New space in ${popover.target.projectName}`;
    return (
      <div className="spaces-tree__chooser" role="menu" data-testid="space-create-chooser">
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
                void doCreate(popover.target, blankTitle, 'select');
              }
            }}
          />
        </label>
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
            data-testid="space-create-blank"
            onClick={() => void doCreate(popover.target, blankTitle, 'select')}
          >
            Blank space
          </button>
          <button
            type="button"
            className="spaces-tree__chooser-action"
            disabled={!blankTitle.trim() || creating}
            data-testid="space-create-seed"
            onClick={() => void doCreate(popover.target, blankTitle, 'seed')}
          >
            Seed from filter…
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

  return (
    <div
      className="spaces-tree"
      ref={containerRef}
      data-testid="spaces-sidebar"
      style={{ ...(sidebarWidth !== null ? { width: `${sidebarWidth}px` } : {}), flexShrink: 0 }}
    >
      {/* FIXED header row (outside the scroll region) */}
      <div className="spaces-tree__header">
        <input
          type="text"
          className="spaces-tree__filter-input"
          placeholder="Filter spaces…"
          aria-label="Filter spaces"
          value={filter}
          data-testid="spaces-filter-input"
          onInput={(event) => setFilter((event.currentTarget as HTMLInputElement).value)}
        />
        {createButton({ kind: 'top-level' }, 'Create top-level space', 'create-top-level')}
      </div>

      {/* SCROLLING region */}
      <div className="spaces-tree__scroll" data-testid="spaces-tree-scroll">
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
              {!isCollapsed ? (
                <div className="spaces-tree__group-spaces">
                  {kg.group.spaces.length === 0 ? (
                    <p className="spaces-tree__empty-group">No spaces yet</p>
                  ) : (
                    kg.group.spaces.map(renderSpaceRow)
                  )}
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

      {renderChooser()}
      {renderSeedDialog()}
    </div>
  );
}

export default SpacesSidebar;
