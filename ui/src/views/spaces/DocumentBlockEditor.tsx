import { Icon } from '../../components/icons/Icon';
import { useQuery } from '@tanstack/preact-query';
import { queryClient } from '../../query/client';
import { browserResourceKeys, browserResourceKeysForEvent, refreshBrowserResources } from '../../query/browserResources';
import { browserSessionFetch } from '../../client-auth-token';
import { SpaceExportDialog } from './SpaceExportDialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import type { SpaceBlock, SpaceItem } from '../../api';
import type { SpaceBlockType } from '../../../../src/contracts';
import { canPerformOperation } from '../../api';
import { acquireSharedSse } from '../../sse-shared';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import { DocumentBody, renderSpaceBlocks } from './DocumentRenderer';
import {
  appendSortKey,
  placementForIndex,
  siblingIndexOf,
} from './blockEditorModel';
import {
  createSpaceBlock,
  detachItemFromBlocks,
  listSpaceBlocks,
  updateSpaceBlock,
  type CreateBlockBody,
} from '../../api';
import {
  blockEditorStorageKey,
  normalizeBlockEditorViewState,
  EMPTY_BLOCK_EDITOR_VIEW_STATE,
} from './blockEditorViewState';
import { SpaceItemPicker } from './SpaceItemPicker';
import {
  ReferenceDetailContent,
  referenceDetailTargetFromResourceRef,
  type ReferenceDetailTarget,
} from '../reference-detail';
import {
  MarkdownSourceEditor,
  type MarkdownSourceBoundaryDirection,
  type MarkdownSourceItemCommand,
  type MarkdownSourceSelection,
} from './MarkdownSourceEditor';
import './DocumentBlockEditor.css';

const AUTOSAVE_DELAY_MS = 650;
const MIN_INSPECTOR_HEIGHT = 160;
const MAX_INSPECTOR_VIEWPORT_FRACTION = 0.7;
function clampInspectorHeight(height: number, viewportHeight: number): number {
  const maxHeight = Math.max(
    MIN_INSPECTOR_HEIGHT,
    Math.floor(viewportHeight * MAX_INSPECTOR_VIEWPORT_FRACTION),
  );
  return Math.min(Math.max(Math.round(height), MIN_INSPECTOR_HEIGHT), maxHeight);
}

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

type SaveState =
  | { status: 'idle' }
  | { status: 'saving'; blockId: string }
  | { status: 'saved'; blockId: string }
  | { status: 'error'; blockId: string; message: string };

type CaretTarget = { blockId: string; start: number; end: number };
type ItemCommandRange = { blockId: string; start: number; end: number };

async function getSpaceItemsWithFetch(spaceId: string, fetchImpl: typeof fetch): Promise<SpaceItem[]> {
  const response = await fetchImpl(`/api/spaces/${encodeURIComponent(spaceId)}`);
  if (!response.ok) throw new Error(`Failed to load Space fact packet (${response.status})`);
  const payload = (await response.json()) as { items?: SpaceItem[] };
  if (!Array.isArray(payload.items)) throw new Error('The Spaces service returned an invalid item collection.');
  return payload.items;
}
type SelectionMenuState = {
  blockId: string;
  start: number;
  end: number;
  top: number;
  left: number;
};
type OverlayPosition = { top: number; left: number };

