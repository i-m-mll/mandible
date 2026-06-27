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
import { createSSEClient } from '../../sse-client';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import { DocumentBody, renderDocumentText, renderSpaceBlocks } from './DocumentRenderer';
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
import {
  SpaceReferenceDetailContent,
  detailTargetFromResourceRef,
  type SpaceReferenceDetailTarget,
} from './SpaceReferenceDetailPanel';
import './DocumentBlockEditor.css';

const SPACE_EVENT_PREFIX = 'space:';

const AUTOSAVE_DELAY_MS = 650;
const MIN_INSPECTOR_HEIGHT = 160;
const MAX_INSPECTOR_VIEWPORT_FRACTION = 0.7;
const RENDERED_MARKDOWN_HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
const RENDERED_HEADING_SELECTOR = `${RENDERED_MARKDOWN_HEADING_SELECTOR},p`;

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

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; spaceId: string; blocks: SpaceBlock[]; exports: SpaceExport[]; items: SpaceItem[] }
  | { status: 'error'; message: string };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving'; blockId: string }
  | { status: 'saved'; blockId: string }
  | { status: 'error'; blockId: string; message: string };

type CaretTarget = { blockId: string; start: number; end: number };
type FocusEditTarget = CaretTarget & { selectEnd: boolean };
type ItemCommandRange = { blockId: string; start: number; end: number };
type MarkdownLineRegion = {
  start: number;
  end: number;
  text: string;
  prefixLength: number;
  isHeading: boolean;
};
type LineEditRegion = { blockId: string; start: number; end: number };
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

