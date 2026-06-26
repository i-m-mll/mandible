// Spaces document block editor (umbrella de56ffa, C14c / issue cef3eac).
//
// The EDITOR over the `space_blocks` tree. It is the writable counterpart to the
// C14b read-only `DocumentRenderer`: it creates / edits / reorders / deletes
// blocks and embeds issue/artifact/comment items through the C11 block routes,
// and renders the live block tree through the C14b renderer (`renderSpaceBlocks`
// + `DocumentBody`) so the authored result is shown by exactly the same
// sanitize/grammar/ref path the reader sees. It owns NO renderer internals, NO
// `space_blocks` grammar/schema, and NO custody backend.
//
// CUSTODY GATING (C13d, `./custodyEditorUx`): the editor gates against the
// single custody rule module. A document under `authority='repo'` whose tracked
// export has drifted from `clean` is READ-ONLY + STALE; the editor renders the
// read-only tree and surfaces the two explicit reconciliation affordances
// (re-import / fork). Both are user-initiated callbacks — the editor never
// silently forks the repo-authoritative bytes (Dataful-UX: canonical mutations
// require explicit user action). Mandible-custody documents are freely editable.
//
// EMBED-ON-DELETE (DEFERRED): deleting a `space_items` row that blocks embed is
// `ON DELETE RESTRICT` + an `item_snapshot_json` placeholder, so degrading to a
// placeholder is always POSSIBLE — but WHICH behavior is correct (auto-detach to
// a placeholder vs. block the delete and make the user remove embeds first) is a
// deferred product decision. This editor does NOT pick it: when a delete is
// blocked by embeds it raises an explicit, user-prompted decision point
// (`onEmbedDeleteDecision`) and takes no destructive action until the user
// chooses. The default (no handler) is the SAFE, non-destructive path: surface
// the conflict and stop.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { SpaceBlock, SpaceExport, SpaceItem } from '../../api';
import type { SpaceBlockType } from '../../../../src/contracts';
import { getSpaceExports, getSpaceFactPacket } from '../../api';
import { resolveResourceRef, type ResolverResult } from '../../resource-refs';
import { createSSEClient } from '../../sse-client';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import { DocumentBody, renderSpaceBlocks } from './DocumentRenderer';
import {
  resolveCustodyEditorUx,
  type CustodyAffordance,
  type CustodyEditorUx,
} from './custodyEditorUx';
import {
  appendSortKey,
  deriveDocumentCustody,
  placementForIndex,
  siblingIndexOf,
} from './blockEditorModel';
import {
  createSpaceBlock,
  detachItemFromBlocks,
  listSpaceBlocks,
  updateSpaceBlock,
  type BlockItemSnapshot,
  type CreateBlockBody,
} from './spaceBlocksClient';
import {
  readBlockEditorViewState,
  reconcileBlockEditorViewState,
  writeBlockEditorViewState,
  type BlockEditorViewState,
} from './blockEditorViewState';
import { EMPTY_DOCUMENT_VIEW_STATE } from './documentViewState';
import { SpaceItemPicker } from './SpaceItemPicker';
import './DocumentBlockEditor.css';

const SPACE_EVENT_PREFIX = 'space:';

/** Prose block types the editor offers as "add prose" affordances. */
const PROSE_BLOCK_TYPES: SpaceBlockType[] = ['paragraph', 'heading', 'todo'];
const AUTOSAVE_DELAY_MS = 650;

/** Embed block types and the ref kind each one binds. */
const EMBED_KIND: Record<string, SpaceBlockType> = {
  issue: 'issue_embed',
  artifact: 'artifact_embed',
  comment: 'comment_embed',
};

/**
 * An item the editor can embed. The caller (the C8 collection / a future picker)
 * supplies resolved items; the editor only needs enough to build the snapshot
 * placeholder + the embed block. Kept minimal so the editor does not depend on
 * the full `SpaceItem` shape.
 */
export type EmbeddableItem = {
  id: string;
  ref_type: 'issue' | 'artifact' | 'comment' | string;
  ref_id: string;
  ref_uri?: string | null;
  title?: string | null;
};

