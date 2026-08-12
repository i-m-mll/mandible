// Finding-reference view model (briefing umbrella 99b74d6, lane d7e51a1).
//
// Pure, side-effect-free projection helpers that turn a `finding` SpaceItem
// (plus an optional server resolution) into exactly what a renderer draws:
// title, source chip, revision-state indicator, and review-state badge.
// Kept out of the `.tsx` so the interesting invariants — pinned references do
// not move when a newer revision arrives, latest-tracking references do and say
// so — are unit-testable without a DOM.
//
// Spaces is a READ-ONLY surface for findings. Nothing in this module (or in the
// component that consumes it) can mutate review state; the Briefing view is the
// single write surface.

import type {
  FindingReviewState,
  SpaceFindingResolution,
  SpaceFindingRevisionMode,
  SpaceFindingRevisionState,
  SpaceItem,
} from '../../api';
import { compactFindingRef, findingDetailHref, findingRefString } from '../../resource-refs';

/** The minimum a renderer needs to describe a finding reference locally. */
export type FindingRefSource = {
  ref_id: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Everything derivable from the placement itself, with no server round-trip. */
export type FindingRefDescriptor = {
  candidateId: string;
  /** Canonical `finding:<candidate id>` ref. */
  ref: string;
  /** Compact display form of the ref. */
  refDisplay: string;
  /** Navigation target (the Briefing view — the single write surface). */
  href: string;
  revisionMode: SpaceFindingRevisionMode;
  pinnedRevisionId: string | null;
  title: string | null;
};

/** Whether a Space item is a finding reference. */
export function isFindingItem(item: Pick<SpaceItem, 'ref_type'>): boolean {
  return item.ref_type === 'finding';
}

/**
 * Read the revision semantics stored on a placement. Contract: `revision_mode`
 * is `'latest' | 'pinned'` and `pinned` REQUIRES `pinned_revision_id`. Anything
 * else (absent, malformed, pinned-without-id) reads as latest-tracking — the
 * route layer rejects malformed authored input, so this reader only has to be
 * total, never strict.
 */
export function readFindingMetadata(
  metadata: Record<string, unknown> | null | undefined,
): { revisionMode: SpaceFindingRevisionMode; pinnedRevisionId: string | null } {
  const raw = metadata ?? {};
  const mode = raw.revision_mode;
  const pinned = raw.pinned_revision_id;
  if (mode === 'pinned' && typeof pinned === 'string' && pinned.trim()) {
    return { revisionMode: 'pinned', pinnedRevisionId: pinned.trim() };
  }
  return { revisionMode: 'latest', pinnedRevisionId: null };
}

/** Describe a finding reference from the placement alone. */
export function describeFindingRef(source: FindingRefSource): FindingRefDescriptor {
  const candidateId = (source.ref_id ?? '').trim();
  const ref = findingRefString(candidateId);
  const { revisionMode, pinnedRevisionId } = readFindingMetadata(source.metadata);
  const title = source.title && source.title.trim() ? source.title.trim() : null;
  return {
    candidateId,
    ref,
    refDisplay: compactFindingRef(ref),
    href: findingDetailHref(candidateId),
    revisionMode,
    pinnedRevisionId,
    title,
  };
}

/** Clip a long revision id the way other Mandible surfaces clip hex ids. */
export function shortRevisionId(revisionId: string | null, length = 8): string {
  if (!revisionId) return '';
  const trimmed = revisionId.trim();
  return trimmed.length > length ? trimmed.slice(0, length) : trimmed;
}

const REVIEW_STATE_LABELS: Record<FindingReviewState, string> = {
  pending: 'Pending review',
  kept: 'Kept',
  dismissed: 'Dismissed',
  expired_unreviewed: 'Expired unreviewed',
  unknown: 'Review state unknown',
};

export function reviewStateLabel(state: FindingReviewState): string {
  return REVIEW_STATE_LABELS[state] ?? REVIEW_STATE_LABELS.unknown;
}

/** What one finding reference renders as, in any of the four renderers. */
export type FindingPresentation = {
  candidateId: string;
  ref: string;
  href: string;
  /** Visible title: resolved revision title → placement title → compact ref. */
  title: string;
  /** Producing collector task, or null until resolved. */
  source: string | null;
  revisionMode: SpaceFindingRevisionMode;
  revisionState: SpaceFindingRevisionState;
  /** Short indicator text, e.g. "Tracking latest" / "Pinned 1a2b3c4d". */
  revisionLabel: string;
  /**
   * Plain-language warning for the revision state, or null when there is
   * nothing to warn about (a pin that is still current).
   */
  revisionWarning: string | null;
  /** Machine warning code, mirroring the artifact `series_latest_not_pinned` idiom. */
  warningCode: string | null;
  reviewState: FindingReviewState;
  reviewLabel: string;
  /** True once the candidate itself resolved against the briefing store. */
  resolved: boolean;
  /** Resolution error (missing candidate, store unavailable), when any. */
  error: string | null;
};

const WARNING_TEXT: Record<string, string> = {
  finding_latest_not_pinned: 'Tracks the latest revision — not pinned.',
  finding_pinned_revision_superseded:
    'A newer revision exists; this reference stays pinned to the revision it was saved with.',
  finding_pinned_revision_missing: 'Pinned revision is not in the candidate store.',
  finding_store_unavailable: 'Briefing candidate store is unavailable.',
};

function warningCodeFor(
  revisionState: SpaceFindingRevisionState,
  resolution: SpaceFindingResolution | null,
): string | null {
  if (resolution && resolution.warnings.length > 0) return resolution.warnings[0];
  if (revisionState === 'latest') return 'finding_latest_not_pinned';
  if (revisionState === 'pinned_superseded') return 'finding_pinned_revision_superseded';
  if (revisionState === 'pinned_missing') return 'finding_pinned_revision_missing';
  return null;
}

/**
 * Project a placement (+ optional resolution) into render-ready display state.
 *
 * Without a resolution this still produces a complete, honest presentation from
 * the placement's own metadata — a reference is never rendered as a bare id.
 * With a resolution it gains the source chip, the resolved title, the review
 * state, and the latest-vs-pinned comparison.
 */
export function presentFinding(
  source: FindingRefSource,
  resolution: SpaceFindingResolution | null = null,
): FindingPresentation {
  const descriptor = describeFindingRef(source);
  // The placement's own metadata is authoritative for the reference's intent;
  // a resolution computed under different semantics never silently overrides it.
  const revisionMode = resolution?.revision_mode ?? descriptor.revisionMode;
  const pinnedRevisionId = resolution?.pinned_revision_id ?? descriptor.pinnedRevisionId;

  const revisionState: SpaceFindingRevisionState =
    resolution?.revision_state ?? (revisionMode === 'pinned' ? 'pinned_current' : 'latest');

  const revisionLabel =
    revisionMode === 'pinned'
      ? `Pinned ${shortRevisionId(pinnedRevisionId) || 'revision'}`
      : 'Tracking latest';

  const warningCode = warningCodeFor(revisionState, resolution);
  const revisionWarning = warningCode ? WARNING_TEXT[warningCode] ?? warningCode : null;

  const resolvedTitle = resolution?.effective_revision?.title ?? null;
  const title =
    (resolvedTitle && resolvedTitle.trim()) ||
    descriptor.title ||
    descriptor.refDisplay;

  return {
    candidateId: descriptor.candidateId,
    ref: descriptor.ref,
    href: descriptor.href,
    title,
    source: resolution?.source ?? null,
    revisionMode,
    revisionState,
    revisionLabel,
    revisionWarning,
    warningCode,
    reviewState: resolution?.review_state ?? 'unknown',
    reviewLabel: reviewStateLabel(resolution?.review_state ?? 'unknown'),
    resolved: resolution?.resolved ?? false,
    error: resolution?.error ?? null,
  };
}

/**
 * The revision a reference actually displays. A pinned reference reports its
 * pinned revision even after the candidate moves on — this is the invariant the
 * whole latest-vs-pinned design exists to protect.
 */
export function displayedRevisionId(resolution: SpaceFindingResolution | null): string | null {
  if (!resolution) return null;
  return resolution.effective_revision?.id ?? null;
}
