// SpaceItemPicker — search-and-add picker that adds issues/artifacts to the
// CURRENT space from inside the space view (umbrella de56ffa, child e670176).
//
// The reverse of `AddToSpace` (which picks a space for a known item): this picks
// items for a known space. It is the discoverable "Add items" affordance the
// Canvas (and Collection) renderers open. It:
//   - reads candidate ISSUES from the backend graph adapter
//     (`getGraph({ status: 'all' })`, the same cross-project ledger-backed read
//     the seed dialog uses) and candidate ARTIFACTS from `getArtifacts`,
//   - filters them client-side by title/ref as the user types,
//   - lets the user multi-select and adds each via the C2 `addSpaceItem` route,
//   - runs an injected `afterAdd(item)` hook per created item so the host can
//     materialize whatever placement makes the item VISIBLE in its renderer
//     (the Canvas host creates an unplaced `canvas` occurrence so the item lands
//     in the shelf; the Collection host relies on item-only membership which its
//     own unplaced shelf already surfaces).
//
// Cross-project membership is allowed (issue 812df41 / universal item-level
// membership): the candidate lists are not scoped to the space's project.
//
// Per the project Dataful UX State rule this component owns ONLY transient
// browser-local view state (open candidate list, the search text, the pending
// selection, the in-flight add). The canonical mutation (adding items) is driven
// exclusively by an explicit user click; membership is read back from the C2 API
// by the host's refetch — never promoted from this component's local state. The
// host must NOT reset its viewport/selection when this picker reports an add.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  addSpaceItem,
  getArtifacts,
  getGraph,
  type ArtifactRecord,
  type GraphNode,
  type SpaceItem,
  type SpaceItemRefType,
} from '../../api';
import './SpaceItemPicker.css';

/** One searchable candidate row: a ledger issue or a registered artifact. */
export type PickerCandidate = {
  /** Stable key for selection (the ref_type:ref_id pair is unique enough). */
  key: string;
  ref_type: SpaceItemRefType;
  ref_id: string;
  ref_uri?: string | null;
  title: string;
  /** Human project label for the row (or '' for cross/top-level). */
  projectLabel: string;
};

export type SpaceItemPickerProps = {
  /** The space items are added to. */
  spaceId: string;
  /** Project scope of the open space (used only for row ordering, not filtering). */
  projectId: string;
  /**
   * Per-created-item hook, run AFTER `addSpaceItem` succeeds with `created`
   * true. Lets the host make the new item visible in its renderer (e.g. the
   * Canvas creates an unplaced shelf occurrence). May be async; failures are
   * surfaced as feedback but do not roll back the membership.
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
  /** addSpaceItem client (tests); defaults to the real C2 client. */
  addItem?: typeof addSpaceItem;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; candidates: PickerCandidate[] }
  | { status: 'error'; message: string };

const ARTIFACT_FETCH_LIMIT = 200;

/** Project the cross-project graph issue nodes into picker candidates. */
export function issuesFromGraph(nodes: GraphNode[]): PickerCandidate[] {
  const out: PickerCandidate[] = [];
  for (const node of nodes) {
    if (node.type !== 'issue') continue;
    // Prefer the canonical ledger id; fall back to the display id the backend
    // predicate resolver also accepts (mirrors SpaceSeedDialog.issueIdFromNode).
    const ledgerId = node.detail?.ledger_issue_id;
    const displayId = node.summary?.issue_id;
    const refId =
      (typeof ledgerId === 'string' && ledgerId) ||
      (typeof displayId === 'string' && displayId) ||
      node.id;
    if (!refId) continue;
    const projectName = node.detail?.project_name;
    out.push({
      key: `issue:${refId}`,
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
      key: `artifact:${record.id}`,
      ref_type: 'artifact' as const,
      ref_id: record.id,
      title,
      projectLabel: record.role ?? record.home_repo_id ?? '',
    };
  });
}

/** Default issue loader: cross-project ledger-backed graph read. */
async function defaultLoadIssues(): Promise<PickerCandidate[]> {
  const graph = await getGraph({ status: 'all' });
  return issuesFromGraph(graph.nodes);
}

/** Default artifact loader: the registered artifact list. */
async function defaultLoadArtifacts(): Promise<PickerCandidate[]> {
  const records = await getArtifacts({ limit: ARTIFACT_FETCH_LIMIT });
  return artifactsToCandidates(records);
}

/** Case-insensitive title/ref filter. */
export function matchesQuery(candidate: PickerCandidate, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    candidate.title.toLowerCase().includes(needle) ||
    candidate.ref_id.toLowerCase().includes(needle) ||
    candidate.projectLabel.toLowerCase().includes(needle)
  );
}