export interface DocumentBlockEditorProps extends SpaceRendererMountProps {
  /** Test seam: inject a fetch implementation for block reads/writes. */
  fetchImpl?: typeof fetch;
  /**
   * The DEFERRED embed-on-delete decision point. Invoked when a user tries to
   * remove an embedded item: the editor presents the decision and takes no
   * destructive action until the user resolves it through this surface. When
   * omitted, the editor falls back to surfacing the conflict read-only and does
   * nothing (the safe non-destructive default).
   */
  onEmbedDeleteDecision?: (decision: EmbedDeleteDecision) => void;
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

function replaceRange(value: string, insertion: string, start: number, end: number): string {
  return `${value.slice(0, Math.max(0, start))}${insertion}${value.slice(Math.max(0, end))}`;
}

function wrappedSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
): { next: string; caret: number } {
  const selection = value.slice(start, end);
  const replacement = `${before}${selection}${after}`;
  return {
    next: replaceRange(value, replacement, start, end),
    caret: start + replacement.length,
  };
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

function blockEndPosition(view: EditorView): number {
  return view.state.doc.length;
}

function eventTargetsEditorChrome(target: HTMLElement | null): boolean {
  if (!target) return false;
  return Boolean(
    target.closest(
      [
        'button',
        'input',
        'select',
        'textarea',
        'a.resource-ref__link',
        'a.spaces-doc-ref__link',
        '[data-heading-hit-area="true"]',
        '.spaces-markdown-source__emphasis',
        '.spaces-block-editor__picker-overlay',
        '.spaces-block-editor__selection-menu',
        '.spaces-block-editor__inspector',
      ].join(', '),
    ),
  );
}

function lineEndAtClientY(view: EditorView, clientY: number): number {
  const doc = view.state.doc;
  try {
    const block = view.lineBlockAtHeight(clientY - view.documentTop);
    const pos = Math.max(0, Math.min(doc.length, block.to));
    return doc.lineAt(pos).to;
  } catch {
    return doc.length;
  }
}

function isHorizontalWhitespaceClick(view: EditorView, event: MouseEvent): boolean {
  const lineEnd = lineEndAtClientY(view, event.clientY);
  try {
    const coords = view.coordsAtPos(lineEnd, 1);
    return Boolean(coords && event.clientX >= coords.right - 1);
  } catch {
    return true;
  }
}

function caretPositionForDocumentClick(view: EditorView, event: MouseEvent): number {
  const rect = view.dom.getBoundingClientRect();
  if (rect.height > 0 && event.clientY > rect.bottom) return blockEndPosition(view);
  if (isHorizontalWhitespaceClick(view, event)) return lineEndAtClientY(view, event.clientY);
  try {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null) return Math.max(0, Math.min(view.state.doc.length, pos));
  } catch {
    // Fall back to line end below.
  }
  return lineEndAtClientY(view, event.clientY);
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
  instance = null,
  onEmbedDeleteDecision,
}: DocumentBlockEditorProps): JSX.Element {
  const [viewState, setViewState] = usePersistedViewState(
    spaceId ? blockEditorStorageKey(projectId, spaceId) : '',
    normalizeBlockEditorViewState,
    EMPTY_BLOCK_EDITOR_VIEW_STATE,
  );
  const [busy, setBusy] = useState(false);
  const [publicationOpen,setPublicationOpen]=useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [itemCommandRange, setItemCommandRange] = useState<ItemCommandRange | null>(null);
  const [pickerPosition, setPickerPosition] = useState<OverlayPosition | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<ReferenceDetailTarget | null>(null);
  const [inspectorHeight, setInspectorHeight] = useState<number | null>(null);
  const [pendingEmbedDelete, setPendingEmbedDelete] = useState<EmbedDeleteDecision | null>(null);
  const fetchRef = useRef(fetchImpl);
  const pendingSaves = useRef<Map<string, Promise<void>>>(new Map());
  const saveTimers = useRef<Map<string, number>>(new Map());
  const editorViews = useRef<Map<string, EditorView>>(new Map());
  const caretRef = useRef<CaretTarget | null>(null);
  const autoCreatedEmptySpaces = useRef<Set<string>>(new Set());
  const pendingFocusBlockId = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inspectorResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const mountedRef = useRef(true);
  const spaceGenerationRef = useRef({ spaceId, generation: 0 });
  if (spaceGenerationRef.current.spaceId !== spaceId) spaceGenerationRef.current = { spaceId, generation: spaceGenerationRef.current.generation + 1 };
  const spaceGeneration = spaceGenerationRef.current.generation;
  const currentSpaceIdRef = useRef<string | null | undefined>(spaceId);
  fetchRef.current = fetchImpl;
  currentSpaceIdRef.current = spaceId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of saveTimers.current.values()) window.clearTimeout(timer);
      saveTimers.current.clear();
    };
  }, [spaceId]);

  const fetcher = useCallback(() => (input: RequestInfo | URL, init?: RequestInit) =>
    browserSessionFetch(input, init, fetchRef.current), []);
  const documentKey = browserResourceKeys.spaceDocument(spaceId);
  const documentQuery = useQuery({
    queryKey: documentKey,
    enabled: Boolean(spaceId),
    queryFn: async ({ signal }) => {
      const blocks = await listSpaceBlocks(spaceId!, fetchRef.current, signal);
      return { spaceId: spaceId!, blocks };
    },
    refetchOnWindowFocus: true,
  }, queryClient);
  const itemsQuery = useQuery({
    queryKey: browserResourceKeys.spaceItems(spaceId),
    enabled: Boolean(spaceId),
    queryFn: ({ signal }) => getSpaceItemsWithFetch(spaceId!, (input, init) => fetcher()(input, { ...init, signal })),
    refetchOnWindowFocus: true,
  }, queryClient);
  const load = documentQuery.data
    ? { status: 'ready' as const, ...documentQuery.data }
    : { status: documentQuery.isPending ? 'loading' as const : 'error' as const };
  const refreshDocument = useCallback(async () => {
    await queryClient.cancelQueries({ queryKey: browserResourceKeys.spaceDocument(spaceId), exact: true });
    void itemsQuery.refetch();
    await documentQuery.refetch();
  }, [spaceId, documentQuery.refetch, itemsQuery.refetch]);

  useEffect(() => {
    if (!spaceId) return;
    const client = acquireSharedSse();
    const unsubscribe = client.on('*', (payload) => {
      const keys = browserResourceKeysForEvent(payload.type, payload.data);
      if (keys.some((key) => key[1] === spaceId)) void refreshBrowserResources(queryClient, keys);
    });
    const offState = client.onState((_state, { reconnected }) => {
      if (reconnected) void refreshBrowserResources(queryClient, [browserResourceKeys.spaceDocument(spaceId), browserResourceKeys.spaceItems(spaceId)]);
    });
    client.connect();
    return () => { unsubscribe(); offState(); client.close(); };
  }, [spaceId, refreshDocument]);

  const blocks = useMemo(() => {
    const live = load.status === 'ready' ? load.blocks : [];
    return live.map((block) => {
      const draft = viewState.drafts[block.id];
      return draft === undefined ? block : { ...block, markdown: draft };
    });
  }, [load, viewState.drafts]);
  const spaceItems = itemsQuery.data ?? [];

  const editable = load.status === 'ready' && !documentQuery.error && spaceId !== null && canPerformOperation(
    instance,
    'PATCH',
    `/api/spaces/${encodeURIComponent(spaceId)}/blocks/_`,
  );

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
        await refreshDocument();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [editable, spaceId, refreshDocument],
  );

  const saveMarkdownNow = useCallback(
    async (blockId: string, markdown: string) => {
      if (!editable || !spaceId || !mountedRef.current || spaceGeneration !== spaceGenerationRef.current.generation) return;
      const prior = saveTimers.current.get(blockId);
      if (prior) {
        window.clearTimeout(prior);
        saveTimers.current.delete(blockId);
      }
      const previousSave = pendingSaves.current.get(blockId);
      let finishSave!: () => void;
      const currentSave = new Promise<void>((resolve) => { finishSave = resolve; });
      pendingSaves.current.set(blockId, currentSave);
      if (previousSave) await previousSave;
      if (!mountedRef.current || currentSpaceIdRef.current !== spaceId || spaceGeneration !== spaceGenerationRef.current.generation) { finishSave(); return; }
      setSaveState({ status: 'saving', blockId });
      try {
        const savedBlock = await updateSpaceBlock(spaceId, blockId, { markdown }, fetchRef.current);
        if (!mountedRef.current || currentSpaceIdRef.current !== spaceId || spaceGeneration !== spaceGenerationRef.current.generation) return;
        setSaveState({ status: 'saved', blockId });
        await queryClient.cancelQueries({ queryKey: browserResourceKeys.spaceDocument(spaceId), exact: true });
        queryClient.setQueryData<typeof documentQuery.data>(browserResourceKeys.spaceDocument(spaceId), (prior) => {
          if (!prior) return prior;
          return {
            ...prior,
            blocks: prior.blocks.map((block) => (block.id === blockId ? savedBlock : block)),
          };
        });
        await refreshDocument();
        if (!mountedRef.current || currentSpaceIdRef.current !== spaceId || spaceGeneration !== spaceGenerationRef.current.generation) return;
        setViewState((state) => {
          if (state.drafts[blockId] !== markdown || queryClient.getQueryData<typeof documentQuery.data>(browserResourceKeys.spaceDocument(spaceId))?.blocks.find((block) => block.id === blockId)?.markdown !== markdown) return state;
          const drafts = { ...state.drafts };
          delete drafts[blockId];
          return { ...state, drafts };
        });
      } catch (err) {
        if (!mountedRef.current || spaceGeneration !== spaceGenerationRef.current.generation) return;
        setSaveState({
          status: 'error',
          blockId,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        finishSave();
        if (pendingSaves.current.get(blockId) === currentSave) pendingSaves.current.delete(blockId);
      }
    },
    [editable, spaceId, spaceGeneration, fetcher, refreshDocument],
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

  const cancelPendingAutosave = useCallback((blockId: string) => {
    const prior = saveTimers.current.get(blockId);
    if (!prior) return;
    window.clearTimeout(prior);
    saveTimers.current.delete(blockId);
  }, []);

  const setEditing = useCallback((blockId: string | null) => {
    setActiveBlockId(blockId);
    setViewState((prior) => ({ ...prior, editingId: blockId }));
  }, []);

  const beginEditing = useCallback((blockId: string) => {
    setEditing(blockId);
  }, [setEditing]);

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
      const blockMarkdown = markdown || (blockType === 'heading' ? 'New heading' : '');
      const body: CreateBlockBody = {
        block_type: blockType,
        parent_id: parentId,
        sort_key: placement.sort_key,
        markdown: blockMarkdown,
      };
      await runMutation(async () => {
        const created = await createSpaceBlock(spaceId, body, fetchRef.current);
        if (!mountedRef.current || currentSpaceIdRef.current !== spaceId) return created;
        const caret = blockMarkdown.length;
        setActiveBlockId(created.id);
        beginEditing(created.id);
        pendingFocusBlockId.current = created.id;
        caretRef.current = { blockId: created.id, start: caret, end: caret };
        return created;
      });
    },
    [spaceId, blocks, runMutation, fetcher, beginEditing],
  );

  useEffect(() => {
    if (!spaceId || !editable || load.status !== 'ready' || load.blocks.length > 0 || Object.keys(viewState.drafts).length > 0) return;
    if (autoCreatedEmptySpaces.current.has(spaceId)) return;
    autoCreatedEmptySpaces.current.add(spaceId);
    void addProseBlock('paragraph');
  }, [addProseBlock, editable, load, spaceId]);

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
      const commandTargetId =
        itemCommandRange && editableBlocks.some((b) => b.id === itemCommandRange.blockId)
          ? itemCommandRange.blockId
          : null;
      const activeTargetId =
        activeBlockId && editableBlocks.some((b) => b.id === activeBlockId)
          ? activeBlockId
          : null;
      const targetId =
        commandTargetId ??
        activeTargetId ??
        editableBlocks[editableBlocks.length - 1]?.id ??
        null;
      if (!targetId) {
        await addProseBlock('paragraph', null, refText);
        return;
      }
      const block = blocks.find((b) => b.id === targetId);
      if (!block) return;
      const editorView = editorViews.current.get(targetId);
      const draft = editorView?.state.doc.toString() ?? viewState.drafts[targetId] ?? block.markdown ?? '';
      const commandRange =
        itemCommandRange?.blockId === targetId ? itemCommandRange : null;
      const caret =
        commandRange ??
        (caretRef.current?.blockId === targetId
          ? caretRef.current
          : { blockId: targetId, start: draft.length, end: draft.length });
      const next = commandRange
        ? replaceRange(draft, refText, commandRange.start, commandRange.end)
        : insertAtCaret(draft, refText, caret.start, caret.end);
      const beforeCaret = draft.slice(0, caret.start);
      const fallbackPrefixLength = !commandRange && beforeCaret && !/\s$/.test(beforeCaret) ? 1 : 0;
      const nextPos = commandRange
        ? commandRange.start + refText.length
        : Math.min(next.length, caret.start + fallbackPrefixLength + refText.length);
      setActiveBlockId(targetId);
      setEditing(targetId);
      setItemCommandRange(null);
      setPickerPosition(null);
      setPickerOpen(false);
      setSelectionMenu(null);
      if (editorView) {
        editorView.dispatch({
          changes: { from: 0, to: editorView.state.doc.length, insert: next },
          selection: EditorSelection.cursor(nextPos),
          scrollIntoView: true,
        });
        editorView.focus();
        setDraft(targetId, next);
        queueAutosave(targetId, next);
        caretRef.current = { blockId: targetId, start: nextPos, end: nextPos };
        return;
      }
      setDraft(targetId, next);
      queueAutosave(targetId, next);
      caretRef.current = { blockId: targetId, start: nextPos, end: nextPos };
    },
    [
      activeBlockId,
      addProseBlock,
      blocks,
      itemCommandRange,
      queueAutosave,
      setDraft,
      setEditing,
      viewState.drafts,
    ],
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

  const handleSourceView = useCallback((blockId: string, view: EditorView | null) => {
    if (view) {
      editorViews.current.set(blockId, view);
      if (pendingFocusBlockId.current === blockId) {
        pendingFocusBlockId.current = null;
        const target = caretRef.current?.blockId === blockId ? caretRef.current.end : 0;
        const pos = Math.max(0, Math.min(view.state.doc.length, target));
        view.dispatch({
          selection: EditorSelection.cursor(pos),
          scrollIntoView: true,
        });
        view.focus();
      }
    } else {
      editorViews.current.delete(blockId);
    }
  }, []);

  const focusEditorAt = useCallback(
    (blockId: string, position: number) => {
      const view = editorViews.current.get(blockId);
      if (!view) return false;
      const pos = Math.max(0, Math.min(view.state.doc.length, position));
      setActiveBlockId(blockId);
      setEditing(blockId);
      caretRef.current = { blockId, start: pos, end: pos };
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        scrollIntoView: true,
      });
      view.focus();
      return true;
    },
    [setEditing],
  );

  const editableBlockIds = useMemo(
    () => blocks.filter(blockCanEditMarkdown).map((block) => block.id),
    [blocks],
  );

  const focusFinalEditableBlockEnd = useCallback(() => {
    const finalBlockId = editableBlockIds[editableBlockIds.length - 1];
    if (!finalBlockId) return false;
    const view = editorViews.current.get(finalBlockId);
    return focusEditorAt(finalBlockId, view ? blockEndPosition(view) : 0);
  }, [editableBlockIds, focusEditorAt]);

  const handleSourceBoundaryArrow = useCallback(
    (blockId: string, direction: MarkdownSourceBoundaryDirection) => {
      const index = editableBlockIds.indexOf(blockId);
      if (index === -1) return false;
      const targetBlockId =
        direction === 'up' ? editableBlockIds[index - 1] : editableBlockIds[index + 1];
      if (!targetBlockId) return false;
      const targetView = editorViews.current.get(targetBlockId);
      const position = direction === 'up' && targetView ? blockEndPosition(targetView) : 0;
      return focusEditorAt(targetBlockId, position);
    },
    [editableBlockIds, focusEditorAt],
  );

  const handleSourceChange = useCallback(
    (blockId: string, value: string, selection: { start: number; end: number }) => {
      setActiveBlockId(blockId);
      setEditing(blockId);
      caretRef.current = { blockId, start: selection.start, end: selection.end };
      setDraft(blockId, value);
      queueAutosave(blockId, value);
    },
    [queueAutosave, setDraft, setEditing],
  );

  const handleSourceBlur = useCallback(
    (blockId: string, value: string) => {
      window.setTimeout(() => {
        setSelectionMenu((current) => (current?.blockId === blockId ? null : current));
      }, 0);
      if (itemCommandRange?.blockId === blockId && pickerOpen) {
        cancelPendingAutosave(blockId);
        return;
      }
      saveProse(blockId, value);
    },
    [cancelPendingAutosave, itemCommandRange, pickerOpen, saveProse],
  );

  const handleSourceCaretChange = useCallback((blockId: string, selection: { start: number; end: number }) => {
    caretRef.current = { blockId, start: selection.start, end: selection.end };
    setActiveBlockId(blockId);
  }, []);

  const handleSourceSelectionChange = useCallback(
    (blockId: string, selection: MarkdownSourceSelection | null) => {
      if (!selection) {
        setSelectionMenu((current) => (current?.blockId === blockId ? null : current));
        return;
      }
      setActiveBlockId(blockId);
      setSelectionMenu({
        blockId,
        start: selection.start,
        end: selection.end,
        top: selection.top,
        left: selection.left,
      });
    },
    [],
  );

  const handleSourceItemCommand = useCallback(
    (blockId: string, command: MarkdownSourceItemCommand) => {
      cancelPendingAutosave(blockId);
      setActiveBlockId(blockId);
      setEditing(blockId);
      setSelectionMenu(null);
      setPickerPosition({ top: command.top, left: command.left });
      setItemCommandRange({ blockId, start: command.start, end: command.end });
      setPickerOpen(true);
    },
    [cancelPendingAutosave, setEditing],
  );

  const applySelectionFormat = useCallback(
    (before: string, after: string) => {
      if (!selectionMenu) return;
      const block = blocks.find((b) => b.id === selectionMenu.blockId);
      if (!block) return;
      const editorView = editorViews.current.get(block.id);
      const draft = editorView?.state.doc.toString() ?? viewState.drafts[block.id] ?? block.markdown ?? '';
      const { next, caret } = wrappedSelection(
        draft,
        selectionMenu.start,
        selectionMenu.end,
        before,
        after,
      );
      if (editorView) {
        editorView.dispatch({
          changes: { from: 0, to: editorView.state.doc.length, insert: next },
          selection: EditorSelection.cursor(caret),
          scrollIntoView: true,
        });
        editorView.focus();
        setDraft(block.id, next);
        queueAutosave(block.id, next);
        setSelectionMenu(null);
        caretRef.current = { blockId: block.id, start: caret, end: caret };
        return;
      }
      setDraft(block.id, next);
      queueAutosave(block.id, next);
      setSelectionMenu(null);
      caretRef.current = { blockId: block.id, start: caret, end: caret };
    },
    [blocks, queueAutosave, selectionMenu, setDraft, viewState.drafts],
  );

  const openReferenceInspector = useCallback(
    (ref: string) => {
      if (!ref.trim()) return;
      setInspector(referenceDetailTargetFromResourceRef(ref));
    },
    [],
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

  const handleDocumentMouseDown = useCallback(
    (event: MouseEvent) => {
      if (!editable || load.status !== 'ready' || event.button !== 0 || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (eventTargetsEditorChrome(target)) return;

      const row = target?.closest?.('[data-block-id]') as HTMLElement | null;
      if (!row) {
        if (focusFinalEditableBlockEnd()) event.preventDefault();
        return;
      }

      const blockId = row.getAttribute('data-block-id');
      if (!blockId || !editableBlockIds.includes(blockId)) return;
      const view = editorViews.current.get(blockId);
      if (!view) return;

      const insideCodeMirror = Boolean(target?.closest?.('.cm-editor'));
      if (insideCodeMirror && !isHorizontalWhitespaceClick(view, event)) return;

      const position = caretPositionForDocumentClick(view, event);
      if (focusEditorAt(blockId, position)) event.preventDefault();
    },
    [editable, editableBlockIds, focusEditorAt, focusFinalEditableBlockEnd, load.status],
  );

  const beginInspectorResize = useCallback(
    (event: JSX.TargetedMouseEvent<HTMLDivElement> | JSX.TargetedPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (inspectorResizeRef.current) return;
      const inspectorElement = event.currentTarget.parentElement as HTMLElement | null;
      if (!inspectorElement) return;
      inspectorResizeRef.current = {
        startY: event.clientY,
        startHeight: inspectorElement.getBoundingClientRect().height,
      };
      const previousCursor = document.documentElement.style.cursor;
      const previousUserSelect = document.documentElement.style.userSelect;
      document.documentElement.style.cursor = 'row-resize';
      document.documentElement.style.userSelect = 'none';
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const origin = inspectorResizeRef.current;
        if (!origin) return;
        const bodyHeight =
          bodyRef.current?.getBoundingClientRect().height ?? window.innerHeight;
        setInspectorHeight(
          clampInspectorHeight(
            origin.startHeight + origin.startY - moveEvent.clientY,
            bodyHeight,
          ),
        );
      };
      const stopResize = () => {
        inspectorResizeRef.current = null;
        document.documentElement.style.cursor = previousCursor;
        document.documentElement.style.userSelect = previousUserSelect;
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', stopResize);
        window.removeEventListener('pointercancel', stopResize);
      };
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', stopResize);
      window.addEventListener('pointercancel', stopResize);
    },
    [],
  );

  const pickerBlockId = itemCommandRange?.blockId ?? activeBlockId;

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
      ref={bodyRef}
    >
      <div className="spaces-block-editor__viewport" ref={viewportRef}>
        <button disabled={!editable || busy || Object.keys(viewState.drafts).length > 0 || saveState.status === 'saving'} onClick={()=>setPublicationOpen(true)}>Publications and import</button>
        {publicationOpen && <SpaceExportDialog spaceId={spaceId} projectId={projectId} onClose={()=>setPublicationOpen(false)} onImported={()=>void queryClient.invalidateQueries()}/>}

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
        {documentQuery.error && (
          <DetailPaneNotice severity="error" density="compact" title="Could not load document" testId="spaces-block-editor-error">
            {documentQuery.error.message}
          </DetailPaneNotice>
        )}
        {itemsQuery.error && <DetailPaneNotice severity="error" density="compact" title="Space items could not be refreshed">{itemsQuery.error.message}</DetailPaneNotice>}
        {actionError && (
          <DetailPaneNotice severity="error" density="compact" testId="spaces-block-editor-action-error">{actionError}</DetailPaneNotice>
        )}
        {load.status === 'ready' && Object.entries(viewState.drafts)
          .filter(([id]) => !load.blocks.some((block) => block.id === id))
          .map(([id, markdown]) => (
            <section key={id} role="status" className="spaces-block-editor__draft-conflict">
              <p>This block was removed; your draft is retained.</p>
              <textarea aria-label="Retained block draft" value={markdown} onInput={(event) => setDraft(id, event.currentTarget.value)} />
              <button type="button" disabled={!editable || busy} onClick={() => runMutation(async () => {
                await createSpaceBlock(spaceId, { block_type: 'paragraph', markdown, sort_key: appendSortKey(blocks, null) }, fetchRef.current);
                setViewState((prior) => {
                  const drafts = { ...prior.drafts };
                  if (drafts[id] === markdown) delete drafts[id];
                  return { ...prior, drafts, editingId: prior.editingId === id ? null : prior.editingId };
                });
              })}>Restore as a new block</button>
              <button type="button" onClick={() => setViewState((prior) => {
                const drafts = { ...prior.drafts };
                delete drafts[id];
                return { ...prior, drafts, editingId: prior.editingId === id ? null : prior.editingId };
              })}>Discard draft</button>
            </section>
          ))}
        <div className="spaces-block-editor__scroller" onMouseDown={handleDocumentMouseDown}>
          {load.status === 'loading' && (
            <div className="spaces-block-editor__status">
              <span>Loading document…</span>
              <div className="spaces-block-editor__doc-shell" aria-hidden="true">
                <div className="spaces-block-editor__ghost-line spaces-block-editor__ghost-line--wide" />
                <div className="spaces-block-editor__ghost-line" />
              </div>
            </div>
          )}
          {/* The live document, rendered through the C14b renderer (read path). */}

          {!editable && rendered && (
            <div className="spaces-block-editor__doc" onClick={handleDocumentClick}>
              <DocumentBody
                document={rendered}
                sources={sources}
              />
            </div>
          )}

          {editable && load.status === 'ready' && blocks.length > 0 && (
            <ul
              className="spaces-block-editor__list"
              data-testid="spaces-block-editor-list"
              onClick={handleDocumentClick}
            >
              {blocks.map((block) => {
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
                    {!isEmbed && (
                      <div className="spaces-block-editor__source-block" data-testid="spaces-block-editor-edit">
                        <MarkdownSourceEditor
                          blockId={block.id}
                          value={draft}
                          ariaLabel={`Edit ${block.block_type} Markdown`}
                          onView={handleSourceView}
                          onChange={(value, selection) => handleSourceChange(block.id, value, selection)}
                          onBlur={(value) => handleSourceBlur(block.id, value)}
                          onCaretChange={(selection) => handleSourceCaretChange(block.id, selection)}
                          onSelectionChange={(selection) => handleSourceSelectionChange(block.id, selection)}
                          onItemCommand={(command) => handleSourceItemCommand(block.id, command)}
                          onOpenReference={openReferenceInspector}
                          onBoundaryArrow={handleSourceBoundaryArrow}
                        />
                      </div>
                    )}
                    {isEmbed && renderedBlock && (
                      <div className="spaces-block-editor__embed-preview">
                        <DocumentBody
                          document={{ format: rendered?.format ?? null, html: '', refs: [], isSpacesDoc: true, blocks: [renderedBlock] }}
                          sources={sources}
                        />
                      </div>
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
                  </li>
                );
              })}
            </ul>
          )}

          {/* DEFERRED embed-on-delete decision surfaced inline when no host handler. */}
          {pendingEmbedDelete && (
            <EmbedDeletePrompt decision={pendingEmbedDelete} busy={busy} />
          )}
        </div>
      </div>

      {editable && pickerOpen && pickerBlockId && (
        <div
          className="spaces-block-editor__picker-overlay"
          data-testid="spaces-block-editor-picker-overlay"
          style={{
            position: 'fixed',
            top: `${pickerPosition?.top ?? 72}px`,
            left: `${pickerPosition?.left ?? 24}px`,
            zIndex: 42,
          }}
        >
          <SpaceItemPicker
            spaceId={spaceId}
            projectId={projectId}
            existingItems={spaceItems}
            isItemInView={() => false}
            afterAdd={embedSpaceItem}
            onAdded={() => {
              void refreshDocument();
            }}
            onClose={() => {
              const focusBlockId = pickerBlockId;
              setPickerOpen(false);
              setItemCommandRange(null);
              setPickerPosition(null);
              const editorView = editorViews.current.get(focusBlockId);
              if (editorView) window.setTimeout(() => editorView.focus(), 0);
            }}
          />
        </div>
      )}

      {selectionMenu && (
        <div
          className="spaces-block-editor__selection-menu"
          data-testid="spaces-block-editor-selection-menu"
          style={{
            position: 'fixed',
            top: `${selectionMenu.top}px`,
            left: `${selectionMenu.left}px`,
            zIndex: 45,
          }}
          role="toolbar"
          aria-label="Text formatting"
        >
          <button
            type="button"
            className="spaces-block-editor__selection-command"
            onMouseDown={(event) => {
              event.preventDefault();
              applySelectionFormat('**', '**');
            }}
            aria-label="Bold"
            title="Bold"
          >
            B
          </button>
          <button
            type="button"
            className="spaces-block-editor__selection-command"
            onMouseDown={(event) => {
              event.preventDefault();
              applySelectionFormat('*', '*');
            }}
            aria-label="Italic"
            title="Italic"
          >
            I
          </button>
          <button
            type="button"
            className="spaces-block-editor__selection-command"
            onMouseDown={(event) => {
              event.preventDefault();
              applySelectionFormat('[', '](url)');
            }}
            aria-label="Link"
            title="Link"
          >
            Link
          </button>
        </div>
      )}

      {inspector && (
        <ReferenceInspector
          target={inspector}
          height={inspectorHeight}
          onResizeStart={beginInspectorResize}
          onClose={() => setInspector(null)}
        />
      )}
    </div>
  );
}

