import { Icon } from '../../components/icons/Icon';
// Space seed dialog (umbrella de56ffa, child 27a5026).
//
// Filter-driven seeding for a Space. The dialog offers the §6.2 seed sources
// ("issue + its artifacts", "graph selection", "label X", "saved filter"),
// builds the shared `TimelineIssuePredicate` AST, and posts it to the C2 `/seed`
// endpoint via `seedSpace`. The predicate shape is the exact same one the
// Timeline produces — both surfaces consume `./../filters/issue-predicate-filter`.
//
// Boundaries (sibling-ownership / non-goals from the issue):
//   - No backend predicate evaluation here: the C2 route owns evaluation; this
//     dialog only assembles the predicate JSON and posts it.
//   - The "graph selection" seed reads the relationship/issue source through the
//     BACKEND graph endpoint (`getGraph` → `/api/graph`, which reads
//     `ledger_issue_relationships` server-side). It never reads a UI-side DB.
//   - No "Add to Space" affordances (those are C7c).
//
// Per the project Dataful UX State rule the dialog is pure local view state:
// the only canonical mutation is the explicit user-triggered seed POST.

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';

import {
  getGraph,
  seedSpace,
  type GraphNode,
  type SeedSpaceRequest,
  type SeedSpaceResult,
} from '../../api';
import {
  parseFilterToken,
  predicateForChips,
  filterRowTitle,
  type TimelineFilterChip,
  type TimelineIssuePredicate,
} from '../filters/issue-predicate-filter';
import { IssuePredicateFilter } from '../filters/IssuePredicateFilter';
import './SpaceSeedDialog.css';

/** The §6.2 seed sources offered by the dialog. */
export type SpaceSeedSource = 'issue' | 'graph' | 'label' | 'filter';

export const SPACE_SEED_SOURCES: readonly SpaceSeedSource[] = ['issue', 'graph', 'label', 'filter'];

const SOURCE_LABELS: Record<SpaceSeedSource, string> = {
  issue: 'This issue + its artifacts',
  graph: 'Current graph selection',
  label: 'All issues with label',
  filter: 'A saved filter',
};

export type SpaceSeedDialogProps = {
  /** The Space being seeded; the predicate posts to `/api/spaces/:spaceId/seed`. */
  spaceId: string;
  /** Project scope (used to pre-filter the graph-selection issue list). */
  projectId: string;
  /** Repo scope for the backend graph read (graph endpoint is repo-scoped). */
  repo?: string;
  /** Issue-label suggestions for the saved-filter chip composer (optional). */
  labelOptions?: string[];
  kindOptions?: string[];
  issueOptions?: string[];
  /** Called after a successful seed POST with the C2 result. */
  onSeeded?: (result: SeedSpaceResult) => void;
  /** Dismiss the dialog without seeding. */
  onClose?: () => void;
};

/**
 * Build the predicate AST for a single issue (the issue + its subtree). The
 * artifacts themselves are pulled in backend-side via `include_artifacts`, so
 * the predicate only has to match the issue. `parent_subtree` is the closest
 * shared-AST primitive for "this issue", matching the Timeline's `subtree` chip.
 */
function predicateForIssue(issueId: string): TimelineIssuePredicate {
  return { type: 'parent_subtree', issue_id: issueId };
}

/** Build the predicate AST for a graph selection of issue ids. */
function predicateForGraphSelection(issueIds: string[]): TimelineIssuePredicate | null {
  const predicates = issueIds.map<TimelineIssuePredicate>((id) => predicateForIssue(id));
  if (predicates.length === 0) return null;
  return predicates.length === 1 ? predicates[0] : { type: 'or', predicates };
}

/** Build the predicate AST for a single label. */
function predicateForLabel(label: string): TimelineIssuePredicate | null {
  const name = label.trim();
  return name ? { type: 'label', name } : null;
}

/**
 * The canonical ledger issue id carried on an issue graph node. The graph
 * adapter sets `detail.ledger_issue_id`; we fall back to `summary.issue_id`
 * (display id, which the backend predicate resolver also accepts).
 */
function issueIdFromNode(node: GraphNode): string | null {
  const ledgerId = node.detail?.ledger_issue_id;
  if (typeof ledgerId === 'string' && ledgerId) return ledgerId;
  const displayId = node.summary?.issue_id;
  if (typeof displayId === 'string' && displayId) return displayId;
  return null;
}

