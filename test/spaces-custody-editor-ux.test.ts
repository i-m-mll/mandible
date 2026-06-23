// Custody-aware editor-UX rule tests (umbrella de56ffa, C13f / issue f7be021).
//
// This is the load-bearing rule C14c gates the block editor against (custody-doc
// §6, review2 missing-scope): a repo-authoritative document (`authority='repo'`)
// whose tracked export is non-`clean` is read-only/stale with explicit re-import
// / fork affordances. These tests pin every branch of that decision so the
// editor gating C14c builds against it can rely on the exact contract.

import { describe, expect, it } from 'vitest';

import {
  resolveCustodyEditorUx,
  isDocumentEditable,
  custodyStaleReason,
  type DocumentCustody,
} from '../ui/src/views/spaces/custodyEditorUx';
import type { SpaceExportStatus } from '../ui/src/api';

const NON_CLEAN: SpaceExportStatus[] = ['stale', 'repo_changed', 'worktree_dirty', 'conflict'];

describe('resolveCustodyEditorUx', () => {
  it('treats a document with no tracked export row as freely editable (Mandible custody)', () => {
    const ux = resolveCustodyEditorUx(null);
    expect(ux.editable).toBe(true);
    expect(ux.stale).toBe(false);
    expect(ux.authority).toBe('mandible');
    expect(ux.status).toBe('clean');
    expect(ux.affordances).toEqual([]);
    expect(ux.reason).toBeNull();
  });

  it('treats an authority=mandible row as editable regardless of status', () => {
    for (const status of ['clean', ...NON_CLEAN] as SpaceExportStatus[]) {
      const custody: DocumentCustody = { authority: 'mandible', status };
      const ux = resolveCustodyEditorUx(custody);
      expect(ux.editable).toBe(true);
      expect(ux.stale).toBe(false);
      expect(ux.affordances).toEqual([]);
    }
  });

  it('treats a clean repo-authoritative row as editable (normal authoring loop)', () => {
    const ux = resolveCustodyEditorUx({ authority: 'repo', status: 'clean' });
    expect(ux.editable).toBe(true);
    expect(ux.stale).toBe(false);
    expect(ux.affordances).toEqual([]);
    expect(ux.reason).toBeNull();
  });

  it('locks a repo-authoritative row read-only/stale for every non-clean drift state', () => {
    for (const status of NON_CLEAN) {
      const ux = resolveCustodyEditorUx({ authority: 'repo', status });
      expect(ux.editable, `status=${status} must be read-only`).toBe(false);
      expect(ux.stale, `status=${status} must be stale`).toBe(true);
      expect(ux.authority).toBe('repo');
      expect(ux.status).toBe(status);
      // Both explicit reconciliation affordances are offered (custody-doc §6).
      expect(ux.affordances).toEqual(['reimport', 'fork']);
      expect(typeof ux.reason).toBe('string');
      expect(ux.reason).toBeTruthy();
    }
  });
});

describe('isDocumentEditable', () => {
  it('mirrors resolveCustodyEditorUx().editable', () => {
    expect(isDocumentEditable(null)).toBe(true);
    expect(isDocumentEditable({ authority: 'repo', status: 'clean' })).toBe(true);
    expect(isDocumentEditable({ authority: 'repo', status: 'conflict' })).toBe(false);
    expect(isDocumentEditable({ authority: 'mandible', status: 'stale' })).toBe(true);
  });
});

describe('custodyStaleReason', () => {
  it('returns a distinct human-readable reason for each non-clean status', () => {
    const reasons = new Set(NON_CLEAN.map((status) => custodyStaleReason(status)));
    // Every non-clean status maps to a non-empty reason, and they are distinct
    // so the read-only banner can explain the specific drift cause.
    expect(reasons.size).toBe(NON_CLEAN.length);
    for (const reason of reasons) {
      expect(reason).toBeTruthy();
      expect(reason.toLowerCase()).toContain('re-import');
    }
  });
});
