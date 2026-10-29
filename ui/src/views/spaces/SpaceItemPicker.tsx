// SpaceItemPicker - shared in-Space picker for adding refs or existing members
// to a Space renderer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';

import {
  addSpaceItem,
  getArtifacts,
  listSpacesGrouped,
  type ArtifactRecord,
  type AddSpaceItemRequest,
  type GraphNode,
  type Space,
  type SpaceGroup,
  type SpaceItem,
  type SpaceItemRefType,
} from '../../api';
import './SpaceItemPicker.css';
import { graphOptions } from '../../query/graph';
import { useProjectionQuery } from '../../query/useProjectionQuery';
import { detailQueryData } from '../../query/snapshots';
import { useViewActive } from '../../app-shell';

export type PickerRefType = SpaceItemRefType | 'space';

/** One searchable candidate row: a ledger issue, artifact, or existing Space member. */
export type PickerCandidate = {
  /** Stable key for selection (the ref_type:ref_id pair is unique enough). */
  key: string;
  ref_type: PickerRefType;
  ref_id: string;
  ref_uri?: string | null;
  title: string;
  /** Human project label for the row (or '' for cross/top-level). */
  projectLabel: string;
  metadata?: Record<string, unknown>;
  /** Existing membership row, when this candidate is already in the Space. */
  item?: SpaceItem;
};

export type SpaceItemPickerAddRequest = Omit<AddSpaceItemRequest, 'ref_type'> & {
  ref_type: PickerRefType;
};

export type SpaceItemPickerAddItem = (
  spaceId: string,
  body: SpaceItemPickerAddRequest,
) => ReturnType<typeof addSpaceItem>;

export type SpaceItemPickerProps = {
  /** The space items are added to. */
  spaceId: string;
  /** Project scope of the open space (used only for row ordering, not filtering). */
  projectId: string;
  /**
   * Per-selected-item hook, run after Space membership is available. Hosts use
   * this to materialize renderer placement: Canvas shelf occurrences, Board
   * cards, or Document embeds. It is not called for rows already in this view.
   */
  afterAdd?: (item: SpaceItem) => void | Promise<void>;
  /** Notified once after a batch add completes so the host can refetch. */
  onAdded?: (summary: { added: number; alreadyPresent: number }) => void;
  /** Dismiss the picker. */
  onClose?: () => void;
  /**
   * Injectable candidate loaders (tests). Default to the real graph/artifact
   * reads. The loaders run once when the picker mounts.
  */
  loadIssues?: () => Promise<PickerCandidate[]>;
  loadArtifacts?: () => Promise<PickerCandidate[]>;
  loadSpaces?: () => Promise<PickerCandidate[]>;
  /** addSpaceItem client (tests); defaults to the real C2 client. */
  addItem?: SpaceItemPickerAddItem;
  /** Current Space membership rows; existing members are also picker candidates. */
  existingItems?: SpaceItem[];
  /** Restrict existing-members rows to these ref types. */
  existingItemRefTypes?: PickerRefType[];
  /** Include issue search results. */
  includeIssues?: boolean;
  /** Include artifact search results. */
  includeArtifacts?: boolean;
  /** Include existing Space targets. */
  includeSpaces?: boolean;
  title?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  addButtonLabel?: string;
  /** Whether a Space item is already represented in the host renderer view. */
  isItemInView?: (item: SpaceItem) => boolean;
  /** Row status label for existing items already represented in the host view. */
  alreadyInViewLabel?: string;
};

type PickerRow = PickerCandidate & {
  item?: SpaceItem;
  inSpace: boolean;
  inView: boolean;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; candidates: PickerCandidate[] }
  | { status: 'error'; message: string };

const ARTIFACT_FETCH_LIMIT = 200;

function candidateKey(refType: PickerRefType, refId: string): string {
  return `${refType}:${refId}`;
}