export function SpaceSeedDialog({
  spaceId,
  projectId,
  repo,
  labelOptions = [],
  kindOptions = [],
  issueOptions = [],
  onSeeded,
  onClose,
}: SpaceSeedDialogProps): JSX.Element {
  const [source, setSource] = useState<SpaceSeedSource>('filter');
  const [issueId, setIssueId] = useState('');
  const [labelValue, setLabelValue] = useState('');
  const [includeArtifacts, setIncludeArtifacts] = useState(true);
  const [withShelfOccurrences, setWithShelfOccurrences] = useState(true);

  // Saved-filter chip composer state.
  const [chips, setChips] = useState<TimelineFilterChip[]>([]);

  // Graph-selection state (loaded from the BACKEND graph endpoint).
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [selectedGraphIds, setSelectedGraphIds] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [graphLoaded, setGraphLoaded] = useState(false);
  // Opt-in cross-project seeding: when on, the graph-selection source pulls
  // issue nodes from ALL projects (not just this Space's project + null-project
  // nodes), so a Space can be seeded with cross-project items. Off by default to
  // keep the common single-project case scoped. (umbrella de56ffa, child 6a4a69a)
  const [allProjects, setAllProjects] = useState(false);

  // Load the project's issue nodes from the backend graph adapter the first time
  // the graph-selection source is chosen. This is the only source-of-truth read
  // for graph membership — never a UI-side relationship query. The effect keys
  // only off `source`/`repo`/`projectId` so it never cancels its own in-flight
  // request by re-running on its own loading-state writes.
  useEffect(() => {
    if (source !== 'graph' || graphLoaded) return;
    let cancelled = false;
    setGraphLoading(true);
    setGraphError(null);
    getGraph({ repo, status: 'all' })
      .then((payload) => {
        if (cancelled) return;
        const issueNodes = payload.nodes.filter(
          (node) => node.type === 'issue'
            // When "all projects" is on, keep every issue node; otherwise scope to
            // this Space's project (and null-project / cross nodes as before).
            && (allProjects || !projectId || node.detail?.project_id === projectId || node.detail?.project_id == null),
        );
        setGraphNodes(issueNodes);
        setGraphLoaded(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setGraphError(error instanceof Error ? error.message : 'Failed to load graph');
      })
      .finally(() => {
        if (!cancelled) setGraphLoading(false);
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, repo, projectId, allProjects, graphLoaded]);

  const addChipToken = useCallback((token: string): boolean => {
    const chip = parseFilterToken(token);
    if (!chip) return false;
    setChips((current) => [...current, chip]);
    return true;
  }, []);

  const removeChip = useCallback((index: number) => {
    setChips((current) => current.filter((_, i) => i !== index));
  }, []);

  const toggleGraphNode = useCallback((id: string) => {
    setSelectedGraphIds((current) => (
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    ));
  }, []);

  // The single predicate the dialog will POST — derived purely from local state.
  const predicate = useMemo<TimelineIssuePredicate | null>(() => {
    if (source === 'issue') return issueId.trim() ? predicateForIssue(issueId.trim()) : null;
    if (source === 'label') return predicateForLabel(labelValue);
    if (source === 'filter') return predicateForChips(chips);
    if (source === 'graph') {
      const ids = selectedGraphIds
        .map((nodeId) => graphNodes.find((node) => node.id === nodeId))
        .map((node) => (node ? issueIdFromNode(node) : null))
        .filter((id): id is string => Boolean(id));
      return predicateForGraphSelection(ids);
    }
    return null;
  }, [source, issueId, labelValue, chips, selectedGraphIds, graphNodes]);

  const previewTitle = useMemo(() => filterRowTitle(chips), [chips]);

  const handleSeed = useCallback(async () => {
    if (!predicate || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const body: SeedSpaceRequest = {
      predicate: predicate as unknown as Record<string, unknown>,
      include_artifacts: includeArtifacts,
      with_shelf_occurrences: withShelfOccurrences,
    };
    try {
      const result = await seedSpace(spaceId, body);
      onSeeded?.(result);
    } catch (error: unknown) {
      setSubmitError(error instanceof Error ? error.message : 'Seeding failed');
    } finally {
      setSubmitting(false);
    }
  }, [predicate, submitting, includeArtifacts, withShelfOccurrences, spaceId, onSeeded]);

  const canSeed = Boolean(predicate) && !submitting;

  return (
    <section
      className="space-seed-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Seed Space"
      data-testid="space-seed-dialog"
      data-source={source}
    >
      <header className="space-seed-dialog__header">
        <h2 className="space-seed-dialog__title">Seed this Space</h2>
        {onClose ? (
          <button
            type="button"
            className="space-seed-dialog__close"
            aria-label="Close seed dialog"
            onClick={onClose}
          >
            <Icon name="dismiss" />
            </button>
        ) : null}
      </header>

      {((source === 'graph' && graphError) || submitError) && (
        <DetailPaneNotice severity="error" density="compact" title={submitError ? 'Could not seed Space' : 'Graph issues unavailable'} testId={submitError ? 'seed-error' : undefined}>
          {source === 'graph' && graphError && <div>{graphError}</div>}
          {submitError && <div>{submitError}</div>}
        </DetailPaneNotice>
      )}

      <div className="space-seed-dialog__sources" role="tablist" aria-label="Seed source">
        {SPACE_SEED_SOURCES.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={source === value}
            className="space-seed-dialog__source"
            data-active={source === value}
            data-testid={`seed-source-${value}`}
            onClick={() => setSource(value)}
          >
            {SOURCE_LABELS[value]}
          </button>
        ))}
      </div>

      <div className="space-seed-dialog__body">
        {source === 'issue' ? (
          <label className="space-seed-dialog__field">
            <span>Issue id</span>
            <input
              value={issueId}
              data-testid="seed-issue-input"
              onInput={(event) => setIssueId((event.currentTarget as HTMLInputElement).value)}
              placeholder="e.g. 27a5026"
              list="space-seed-issue-options"
            />
            <datalist id="space-seed-issue-options">
              {issueOptions.map((value) => <option key={value} value={value} />)}
            </datalist>
          </label>
        ) : null}

        {source === 'label' ? (
          <label className="space-seed-dialog__field">
            <span>Label</span>
            <input
              value={labelValue}
              data-testid="seed-label-input"
              onInput={(event) => setLabelValue((event.currentTarget as HTMLInputElement).value)}
              placeholder="e.g. feature"
              list="space-seed-label-options"
            />
            <datalist id="space-seed-label-options">
              {labelOptions.map((value) => <option key={value} value={value} />)}
            </datalist>
          </label>
        ) : null}

        {source === 'filter' ? (
          <IssuePredicateFilter
            chips={chips}
            projecting={Boolean(predicate)}
            previewTitle={previewTitle}
            projectingLabel="Will seed matching issues"
            emptyLabel="Add at least one filter chip"
            labelOptions={labelOptions}
            kindOptions={kindOptions}
            issueOptions={issueOptions}
            onAddToken={addChipToken}
            onRemoveChip={removeChip}
            onCancel={() => setChips([])}
            onSave={handleSeed}
            canSave={canSeed}
            saveLabel="Seed from filter"
            autoFocusInput={false}
          />
        ) : null}

        {source === 'graph' ? (
          <div className="space-seed-dialog__graph" data-testid="seed-graph-picker">
            <label className="space-seed-dialog__option" data-testid="seed-all-projects-label">
              <input
                type="checkbox"
                checked={allProjects}
                data-testid="seed-all-projects"
                onChange={(event) => {
                  setAllProjects((event.currentTarget as HTMLInputElement).checked);
                  // Re-read the graph under the new scope.
                  setGraphLoaded(false);
                }}
              />
              <span>Include issues from all projects</span>
            </label>
            {graphLoading ? (
              <p className="space-seed-dialog__hint">Loading graph issues…</p>
            ) : graphError ? (
              <p className="space-seed-dialog__hint">Graph issues unavailable.</p>
            ) : graphNodes.length === 0 ? (
              <p className="space-seed-dialog__hint">No issue nodes in the graph.</p>
            ) : (
              <ul className="space-seed-dialog__graph-list">
                {graphNodes.map((node) => (
                  <li key={node.id}>
                    <label className="space-seed-dialog__graph-item">
                      <input
                        type="checkbox"
                        checked={selectedGraphIds.includes(node.id)}
                        data-testid={`seed-graph-node-${node.id}`}
                        onChange={() => toggleGraphNode(node.id)}
                      />
                      <span>{node.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="space-seed-dialog__hint" data-testid="seed-graph-count">
              {selectedGraphIds.length} selected
            </p>
          </div>
        ) : null}
      </div>

      <fieldset className="space-seed-dialog__options">
        <legend>Options</legend>
        <label className="space-seed-dialog__option">
          <input
            type="checkbox"
            checked={includeArtifacts}
            data-testid="seed-include-artifacts"
            onChange={(event) => setIncludeArtifacts((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>Include linked artifacts</span>
        </label>
        <label className="space-seed-dialog__option">
          <input
            type="checkbox"
            checked={withShelfOccurrences}
            data-testid="seed-with-shelf"
            onChange={(event) => setWithShelfOccurrences((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>Place on the shelf</span>
        </label>
      </fieldset>

      <footer className="space-seed-dialog__actions">
        {onClose ? (
          <button type="button" onClick={onClose}>Cancel</button>
        ) : null}
        <button
          type="button"
          className="space-seed-dialog__seed"
          data-testid="seed-submit"
          disabled={!canSeed}
          onClick={handleSeed}
        >
          {submitting ? 'Seeding…' : 'Seed Space'}
        </button>
      </footer>
    </section>
  );
}

export default SpaceSeedDialog;
