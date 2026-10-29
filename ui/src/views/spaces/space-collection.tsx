import { Icon } from '../../components/icons/Icon';
// Collection / list renderer (umbrella de56ffa, child C8 / issue fa83ec7).
//
// The first usable Spaces renderer: a list/tree view over collection
// OCCURRENCES (`space_occurrences` with renderer='collection'), ordered by
// `parent_id`/`sort_key`/`section_id`. Item-only membership (a `space_item`
// with no collection occurrence) surfaces in the flat Items section — never lost
// (review2 C7 [Warning]: ordering/tree state lives on occurrences, not items).
//
// Data: assembled from the single `GET /api/spaces/:id` fact packet
// (`getSpaceFactPacket`) via the pure helpers in ./collectionModel. Mutations go
// through the frozen C2/C3 typed client (`addSpaceItem`, `deleteSpaceItem`,
// `deleteSpaceOccurrence`) — this view writes ONLY through those audited routes.
//
// Missing/unresolved refs render through the shared C6 unresolved-ref UI
// (ui/src/resource-refs.ts): every item ref is linkified into a `.resource-ref`
// placeholder, never silently dropped.
//
// View-state (filter, selection, collapse) is browser-local (./collectionViewState)
// and follows the shared browser-persistence pattern; canonical state stays in SQLite.
// SSE `space:*` events are RECONCILIATION inputs — they refetch the packet but
// never reset selection/filter/collapse (Dataful-UX contract).

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';

import {
  deleteSpaceItem,
  deleteSpaceOccurrence,
  type SpaceItem,
} from '../../api';
import { SpaceItemPicker } from './SpaceItemPicker';
import { parseResourceRef, resourceRefHref, displayResourceRef } from '../../resource-refs';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import {
  buildSpaceViewModel,
  projectCollection,
  itemDisplayLabel,
  itemRefString,
  type CollectionTreeNode,
} from './collectionModel';
import {
  collectionStorageKey,
  normalizeCollectionViewState,
  reconcileCollectionViewState,
  EMPTY_COLLECTION_VIEW_STATE,
} from './collectionViewState';
import './space-collection.css';


/** Collapse the case-insensitive filter once per render pass. */
function matchesFilter(label: string, ref: string, filter: string): boolean {
  if (!filter.trim()) return true;
  const needle = filter.trim().toLowerCase();
  return label.toLowerCase().includes(needle) || ref.toLowerCase().includes(needle);
}

/**
 * Inline unresolved-ref affordance for one item ref, using the shared C6 UI.
 * The ref starts as a quiet unresolved link/label. No raw ref text is ever
 * injected as HTML and no always-visible resolve button clutters normal rows.
 */
function ItemRef({ item }: { item: SpaceItem }): JSX.Element {
  const ref = itemRefString(item);
  const parsed = useMemo(() => parseResourceRef(ref), [ref]);

  // Prefer the item's human label (title) as the visible text; the ref remains
  // the resolve authority. A ref the C6 grammar does not recognize still renders
  // as a labelled placeholder so it is never dropped.
  const label = itemDisplayLabel(item) || (parsed ? parsed.display : displayResourceRef(ref));
  const href = parsed ? resourceRefHref(parsed.canonical) : undefined;

  return (
    <span
      className="space-collection__ref resource-ref resource-ref--unresolved"
      data-resource-ref={parsed ? parsed.canonical : ref}
      data-resource-kind={parsed ? parsed.kind : 'unknown'}
      data-ref-state="unresolved"
      title={`Resource reference ${ref}`}
    >
      {href ? (
        <a className="artifact-xref resource-ref__link" href={href}>
          {label}
        </a>
      ) : (
        <span className="resource-ref__link">{label}</span>
      )}
    </span>
  );
}

type RowProps = {
  node: CollectionTreeNode;
  selectedIds: ReadonlySet<string>;
  collapsed: Record<string, boolean>;
  filter: string;
  onToggle: (occurrenceId: string) => void;
  onSelect: (occurrenceId: string) => void;
  onRemove: (occurrenceId: string) => void;
};

/** Whether a node or any descendant passes the active filter (so parents of a hit stay visible). */
function subtreeMatches(node: CollectionTreeNode, filter: string): boolean {
  const item = node.occurrence.item;
  const label = item ? itemDisplayLabel(item) : node.occurrence.occurrence.note ?? '(occurrence)';
  const ref = item ? itemRefString(item) : '';
  if (matchesFilter(label, ref, filter)) return true;
  return node.children.some((child) => subtreeMatches(child, filter));
}

