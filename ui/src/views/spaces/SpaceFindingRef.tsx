// Read-only finding reference (briefing umbrella 99b74d6, lane d7e51a1).
//
// One shared component for every Spaces renderer (collection, board, canvas,
// document). It draws a placed briefing review candidate: title, source chip,
// revision-state indicator, and review-state badge.
//
// READ-ONLY BY CONSTRUCTION: this component renders no control that could
// change review state. The Briefing view is the single write surface; the only
// interactive affordance here is a link out to it.

import { useEffect, useState } from 'preact/hooks';

import {
  resolveSpaceFinding,
  type SpaceFindingRefMetadata,
  type SpaceFindingResolution,
  type SpaceItem,
} from '../../api';
import {
  describeFindingRef,
  presentFinding,
  type FindingPresentation,
  type FindingRefSource,
} from './findingModel';
import './SpaceFindingRef.css';

/** Resolver seam: tests inject a stub instead of hitting the daemon. */
export type FindingResolver = (
  candidateId: string,
  metadata: SpaceFindingRefMetadata,
) => Promise<SpaceFindingResolution>;

const defaultResolver: FindingResolver = (candidateId, metadata) =>
  resolveSpaceFinding(candidateId, metadata);

/**
 * Resolve one finding reference under the revision semantics stored on the
 * placement. Returns `null` until the first resolution lands, so callers always
 * have a complete metadata-only presentation to render in the meantime.
 */
export function useFindingResolution(
  source: FindingRefSource,
  resolve: FindingResolver = defaultResolver,
): SpaceFindingResolution | null {
  const descriptor = describeFindingRef(source);
  const [resolution, setResolution] = useState<SpaceFindingResolution | null>(null);
  const { candidateId, revisionMode, pinnedRevisionId } = descriptor;

  useEffect(() => {
    if (!candidateId) return undefined;
    let cancelled = false;
    setResolution(null);
    const metadata: SpaceFindingRefMetadata =
      revisionMode === 'pinned' && pinnedRevisionId
        ? { revision_mode: 'pinned', pinned_revision_id: pinnedRevisionId }
        : { revision_mode: 'latest' };
    resolve(candidateId, metadata)
      .then((next) => {
        if (!cancelled) setResolution(next);
      })
      .catch(() => {
        // A failed resolution is not an error state for the placement: the
        // reference still renders from its own metadata, never dropped.
        if (!cancelled) setResolution(null);
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, revisionMode, pinnedRevisionId, resolve]);

  return resolution;
}

export type SpaceFindingRefProps = {
  /** The placement to render (a `finding` SpaceItem, or a document snapshot). */
  source: FindingRefSource;
  /** Pre-resolved payload; when omitted the component resolves it itself. */
  resolution?: SpaceFindingResolution | null;
  /** Resolver override (tests / hosts with their own cache). */
  resolve?: FindingResolver;
  /** Compact one-line variant for dense rows (collection tree, board cards). */
  compact?: boolean;
};

/** Build the item-shaped source a renderer holds into the model's input shape. */
export function findingSourceFromItem(item: SpaceItem): FindingRefSource {
  return { ref_id: item.ref_id, title: item.title, metadata: item.metadata };
}

/** Never-resolving resolver used when the host already supplies the resolution. */
const suspendedResolver: FindingResolver = () => new Promise<SpaceFindingResolution>(() => {});

export function SpaceFindingRef({
  source,
  resolution: providedResolution,
  resolve = defaultResolver,
  compact = false,
}: SpaceFindingRefProps): JSX.Element {
  const hostSupplied = providedResolution !== undefined;
  const fetched = useFindingResolution(source, hostSupplied ? suspendedResolver : resolve);
  const resolution = hostSupplied ? providedResolution : fetched;
  const view = presentFinding(source, resolution ?? null);
  return <SpaceFindingRefView view={view} compact={compact} />;
}

/** Pure presentational half — no data access, trivially testable. */
export function SpaceFindingRefView({
  view,
  compact = false,
}: {
  view: FindingPresentation;
  compact?: boolean;
}): JSX.Element {
  return (
    <span
      className={`space-finding${compact ? ' space-finding--compact' : ''}`}
      data-testid="space-finding-ref"
      data-candidate-id={view.candidateId}
      data-revision-mode={view.revisionMode}
      data-revision-state={view.revisionState}
      data-review-state={view.reviewState}
      data-resolved={view.resolved ? 'true' : 'false'}
      title={`Finding reference ${view.ref}`}
    >
      <a className="space-finding__title" href={view.href} data-testid="space-finding-title">
        {view.title}
      </a>
      <span className="space-finding__chips">
        <span className="space-finding__chip space-finding__chip--source" data-testid="space-finding-source">
          {view.source ?? 'finding'}
        </span>
        <span
          className="space-finding__chip space-finding__chip--revision"
          data-testid="space-finding-revision"
          data-state={view.revisionState}
        >
          {view.revisionLabel}
        </span>
        <span
          className="space-finding__chip space-finding__chip--review"
          data-testid="space-finding-review"
          data-state={view.reviewState}
          // Review state is DISPLAY ONLY here; it is mutated in the Briefing view.
          aria-label={`Review state: ${view.reviewLabel} (read-only in Spaces)`}
        >
          {view.reviewLabel}
        </span>
      </span>
      {view.revisionWarning && !compact ? (
        <span
          className="space-finding__warning"
          data-testid="space-finding-warning"
          data-warning-code={view.warningCode ?? ''}
        >
          {view.revisionWarning}
        </span>
      ) : null}
      {view.error && !compact ? (
        <span className="space-finding__error" role="status" data-testid="space-finding-error">
          {view.error}
        </span>
      ) : null}
    </span>
  );
}

export default SpaceFindingRef;