/** The user-prompted, DEFERRED embed-on-delete decision surface. */
export type EmbedDeleteDecision = {
  /** The item the user tried to delete that blocks embed. */
  itemId: string;
  /** The blocks currently embedding it (degrade targets). */
  embeddingBlocks: SpaceBlock[];
  /** Explicit "detach to placeholder, then the item can be deleted" choice. */
  detachToPlaceholder: () => Promise<void>;
  /** Explicit "leave embeds intact, cancel the delete" choice. */
  cancel: () => void;
};

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; blocks: SpaceBlock[]; exports: SpaceExport[]; items: SpaceItem[] }
  | { status: 'error'; message: string };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving'; blockId: string }
  | { status: 'saved'; blockId: string }
  | { status: 'error'; blockId: string; message: string };

type CaretTarget = { blockId: string; start: number; end: number };

type RefInspector =
  | { status: 'resolving'; ref: string }
  | { status: 'ready'; ref: string; result: ResolverResult }
  | { status: 'error'; ref: string; message: string };

export interface DocumentBlockEditorProps extends SpaceRendererMountProps {
  /** Test seam: inject a fetch implementation for block reads/writes. */
  fetchImpl?: typeof fetch;
  /** Items the editor may embed (issue / artifact / comment). */
  embeddableItems?: EmbeddableItem[];
  /**
   * Explicit re-import affordance: pull the repo's current version into Mandible
   * working state. Surfaced only when custody is repo-authoritative + stale. The
   * reconciliation backend is out of this lane's scope (C13*); the editor only
   * OFFERS the affordance as an explicit user action.
   */
  onReimport?: () => void;
  /** Explicit fork affordance: fork a fresh Mandible-custody copy to edit. */
  onFork?: () => void;
  /**
   * The DEFERRED embed-on-delete decision point. Invoked when a user tries to
   * remove an embedded item: the editor presents the decision and takes no
   * destructive action until the user resolves it through this surface. When
   * omitted, the editor falls back to surfacing the conflict read-only and does
   * nothing (the safe non-destructive default).
   */
  onEmbedDeleteDecision?: (decision: EmbedDeleteDecision) => void;
}

/** Build the C11 snapshot placeholder for an embedded item. */
function snapshotFor(item: EmbeddableItem): BlockItemSnapshot {
  return {
    item_id: item.id,
    ref_type: item.ref_type,
    ref_id: item.ref_id,
    ref_uri: item.ref_uri ?? null,
    title: item.title ?? null,
  };
}

function blockCanEditMarkdown(block: SpaceBlock): boolean {
  return block.item_id == null && block.item_snapshot == null;
}

function formatInlineRef(item: Pick<EmbeddableItem, 'ref_type' | 'ref_id' | 'ref_uri'>): string {
  const raw = (item.ref_uri || item.ref_id || '').trim();
  if (!raw) return `[${item.ref_type}:unknown]`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return `[${raw}]`;
  if (item.ref_type === 'artifact') return `[artifact:${raw}]`;
  if (item.ref_type === 'issue') return `[issue:${raw}]`;
  if (item.ref_type === 'comment') return `[comment:${raw}]`;
  return `[${item.ref_type}:${raw}]`;
}

function insertAtCaret(value: string, insertion: string, start: number, end: number): string {
  const before = value.slice(0, Math.max(0, start));
  const after = value.slice(Math.max(0, end));
  const prefix = before && !/\s$/.test(before) ? ' ' : '';
  const suffix = after && !/^\s/.test(after) ? ' ' : '';
  return `${before}${prefix}${insertion}${suffix}${after}`;
}

function refFromHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.href);
    return url.hash.includes('?')
      ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)).get('ref')
      : url.searchParams.get('ref');
  } catch {
    return null;
  }
}

/**
 * Spaces document block editor mount. Registered for the `document` renderer in
 * the C10 shell (it is the editable document surface; the read-only renderer is
 * mounted for non-editable / stale custody states). Reads `space_blocks` + the
 * Space's custody, renders the tree through the C14b renderer, and writes block
 * mutations through the C11 routes — preserving browser-local edit state across
 * refetches and SSE reconciliation (Dataful-UX contract).
 */
