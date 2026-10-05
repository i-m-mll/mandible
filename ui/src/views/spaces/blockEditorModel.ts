// Block-editor pure model (umbrella de56ffa, C14c / issue cef3eac).
//
// Pure, DOM-free helpers the document block editor builds on:
//
//   - SORT KEYS: a UI mirror of the C11 base-36 lexicographic sort-key scheme
//     (`src/ledger/space-blocks.ts`). The editor needs to compute an insertion /
//     reorder key on the client (between two siblings, at the start/end) so a
//     create/move can post a concrete `sort_key` and the rendered order matches
//     the server's `ORDER BY sort_key`. The algorithm is identical to the
//     backend `generateSortKey`, so a key produced here round-trips through C11.
//
//   - CUSTODY: project the C13a `SpaceExportsReadResult` onto the C13d
//     `DocumentCustody` shape so the editor can gate against
//     `resolveCustodyEditorUx` without re-deriving custody policy.
//
//   - SIBLINGS: derive the ordered sibling list under a parent from a flat block
//     list, the input the insert/move key helpers consume.
//
// This module owns NO grammar (C12), NO custody policy (C13d owns the rule), and
// NO block schema (C11) — it only adapts their frozen surfaces for the editor.

import type { SpaceBlock } from '../../api';

// --- sort-key generation (UI mirror of C11 `generateSortKey`) ----------------

const SORT_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const SORT_BASE = SORT_ALPHABET.length;

function digitValue(ch: string): number {
  const idx = SORT_ALPHABET.indexOf(ch);
  return idx < 0 ? 0 : idx;
}

/** True when `value` is a non-empty base-36 sort key (matches C11 `isValidSortKey`). */
export function isValidSortKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    [...value].every((ch) => SORT_ALPHABET.includes(ch))
  );
}

/**
 * A key strictly between `before` and `after` in lexicographic order (pass null
 * for an open start/end). Byte-for-byte the C11 backend algorithm so a key
 * generated in the editor sorts identically on the server. Deterministic.
 */
export function generateSortKey(before: string | null, after: string | null): string {
  const lo = before ?? '';
  const hi = after ?? '';
  if (lo && hi && lo >= hi) {
    throw new Error(`sort-key bounds out of order: ${JSON.stringify({ before, after })}`);
  }

  let prefix = '';
  let i = 0;
  for (;;) {
    const loDigit = i < lo.length ? digitValue(lo[i]) : 0;
    const hiBounded = i < hi.length;
    const hiDigit = hiBounded ? digitValue(hi[i]) : SORT_BASE;

    if (hiDigit - loDigit > 1) {
      const mid = Math.floor((loDigit + hiDigit) / 2);
      return prefix + SORT_ALPHABET[mid];
    }
    if (!hiBounded) {
      prefix += SORT_ALPHABET[loDigit];
      return prefix + SORT_ALPHABET[Math.floor(SORT_BASE / 2)];
    }
    if (loDigit === hiDigit) {
      prefix += SORT_ALPHABET[loDigit];
      i += 1;
      continue;
    }
    prefix += SORT_ALPHABET[loDigit];
    return prefix + generateSortKey(lo.slice(i + 1), null);
  }
}

// --- sibling derivation ------------------------------------------------------

/**
 * The ordered sibling list under `parentId` (null = top level), sorted by
 * `sort_key` then `id` — the same total order the C11 `listSpaceBlocks` /
 * `orderBlocksDepthFirst` uses for siblings.
 */
export function siblingsUnder(blocks: SpaceBlock[], parentId: string | null): SpaceBlock[] {
  return blocks
    .filter((b) => (b.parent_id ?? null) === (parentId ?? null))
    .sort((a, b) =>
      a.sort_key < b.sort_key
        ? -1
        : a.sort_key > b.sort_key
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
}

/** Sort key to APPEND a new last sibling under `parentId`. */
export function appendSortKey(blocks: SpaceBlock[], parentId: string | null): string {
  const siblings = siblingsUnder(blocks, parentId);
  const last = siblings.length ? siblings[siblings.length - 1].sort_key : null;
  return generateSortKey(last, null);
}

/** Sort key to PREPEND a new first sibling under `parentId`. */
export function prependSortKey(blocks: SpaceBlock[], parentId: string | null): string {
  const siblings = siblingsUnder(blocks, parentId);
  const first = siblings.length ? siblings[0].sort_key : null;
  return generateSortKey(null, first);
}

/**
 * The result of computing a move/insert: the new `sort_key`, or a request to
 * re-space the whole sibling list when headroom is exhausted (equal bounds).
 */
export type SortKeyPlacement = { sort_key: string };

/**
 * Compute the sort key that places a block at sibling index `targetIndex` under
 * `parentId`, ignoring `movingId` (so a self-move is computed against its
 * destination neighbours, not itself). `targetIndex` is clamped to
 * `[0, siblingCount]`. Returns a key strictly between the neighbours at that
 * slot. Throws only if neighbouring keys are equal (degenerate stored data),
 * which the caller can recover from by re-spacing — a rare path the editor
 * surfaces as an error rather than silently corrupting order.
 */
export function placementForIndex(
  blocks: SpaceBlock[],
  parentId: string | null,
  targetIndex: number,
  movingId: string | null = null,
): SortKeyPlacement {
  const siblings = siblingsUnder(blocks, parentId).filter((b) => b.id !== movingId);
  const idx = Math.max(0, Math.min(targetIndex, siblings.length));
  const before = idx > 0 ? siblings[idx - 1].sort_key : null;
  const after = idx < siblings.length ? siblings[idx].sort_key : null;
  return { sort_key: generateSortKey(before, after) };
}

/** Current sibling index of `blockId` under its parent (or -1 if not found). */
export function siblingIndexOf(blocks: SpaceBlock[], blockId: string): number {
  const block = blocks.find((b) => b.id === blockId);
  if (!block) return -1;
  return siblingsUnder(blocks, block.parent_id ?? null).findIndex((b) => b.id === blockId);
}

// --- custody projection (C13a exports -> C13d custody) -----------------------