function findItemCommandRange(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { start: number; end: number } | null {
  const commandEnd = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  const beforeSelection = value.slice(0, commandEnd);
  const match = /(?:^|\s)(\/item)$/.exec(beforeSelection);
  if (!match) return null;
  const start = commandEnd - match[1].length;
  return { start, end: commandEnd };
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

function headingMarkdownPrefixLength(markdown: string): number {
  const match = /^(\s{0,3}#{1,6}\s+)/.exec(markdown);
  return match ? match[1].length : 0;
}

function markdownLineRegions(markdown: string): MarkdownLineRegion[] {
  const regions: MarkdownLineRegion[] = [];
  let start = 0;
  for (const line of markdown.split('\n')) {
    const match = /^(\s{0,3}#{1,6}\s+)(.*)$/.exec(line);
    regions.push({
      start,
      end: start + line.length,
      text: line,
      prefixLength: match ? match[1].length : 0,
      isHeading: Boolean(match),
    });
    start += line.length + 1;
  }
  return regions;
}

function shouldRenderLineRegions(markdown: string): boolean {
  const regions = markdownLineRegions(markdown);
  return regions.length > 1 && regions.some((line) => line.isHeading);
}

function renderedLineHtml(line: MarkdownLineRegion): string {
  return line.text ? renderDocumentText(line.text).html : '';
}

function markdownHeadingLines(markdown: string): Array<{ start: number; prefixLength: number; text: string }> {
  const lines: Array<{ start: number; prefixLength: number; text: string }> = [];
  let start = 0;
  for (const line of markdown.split('\n')) {
    const match = /^(\s{0,3}#{1,6}\s+)(.*)$/.exec(line);
    if (match) {
      lines.push({ start, prefixLength: match[1].length, text: match[2].trim() });
    }
    start += line.length + 1;
  }
  return lines;
}

function markdownHeadingSourceLine(
  markdown: string,
  root: HTMLElement,
  heading: HTMLElement,
): { start: number; prefixLength: number } | null {
  const headings = Array.from(
    root.querySelectorAll(RENDERED_MARKDOWN_HEADING_SELECTOR),
  ) as HTMLElement[];
  const headingIndex = headings.indexOf(heading);
  const lines = markdownHeadingLines(markdown);
  if (headingIndex >= 0 && lines[headingIndex]) {
    return { start: lines[headingIndex].start, prefixLength: lines[headingIndex].prefixLength };
  }

  const headingText = heading.textContent?.trim() ?? '';
  const matchingLine = lines.find((line) => line.text === headingText);
  return matchingLine
    ? { start: matchingLine.start, prefixLength: matchingLine.prefixLength }
    : null;
}

function textOffsetFromNode(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) {
      return total + Math.max(0, Math.min(offset, current.textContent?.length ?? 0));
    }
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return null;
}

function eventTargetElement(event: MouseEvent): Element | null {
  const target = event.target;
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function hasSelectionInside(root: HTMLElement): boolean {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  return Boolean(anchorNode && focusNode && root.contains(anchorNode) && root.contains(focusNode));
}

function renderedClickTextOffset(root: HTMLElement, event: MouseEvent): number | null {
  const doc = root.ownerDocument;
  const caretPositionFromPoint = (
    doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    }
  ).caretPositionFromPoint;
  const position = caretPositionFromPoint?.call(doc, event.clientX, event.clientY);
  if (position) {
    const offset = textOffsetFromNode(root, position.offsetNode, position.offset);
    if (offset !== null) return offset;
  }

  const caretRangeFromPoint = (
    doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  ).caretRangeFromPoint;
  const range = caretRangeFromPoint?.call(doc, event.clientX, event.clientY);
  if (range) {
    const offset = textOffsetFromNode(root, range.startContainer, range.startOffset);
    if (offset !== null) return offset;
  }

  const rect = root.getBoundingClientRect();
  const textLength = root.textContent?.length ?? 0;
  if (rect.width > 0 && textLength > 0) {
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return Math.round(ratio * textLength);
  }
  return null;
}

function eventPointIsInsideElement(element: HTMLElement, event: MouseEvent): boolean {
  const rects = Array.from(element.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (rects.length === 0) return true;
  return rects.some(
    (rect) =>
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom,
  );
}

function renderedHeadingClickRoot(root: HTMLElement, event: MouseEvent): HTMLElement | null {
  const target = eventTargetElement(event);
  const targetHeading =
    (target?.closest?.(RENDERED_HEADING_SELECTOR) as HTMLElement | null) ?? null;
  if (!targetHeading || !root.contains(targetHeading)) return null;

  const realHeadings = root.querySelectorAll(RENDERED_MARKDOWN_HEADING_SELECTOR);
  const isActualMarkdownHeading = targetHeading.matches(RENDERED_MARKDOWN_HEADING_SELECTOR);
  if (!isActualMarkdownHeading && realHeadings.length > 0) {
    return null;
  }
  if (!eventPointIsInsideElement(targetHeading, event)) return null;
  return targetHeading;
}

function caretForRenderedHeadingClick(
  block: SpaceBlock,
  root: HTMLElement,
  event: MouseEvent,
): number | null {
  const markdown = block.markdown ?? '';
  const renderedRoot = renderedHeadingClickRoot(root, event);
  if (!renderedRoot) return null;

  const renderedOffset = renderedClickTextOffset(renderedRoot, event) ?? 0;
  const sourceLine = renderedRoot.matches(RENDERED_MARKDOWN_HEADING_SELECTOR)
    ? markdownHeadingSourceLine(markdown, root, renderedRoot)
    : null;
  const sourceStart = sourceLine?.start ?? 0;
  const prefix = sourceLine?.prefixLength ?? headingMarkdownPrefixLength(markdown);
  return Math.max(0, Math.min(markdown.length, sourceStart + prefix + renderedOffset));
}

function caretForRenderedClick(block: SpaceBlock, root: HTMLElement, event: MouseEvent): number | null {
  const markdown = block.markdown ?? '';
  if (block.block_type === 'heading') {
    return caretForRenderedHeadingClick(block, root, event);
  }
  const renderedOffset = renderedClickTextOffset(root, event);
  return Math.max(0, Math.min(markdown.length, renderedOffset ?? markdown.length));
}

function isResourceRefClick(event: MouseEvent): boolean {
  const target = eventTargetElement(event);
  return Boolean(target?.closest?.('a.resource-ref__link, a.spaces-doc-ref__link'));
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
  const [itemCommandRange, setItemCommandRange] = useState<ItemCommandRange | null>(null);
  const [pickerPosition, setPickerPosition] = useState<OverlayPosition | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [lineEditRegion, setLineEditRegion] = useState<LineEditRegion | null>(null);
  const [inspector, setInspector] = useState<SpaceReferenceDetailTarget | null>(null);
  const [inspectorHeight, setInspectorHeight] = useState<number | null>(null);
  const [pendingEmbedDelete, setPendingEmbedDelete] = useState<EmbedDeleteDecision | null>(null);
  const fetchRef = useRef(fetchImpl);
  const saveTimers = useRef<Map<string, number>>(new Map());
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const caretRef = useRef<CaretTarget | null>(null);
  const focusEditRef = useRef<FocusEditTarget | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inspectorResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const currentSpaceIdRef = useRef<string | null | undefined>(spaceId);
  fetchRef.current = fetchImpl;
  currentSpaceIdRef.current = spaceId;

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
      const requestedSpaceId = spaceId;
      if (!isReconcile) setLoad({ status: 'loading' });
      try {
        const [blocks, exportsResult] = await Promise.all([
          listSpaceBlocks(requestedSpaceId, fetcher()),
          getSpaceExports(requestedSpaceId).catch(() => ({ exports: [] as SpaceExport[] })),
        ]);
        if (currentSpaceIdRef.current !== requestedSpaceId) return;
        setLoad((prior) => ({
          status: 'ready',
          spaceId: requestedSpaceId,
          blocks,
          exports: exportsResult.exports,
          items: prior.status === 'ready' && prior.spaceId === requestedSpaceId ? prior.items : [],
        }));
        void getSpaceFactPacket(requestedSpaceId)
          .then((packet) => {
            if (currentSpaceIdRef.current !== requestedSpaceId) return;
            setLoad((prior) =>
              prior.status === 'ready' && prior.spaceId === requestedSpaceId
                ? { ...prior, items: packet.items }
                : prior,
            );
          })
          .catch(() => undefined);
        // Reconcile edit state against live block ids without resetting the
        // user's in-progress drafts (Dataful-UX: refetch is reconciliation).
        setViewState((prior) =>
          reconcileBlockEditorViewState(prior, blocks.map((b) => b.id)),
        );
      } catch (err) {
        if (currentSpaceIdRef.current !== requestedSpaceId) return;
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

  const cancelPendingAutosave = useCallback((blockId: string) => {
    const prior = saveTimers.current.get(blockId);
    if (!prior) return;
    window.clearTimeout(prior);
    saveTimers.current.delete(blockId);
  }, []);

  const setEditing = useCallback((blockId: string | null) => {
    setActiveBlockId(blockId);
    if (blockId === null) setLineEditRegion(null);
    setViewState((prior) => ({ ...prior, editingId: blockId }));
  }, []);

  const beginEditing = useCallback(
    (blockId: string, selectEnd = true, selection?: { start: number; end: number }) => {
      setLineEditRegion(null);
      focusEditRef.current = {
        blockId,
        selectEnd,
        start: selection?.start ?? 0,
        end: selection?.end ?? 0,
      };
      setEditing(blockId);
    },
    [setEditing],
  );

  const beginEditingLine = useCallback(
    (blockId: string, line: MarkdownLineRegion, selection?: { start: number; end: number }) => {
      setLineEditRegion({ blockId, start: line.start, end: line.end });
      focusEditRef.current = {
        blockId,
        selectEnd: false,
        start: selection?.start ?? line.start,
        end: selection?.end ?? selection?.start ?? line.start,
      };
      setEditing(blockId);
    },
    [setEditing],
  );

  const beginEditingFromRenderedClick = useCallback(
    (block: SpaceBlock, event: MouseEvent) => {
      if (isResourceRefClick(event)) return;
      const root = event.currentTarget as HTMLElement | null;
      if (root && hasSelectionInside(root)) return;
      const caret = root ? caretForRenderedClick(block, root, event) : (block.markdown ?? '').length;
      if (caret === null) return;
      beginEditing(block.id, false, { start: caret, end: caret });
    },
    [beginEditing],
  );

  const beginEditingLineFromRenderedClick = useCallback(
    (block: SpaceBlock, line: MarkdownLineRegion, event: MouseEvent) => {
      if (isResourceRefClick(event)) return;
      const root = event.currentTarget as HTMLElement | null;
      if (!root || hasSelectionInside(root)) return;
      const target = eventTargetElement(event);
      const textRoot = target?.closest?.(RENDERED_HEADING_SELECTOR) as HTMLElement | null;
      if (line.text && (!textRoot || !root.contains(textRoot) || !eventPointIsInsideElement(textRoot, event))) {
        return;
      }
      const renderedOffset = textRoot ? (renderedClickTextOffset(textRoot, event) ?? 0) : 0;
      const lineOffset = Math.min(line.text.length, line.prefixLength + renderedOffset);
      const caret = Math.max(line.start, Math.min(line.end, line.start + lineOffset));
      beginEditingLine(block.id, line, { start: caret, end: caret });
    },
    [beginEditingLine],
  );

  useEffect(() => {
    const target = focusEditRef.current;
    if (!target || viewState.editingId !== target.blockId) return;
    const textarea = textareaRefs.current.get(target.blockId);
    if (!textarea) return;
    focusEditRef.current = null;
    textarea.focus();
    if (target.selectEnd) {
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
      caretRef.current = { blockId: target.blockId, start: end, end };
    } else {
      const lineStart =
        lineEditRegion?.blockId === target.blockId ? lineEditRegion.start : 0;
      const start = Math.max(0, Math.min(target.start - lineStart, textarea.value.length));
      const end = Math.max(start, Math.min(target.end - lineStart, textarea.value.length));
      textarea.setSelectionRange(start, end);
      caretRef.current = { blockId: target.blockId, start: lineStart + start, end: lineStart + end };
    }
  }, [lineEditRegion, viewState.editingId]);

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
        beginEditing(created.id);
        return created;
      });
    },
    [spaceId, blocks, runMutation, fetcher, beginEditing],
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
      const draft = viewState.drafts[targetId] ?? block.markdown ?? '';
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
      const activeLineRegion = lineEditRegion?.blockId === targetId ? lineEditRegion : null;
      setActiveBlockId(targetId);
      setEditing(targetId);
      setItemCommandRange(null);
      setPickerPosition(null);
      setPickerOpen(false);
      setSelectionMenu(null);
      setDraft(targetId, next);
      if (activeLineRegion) {
        setLineEditRegion({
          ...activeLineRegion,
          end: activeLineRegion.end + next.length - draft.length,
        });
      }
      queueAutosave(targetId, next);
      window.setTimeout(() => {
        const textarea = textareaRefs.current.get(targetId);
        if (!textarea) return;
        textarea.focus();
        const relativeNextPos = activeLineRegion
          ? Math.max(0, Math.min(nextPos - activeLineRegion.start, textarea.value.length))
          : nextPos;
        textarea.setSelectionRange(relativeNextPos, relativeNextPos);
        caretRef.current = { blockId: targetId, start: nextPos, end: nextPos };
      }, 0);
    },
    [
      activeBlockId,
      addProseBlock,
      blocks,
      itemCommandRange,
      lineEditRegion,
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
      setLineEditRegion(null);
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
    const lineStart = lineEditRegion?.blockId === blockId ? lineEditRegion.start : 0;
    caretRef.current = {
      blockId,
      start: lineStart + (textarea.selectionStart ?? textarea.value.length),
      end: lineStart + (textarea.selectionEnd ?? textarea.value.length),
    };
  }, [lineEditRegion]);

  const updateSelectionMenu = useCallback((blockId: string, textarea: HTMLTextAreaElement) => {
    const lineStart = lineEditRegion?.blockId === blockId ? lineEditRegion.start : 0;
    const start = lineStart + (textarea.selectionStart ?? textarea.value.length);
    const end = lineStart + (textarea.selectionEnd ?? textarea.value.length);
    if (start === end) {
      setSelectionMenu((current) => (current?.blockId === blockId ? null : current));
      return;
    }
    const rect = textarea.getBoundingClientRect();
    setSelectionMenu({
      blockId,
      start,
      end,
      top: Math.max(8, rect.top - 44),
      left: Math.max(8, Math.min(rect.left + rect.width - 180, rect.left + 24)),
    });
  }, [lineEditRegion]);

  const handleDraftInput = useCallback(
    (blockId: string, textarea: HTMLTextAreaElement) => {
      const value = textarea.value;
      if (lineEditRegion?.blockId === blockId) {
        const block = blocks.find((b) => b.id === blockId);
        const draft = viewState.drafts[blockId] ?? block?.markdown ?? '';
        const next = replaceRange(draft, value, lineEditRegion.start, lineEditRegion.end);
        const nextRegion = {
          ...lineEditRegion,
          end: lineEditRegion.start + value.length,
        };
        setLineEditRegion(nextRegion);
        caretRef.current = {
          blockId,
          start: nextRegion.start + (textarea.selectionStart ?? value.length),
          end: nextRegion.start + (textarea.selectionEnd ?? value.length),
        };
        updateSelectionMenu(blockId, textarea);
        setDraft(blockId, next);
        queueAutosave(blockId, next);
        return;
      }
      updateCaret(blockId, textarea);
      updateSelectionMenu(blockId, textarea);
      setDraft(blockId, value);
      queueAutosave(blockId, value);
    },
    [blocks, lineEditRegion, queueAutosave, setDraft, updateCaret, updateSelectionMenu, viewState.drafts],
  );

  const handleTextareaKeyDown = useCallback(
    (blockId: string, event: KeyboardEvent) => {
      const textarea = event.currentTarget as HTMLTextAreaElement | null;
      if (!textarea || event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const lineStart = lineEditRegion?.blockId === blockId ? lineEditRegion.start : 0;
      const range = findItemCommandRange(
        textarea.value,
        textarea.selectionStart ?? textarea.value.length,
        textarea.selectionEnd ?? textarea.value.length,
      );
      if (range) {
        event.preventDefault();
        updateCaret(blockId, textarea);
        cancelPendingAutosave(blockId);
        setActiveBlockId(blockId);
        setEditing(blockId);
        setSelectionMenu(null);
        const rect = textarea.getBoundingClientRect();
        setPickerPosition({
          top: Math.max(8, rect.bottom + 8),
          left: Math.max(8, Math.min(rect.left + 24, window.innerWidth - 360)),
        });
        setItemCommandRange({
          blockId,
          start: lineStart + range.start,
          end: lineStart + range.end,
        });
        setPickerOpen(true);
        return;
      }

      const selectionStart = textarea.selectionStart ?? textarea.value.length;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      if (lineEditRegion?.blockId === blockId) {
        event.preventDefault();
        const block = blocks.find((b) => b.id === blockId);
        const draft = viewState.drafts[blockId] ?? block?.markdown ?? '';
        const before = textarea.value.slice(0, Math.min(selectionStart, selectionEnd));
        const after = textarea.value.slice(Math.max(selectionStart, selectionEnd));
        const replacement = `${before}\n${after}`;
        const next = replaceRange(draft, replacement, lineEditRegion.start, lineEditRegion.end);
        const nextLineStart = lineEditRegion.start + before.length + 1;
        const afterLineBreak = after.indexOf('\n');
        const nextRegion = {
          blockId,
          start: nextLineStart,
          end: nextLineStart + (afterLineBreak === -1 ? after.length : afterLineBreak),
        };
        setLineEditRegion(nextRegion);
        focusEditRef.current = {
          blockId,
          selectEnd: false,
          start: nextLineStart,
          end: nextLineStart,
        };
        caretRef.current = { blockId, start: nextLineStart, end: nextLineStart };
        setActiveBlockId(blockId);
        setEditing(blockId);
        setSelectionMenu(null);
        setDraft(blockId, next);
        queueAutosave(blockId, next);
        return;
      }

      event.preventDefault();
      const before = textarea.value.slice(0, Math.min(selectionStart, selectionEnd));
      const after = textarea.value.slice(Math.max(selectionStart, selectionEnd));
      const next = `${before}\n${after}`;
      const nextLineStart = before.length + 1;
      const afterLineBreak = after.indexOf('\n');
      const nextRegion = {
        blockId,
        start: nextLineStart,
        end: nextLineStart + (afterLineBreak === -1 ? after.length : afterLineBreak),
      };
      setLineEditRegion(nextRegion);
      focusEditRef.current = {
        blockId,
        selectEnd: false,
        start: nextLineStart,
        end: nextLineStart,
      };
      caretRef.current = { blockId, start: nextLineStart, end: nextLineStart };
      setActiveBlockId(blockId);
      setEditing(blockId);
      setSelectionMenu(null);
      setDraft(blockId, next);
      queueAutosave(blockId, next);
    },
    [
      blocks,
      cancelPendingAutosave,
      lineEditRegion,
      queueAutosave,
      setDraft,
      setEditing,
      updateCaret,
      viewState.drafts,
    ],
  );

  const applySelectionFormat = useCallback(
    (before: string, after: string) => {
      if (!selectionMenu) return;
      const block = blocks.find((b) => b.id === selectionMenu.blockId);
      if (!block) return;
      const draft = viewState.drafts[block.id] ?? block.markdown ?? '';
      const { next, caret } = wrappedSelection(
        draft,
        selectionMenu.start,
        selectionMenu.end,
        before,
        after,
      );
      setDraft(block.id, next);
      queueAutosave(block.id, next);
      setSelectionMenu(null);
      window.setTimeout(() => {
        const textarea = textareaRefs.current.get(block.id);
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
        caretRef.current = { blockId: block.id, start: caret, end: caret };
      }, 0);
    },
    [blocks, queueAutosave, selectionMenu, setDraft, viewState.drafts],
  );

  const handleTextareaBlur = useCallback(
    (blockId: string, textarea: HTMLTextAreaElement) => {
      window.setTimeout(() => {
        setSelectionMenu((current) => (current?.blockId === blockId ? null : current));
      }, 0);
      if (itemCommandRange?.blockId === blockId && pickerOpen) {
        cancelPendingAutosave(blockId);
        return;
      }
      if (lineEditRegion?.blockId === blockId) {
        const block = blocks.find((b) => b.id === blockId);
        const draft = viewState.drafts[blockId] ?? block?.markdown ?? '';
        saveProse(blockId, replaceRange(draft, textarea.value, lineEditRegion.start, lineEditRegion.end));
        return;
      }
      saveProse(blockId, textarea.value);
    },
    [blocks, cancelPendingAutosave, itemCommandRange, lineEditRegion, pickerOpen, saveProse, viewState.drafts],
  );

  const openReferenceInspector = useCallback(
    (ref: string) => {
      if (!ref.trim()) return;
      setInspector(detailTargetFromResourceRef(ref));
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
      data-stale={String(custody.stale)}
      ref={bodyRef}
    >
      <div className="spaces-block-editor__viewport" ref={viewportRef}>
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
        <div className="spaces-block-editor__scroller">
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
                const activeLineRegion =
                  lineEditRegion?.blockId === block.id ? lineEditRegion : null;
                const useLineRegions =
                  !isEmbed && (shouldRenderLineRegions(draft) || activeLineRegion !== null);
                const lineRegions = useLineRegions ? markdownLineRegions(draft) : [];
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
                    {isEditing && !isEmbed && !activeLineRegion && (
                      <div className="spaces-block-editor__editbox">
                        <textarea
                          ref={(node) => {
                            if (node) textareaRefs.current.set(block.id, node);
                            else textareaRefs.current.delete(block.id);
                          }}
                          className="spaces-block-editor__textarea"
                          value={draft}
                          rows={1}
                          data-testid="spaces-block-editor-textarea"
                          aria-label={`Edit ${block.block_type} block`}
                          onInput={(e) => handleDraftInput(block.id, e.currentTarget as HTMLTextAreaElement)}
                          onSelect={(e) => {
                            const textarea = e.currentTarget as HTMLTextAreaElement;
                            updateCaret(block.id, textarea);
                            updateSelectionMenu(block.id, textarea);
                          }}
                          onClick={(e) => {
                            const textarea = e.currentTarget as HTMLTextAreaElement;
                            updateCaret(block.id, textarea);
                            updateSelectionMenu(block.id, textarea);
                          }}
                          onKeyDown={(e) => handleTextareaKeyDown(block.id, e as unknown as KeyboardEvent)}
                          onKeyUp={(e) => {
                            const textarea = e.currentTarget as HTMLTextAreaElement;
                            updateCaret(block.id, textarea);
                            updateSelectionMenu(block.id, textarea);
                          }}
                          onBlur={(e) => handleTextareaBlur(block.id, e.currentTarget as HTMLTextAreaElement)}
                        />
                      </div>
                    )}
                    {useLineRegions && (!isEditing || activeLineRegion) && (
                      <div className="spaces-block-editor__rendered-block">
                        {lineRegions.map((line, index) => {
                          const isActiveLine =
                            activeLineRegion !== null &&
                            line.start === activeLineRegion.start;
                          const html = renderedLineHtml(line);
                          return (
                            <div
                              key={`${line.start}:${index}`}
                              className="spaces-block-editor__line-region"
                              data-markdown-heading={line.isHeading ? 'true' : undefined}
                              data-testid="spaces-block-editor-line-region"
                              onClick={(event) =>
                                !isActiveLine &&
                                beginEditingLineFromRenderedClick(
                                  block,
                                  line,
                                  event as unknown as MouseEvent,
                                )
                              }
                            >
                              {isActiveLine ? (
                                <div className="spaces-block-editor__editbox">
                                  <textarea
                                    ref={(node) => {
                                      if (node) textareaRefs.current.set(block.id, node);
                                      else textareaRefs.current.delete(block.id);
                                    }}
                                    className="spaces-block-editor__textarea"
                                    value={line.text}
                                    rows={1}
                                    data-testid="spaces-block-editor-textarea"
                                    aria-label={`Edit ${block.block_type} line`}
                                    onInput={(e) =>
                                      handleDraftInput(block.id, e.currentTarget as HTMLTextAreaElement)
                                    }
                                    onSelect={(e) => {
                                      const textarea = e.currentTarget as HTMLTextAreaElement;
                                      updateCaret(block.id, textarea);
                                      updateSelectionMenu(block.id, textarea);
                                    }}
                                    onClick={(e) => {
                                      const textarea = e.currentTarget as HTMLTextAreaElement;
                                      updateCaret(block.id, textarea);
                                      updateSelectionMenu(block.id, textarea);
                                    }}
                                    onKeyDown={(e) => handleTextareaKeyDown(block.id, e as unknown as KeyboardEvent)}
                                    onKeyUp={(e) => {
                                      const textarea = e.currentTarget as HTMLTextAreaElement;
                                      updateCaret(block.id, textarea);
                                      updateSelectionMenu(block.id, textarea);
                                    }}
                                    onBlur={(e) => handleTextareaBlur(block.id, e.currentTarget as HTMLTextAreaElement)}
                                  />
                                </div>
                              ) : html ? (
                                <span
                                  className="spaces-block-editor__rendered-html spaces-block-editor__rendered-html--line"
                                  data-heading-hit-area={line.isHeading ? 'true' : undefined}
                                  // eslint-disable-next-line react/no-danger -- pipeline-sanitized HTML from DocumentRenderer.
                                  dangerouslySetInnerHTML={{ __html: html }}
                                />
                              ) : (
                                <span className="spaces-block-editor__blank" aria-hidden="true" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {!isEditing && !isEmbed && !useLineRegions && (
                      <div
                        className="spaces-block-editor__rendered-block"
                        data-testid="spaces-block-editor-edit"
                        onClick={(event) =>
                          beginEditingFromRenderedClick(block, event as unknown as MouseEvent)
                        }
                        onFocus={() => setActiveBlockId(block.id)}
                      >
                        {renderedBlock?.html ? (
                          <span
                            className={
                              block.block_type === 'heading'
                                ? 'spaces-block-editor__rendered-html spaces-block-editor__rendered-html--heading-hit-area'
                                : 'spaces-block-editor__rendered-html'
                            }
                            data-heading-hit-area={block.block_type === 'heading' ? 'true' : undefined}
                            // eslint-disable-next-line react/no-danger -- pipeline-sanitized HTML from DocumentRenderer.
                            dangerouslySetInnerHTML={{ __html: renderedBlock.html }}
                          />
                        ) : (
                          <span className="spaces-block-editor__blank" aria-hidden="true" />
                        )}
                      </div>
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
              void loadAll(true);
            }}
            onClose={() => {
              const focusBlockId = pickerBlockId;
              setPickerOpen(false);
              setItemCommandRange(null);
              setPickerPosition(null);
              const textarea = textareaRefs.current.get(focusBlockId);
              if (textarea) window.setTimeout(() => textarea.focus(), 0);
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
  target: SpaceReferenceDetailTarget;
  height: number | null;
  onResizeStart: (
    event: JSX.TargetedMouseEvent<HTMLDivElement> | JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => void;
  onClose: () => void;
}): JSX.Element {
  const style = height !== null ? ({ flexBasis: `${height}px` } as JSX.CSSProperties) : undefined;
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
          ×
        </button>
      </header>
      <div className="spaces-block-editor__inspector-body">
        <SpaceReferenceDetailContent target={target} />
      </div>
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