export function DocumentBlockEditor({
  projectId,
  spaceId,
  fetchImpl,
  embeddableItems = [],
  onReimport,
  onFork,
  onEmbedDeleteDecision,
}: DocumentBlockEditorProps): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [viewState, setViewState] = useState<BlockEditorViewState>(() =>
    readBlockEditorViewState(projectId, spaceId ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [commandBlockId, setCommandBlockId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<RefInspector | null>(null);
  const [pendingEmbedDelete, setPendingEmbedDelete] = useState<EmbedDeleteDecision | null>(null);
  const fetchRef = useRef(fetchImpl);
  const saveTimers = useRef<Map<string, number>>(new Map());
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const caretRef = useRef<CaretTarget | null>(null);
  fetchRef.current = fetchImpl;

  // Re-hydrate per-space edit state whenever the open Space changes.
  useEffect(() => {
    setViewState(readBlockEditorViewState(projectId, spaceId ?? ''));
  }, [projectId, spaceId]);

  // Persist edit state (browser-local only; never promoted to the ledger).
  useEffect(() => {
    if (spaceId) writeBlockEditorViewState(projectId, spaceId, viewState);
  }, [projectId, spaceId, viewState]);

  useEffect(() => {
    return () => {
      for (const timer of saveTimers.current.values()) window.clearTimeout(timer);
      saveTimers.current.clear();
    };
  }, []);

  const fetcher = useCallback(() => fetchRef.current ?? fetch, []);

  const loadAll = useCallback(
    async (isReconcile: boolean) => {
      if (!spaceId) {
        setLoad({ status: 'idle' });
        return;
      }
      if (!isReconcile) setLoad({ status: 'loading' });
      try {
        const [blocks, exportsResult, packet] = await Promise.all([
          listSpaceBlocks(spaceId, fetcher()),
          getSpaceExports(spaceId).catch(() => ({ exports: [] as SpaceExport[] })),
          getSpaceFactPacket(spaceId).catch(() => ({ items: [] as SpaceItem[] })),
        ]);
        setLoad({ status: 'ready', blocks, exports: exportsResult.exports, items: packet.items });
        // Reconcile edit state against live block ids without resetting the
        // user's in-progress drafts (Dataful-UX: refetch is reconciliation).
        setViewState((prior) =>
          reconcileBlockEditorViewState(prior, blocks.map((b) => b.id)),
        );
      } catch (err) {
        setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [spaceId, fetcher],
  );

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  // SSE reconciliation: any `space:*` event refetches as a reconciliation input.
  // Edit drafts are preserved across the refetch.
  useEffect(() => {
    if (!spaceId) return;
    const client = createSSEClient();
    const unsubscribe = client.on('*', (payload) => {
      if (typeof payload.type === 'string' && payload.type.startsWith(SPACE_EVENT_PREFIX)) {
        void loadAll(true);
      }
    });
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [spaceId, loadAll]);

  const blocks = useMemo(() => {
    const live = load.status === 'ready' ? load.blocks : [];
    return live.map((block) => {
      const draft = viewState.drafts[block.id];
      return draft === undefined ? block : { ...block, markdown: draft };
    });
  }, [load, viewState.drafts]);
  const exports = load.status === 'ready' ? load.exports : [];
  const spaceItems = load.status === 'ready' ? load.items : [];

  const custody: CustodyEditorUx = useMemo(
    () => resolveCustodyEditorUx(deriveDocumentCustody(exports)),
    [exports],
  );
  const editable = custody.editable;

  const rendered = useMemo(
    () => (load.status === 'ready' ? renderSpaceBlocks(blocks, spaceId ?? undefined) : null),
    [load.status, blocks, spaceId],
  );
  const sources = useMemo(() => {
    const map = new Map<string, SpaceBlock>();
    for (const b of blocks) map.set(b.id, b);
    return map;
  }, [blocks]);

  // --- mutations (guarded by `editable`) -------------------------------------

  const runMutation = useCallback(
    async (op: () => Promise<unknown>) => {
      if (!editable || !spaceId) return;
      setBusy(true);
      setActionError(null);
      try {
        await op();
        await loadAll(true);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [editable, spaceId, loadAll],
  );

  const saveMarkdownNow = useCallback(
    async (blockId: string, markdown: string) => {
      if (!editable || !spaceId) return;
      const prior = saveTimers.current.get(blockId);
      if (prior) {
        window.clearTimeout(prior);
        saveTimers.current.delete(blockId);
      }
      setSaveState({ status: 'saving', blockId });
      try {
        await updateSpaceBlock(spaceId, blockId, { markdown }, fetcher());
        setSaveState({ status: 'saved', blockId });
        setViewState((state) => {
          if (state.drafts[blockId] !== markdown) return state;
          const drafts = { ...state.drafts };
          delete drafts[blockId];
          return { ...state, drafts };
        });
        await loadAll(true);
      } catch (err) {
        setSaveState({
          status: 'error',
          blockId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [editable, spaceId, fetcher, loadAll],
  );

  const queueAutosave = useCallback(
    (blockId: string, markdown: string) => {
      const prior = saveTimers.current.get(blockId);
      if (prior) window.clearTimeout(prior);
      const timer = window.setTimeout(() => {
        saveTimers.current.delete(blockId);
        void saveMarkdownNow(blockId, markdown);
      }, AUTOSAVE_DELAY_MS);
      saveTimers.current.set(blockId, timer);
    },
    [saveMarkdownNow],
  );

  const setEditing = useCallback((blockId: string | null) => {
    setActiveBlockId(blockId);
    setViewState((prior) => ({ ...prior, editingId: blockId }));
  }, []);

  const setDraft = useCallback((blockId: string, value: string) => {
    setViewState((prior) => ({
      ...prior,
      drafts: { ...prior.drafts, [blockId]: value },
    }));
  }, []);

  const addProseBlock = useCallback(
    async (blockType: SpaceBlockType, afterBlockId?: string | null, markdown = '') => {
      if (!spaceId) return;
      const anchor = afterBlockId ? blocks.find((b) => b.id === afterBlockId) : null;
      const parentId = anchor?.parent_id ?? null;
      const anchorIndex = anchor ? siblingIndexOf(blocks, anchor.id) + 1 : blocks.length;
      const placement = afterBlockId
        ? placementForIndex(blocks, parentId, anchorIndex, null)
        : { sort_key: appendSortKey(blocks, null) };
      const body: CreateBlockBody = {
        block_type: blockType,
        parent_id: parentId,
        sort_key: placement.sort_key,
        markdown: markdown || (blockType === 'heading' ? 'New heading' : ''),
      };
      await runMutation(async () => {
        const created = await createSpaceBlock(spaceId, body, fetcher());
        setActiveBlockId(created.id);
        setEditing(created.id);
        return created;
      });
    },
    [spaceId, blocks, runMutation, fetcher, setEditing],
  );

  const isItemEmbedded = useCallback(
    (item: Pick<EmbeddableItem, 'id'>) => blocks.some((block) => block.item_id === item.id),
    [blocks],
  );

  const embedItem = useCallback(
    async (item: EmbeddableItem) => {
      if (!spaceId) return;
      if (isItemEmbedded(item)) return;
      const blockType = EMBED_KIND[item.ref_type] ?? 'reference';
      const body: CreateBlockBody = {
        block_type: blockType,
        parent_id: null,
        item_id: item.id,
        item_snapshot: snapshotFor(item),
        sort_key: appendSortKey(blocks, null),
        markdown: '',
      };
      await runMutation(() => createSpaceBlock(spaceId, body, fetcher()));
    },
    [spaceId, blocks, isItemEmbedded, runMutation, fetcher],
  );

  const embedSpaceItem = useCallback(
    async (item: SpaceItem) => {
      const embeddable = {
        id: item.id,
        ref_type: item.ref_type,
        ref_id: item.ref_id,
        ref_uri: item.ref_uri,
        title: item.title,
      };
      const refText = formatInlineRef(embeddable);
      const editableBlocks = blocks.filter(blockCanEditMarkdown);
      const targetId =
        activeBlockId && editableBlocks.some((b) => b.id === activeBlockId)
          ? activeBlockId
          : editableBlocks[editableBlocks.length - 1]?.id ?? null;
      if (!targetId) {
        await addProseBlock('paragraph', null, refText);
        return;
      }
      const block = blocks.find((b) => b.id === targetId);
      if (!block) return;
      const draft = viewState.drafts[targetId] ?? block.markdown ?? '';
      const caret =
        caretRef.current?.blockId === targetId
          ? caretRef.current
          : { blockId: targetId, start: draft.length, end: draft.length };
      const next = insertAtCaret(draft, refText, caret.start, caret.end);
      setActiveBlockId(targetId);
      setEditing(targetId);
      setDraft(targetId, next);
      queueAutosave(targetId, next);
      window.setTimeout(() => {
        const textarea = textareaRefs.current.get(targetId);
        if (!textarea) return;
        const nextPos = Math.min(next.length, caret.start + refText.length + 1);
        textarea.focus();
        textarea.setSelectionRange(nextPos, nextPos);
        caretRef.current = { blockId: targetId, start: nextPos, end: nextPos };
      }, 0);
    },
    [activeBlockId, addProseBlock, blocks, queueAutosave, setDraft, setEditing, viewState.drafts],
  );

  const saveProse = useCallback(
    (blockId: string, markdown: string) => {
      if (!spaceId) return;
      void saveMarkdownNow(blockId, markdown);
      setViewState((prior) => ({ ...prior, editingId: null }));
    },
    [spaceId, saveMarkdownNow],
  );

  /**
   * Try to remove an embedded ITEM (not the block). Because the item is
   * `ON DELETE RESTRICT`, this is the DEFERRED embed-on-delete decision point:
   * the editor never silently degrades; it raises the choice to the user and
   * only detaches-to-placeholder if the user explicitly confirms.
   */
  const requestItemDelete = useCallback(
    (itemId: string) => {
      if (!spaceId || !editable) return;
      const embeddingBlocks = blocks.filter((b) => b.item_id === itemId);
      const decision: EmbedDeleteDecision = {
        itemId,
        embeddingBlocks,
        detachToPlaceholder: async () => {
          await runMutation(() => detachItemFromBlocks(spaceId, itemId, fetcher()));
          setPendingEmbedDelete(null);
        },
        cancel: () => setPendingEmbedDelete(null),
      };
      if (onEmbedDeleteDecision) {
        onEmbedDeleteDecision(decision);
      } else {
        // Safe non-destructive default: surface the conflict, take no action.
        setPendingEmbedDelete(decision);
      }
    },
    [spaceId, editable, blocks, runMutation, fetcher, onEmbedDeleteDecision],
  );

  const updateCaret = useCallback((blockId: string, textarea: HTMLTextAreaElement) => {
    caretRef.current = {
      blockId,
      start: textarea.selectionStart ?? textarea.value.length,
      end: textarea.selectionEnd ?? textarea.value.length,
    };
  }, []);

  const handleDraftInput = useCallback(
    (blockId: string, textarea: HTMLTextAreaElement) => {
      const value = textarea.value;
      updateCaret(blockId, textarea);
      setDraft(blockId, value);
      queueAutosave(blockId, value);
    },
    [queueAutosave, setDraft, updateCaret],
  );

  const snapshotCaretForBlock = useCallback(
    (blockId: string) => {
      const textarea = textareaRefs.current.get(blockId);
      if (textarea) updateCaret(blockId, textarea);
      else {
        const block = blocks.find((b) => b.id === blockId);
        const draft = viewState.drafts[blockId] ?? block?.markdown ?? '';
        caretRef.current = { blockId, start: draft.length, end: draft.length };
      }
      setActiveBlockId(blockId);
      setEditing(blockId);
    },
    [blocks, setEditing, updateCaret, viewState.drafts],
  );

  const openReferencePicker = useCallback(
    (blockId: string) => {
      snapshotCaretForBlock(blockId);
      setCommandBlockId(null);
      setPickerOpen(true);
    },
    [snapshotCaretForBlock],
  );

  const runContextCommand = useCallback(
    (blockId: string, command: () => void) => {
      snapshotCaretForBlock(blockId);
      setCommandBlockId(null);
      command();
    },
    [snapshotCaretForBlock],
  );

  const openReferenceInspector = useCallback(
    (ref: string) => {
      if (!ref.trim()) return;
      setInspector({ status: 'resolving', ref });
      resolveResourceRef(ref, fetcher())
        .then((result) => setInspector({ status: 'ready', ref, result }))
        .catch((err) =>
          setInspector({ status: 'error', ref, message: err instanceof Error ? err.message : String(err) }),
        );
    },
    [fetcher],
  );

  const handleDocumentClick = useCallback(
    (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a.resource-ref__link, a.spaces-doc-ref__link') as HTMLAnchorElement | null;
      if (!anchor) return;
      const wrapper = anchor.closest('[data-resource-ref]') as HTMLElement | null;
      const ref = wrapper?.getAttribute('data-resource-ref') || refFromHref(anchor.href);
      if (!ref) return;
      event.preventDefault();
      openReferenceInspector(ref);
    },
    [openReferenceInspector],
  );

  // --- render ----------------------------------------------------------------

  if (!spaceId) {
    return (
      <div
        className="spaces-block-editor spaces-block-editor--empty"
        data-testid="spaces-block-editor"
      >
        Select a Space to edit its document.
      </div>
    );
  }

  return (
    <div
      className="spaces-block-editor"
      data-testid="spaces-block-editor"
      data-editable={String(editable)}
      data-stale={String(custody.stale)}
    >
      {load.status === 'loading' && (
        <div className="spaces-block-editor__status">
          <span>Loading document…</span>
          <div className="spaces-block-editor__doc-shell" aria-hidden="true">
            <div className="spaces-block-editor__ghost-line spaces-block-editor__ghost-line--wide" />
            <div className="spaces-block-editor__ghost-line" />
          </div>
        </div>
      )}
      {load.status === 'error' && (
        <div className="spaces-block-editor__error" data-testid="spaces-block-editor-error">
          Failed to load document: {load.message}
        </div>
      )}

      {!editable && custody.stale && (
        <CustodyStaleBanner
          custody={custody}
          onReimport={onReimport}
          onFork={onFork}
        />
      )}

      {actionError && (
        <div className="spaces-block-editor__error" data-testid="spaces-block-editor-action-error">
          {actionError}
        </div>
      )}

      {/* The live document, rendered through the C14b renderer (read path). */}
      {saveState.status !== 'idle' && (
        <div
          className="spaces-block-editor__save-state"
          data-state={saveState.status}
          data-testid="spaces-block-editor-save-state"
        >
          {saveState.status === 'saving'
            ? 'Autosaving…'
            : saveState.status === 'saved'
              ? 'Saved'
              : `Autosave failed: ${saveState.message}`}
        </div>
      )}

      {!editable && rendered && (
        <div className="spaces-block-editor__doc" onClick={handleDocumentClick}>
          <DocumentBody
            document={rendered}
            sources={sources}
            collapsed={EMPTY_DOCUMENT_VIEW_STATE.collapsed}
          />
        </div>
      )}

      {editable && load.status === 'ready' && blocks.length === 0 && (
        <div className="spaces-block-editor__empty-author" data-testid="spaces-block-editor-empty-author">
          <button
            type="button"
            className="spaces-block-editor__empty-start"
            disabled={busy}
            onClick={() => void addProseBlock('paragraph')}
          >
            Start writing
          </button>
        </div>
      )}

      {editable && load.status === 'ready' && blocks.length > 0 && (
        <ul
          className="spaces-block-editor__list"
          data-testid="spaces-block-editor-list"
          onClick={handleDocumentClick}
        >
          {blocks.map((block) => {
            const isEditing = viewState.editingId === block.id;
            const draft = viewState.drafts[block.id] ?? block.markdown ?? '';
            const isEmbed = !blockCanEditMarkdown(block);
            const renderedBlock = rendered?.blocks.find((b) => b.id === block.id);
            return (
              <li
                key={block.id}
                className={`spaces-block-editor__row${activeBlockId === block.id ? ' spaces-block-editor__row--active' : ''}`}
                data-block-id={block.id}
                data-block-type={block.block_type}
                data-testid="spaces-block-editor-row"
                onFocusIn={() => setActiveBlockId(block.id)}
                onMouseEnter={() => setActiveBlockId(block.id)}
              >
                {isEditing && !isEmbed && (
                  <div className="spaces-block-editor__editbox">
                    <textarea
                      ref={(node) => {
                        if (node) textareaRefs.current.set(block.id, node);
                        else textareaRefs.current.delete(block.id);
                      }}
                      className="spaces-block-editor__textarea"
                      value={draft}
                      data-testid="spaces-block-editor-textarea"
                      aria-label={`Edit ${block.block_type} block`}
                      onInput={(e) => handleDraftInput(block.id, e.currentTarget as HTMLTextAreaElement)}
                      onSelect={(e) => updateCaret(block.id, e.currentTarget as HTMLTextAreaElement)}
                      onClick={(e) => updateCaret(block.id, e.currentTarget as HTMLTextAreaElement)}
                      onKeyUp={(e) => updateCaret(block.id, e.currentTarget as HTMLTextAreaElement)}
                      onBlur={(e) => saveProse(block.id, (e.currentTarget as HTMLTextAreaElement).value)}
                    />
                  </div>
                )}
                {!isEditing && !isEmbed && (
                  <button
                    type="button"
                    className="spaces-block-editor__rendered-block"
                    data-testid="spaces-block-editor-edit"
                    onClick={() => setEditing(block.id)}
                    onFocus={() => setActiveBlockId(block.id)}
                  >
                    {renderedBlock?.html ? (
                      <span
                        className="spaces-block-editor__rendered-html"
                        // eslint-disable-next-line react/no-danger -- pipeline-sanitized HTML from DocumentRenderer.
                        dangerouslySetInnerHTML={{ __html: renderedBlock.html }}
                      />
                    ) : (
                      <span className="spaces-block-editor__placeholder">Write here…</span>
                    )}
                  </button>
                )}
                {!isEditing && isEmbed && renderedBlock && (
                  <div className="spaces-block-editor__embed-preview">
                    <DocumentBody
                      document={{ format: rendered?.format ?? null, html: '', refs: [], isSpacesDoc: true, blocks: [renderedBlock] }}
                      sources={sources}
                      collapsed={EMPTY_DOCUMENT_VIEW_STATE.collapsed}
                    />
                  </div>
                )}
                {!isEmbed && (
                  <span className="spaces-block-editor__command-slot">
                    <button
                      type="button"
                      className="spaces-block-editor__command-trigger"
                      disabled={busy}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        snapshotCaretForBlock(block.id);
                        setCommandBlockId((open) => (open === block.id ? null : block.id));
                      }}
                      aria-haspopup="menu"
                      aria-expanded={commandBlockId === block.id}
                      aria-label="Open document commands"
                      title="Document commands"
                      data-testid="spaces-block-editor-command-trigger"
                    >
                      /
                    </button>
                    {commandBlockId === block.id ? (
                      <span className="spaces-block-editor__command-menu" role="menu" aria-label="Document commands">
                        <button
                          type="button"
                          className="spaces-block-editor__command"
                          disabled={busy}
                          role="menuitem"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => runContextCommand(block.id, () => void addProseBlock('paragraph', block.id))}
                          data-testid="spaces-block-editor-add-paragraph"
                        >
                          Add paragraph
                        </button>
                        <button
                          type="button"
                          className="spaces-block-editor__command"
                          disabled={busy}
                          role="menuitem"
                          aria-haspopup="dialog"
                          aria-expanded={pickerOpen && activeBlockId === block.id}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            if (pickerOpen && activeBlockId === block.id) {
                              setPickerOpen(false);
                              return;
                            }
                            openReferencePicker(block.id);
                          }}
                          data-testid="spaces-block-editor-add-items"
                        >
                          Insert reference
                        </button>
                        {PROSE_BLOCK_TYPES.filter((bt) => bt !== 'paragraph').map((bt) => (
                          <button
                            key={bt}
                            type="button"
                            className="spaces-block-editor__command"
                            disabled={busy}
                            role="menuitem"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => runContextCommand(block.id, () => void addProseBlock(bt, block.id))}
                            data-testid={`spaces-block-editor-add-${bt}`}
                          >
                            {bt === 'heading' ? 'Add heading' : 'Add todo'}
                          </button>
                        ))}
                      </span>
                    ) : null}
                    {pickerOpen && activeBlockId === block.id ? (
                      <span className="spaces-block-editor__picker-anchor">
                        <SpaceItemPicker
                          spaceId={spaceId}
                          projectId={projectId}
                          existingItems={spaceItems}
                          isItemInView={() => false}
                          afterAdd={embedSpaceItem}
                          onAdded={() => {
                            void loadAll(true);
                          }}
                          onClose={() => {
                            setPickerOpen(false);
                            const textarea = textareaRefs.current.get(block.id);
                            if (textarea) window.setTimeout(() => textarea.focus(), 0);
                          }}
                        />
                      </span>
                    ) : null}
                  </span>
                )}
                {isEmbed && block.item_id && (
                  <span className="spaces-block-editor__commands" aria-label="Embedded item commands">
                    <button
                      type="button"
                      className="spaces-block-editor__command spaces-block-editor__command--text"
                      disabled={busy}
                      onClick={() => requestItemDelete(block.item_id!)}
                      data-testid="spaces-block-editor-delete-item"
                      title="Delete the embedded item (prompts an embed-on-delete decision)"
                    >
                      Remove item
                    </button>
                  </span>
                )}
                {embeddableItems.length > 0 && activeBlockId === block.id && (
                  <span className="spaces-block-editor__embeds" data-testid="spaces-block-editor-embeds">
                    {embeddableItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="spaces-block-editor__embed"
                        disabled={busy}
                        onClick={() => void embedItem(item)}
                        data-testid={`spaces-block-editor-embed-${item.id}`}
                      >
                        embed {item.ref_type}: {item.title || item.ref_id}
                      </button>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {inspector && (
        <ReferenceInspector inspector={inspector} onClose={() => setInspector(null)} />
      )}

      {/* DEFERRED embed-on-delete decision surfaced inline when no host handler. */}
      {pendingEmbedDelete && (
        <EmbedDeletePrompt decision={pendingEmbedDelete} busy={busy} />
      )}
    </div>
  );
}

function ReferenceInspector({
  inspector,
  onClose,
}: {
  inspector: RefInspector;
  onClose: () => void;
}): JSX.Element {
  const result = inspector.status === 'ready' ? inspector.result : null;
  const entity = result?.entity ?? null;
  const title =
    (entity && typeof entity.title === 'string' && entity.title) ||
    (entity && typeof entity.display_id === 'string' && entity.display_id) ||
    inspector.ref;
  return (
    <aside className="spaces-block-editor__inspector" data-testid="spaces-block-editor-inspector">
      <header className="spaces-block-editor__inspector-head">
        <strong>{title}</strong>
        <button type="button" onClick={onClose} aria-label="Close reference inspector">
          ×
        </button>
      </header>
      <div className="spaces-block-editor__inspector-meta">
        <code>{inspector.ref}</code>
      </div>
      {inspector.status === 'resolving' && (
        <div className="spaces-block-editor__inspector-status">Resolving…</div>
      )}
      {inspector.status === 'error' && (
        <div className="spaces-block-editor__inspector-error">{inspector.message}</div>
      )}
      {result && (
        <div className="spaces-block-editor__inspector-body" data-resolved={String(result.resolved)}>
          <span className="spaces-block-editor__inspector-kind">{result.kind}</span>
          {result.resolved ? (
            <pre>{JSON.stringify(result.entity ?? result.detail ?? {}, null, 2)}</pre>
          ) : (
            <p>{result.error ?? 'Reference did not resolve.'}</p>
          )}
        </div>
      )}
    </aside>
  );
}

/** Read-only/stale custody banner with the explicit re-import / fork affordances. */
function CustodyStaleBanner({
  custody,
  onReimport,
  onFork,
}: {
  custody: CustodyEditorUx;
  onReimport?: () => void;
  onFork?: () => void;
}): JSX.Element {
  const handlers: Record<CustodyAffordance, (() => void) | undefined> = {
    reimport: onReimport,
    fork: onFork,
  };
  const labels: Record<CustodyAffordance, string> = {
    reimport: 'Re-import repo version',
    fork: 'Fork a Mandible copy',
  };
  return (
    <div
      className="spaces-block-editor__banner"
      role="status"
      data-testid="spaces-block-editor-stale-banner"
      data-status={custody.status}
    >
      <span className="spaces-block-editor__bannertext">
        {custody.reason ?? 'This document is read-only.'}
      </span>
      <span className="spaces-block-editor__banneractions">
        {custody.affordances.map((aff) => (
          <button
            key={aff}
            type="button"
            className="spaces-block-editor__affordance"
            data-testid={`spaces-block-editor-affordance-${aff}`}
            disabled={!handlers[aff]}
            onClick={() => handlers[aff]?.()}
          >
            {labels[aff]}
          </button>
        ))}
      </span>
    </div>
  );
}

/** Inline rendering of the deferred embed-on-delete decision (no host handler). */
function EmbedDeletePrompt({
  decision,
  busy,
}: {
  decision: EmbedDeleteDecision;
  busy: boolean;
}): JSX.Element {
  return (
    <div
      className="spaces-block-editor__embeddelete"
      role="alertdialog"
      data-testid="spaces-block-editor-embed-delete"
    >
      <p className="spaces-block-editor__embeddeletetext">
        {decision.embeddingBlocks.length} block(s) embed this item. Deleting the item is restricted.
        Choose how to proceed — this decision is not made automatically.
      </p>
      <span className="spaces-block-editor__embeddeleteactions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decision.detachToPlaceholder()}
          data-testid="spaces-block-editor-embed-detach"
        >
          Detach embeds to placeholder
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decision.cancel()}
          data-testid="spaces-block-editor-embed-cancel"
        >
          Keep embeds (cancel)
        </button>
      </span>
    </div>
  );
}

export default DocumentBlockEditor;