/** Project the cross-project graph issue nodes into picker candidates. */
export function issuesFromGraph(nodes: GraphNode[]): PickerCandidate[] {
  const out: PickerCandidate[] = [];
  for (const node of nodes) {
    if (node.type !== 'issue') continue;
    const ledgerId = node.detail?.ledger_issue_id;
    const displayId = node.summary?.issue_id;
    const refId =
      (typeof ledgerId === 'string' && ledgerId) ||
      (typeof displayId === 'string' && displayId) ||
      node.id;
    if (!refId) continue;
    const projectName = node.detail?.project_name;
    out.push({
      key: candidateKey('issue', refId),
      ref_type: 'issue',
      ref_id: refId,
      title: node.label || (typeof displayId === 'string' ? displayId : refId),
      projectLabel: typeof projectName === 'string' ? projectName : node.repo ?? '',
    });
  }
  return out;
}

/** Project artifact records into picker candidates. */
export function artifactsToCandidates(records: ArtifactRecord[]): PickerCandidate[] {
  return records.map((record) => {
    const meta = record.metadata ?? {};
    const metaTitle = typeof meta.title === 'string' ? meta.title : '';
    const metaName = typeof meta.filename === 'string' ? meta.filename : '';
    const title = metaTitle || metaName || record.uri || record.id;
    return {
      key: candidateKey('artifact', record.id),
      ref_type: 'artifact' as const,
      ref_id: record.id,
      title,
      projectLabel: record.role ?? record.home_repo_id ?? '',
    };
  });
}

function projectLabelForSpace(group: SpaceGroup, space: Space): string {
  if (group.project_name) return group.project_name;
  if (group.project_key) return group.project_key;
  return space.project_id ? 'Project' : 'Top-level';
}

function spaceTypeLabel(space: Space): string {
  switch (space.default_renderer) {
    case 'document':
      return 'Document';
    case 'board':
      return 'Board';
    case 'collection':
      return 'Collection';
    case 'canvas':
    default:
      return 'Canvas';
  }
}

/** Project grouped Spaces into picker candidates for linked-Space canvas nodes. */
export function spacesFromGroups(groups: SpaceGroup[], currentProjectId?: string | null): PickerCandidate[] {
  const candidates: PickerCandidate[] = [];
  for (const group of groups) {
    for (const space of group.spaces) {
      const projectLabel = projectLabelForSpace(group, space);
      candidates.push({
        key: candidateKey('space', space.id),
        ref_type: 'space',
        ref_id: space.id,
        title: space.title || 'Untitled Space',
        projectLabel,
        metadata: {
          default_renderer: space.default_renderer,
          primary_type: space.default_renderer,
          primary_type_label: spaceTypeLabel(space),
          project_id: space.project_id,
          project_key: group.project_key,
          project_label: projectLabel,
        },
      });
    }
  }
  return candidates.sort((left, right) => {
    const leftSameProject = Boolean(currentProjectId && left.metadata?.project_id === currentProjectId);
    const rightSameProject = Boolean(currentProjectId && right.metadata?.project_id === currentProjectId);
    if (leftSameProject !== rightSameProject) return leftSameProject ? -1 : 1;
    return left.title.localeCompare(right.title);
  });
}

/** Project current Space memberships into picker candidates. */
export function itemsToCandidates(
  items: SpaceItem[],
  allowedRefTypes?: ReadonlySet<PickerRefType>,
): PickerCandidate[] {
  return items
    .filter((item) => !allowedRefTypes || allowedRefTypes.has(item.ref_type as PickerRefType))
    .map((item) => ({
      key: candidateKey(item.ref_type as PickerRefType, item.ref_id),
      ref_type: item.ref_type as PickerRefType,
      ref_id: item.ref_id,
      ref_uri: item.ref_uri,
      title: item.title || item.ref_uri || `${item.ref_type}:${item.ref_id}`,
      projectLabel: 'In this Space',
      metadata: item.metadata,
      item,
    }));
}