export function SpaceItemPicker({
  spaceId,
  projectId: _projectId,
  afterAdd,
  onAdded,
  onClose,
  loadIssues = defaultLoadIssues,
  loadArtifacts = defaultLoadArtifacts,
  addItem = addSpaceItem,
}: SpaceItemPickerProps): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load candidates once on mount. Issue and artifact loads are independent;
  // a failure in one still surfaces the other so the picker stays usable.
  useEffect(() => {
    let active = true;
    setLoad({ status: 'loading' });
    Promise.allSettled([loadIssues(), loadArtifacts()])
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
  }, [loadIssues, loadArtifacts]);

  // Close on outside pointer / Escape (matching the AddToSpace popover behavior).
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

  const candidates = load.status === 'ready' ? load.candidates : [];
  const filtered = useMemo(
    () => candidates.filter((candidate) => matchesQuery(candidate, query)),
    [candidates, query],
  );
  const byKey = useMemo(() => {
    const map = new Map<string, PickerCandidate>();
    for (const candidate of candidates) map.set(candidate.key, candidate);
    return map;
  }, [candidates]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleAdd = useCallback(async () => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    setFeedback(null);
    let added = 0;
    let alreadyPresent = 0;
    try {
      for (const key of selected) {
        const candidate = byKey.get(key);
        if (!candidate) continue;
        const response = await addItem(spaceId, {
          ref_type: candidate.ref_type,
          ref_id: candidate.ref_id,
          ref_uri: candidate.ref_uri ?? null,
          title: candidate.title,
        });
        if (response.already_present) {
          alreadyPresent += 1;
        } else {
          added += 1;
        }
        // Run the host placement hook only for freshly created memberships so a
        // re-add does not spawn duplicate shelf occurrences.
        if (response.created && afterAdd) {
          await afterAdd(response.item);
        }
      }
      setSelected(new Set());
      setFeedback(summarize(added, alreadyPresent));
      onAdded?.({ added, alreadyPresent });
    } catch (error) {
      setFeedback(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, selected, byKey, addItem, spaceId, afterAdd, onAdded]);

  return (
    <div className="space-item-picker" ref={containerRef} role="dialog" aria-modal="true" aria-label="Add items to this Space" data-testid="space-item-picker">
      <header className="space-item-picker__header">
        <strong className="space-item-picker__title">Add items</strong>
        {onClose ? (
          <button
            type="button"
            className="space-item-picker__close"
            aria-label="Close add-items picker"
            data-testid="space-item-picker-close"
            onClick={() => onClose()}
          >
            ×
          </button>
        ) : null}
      </header>

      <input
        className="space-item-picker__search"
        type="search"
        autoFocus
        placeholder="Search issues and artifacts by title…"
        aria-label="Search items to add"
        data-testid="space-item-picker-search"
        value={query}
        onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
      />

      <div className="space-item-picker__results" data-testid="space-item-picker-results">
        {load.status === 'loading' ? (
          <div className="space-item-picker__status">Loading items…</div>
        ) : load.status === 'error' ? (
          <div className="space-item-picker__status space-item-picker__status--error" role="alert">
            {load.message}
          </div>
        ) : filtered.length === 0 ? (
          <div className="space-item-picker__status" data-testid="space-item-picker-empty">
            {query.trim() ? 'No items match your search.' : 'No items available.'}
          </div>
        ) : (
          <ul className="space-item-picker__list" role="listbox" aria-multiselectable="true">
            {filtered.map((candidate) => {
              const isSelected = selected.has(candidate.key);
              return (
                <li key={candidate.key} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    className="space-item-picker__option"
                    data-selected={isSelected ? 'true' : 'false'}
                    data-ref-type={candidate.ref_type}
                    data-ref-id={candidate.ref_id}
                    data-testid="space-item-picker-option"
                    onClick={() => toggle(candidate.key)}
                  >
                    <span className="space-item-picker__check" aria-hidden="true">
                      {isSelected ? '✓' : ''}
                    </span>
                    <span className="space-item-picker__option-main">
                      <span className="space-item-picker__option-title">{candidate.title}</span>
                      <span className="space-item-picker__option-meta">
                        <span className="space-item-picker__badge" data-kind={candidate.ref_type}>
                          {candidate.ref_type}
                        </span>
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
          {busy ? 'Adding…' : `Add${selected.size > 0 ? ` (${selected.size})` : ''}`}
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
