import { render } from 'preact';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addSpaceNote, addressSpaceDocumentBlock, canPerformOperation, getSpaceDocument, getSpaceLegacyDraftBases,
  getSpaceReview, spaceDocumentPath, updateSpaceNote, type SpaceItem,
} from '../../api';
import { useViewActive } from '../../app-shell';
import {
  isLargeMarkdownDocument, MarkdownDocument, type MarkdownDirective, type MarkdownDirectiveRenderer,
  type MarkdownDocumentHandle, type MarkdownSelection, type MarkdownSourceRange,
} from '../../components/MarkdownDocument';
import type { MarkdownSourceEdit } from '../../components/markdown/source';
import { Icon } from '../../components/icons/Icon';
import { appTip } from '../../components/shared/AppHoverTips';
import { DetailPaneModal } from '../../components/shared/DetailPaneModal';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { useStandingNoteReview } from '../../components/shared/StandingNoteReview';
import { useProjectionQuery } from '../../query/useProjectionQuery';
import { browserResourceKeys } from '../../query/browserResources';
import { queryClient } from '../../query/client';
import { isResourceRef, parseResourceRef, resourceRefHref } from '../../resource-refs';
import { spacesRoute } from '../../routing';
import { parseAppPath } from '../../../../src/app-routes';
import { SPACE_DIRECTIVE_TYPES } from '../../../../src/spaces/directives';
import { writeSpaceBlock, type SpaceSourceBlock } from '../../../../src/spaces/document-source';
import { type SpaceDocument } from '../../../../src/spaces/document-store';
import { carryReviewRanges } from '../../../../src/feedback/review-ranges';
import { ReferenceDetailContent, referenceDetailTargetFromResourceRef, type ReferenceDetailTarget } from '../reference-detail';
import { SpaceExportDialog } from './SpaceExportDialog';
import { SpaceItemPicker } from './SpaceItemPicker';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import {
  addressIn, blockAt, insertBlock, itemFrame, moveSection, separator, spaceBlocks, todoFrame,
} from './document-model';
import { SpaceDocumentRecovery } from './document-recovery';
import { useSpaceDocumentDraft } from './useSpaceDocumentDraft';
import './SpaceDocumentEditor.css';

type EditorProps = SpaceRendererMountProps & { fetchImpl?: typeof fetch };
type PickerMode = 'embed' | 'reference';
type PickerIntent = { source: string; range: MarkdownSourceRange; mode: PickerMode };
const noNotes: import('../../../../src/feedback/space-review').SpaceReview['notes'] = [];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const emptySelection: MarkdownSelection = { start: 0, end: 0, quote: '' };

export function SpaceDocumentEditor({ spaceId, ...props }: EditorProps) {
  const active = useViewActive();
  const key = browserResourceKeys.spaceDocument(spaceId);
  const read = useProjectionQuery({
    queryKey: key,
    queryFn: ({ signal }) => getSpaceDocument(spaceId!, signal, props.fetchImpl),
    refetchOnWindowFocus: true,
  }, active && Boolean(spaceId));
  return <>
    {read.error && <DetailPaneNotice severity="error" density="compact" title="Could not load document">{read.error.message}</DetailPaneNotice>}
    {spaceId && read.data && <SavedSpaceEditor key={spaceId} {...props} spaceId={spaceId} saved={read.data} />}
  </>;
}