function CollectionRow({
  node,
  selectedIds,
  collapsed,
  filter,
  onToggle,
  onSelect,
  onRemove,
}: RowProps): JSX.Element | null {
  if (filter.trim() && !subtreeMatches(node, filter)) return null;

  const occId = node.occurrence.occurrence.id;
  const item = node.occurrence.item;
  const hasChildren = node.children.length > 0;
  const isCollapsed = !!collapsed[occId] && !filter.trim();
  const selected = selectedIds.has(occId);

  return (
    <li role="treeitem" aria-level={node.depth + 1} aria-selected={selected} aria-expanded={hasChildren ? !isCollapsed : undefined}>
      <div
        className="space-collection__node"
        data-selected={selected ? 'true' : 'false'}
        data-occurrence-id={occId}
        style={{ paddingLeft: `${0.5 + node.depth * 1.1}rem` }}
        onClick={() => onSelect(occId)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="space-collection__twisty"
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(occId);
            }}
          >
            <Icon name={isCollapsed ? 'sectionCollapsed' : 'sectionExpanded'} />
          </button>
        ) : (
          <span className="space-collection__twisty space-collection__twisty--placeholder" aria-hidden="true" />
        )}
        <span className="space-collection__label">
          {item ? (
            <ItemRef item={item} />
          ) : node.occurrence.occurrence.item_id ? (
            // item_id set but the backing item is missing from the packet: a
            // dangling occurrence. Surface it as an unresolved placeholder.
            <span className="space-collection__ref resource-ref resource-ref--error" data-ref-state="error" title="Backing item missing">
              <span className="resource-ref__link">missing item ({node.occurrence.occurrence.item_id})</span>
            </span>
          ) : (
            <span>{node.occurrence.occurrence.note ?? '(section)'}</span>
          )}
        </span>
        <button
          type="button"
          className="space-collection__remove"
          aria-label="Remove from collection"
          title="Remove occurrence from this collection"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(occId);
          }}
        >
          <Icon name="dismiss" />
        </button>
      </div>
      {hasChildren && !isCollapsed ? (
        <ul className="space-collection__tree" role="group">
          {node.children.map((child) => (
            <CollectionRow
              key={child.occurrence.occurrence.id}
              node={child}
              selectedIds={selectedIds}
              collapsed={collapsed}
              filter={filter}
              onToggle={onToggle}
              onSelect={onSelect}
              onRemove={onRemove}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SpaceCollectionRenderer({ projectId, spaceId, factPacket }: SpaceRendererMountProps): JSX.Element {
  const model = useMemo(() => factPacket ? buildSpaceViewModel(factPacket) : null, [factPacket]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const error = mutationError;
  const [viewState, setViewState] = usePersistedViewState(
    spaceId ? collectionStorageKey(projectId, spaceId) : '',
    normalizeCollectionViewState,
    EMPTY_COLLECTION_VIEW_STATE,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!model) return;
    const liveIds = new Set([...model.occurrences.map((entry) => entry.occurrence.id), ...Object.keys(model.itemsById)]);
    setViewState((prior) => reconcileCollectionViewState(prior, liveIds));
  }, [model, setViewState]);

  const projection = useMemo(
    () => model ? projectCollection(model) : null,
    [model],
  );
  const items = model ? Object.values(model.itemsById) : [];

  const selectedIds = useMemo(() => new Set(viewState.selection.ids), [viewState.selection.ids]);

  const onToggle = useCallback((occurrenceId: string) => {
    setViewState((prior) => ({
      ...prior,
      collapsed: { ...prior.collapsed, [occurrenceId]: !prior.collapsed[occurrenceId] },
    }));
  }, []);

  const onSelectOccurrence = useCallback((occurrenceId: string) => {
    setViewState((prior) => ({
      ...prior,
      selection: { kind: 'occurrence', ids: [occurrenceId] },
    }));
  }, []);

  const onSelectItem = useCallback((itemId: string) => {
    setViewState((prior) => ({ ...prior, selection: { kind: 'item', ids: [itemId] } }));
  }, []);

  const onRemoveOccurrence = useCallback(
    async (occurrenceId: string) => {
      if (!spaceId) return;
      setMutationError(null);
      setBusy(true);
      try {
        await deleteSpaceOccurrence(spaceId, occurrenceId);
      } catch (error) {
        setMutationError(String(error));
      } finally {
        setBusy(false);
      }
    },
    [spaceId],
  );

  const onRemoveItem = useCallback(
    async (itemId: string) => {
      if (!spaceId) return;
      setBusy(true);
      try {
        await deleteSpaceItem(spaceId, itemId);
      } catch (error) {
        setMutationError(String(error));
      } finally {
        setBusy(false);
      }
    },
    [spaceId],
  );

  if (!spaceId) {
    return (
      <div className="space-collection" data-testid="space-collection">
        <div className="space-collection__empty" data-testid="space-collection-empty">
          Select a Space to view its collection.
        </div>
      </div>
    );
  }

  return (
    <div className="space-collection" data-testid="space-collection">
      <div className="space-collection__toolbar">
        <input
          className="space-collection__filter"
          type="search"
          placeholder="Filter items…"
          aria-label="Filter collection items"
          value={viewState.itemFilter}
          onInput={(event) =>
            setViewState((prior) => ({ ...prior, itemFilter: (event.target as HTMLInputElement).value }))
          }
        />
        <div className="space-collection__add">
          <button
            type="button"
            className="space-collection__button space-collection__button--primary"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            disabled={busy}
            data-testid="space-collection-add-items"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <Icon name="add" /> Add items
          </button>
          {pickerOpen ? (
            <div className="space-collection__picker-anchor">
              <SpaceItemPicker
                spaceId={spaceId}
                projectId={projectId}
                existingItems={items}
                isItemInView={() => true}
                alreadyInViewLabel="In collection"
                onClose={() => setPickerOpen(false)}
              />
            </div>
          ) : null}
        </div>
      </div>

      {error && (
        <DetailPaneNotice severity="error" density="compact" title="Could not load collection">
          {error}
        </DetailPaneNotice>
      )}
      <div className="space-collection__body" data-testid="space-collection-body">
        {!model && !error ? (
          <div className="space-collection__loading">Loading collection…</div>
        ) : !model && error ? (
          <div className="space-collection__empty">Collection unavailable.</div>
        ) : projection ? (
          <CollectionBody
            projection={projection}
            selectedIds={selectedIds}
            collapsed={viewState.collapsed}
            filter={viewState.itemFilter}
            onToggle={onToggle}
            onSelectOccurrence={onSelectOccurrence}
            onSelectItem={onSelectItem}
            onRemoveOccurrence={onRemoveOccurrence}
            onRemoveItem={onRemoveItem}
          />
        ) : null}
      </div>
    </div>
  );
}

type BodyProps = {
  projection: NonNullable<ReturnType<typeof projectCollection>>;
  selectedIds: ReadonlySet<string>;
  collapsed: Record<string, boolean>;
  filter: string;
  onToggle: (id: string) => void;
  onSelectOccurrence: (id: string) => void;
  onSelectItem: (id: string) => void;
  onRemoveOccurrence: (id: string) => void;
  onRemoveItem: (id: string) => void;
};

function CollectionBody({
  projection,
  selectedIds,
  collapsed,
  filter,
  onToggle,
  onSelectOccurrence,
  onSelectItem,
  onRemoveOccurrence,
  onRemoveItem,
}: BodyProps): JSX.Element {
  const visibleUnplaced = projection.unplaced.filter((item) =>
    matchesFilter(itemDisplayLabel(item), itemRefString(item), filter),
  );
  const hasTree = projection.roots.length > 0;
  const isEmpty = !hasTree && visibleUnplaced.length === 0 && projection.danglingOccurrences.length === 0;

  if (isEmpty) {
    return (
      <div className="space-collection__empty" data-testid="space-collection-empty">
        {filter.trim() ? 'No items match the filter.' : 'This collection is empty.'}
      </div>
    );
  }

  return (
    <>
      {hasTree ? (
        <ul className="space-collection__tree" role="tree" aria-label="Collection" data-testid="space-collection-tree">
          {projection.roots.map((node) => (
            <CollectionRow
              key={node.occurrence.occurrence.id}
              node={node}
              selectedIds={selectedIds}
              collapsed={collapsed}
              filter={filter}
              onToggle={onToggle}
              onSelect={onSelectOccurrence}
              onRemove={onRemoveOccurrence}
            />
          ))}
        </ul>
      ) : null}

      {visibleUnplaced.length > 0 ? (
        <div className="space-collection__shelf" data-testid="space-collection-shelf">
          <div className="space-collection__section-title">Items ({visibleUnplaced.length})</div>
          <ul className="space-collection__shelf-list" role="list">
            {visibleUnplaced.map((item) => {
              const selected = selectedIds.has(item.id);
              return (
                <li key={item.id} role="listitem">
                  <div
                    className="space-collection__node"
                    data-selected={selected ? 'true' : 'false'}
                    data-item-id={item.id}
                    onClick={() => onSelectItem(item.id)}
                  >
                    <span className="space-collection__twisty space-collection__twisty--placeholder" aria-hidden="true" />
                    <span className="space-collection__label">
                      <ItemRef item={item} />
                    </span>
                    <button
                      type="button"
                      className="space-collection__remove"
                      aria-label="Remove item from space"
                      title="Remove item from this Space"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveItem(item.id);
                      }}
                    >
                      <Icon name="dismiss" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export default SpaceCollectionRenderer;