function ReferenceInspector({
  target,
  height,
  onResizeStart,
  onClose,
}: {
  target: ReferenceDetailTarget;
  height: number | null;
  onResizeStart: (
    event: JSX.TargetedMouseEvent<HTMLDivElement> | JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => void;
  onClose: () => void;
}): JSX.Element {
  const style = height !== null ? ({ flexBasis: `${height}px` } as JSX.CSSProperties) : undefined;
  const [referenceError, setReferenceError] = useState<string | null>(null);
  useEffect(() => setReferenceError(null), [target.kind, target.ref]);
  return (
    <aside
      className="spaces-block-editor__inspector"
      data-testid="spaces-block-editor-inspector"
      data-placement="bottom"
      aria-label="Reference inspector"
      style={style}
    >
      <div
        className="spaces-block-editor__inspector-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize reference inspector"
        onMouseDown={onResizeStart}
        onPointerDown={onResizeStart}
        data-testid="spaces-block-editor-inspector-resize"
      />
      <header className="spaces-block-editor__inspector-head">
        <strong>{target.kind === 'unsupported' ? 'Reference' : target.kind}</strong>
        <button type="button" onClick={onClose} aria-label="Close reference inspector">
          <Icon name="dismiss" />
          </button>
      </header>
      {referenceError && <DetailPaneNotice severity="error" density="compact" title="Reference unavailable">{referenceError}</DetailPaneNotice>}
      <div className="spaces-block-editor__inspector-body">
        <ReferenceDetailContent target={target} onErrorChange={setReferenceError} />
      </div>
    </aside>
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
