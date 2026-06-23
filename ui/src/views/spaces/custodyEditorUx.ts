// Custody-aware editor-UX contract (umbrella de56ffa, C13f / issue f7be021).
//
// This module DEFINES the rule the document block editor (C14c) gates against.
// It owns no editor internals; it is the single pure decision surface both this
// child (the export/registration UI) and C14c (the block editor) import so the
// read-only/stale rule is stated in exactly one place.
//
// The rule (custody-doc §6, review2 missing-scope):
//
//   A document under REPO authority (`authority='repo'`) whose tracked export
//   has drifted away from `clean` is NOT directly editable in Mandible: the
//   docs branch is the source of truth (`authority='repo'` → the docs branch
//   wins), so editing the Mandible block tree in place would silently fork away
//   from the authoritative repo bytes. The editor is therefore READ-ONLY and
//   flagged STALE, and the user is offered an EXPLICIT reconciliation:
//
//     - RE-IMPORT the repo's current version into Mandible working state, or
//     - FORK a fresh Mandible-custody copy to edit independently.
//
//   Both are explicit, user-initiated actions — never silent (custody-doc §6,
//   project Dataful-UX rule: canonical mutations require explicit user action).
//
// Mandible-custody documents (no `space_exports` row, or `authority='mandible'`)
// are always freely editable: there is no repo source of truth to fork from.

import type { SpaceExportAuthority, SpaceExportStatus } from '../../api';

/** A `clean` drift status is the only one that keeps a repo-custody doc editable. */
export const CLEAN_EXPORT_STATUS: SpaceExportStatus = 'clean';

/**
 * The minimal custody facts the editor-UX rule reads. This is intentionally a
 * narrow projection of the `space_exports` tracking row (C13a/C3 `SpaceExport`)
 * so C14c can compute editability from a Space's resolved custody state without
 * depending on the full row shape.
 *
 * `null` means "no tracked export row" → the document is in Mandible custody and
 * has never been committed to a repo (custody-doc §2.2).
 */
export type DocumentCustody = {
  authority: SpaceExportAuthority;
  status: SpaceExportStatus;
} | null;

/** The reconciliation affordances offered when a repo-custody doc is stale. */
export type CustodyAffordance = 'reimport' | 'fork';

/**
 * The resolved editor-UX decision C14c gates the block editor against. When
 * `editable` is false the editor must render read-only and surface the
 * `affordances` (re-import / fork) plus the human-readable `reason`.
 */
export type CustodyEditorUx = {
  /** True when the user may edit the Mandible block tree directly. */
  editable: boolean;
  /** True when the document is repo-authoritative but has drifted (read-only/stale). */
  stale: boolean;
  /** The custody authority in effect (`mandible` when no tracked export row). */
  authority: SpaceExportAuthority;
  /** The drift status in effect (`clean` when no tracked export row). */
  status: SpaceExportStatus;
  /** Explicit reconciliation affordances to offer when not editable. */
  affordances: readonly CustodyAffordance[];
  /** Human-readable reason for the gating (for the read-only banner). */
  reason: string | null;
};

/** No reconciliation needed when the document is freely editable. */
const NO_AFFORDANCES: readonly CustodyAffordance[] = [];
/** A stale repo-custody document offers both reconciliation paths. */
const STALE_AFFORDANCES: readonly CustodyAffordance[] = ['reimport', 'fork'];

/**
 * Decide whether a document's block editor is editable, given its resolved
 * custody state. This is the single source of the read-only/stale rule; C14c
 * imports it rather than re-deriving the policy.
 *
 * - No tracked export row (`null`) → Mandible custody → editable.
 * - `authority='mandible'` → Mandible custody → editable (a row can exist with
 *   mandible authority only transiently; it is not repo-authoritative).
 * - `authority='repo'` + `status='clean'` → tracked but in sync → editable
 *   (an in-Mandible edit just makes it `stale` on the next drift check, which is
 *   the normal authoring loop; we don't lock a clean tracked doc).
 * - `authority='repo'` + any non-`clean` status → repo-authoritative AND drifted
 *   → READ-ONLY + STALE with re-import / fork affordances.
 */
export function resolveCustodyEditorUx(custody: DocumentCustody): CustodyEditorUx {
  if (custody === null) {
    return {
      editable: true,
      stale: false,
      authority: 'mandible',
      status: CLEAN_EXPORT_STATUS,
      affordances: NO_AFFORDANCES,
      reason: null,
    };
  }

  const { authority, status } = custody;

  if (authority !== 'repo' || status === CLEAN_EXPORT_STATUS) {
    return {
      editable: true,
      stale: false,
      authority,
      status,
      affordances: NO_AFFORDANCES,
      reason: null,
    };
  }

  // authority === 'repo' && status !== 'clean': repo wins, and it has drifted.
  return {
    editable: false,
    stale: true,
    authority,
    status,
    affordances: STALE_AFFORDANCES,
    reason: custodyStaleReason(status),
  };
}

/** Convenience boolean for callers that only need the editable bit. */
export function isDocumentEditable(custody: DocumentCustody): boolean {
  return resolveCustodyEditorUx(custody).editable;
}

/** Human-readable reason string for the read-only/stale banner, per drift state. */
export function custodyStaleReason(status: SpaceExportStatus): string {
  switch (status) {
    case 'repo_changed':
      return 'The tracked repo file changed outside Mandible. Re-import the repo version or fork a Mandible copy to edit.';
    case 'worktree_dirty':
      return 'The tracked repo file has uncommitted changes in its worktree. Re-import the repo version or fork a Mandible copy to edit.';
    case 'conflict':
      return 'The repo file and Mandible edits diverged. Re-import the repo version or fork a Mandible copy to resolve.';
    case 'stale':
      return 'This document is repo-authoritative and has pending Mandible-side edits. Re-import the repo version or fork a Mandible copy to edit.';
    case 'clean':
    default:
      return 'This document is read-only.';
  }
}