function SavedSpaceEditor({ spaceId, projectId, factPacket, instance = null, fetchImpl, saved }: EditorProps & {
  spaceId: string; saved: SpaceDocument;
}) {
  const path = spaceDocumentPath(spaceId);
  const [storage] = useState(() => {
    try { return { recovery: new SpaceDocumentRecovery(projectId, spaceId) }; }
    catch (error) { return { error: errorMessage(error) }; }
  });
  const recovery = storage.recovery ?? null;
  const canSave = canPerformOperation(instance, 'PATCH', path);
  const draft = useSpaceDocumentDraft(spaceId, saved, recovery, canSave, fetchImpl);
  const [selection, setSelection] = useState(emptySelection);
  const [legacy, setLegacy] = useState(() => recovery?.legacy);
  const [commentsOpen, setCommentsOpen] = useState(() => recovery?.position.commentsOpen ?? false);
  const [reviewedGeneration, setReviewedGeneration] = useState<number | null>(null);
  const [publication, setPublication] = useState(false);
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const pickerIntent = useRef<PickerIntent | null>(null);
  const [detachItem, setDetachItem] = useState<string | null>(null);
  const [inspector, setInspector] = useState<ReferenceDetailTarget | null>(null);
  const [outline, setOutline] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const editor = useRef<MarkdownDocumentHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const dragged = useRef<SpaceSourceBlock | null>(null);
  const justRecovered = useRef(new Map<string, string>());
  const restoreTargets = useRef(new Map<string, string>());
  const detachId = useId();
  const inspectorId = useId();
  const key = browserResourceKeys.spaceDocument(spaceId);
  const allowNote = canPerformOperation(instance, 'POST', path + '/notes');
  const editable = canSave && !isLargeMarkdownDocument(draft.source);
  const active = useViewActive();
  const noteQuery = useProjectionQuery({
    queryKey: browserResourceKeys.spaceDocumentNotes(spaceId),
    queryFn: ({ signal }) => getSpaceReview(spaceId, signal, fetchImpl),
    refetchOnWindowFocus: true,
  }, active);
  const legacyBases = useProjectionQuery({
    queryKey: ['space-legacy-draft-bases', spaceId],
    queryFn: ({ signal }) => getSpaceLegacyDraftBases(spaceId, signal, fetchImpl),
    staleTime: Infinity,
  }, active && Boolean(legacy?.drafts.size));

  const latest = useRef({ draft, selection, editable });
  latest.current = { draft, selection, editable };

  function selectBlock(id: string, focus = true, source = draft.source) {
    const block = addressIn(readBlocks(spaceId, source), id);
    if (!block) return false;
    editor.current?.select({ start: block.body.start, end: block.body.start }, focus);
    return true;
  }

  useLayoutEffect(() => {
    const navigate = () => {
      const hash = window.location.hash.slice(1);
      if (hash) selectBlock(hash, false, latest.current.draft.source);
    };
    if (window.location.hash) navigate();
    else {
      const initial = recovery?.position;
      if (initial?.range) {
        editor.current?.select(initial.range, false);
        if (scroller.current) scroller.current.scrollTop = initial.scroll;
      } else if (legacy?.editingId) selectBlock(legacy.editingId, false);
    }
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, [spaceId]);

  useLayoutEffect(() => {
    try { recovery?.setPosition(selection, scroller.current?.scrollTop ?? 0, commentsOpen); }
    catch (error) { setActionError(errorMessage(error)); }
  }, [commentsOpen, recovery, selection]);

  useEffect(() => {
    if (!legacy?.drafts.size) return;
    const blocks = readBlocks(spaceId, draft.latest.source);
    let changed = false;
    for (const [id, markdown] of legacy.drafts) {
      const span = addressIn(blocks, restoreTargets.current.get(id) ?? id);
      if (span?.block.markdown !== markdown) continue;
      try {
        recovery?.finishLegacy(id, markdown);
        changed = true;
      } catch (error) { setActionError(errorMessage(error)); }
    }
    if (changed) setLegacy(recovery?.legacy);
  }, [draft.latest, legacy, recovery, spaceId]);

  useEffect(() => {
    if (!editable || !legacy || !legacyBases.data || draft.conflict) return;
    const bases = new Map(legacyBases.data.map(row => [row.id, row.markdown]));
    const working = readBlocks(spaceId, draft.source);
    const current = readBlocks(spaceId, draft.latest.source);
    const edits = [...legacy.drafts].flatMap(([id, markdown]): MarkdownSourceEdit[] => {
      if (justRecovered.current.get(id) === markdown || !bases.has(id)) return [];
      const live = addressIn(current, id);
      const local = addressIn(working, id);
      if (!local || !live || live.block.markdown === markdown || live.block.markdown !== bases.get(id)
        || local.block.markdown !== live.block.markdown) return [];
      justRecovered.current.set(id, markdown);
      return [{ start: local.from, end: local.to, text: writeSpaceBlock({ ...local.block, markdown }) }];
    });
    if (!edits.length) return;
    const place = legacy.editingId && addressIn(working, legacy.editingId);
    const selectedEdit = place && edits.find(edit => edit.start === place.from);
    const caret = latest.current.selection;
    let range: MarkdownSourceRange | undefined;
    if (place && selectedEdit && caret.start >= place.body.start && caret.end <= place.body.end) {
      const body = readBlocks(spaceId, selectedEdit.text)[0]?.body;
      if (body) {
        const offset = edits.filter(edit => edit.start < selectedEdit.start)
          .reduce((length, edit) => length + edit.text.length - (edit.end - edit.start), selectedEdit.start);
        const translate = (position: number) => offset + Math.min(body.end, body.start + position - place.body.start);
        range = { start: translate(caret.start), end: translate(caret.end) };
      }
    }
    editor.current?.edit(edits, range);
  }, [draft.source, draft.latest, draft.conflict, editable, legacy, legacyBases.data, spaceId]);

  const directives = useMemo(() => {
    const renderer: MarkdownDirectiveRenderer = (directive, document) => {
      const element = document.createElement('div');
      element.className = 'space-document__directive';
      const span = readBlocks(spaceId, directive.quote)[0];
      if (!directive.body || !span?.addressed) {
        element.textContent = directive.quote;
        return element;
      }
      const editBody = () => editor.current?.select({ start: directive.body!.start, end: directive.body!.start });
      render(<SpaceDirective directive={directive} span={span}
        onDetach={() => setDetachItem(span.block.item_id)}
        onInspect={ref => setInspector(referenceDetailTargetFromResourceRef(ref))}
        editable={latest.current.editable} onEditBody={editBody}
        onTodo={body => editor.current?.edit([{ start: directive.start, end: directive.end,
          text: writeSpaceBlock({ ...span.block, markdown: body, updated_at: Date.now() }) }])} />, element);
      return { element, destroy: () => render(null, element) };
    };
    return new Map([...SPACE_DIRECTIVE_TYPES].map(([name, kind]) => [name,
      kind === 'paragraph' || kind === 'heading' ? 'transparent' as const : renderer]));
  }, [spaceId, editable]);

  const notes = noteQuery.data?.notes ?? noNotes;
  const workingNotes = useMemo(() => {
    if (!notes.length) return notes;
    if (noteQuery.data?.generation !== draft.latest.generation) return notes.map(note => ({
      ...note, anchor: { status: 'detached' as const },
    }));
    if (draft.source === draft.latest.source) return notes;
    const carry = carryReviewRanges(draft.latest.source, draft.source);
    return notes.map(note => ({ ...note, anchor: note.anchor.status === 'detached' ? note.anchor : carry(note.anchor) }));
  }, [notes, noteQuery.data?.generation, draft.latest, draft.source]);

  const standing = useStandingNoteReview({
    scopeKey: spaceId, source: draft.source, rangeKind: 'text', notes: workingNotes,
    documentRef: editor, open: commentsOpen, onOpenChange: setCommentsOpen, scrollOwnerRef: scroller,
    onCreate: allowNote ? async (range, text, selectedSource) => {
      const current = await draft.saveCurrent(selectedSource);
      if (!current || current.source.slice(range.start_offset, range.end_offset) !== range.quote) {
        throw new Error('The selected text could not be pinned to the saved document.');
      }
      await addSpaceNote(spaceId, current.generation, range, text, fetchImpl);
      void noteQuery.refetch();
    } : undefined,
    onMutate: canPerformOperation(instance, 'PATCH', path + '/notes/_') ? async (id, mutation) => {
      await updateSpaceNote(spaceId, id, mutation, fetchImpl);
      void noteQuery.refetch();
    } : undefined,
  });

  async function act(action: () => Promise<void>) {
    if (acting) return;
    setActing(true);
    setActionError(null);
    try { await action(); }
    catch (error) { setActionError(errorMessage(error)); }
    finally { setActing(false); }
  }

  async function copyBlockLink() {
    await act(async () => {
      const target = blockAt(readBlocks(spaceId, draft.source), selection);
      if (!target) throw new Error('Select text within one block.');
      const current = await draft.saveCurrent(draft.source);
      if (!current) throw new Error('The selected block could not be pinned to the saved document.');
      const { id, ...addressed } = await addressSpaceDocumentBlock(spaceId, current.generation, target.from, target.to, fetchImpl);
      if (addressed.generation !== current.generation) {
        queryClient.setQueryData<SpaceDocument>(key, saved => saved && saved.generation > addressed.generation ? saved : addressed);
        void queryClient.invalidateQueries({ queryKey: browserResourceKeys.spaceDocumentNotes(spaceId) });
      }
      const href = new URL(spacesRoute({ projectId, spaceId, renderer: 'document', preserveSpaceId: true }), window.location.origin);
      href.hash = id;
      await navigator.clipboard.writeText(href.href);
    });
  }

  function insertItem(item: SpaceItem) {
    const live = latest.current;
    const intent = pickerIntent.current;
    if (!intent || !live.editable) throw new Error('The document is read-only.');
    const source = live.draft.currentSource();
    if (source !== intent.source) throw new Error('The document changed. Select where to insert the item again.');
    let patch: MarkdownSourceEdit;
    let at: number;
    if (intent.mode === 'reference') {
      patch = { ...intent.range, text: itemReference(item) };
      at = patch.start + patch.text.length;
    } else {
      const span = blockAt(readBlocks(spaceId, source), intent.range);
      patch = insertBlock(source, span?.to ?? source.length, itemFrame(spaceId, item));
      at = patch.start + patch.text.length - (patch.start < source.length ? separator(source).length * 2 : 0);
    }
    editor.current?.edit([patch], { start: at, end: at });
    pickerIntent.current = { ...intent, source: live.draft.currentSource(), range: { start: at, end: at } };
  }

  function openPicker(mode: PickerMode, range: MarkdownSourceRange) {
    pickerIntent.current = { mode, source: draft.source, range };
    setPicker(mode);
  }

  function formatSelection(mark: string) {
    const { start, end, quote } = selection;
    editor.current?.edit([{ start, end, text: mark + quote + mark }], { start: start + mark.length, end: end + mark.length });
  }

  function detach() {
    const edits = readBlocks(spaceId, draft.source).flatMap(span => span.block.item_id !== detachItem ? [] :
      [{ start: span.from, end: span.to, text: writeSpaceBlock({ ...span.block, item_id: null, updated_at: Date.now() }) }]);
    editor.current?.edit(edits);
    setDetachItem(null);
  }

  function insertTodo() {
    const span = blockAt(readBlocks(spaceId, draft.source), selection);
    const text = todoFrame(spaceId);
    const patch = insertBlock(draft.source, span?.to ?? draft.source.length, text);
    const frameStart = patch.start + (patch.start > 0 ? separator(draft.source).length * 2 : 0);
    const at = frameStart + readBlocks(spaceId, text)[0].body.end;
    editor.current?.edit([patch], { start: at, end: at });
  }

  function restoreLegacy(id: string, markdown: string) {
    const recovered = { id: crypto.randomUUID(), space_id: spaceId, parent_id: null,
      item_id: null, item_snapshot: null, metadata: {}, block_type: 'paragraph' as const,
      sort_key: '', created_at: Date.now(), updated_at: Date.now(), markdown };
    restoreTargets.current.set(id, recovered.id);
    editor.current?.edit([insertBlock(draft.source, draft.source.length, writeSpaceBlock(recovered))]);
  }

  function move(from: SpaceSourceBlock, to: SpaceSourceBlock, after: boolean) {
    const blocks = readBlocks(spaceId, draft.source);
    const moving = blocks.find(span => span.from === from.from && span.block.id === from.block.id && span.block.markdown === from.block.markdown);
    const target = blocks.find(span => span.from === to.from && span.block.id === to.block.id);
    if (moving && target) editor.current?.edit(moveSection(draft.source, blocks, moving, target, after));
  }

  const blocks = outline ? readBlocks(spaceId, draft.source) : [];
  const previousSibling = new Map<string | null, SpaceSourceBlock>();
  const recoveryEntries = [...(legacy?.drafts ?? [])].filter(([id, markdown]) => justRecovered.current.get(id) !== markdown);
  const scroll = () => {
    try { recovery?.setPosition(selection, scroller.current?.scrollTop ?? 0, commentsOpen); }
    catch (error) { setActionError(errorMessage(error)); }
  };
  const placeDrop = (event: DragEvent) => {
    const from = dragged.current;
    const at = editor.current?.positionAt(event.clientX, event.clientY);
    if (!from || at == null) return;
    const current = readBlocks(spaceId, draft.source);
    const target = blockAt(current, { start: at, end: at }) ?? current.find(block => block.from >= at) ?? current.at(-1);
    if (target) move(from, target, at > (target.from + target.to) / 2);
    dragged.current = null;
    event.preventDefault();
  };

  return <div className="space-document">
    <div className="space-document__toolbar" role="toolbar" aria-label="Document actions">
      <button className="btn btn--ghost btn--sm" type="button" aria-label="Insert item" {...appTip('Insert item')}
        disabled={!editable || !canPerformOperation(instance, 'POST', `/api/spaces/${encodeURIComponent(spaceId)}/items`)}
        onClick={() => openPicker('embed', selection)}><Icon name="add" /></button>
      {editable && selection.quote && <div role="group" aria-label="Selection format">
        <button className="btn btn--ghost btn--sm" aria-label="Bold" type="button" {...appTip('Bold')} onClick={() => formatSelection('**')}><b>B</b></button>
        <button className="btn btn--ghost btn--sm" aria-label="Italic" type="button" {...appTip('Italic')} onClick={() => formatSelection('*')}><i>I</i></button>
        <button className="btn btn--ghost btn--sm" aria-label="Strike through" type="button" {...appTip('Strike through')} onClick={() => formatSelection('~~')}><s>S</s></button>
        <button className="btn btn--ghost btn--sm" aria-label="Inline code" type="button" {...appTip('Inline code')} onClick={() => formatSelection('`')}><Icon name="toolJavascript" /></button>
        <button className="btn btn--ghost btn--sm" aria-label="Insert reference" type="button" {...appTip('Insert reference')} onClick={() => openPicker('reference', selection)}><Icon name="copyLink" /></button>
      </div>}
      <button className="btn btn--ghost btn--sm" type="button" aria-label="Insert todo"  {...appTip('Insert todo')} disabled={!editable}
        onClick={insertTodo}><Icon name="plan" /></button>
      <button className="btn btn--ghost btn--sm" type="button" aria-label="Copy block link" {...appTip('Copy block link')}
        disabled={acting || !canPerformOperation(instance, 'POST', path + '/address')}
        onClick={() => void copyBlockLink()}><Icon name="copyLink" /></button>
      <button className="btn btn--ghost btn--sm" type="button" aria-label="Document sections" {...appTip('Document sections')}
        aria-expanded={outline} onClick={() => setOutline(!outline)}><Icon name="sidebarMenu" /></button>
      {standing.toolbar}
      <button className="btn btn--ghost btn--sm" type="button" aria-label="Publications and import" {...appTip('Publications and import')}
        onClick={() => setPublication(true)}><Icon name="history" /></button>
    </div>
    {(actionError || draft.recoveryError || storage.error || noteQuery.error || legacyBases.error) &&
      <DetailPaneNotice severity="error" density="compact">{actionError ?? draft.recoveryError ?? storage.error ?? noteQuery.error?.message ?? legacyBases.error?.message}</DetailPaneNotice>}
    {draft.saveError && <DetailPaneNotice severity="error" density="compact" title="Could not save document"
      actions={<button type="button" onClick={() => void draft.save()}>Retry</button>}>{draft.saveError}</DetailPaneNotice>}
    {draft.conflict && !draft.pending && <DetailPaneNotice severity="warning" density="compact" title="Document changed in another session" actions={<>
      <button type="button" onClick={() => setReviewedGeneration(draft.latest.generation)}>Compare with saved document</button>
      {reviewedGeneration === draft.latest.generation && <>
        <button type="button" onClick={() => { draft.applyReviewedDraft(reviewedGeneration); setReviewedGeneration(null); }}>Save reviewed draft</button>
        <button type="button" onClick={() => { draft.acceptRemote(); setReviewedGeneration(null); }}>Discard local draft</button>
      </>}
    </>}>{null}</DetailPaneNotice>}
    <div className="space-document__workspace" data-comments-open={String(commentsOpen)}>
      {outline && <nav className="space-document__outline" aria-label="Document sections">
        {blocks.map(block => {
          const previous = previousSibling.get(block.block.parent_id);
          previousSibling.set(block.block.parent_id, block);
          return <div key={block.block.id} className="space-document__outline-row" draggable={editable}
            onDragStart={event => {
              dragged.current = block;
              event.dataTransfer?.setData('application/x-mandible-space-section', block.block.id);
            }}
            onDragEnd={() => { dragged.current = null; }}
            onDragOver={event => { if (dragged.current) event.preventDefault(); }}
            onDrop={event => { if (dragged.current) { event.preventDefault(); move(dragged.current, block, false); } }}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => editor.current?.select({ start: block.body.start, end: block.body.start })}>
              {sectionTitle(block)}
            </button>
            {editable && previous && <button type="button" className="btn btn--ghost btn--sm"
              aria-label={`Move ${sectionTitle(block)} up`} {...appTip('Move up')} onClick={() => move(block, previous, false)}><Icon name="sortAscending" /></button>}
          </div>;
        })}
      </nav>}
      <div ref={scroller} className="space-document__scroller" onScroll={scroll}
        onDragOver={event => { if (dragged.current) event.preventDefault(); }} onDrop={placeDrop}>
        <MarkdownDocument {...standing.documentProps} ariaLabel="Space document" value={draft.source} readOnly={!editable}
          directives={directives} comparison={draft.conflict && reviewedGeneration !== null ? draft.latest.source : undefined}
          onChange={draft.onChange} onSelectionChange={range => {
            setSelection(range);
            standing.documentProps.onSelectionChange(range);
          }}
          onLink={(href, event) => {
            if (event.metaKey || event.ctrlKey) return false;
            if (href.startsWith('#')) return selectBlock(href.slice(1));
            if (!href.startsWith('/')) return false;
            const url = new URL(href, window.location.origin);
            const target = parseAppPath(url.pathname);
            if (target.kind !== 'entity' || url.searchParams.has('comment')) return false;
            if (target.entity === 'artifact') setInspector({ kind: 'artifact', ref: target.ref });
            else if (target.entity === 'issue') setInspector({ kind: 'issue', ref: target.ref });
            else return false;
            return true;
          }}
          onKeyDown={(event, range) => {
            if (!editable) return false;
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
              openPicker('reference', range);
              return true;
            }
            if (event.key !== 'Enter' || range.quote) return false;
            const start = range.start - 5;
            if (start < 0 || draft.source.slice(start, range.start) !== '/item'
              || (start > 0 && !/\s/.test(draft.source[start - 1]))) return false;
            openPicker('reference', { start, end: range.end });
            return true;
          }} />
        {recoveryEntries.length > 0 && <details className="space-document__recovery">
          <summary>Recovered block drafts</summary>
          {recoveryEntries.map(([id, markdown]) => <div key={id}>
            <textarea aria-label={`Recovered draft ${id.slice(0, 8)}`} value={markdown} readOnly />
            <button type="button" disabled={!editable || restoreTargets.current.has(id)} onClick={() => restoreLegacy(id, markdown)}>Restore as a new block</button>
          </div>)}
        </details>}
      </div>
      {standing.sidebar}
    </div>
    {publication && <SpaceExportDialog spaceId={spaceId} projectId={projectId} savedGeneration={draft.dirty ? null : draft.latest.generation}
      onClose={() => setPublication(false)} onImported={() => void queryClient.invalidateQueries()} />}
    {picker && <SpaceItemPicker spaceId={spaceId} projectId={projectId} existingItems={factPacket?.items}
      title={picker === 'embed' ? 'Insert item' : 'Insert reference'} addButtonLabel="Insert"
      afterAdd={insertItem} onClose={() => { pickerIntent.current = null; setPicker(null); }} />}
    <DetailPaneModal open={detachItem !== null} onClose={() => setDetachItem(null)} titleId={detachId} title="Detach item"
      closeLabel="Cancel detach" embeddedFallback={{ scrollOwnerRef: scroller }}>
      <button type="button" disabled={!editable} onClick={detach}>Keep snapshot and detach</button>
    </DetailPaneModal>
    <DetailPaneModal open={inspector !== null} onClose={() => setInspector(null)} titleId={inspectorId} title="Reference"
      closeLabel="Close reference" embeddedFallback={{ scrollOwnerRef: scroller }}>
      {inspector && <ReferenceDetailContent target={inspector} />}
    </DetailPaneModal>
    {standing.composer}
  </div>;
}