/** Default artifact loader: the registered artifact list. */
async function defaultLoadArtifacts(): Promise<PickerCandidate[]> {
  const records = await getArtifacts({ limit: ARTIFACT_FETCH_LIMIT });
  return artifactsToCandidates(records);
}

/** Default Space loader: grouped list so cross-project/top-level targets carry labels. */
async function defaultLoadSpaces(projectId: string): Promise<PickerCandidate[]> {
  const groups = await listSpacesGrouped();
  return spacesFromGroups(groups, projectId);
}

/** Case-insensitive title/ref/type filter. */
export function matchesQuery(candidate: PickerCandidate, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    candidate.title.toLowerCase().includes(needle) ||
    candidate.ref_id.toLowerCase().includes(needle) ||
    candidate.ref_type.toLowerCase().includes(needle) ||
    candidate.projectLabel.toLowerCase().includes(needle)
  );
}

export function SpaceItemPicker({
  spaceId,
  projectId: _projectId,
  afterAdd,
  onAdded,
  onClose,
  loadIssues,
  loadArtifacts = defaultLoadArtifacts,
  loadSpaces,
  addItem = addSpaceItem as SpaceItemPickerAddItem,
  existingItems = [],
  existingItemRefTypes,
  includeIssues = true,
  includeArtifacts = true,
  includeSpaces = false,
  title = 'Add items',
  searchPlaceholder = 'Search issues and artifacts by title...',
  emptyLabel = 'No items available.',
  addButtonLabel = 'Add',
  isItemInView,
  alreadyInViewLabel = 'Already in this view',
}: SpaceItemPickerProps): JSX.Element {
  const [otherLoad, setLoad] = useState<LoadState>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRead = useMemo(() => graphOptions({ status: 'all' }), []);
  const defaultIssues = includeIssues && !loadIssues;
  const graphQuery = useProjectionQuery(graphRead, useViewActive() && defaultIssues);
  const graph = useMemo(() => detailQueryData(graphQuery, graphRead), [graphQuery.data, graphQuery.isError, graphRead]);
  const candidates = useMemo(() => [
    ...(otherLoad.status === 'ready' ? otherLoad.candidates : []),
    ...(defaultIssues && graph ? issuesFromGraph(graph.nodes) : []),
  ], [otherLoad, defaultIssues, graph]);
  const loading = otherLoad.status === 'loading' || (defaultIssues && graphQuery.isPending && !graph);
  const error = otherLoad.status === 'error' ? otherLoad.message : defaultIssues ? graphQuery.error?.message : null;
  const load: LoadState = candidates.length || (!loading && !error)
    ? { status: 'ready', candidates }
    : loading ? { status: 'loading' } : { status: 'error', message: error! };

  useEffect(() => {
    let active = true;
    setLoad({ status: 'loading' });
    const loaders: Array<Promise<PickerCandidate[]>> = [];
    if (includeIssues && loadIssues) loaders.push(loadIssues());
    if (includeArtifacts) loaders.push(loadArtifacts());
    if (includeSpaces) loaders.push(loadSpaces ? loadSpaces() : defaultLoadSpaces(_projectId));
    Promise.allSettled(loaders)
      .then((results) => {
        if (!active) return;
        const candidates: PickerCandidate[] = [];
        const errors: string[] = [];
        for (const result of results) {
          if (result.status === 'fulfilled') candidates.push(...result.value);
          else errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
        if (candidates.length === 0 && errors.length > 0) {
          setLoad({ status: 'error', message: errors.join('; ') });
        } else {
          setLoad({ status: 'ready', candidates });
        }
      });
    return () => {
      active = false;
    };
  }, [
    loadIssues,
    loadArtifacts,
    loadSpaces,
    includeIssues,
    includeArtifacts,
    includeSpaces,
    _projectId,
  ]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const node = containerRef.current;
      if (!node || node.contains(event.target as Node)) return;
      onClose?.();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [onClose]);

  const rows = useMemo<PickerRow[]>(() => {
    const map = new Map<string, PickerRow>();
    const allowedRefTypes = existingItemRefTypes ? new Set(existingItemRefTypes) : undefined;
    for (const itemCandidate of itemsToCandidates(existingItems, allowedRefTypes)) {
      const item = itemCandidate.item;
      map.set(itemCandidate.key, {
        ...itemCandidate,
        inSpace: true,
        inView: item ? Boolean(isItemInView?.(item)) : false,
      });
    }
    if (load.status === 'ready') {
      for (const candidate of load.candidates) {
        if (candidate.ref_type === 'space' && candidate.ref_id === spaceId) continue;
        const existing = map.get(candidate.key);
        if (existing) {
          map.set(candidate.key, {
            ...candidate,
            item: existing.item,
            title: existing.title || candidate.title,
            projectLabel: candidate.projectLabel || existing.projectLabel,
            inSpace: true,
            inView: existing.inView,
          });
        } else {
          map.set(candidate.key, { ...candidate, inSpace: false, inView: false });
        }
      }
    }
    return [...map.values()];
  }, [load, existingItems, existingItemRefTypes, isItemInView, spaceId]);

  const filtered = useMemo(
    () => rows.filter((candidate) => matchesQuery(candidate, query)),
    [rows, query],
  );

  const byKey = useMemo(() => {
    const map = new Map<string, PickerRow>();
    for (const candidate of rows) map.set(candidate.key, candidate);
    return map;
  }, [rows]);

  useEffect(() => {
    setSelected((prior) => {
      const next = new Set<string>();
      for (const key of prior) {
        const candidate = byKey.get(key);
        if (candidate && !candidate.inView) next.add(key);
      }
      return next.size === prior.size ? prior : next;
    });
  }, [byKey]);

  const toggle = useCallback(
    (key: string) => {
      const candidate = byKey.get(key);
      if (candidate?.inView) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [byKey],
  );

  const handleAdd = useCallback(async () => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    setFeedback(null);
    let added = 0;
    let alreadyPresent = 0;
    const failed: string[] = [];
    const remaining = new Set<string>();
    for (const key of selected) {
      const candidate = byKey.get(key);
      if (!candidate || candidate.inView) continue;
      try {
        let item = candidate.item;
        if (item) {
          alreadyPresent += 1;
        } else {
          const response = await addItem(spaceId, {
            ref_type: candidate.ref_type,
            ref_id: candidate.ref_id,
            ref_uri: candidate.ref_uri ?? null,
            title: candidate.title,
            metadata: candidate.metadata,
          });
          item = response.item;
          if (response.already_present) alreadyPresent += 1;
          else added += 1;
        }
        if (item && afterAdd) await afterAdd(item);
      } catch (error) {
        failed.push(`${candidate.title}: ${error instanceof Error ? error.message : String(error)}`);
        remaining.add(key);
      }
    }
    setSelected(remaining);
    if (failed.length > 0) {
      setFeedback(`${summarize(added, alreadyPresent)}; failed ${failed.length}: ${failed[0]}`);
    } else {
      setFeedback(summarize(added, alreadyPresent));
      onClose?.();
    }
    onAdded?.({ added, alreadyPresent });
    setBusy(false);
  }, [busy, selected, byKey, addItem, spaceId, afterAdd, onAdded, onClose]);

  const selectableCount = useMemo(
    () => filtered.filter((candidate) => !candidate.inView).length,
    [filtered],
  );

  const statusFor = useCallback(
    (candidate: PickerRow): string => {
      if (candidate.inView) return alreadyInViewLabel;
      if (candidate.inSpace) return 'In Space';
      return 'Not in Space';
    },
    [alreadyInViewLabel],
  );

  return (
    <div className="space-item-picker" ref={containerRef} role="dialog" aria-modal="true" aria-label={`${title} to this Space`} data-testid="space-item-picker">
      <header className="space-item-picker__header">
        <strong className="space-item-picker__title">{title}</strong>
        {onClose ? (
          <button
            type="button"
            className="space-item-picker__close"
            aria-label="Close add-items picker"
            data-testid="space-item-picker-close"
            onClick={() => onClose()}
          >
            x
          </button>
        ) : null}
      </header>

      {error && (
        <DetailPaneNotice severity="error" density="compact" title="Could not load items">{error}</DetailPaneNotice>
      )}

      <input
        className="space-item-picker__search"
        type="search"
        autoFocus
        placeholder={searchPlaceholder}
        aria-label="Search items to add"
        data-testid="space-item-picker-search"
        value={query}
        onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
      />

      <div className="space-item-picker__results" data-testid="space-item-picker-results">
        {load.status === 'loading' && existingItems.length === 0 ? (
          <div className="space-item-picker__status">Loading items...</div>
        ) : load.status === 'error' && rows.length === 0 ? (
          <div className="space-item-picker__status">Items unavailable.</div>
        ) : filtered.length === 0 ? (
          <div className="space-item-picker__status" data-testid="space-item-picker-empty">
            {query.trim() ? 'No items match your search.' : emptyLabel}
          </div>
        ) : selectableCount === 0 ? (
          <div className="space-item-picker__status" data-testid="space-item-picker-empty">
            Everything here is already in this view.
          </div>
        ) : (
          <ul className="space-item-picker__list" role="listbox" aria-multiselectable="true">
            {filtered.map((candidate) => {
              const isSelected = selected.has(candidate.key);
              return (
                <li key={candidate.key} role="option" aria-selected={isSelected} aria-disabled={candidate.inView}>
                  <button
                    type="button"
                    className="space-item-picker__option"
                    data-selected={isSelected ? 'true' : 'false'}
                    data-ref-type={candidate.ref_type}
                    data-ref-id={candidate.ref_id}
                    data-in-space={candidate.inSpace ? 'true' : 'false'}
                    data-in-view={candidate.inView ? 'true' : 'false'}
                    data-testid="space-item-picker-option"
                    disabled={candidate.inView}
                    onClick={() => toggle(candidate.key)}
                  >
                    <span className="space-item-picker__check" aria-hidden="true">
                      {candidate.inView ? '-' : isSelected ? '*' : ''}
                    </span>
                    <span className="space-item-picker__option-main">
                      <span className="space-item-picker__option-title">{candidate.title}</span>
                      <span className="space-item-picker__option-meta">
                        <span className="space-item-picker__badge" data-kind={candidate.ref_type}>
                          {candidate.ref_type}
                        </span>
                        <span className="space-item-picker__state">{statusFor(candidate)}</span>
                        {candidate.projectLabel ? (
                          <span className="space-item-picker__project">{candidate.projectLabel}</span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="space-item-picker__footer">
        <span className="space-item-picker__count" data-testid="space-item-picker-count">
          {selected.size} selected
        </span>
        {feedback ? (
          <span className="space-item-picker__feedback" role="status" data-testid="space-item-picker-feedback">
            {feedback}
          </span>
        ) : null}
        <button
          type="button"
          className="space-item-picker__add"
          data-testid="space-item-picker-add"
          disabled={busy || selected.size === 0}
          onClick={() => void handleAdd()}
        >
          {busy ? 'Adding...' : `${addButtonLabel}${selected.size > 0 ? ` (${selected.size})` : ''}`}
        </button>
      </footer>
    </div>
  );
}

function summarize(added: number, alreadyPresent: number): string {
  if (added > 0 && alreadyPresent > 0) {
    return `Added ${added}; ${alreadyPresent} already present`;
  }
  if (added > 0) return `Added ${added === 1 ? '1 item' : `${added} items`}`;
  if (alreadyPresent > 0) return `Already present (${alreadyPresent})`;
  return 'Nothing added';
}

export default SpaceItemPicker;
