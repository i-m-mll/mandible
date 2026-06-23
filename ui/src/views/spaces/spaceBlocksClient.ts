// Block-editor API client (umbrella de56ffa, C14c / issue cef3eac).
//
// The block editor (C14c) reads AND writes `space_blocks` through the C11 block
// routes (`src/routes/spaces.ts`):
//
//   GET    /api/spaces/:id/blocks                       -> list (canonical order)
//   POST   /api/spaces/:id/blocks                        -> create
//   PATCH  /api/spaces/:id/blocks/:block_id              -> update (move/reorder/edit)
//   DELETE /api/spaces/:id/blocks/:block_id              -> delete
//   POST   /api/spaces/:id/items/:item_id/detach-blocks  -> detach/degrade an embed
//
// The shared C3 typed client (`ui/src/api.ts`) owns NO block helper (the C14b
// renderer comment notes this: "the C3 typed client owns no block-list helper").
// So this module is the editor lane's OWN thin client over the frozen C11 routes
// — it does not edit `api.ts`. Every call takes an injectable `fetchImpl` so the
// editor + custody-gating tests can drive it without a server.
//
// This client owns NO grammar, sort-key policy, or custody policy: sort keys are
// computed by `./blockEditorModel` (UI mirror of the C11 base-36 scheme) and
// passed in; custody gating is decided by C13d's `./custodyEditorUx`.

import type { SpaceBlock } from '../../api';
import type { SpaceBlockType } from '../../../../src/contracts';

/** Embed snapshot placeholder posted alongside an `item_id` (C11 invariant). */
export type BlockItemSnapshot = Record<string, unknown>;

/** Create-block request body (mirrors `parseBlockCreateInput`, C11). */
export type CreateBlockBody = {
  block_type: SpaceBlockType;
  parent_id?: string | null;
  item_id?: string | null;
  item_snapshot?: BlockItemSnapshot | null;
  sort_key?: string | null;
  markdown?: string | null;
  metadata?: Record<string, unknown>;
};

/** Update-block request body (mirrors `parseBlockUpdateInput`, C11). */
export type UpdateBlockBody = {
  block_type?: SpaceBlockType;
  parent_id?: string | null;
  item_id?: string | null;
  item_snapshot?: BlockItemSnapshot | null;
  sort_key?: string | null;
  markdown?: string | null;
  metadata?: Record<string, unknown>;
};

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' } as const;

function spacePath(spaceId: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}/blocks`;
}

function blockPath(spaceId: string, blockId: string): string {
  return `${spacePath(spaceId)}/${encodeURIComponent(blockId)}`;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error || body.message || fallback;
  } catch {
    return fallback;
  }
}

/** List a Space's blocks in canonical document order. GET-only (read path). */
export async function listSpaceBlocks(
  spaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceBlock[]> {
  const response = await fetchImpl(spacePath(spaceId), { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(await readError(response, `load blocks for ${spaceId} failed: ${response.status}`));
  }
  const payload = (await response.json()) as { blocks?: SpaceBlock[] };
  return Array.isArray(payload.blocks) ? payload.blocks : [];
}

/** Create a block (POST). The editor supplies a precomputed `sort_key`. */
export async function createSpaceBlock(
  spaceId: string,
  body: CreateBlockBody,
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceBlock> {
  const response = await fetchImpl(spacePath(spaceId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readError(response, `create block failed: ${response.status}`));
  }
  const payload = (await response.json()) as { block: SpaceBlock };
  return payload.block;
}

/** Update a block (PATCH) — edit prose, change type, move/reorder via sort_key. */
export async function updateSpaceBlock(
  spaceId: string,
  blockId: string,
  body: UpdateBlockBody,
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceBlock> {
  const response = await fetchImpl(blockPath(spaceId, blockId), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readError(response, `update block failed: ${response.status}`));
  }
  const payload = (await response.json()) as { block: SpaceBlock };
  return payload.block;
}

/** Delete a block (DELETE). */
export async function deleteSpaceBlock(
  spaceId: string,
  blockId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(blockPath(spaceId, blockId), { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(await readError(response, `delete block failed: ${response.status}`));
  }
}

/**
 * Detach/degrade every block that embeds `itemId` (drops `item_id` but keeps the
 * snapshot placeholder), so the underlying item can then be removed without
 * tripping the `ON DELETE RESTRICT` guard. This is the C11 detach route; the
 * editor invokes it ONLY after an explicit, user-confirmed embed-on-delete
 * decision (the decision itself is deferred policy — see DocumentBlockEditor).
 */
export async function detachItemFromBlocks(
  spaceId: string,
  itemId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ detached: SpaceBlock[] }> {
  const response = await fetchImpl(
    `/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/detach-blocks`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' },
  );
  if (!response.ok) {
    throw new Error(await readError(response, `detach item failed: ${response.status}`));
  }
  return (await response.json()) as { detached: SpaceBlock[] };
}