function sectionTitle({ block }: SpaceSourceBlock) {
  return block.item_snapshot?.title || block.markdown.split(/\r\n|\r|\n/, 1)[0].replace(/^\s*#{1,6}\s+/, '').trim().slice(0, 100)
    || (block.block_type === 'todo' ? 'Todo' : 'Untitled block');
}

function readBlocks(spaceId: string, source: string): SpaceSourceBlock[] {
  try { return spaceBlocks(spaceId, source); } catch { return []; }
}

function itemReference(item: SpaceItem) {
  const raw = item.ref_uri || item.ref_id;
  const ref = isResourceRef(raw) ? raw : `${item.ref_type}:${raw}`;
  return `[${ref}]`;
}

function SpaceDirective({ directive, span, editable, onEditBody, onTodo, onDetach, onInspect }: {
  directive: MarkdownDirective; span: SpaceSourceBlock; editable: boolean; onEditBody(): void; onTodo(markdown: string): void; onDetach(): void; onInspect(ref: string): void;
}) {
  const { block } = span;
  const snapshot = block.item_snapshot;
  const ref = snapshot?.ref_uri ?? (snapshot?.ref_type && snapshot.ref_id ? `${snapshot.ref_type}:${snapshot.ref_id}` : null);
  const legacyBlob = ref && /^artifact:sha256:([a-f0-9]{64})$/i.exec(ref)?.[1];
  const parsed = ref ? parseResourceRef(legacyBlob ? `artifact-blob:${legacyBlob}` : ref) : null;
  const href = parsed && parsed.kind !== 'unknown' ? resourceRefHref(parsed.canonical) : undefined;
  const caption = snapshot?.title || ref || snapshot?.item_id || directive.name;
  if (block.block_type === 'todo') {
    const marker = /^(\s*[-*+]\s+\[)([xX ])(\])/.exec(block.markdown);
    const checked = marker?.[2]?.toLowerCase() === 'x';
    const text = marker ? block.markdown.slice(marker[0].length) : block.markdown;
    return <div className="space-document__todo">
      <input type="checkbox" aria-label={text.trim() || 'Todo'} checked={checked} disabled={!editable}
        onChange={event => onTodo(marker
          ? marker[1] + (event.currentTarget.checked ? 'x' : ' ') + marker[3] + text
          : '- [' + (event.currentTarget.checked ? 'x' : ' ') + '] ' + text)} />
      <button type="button" className="btn btn--ghost btn--sm" onClick={onEditBody}>{text.trim() || 'Todo'}</button>
    </div>;
  }
  return <figure className="space-document__embed">
    <figcaption>
      {href?.startsWith('/') && parsed ? <a href={href} onClick={event => {
        if (event.metaKey || event.ctrlKey || (parsed.kind !== 'artifact' && parsed.kind !== 'issue')) return;
        event.preventDefault();
        onInspect(parsed.canonical);
      }}>{caption}</a> : caption}
      {block.item_id && editable && <button type="button" className="btn btn--ghost btn--sm" {...appTip('Detach item')}
        aria-label="Detach item" onClick={onDetach}><Icon name="dismiss" /></button>}
      {editable && <button type="button" className="btn btn--ghost btn--sm" {...appTip('Edit Markdown')} aria-label="Edit embed Markdown"
        onClick={onEditBody}><Icon name="editAnnotation" /></button>}
    </figcaption>
    {block.markdown && <MarkdownDocument ariaLabel={`${caption} fallback`} value={block.markdown} readOnly />}
  </figure>;
}
