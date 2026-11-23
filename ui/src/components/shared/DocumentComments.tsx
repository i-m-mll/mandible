import { type ComponentChildren, type RefObject } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ArrowUp, Check, History, Link, MessageSquare, Pencil, Trash2, UserRound } from 'lucide-preact';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { formatRelativeTime } from '../../lib/format';
import type { MarkdownDocumentHandle, MarkdownSourceRange } from '../MarkdownDocument';
import { appTip } from './AppHoverTips';
import { ContextualAction } from './ContextualAction';
import { DetailPaneNotice } from './DetailPaneNotice';
import { OfficialProviderMark, type OfficialProviderMarkKind } from './OfficialProviderMark';
import { SidebarItemRow } from './SidebarItemRow';
import { SidebarSearchFilterHeader } from './SidebarSearchFilterHeader';
import '../../styles/review-comments.css';

type CommentMessage = {
  body: ComponentChildren;
  author: string | null;
  createdAt?: number;
  provider?: OfficialProviderMarkKind;
};

type CommentWrite = (body: string) => Promise<void>;
type ThreadAction = () => void | Promise<void>;

export type DocumentCommentThread = CommentMessage & {
  id: string;
  quote: string;
  range: MarkdownSourceRange | null;
  draft?: boolean;
  resolved?: boolean;
  replies?: readonly (CommentMessage & { id: string })[];
  onReply?: CommentWrite;
  onResolve?: ThreadAction;
  onReopen?: ThreadAction;
  onDelete?: ThreadAction;
  onEdit?: CommentWrite;
};

export type DocumentCommentSelection = {
  range: MarkdownSourceRange;
  onComment?: CommentWrite;
  onEdit?: () => void;
  onCopyLink?: () => void | Promise<void>;
};

export function useDocumentComments(scopeKey: string, drawerState?: {
  open: boolean;
  setOpen(open: boolean): void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const drawerId = useId();
  const [open, setOpen] = usePersistedViewState(`document-comments:${scopeKey}`, value => value === true, false);
  const [active, setActive] = useState<{ scopeKey: string; id: string | null }>({ scopeKey, id: null });
  const [hover, setHover] = useState<{ scopeKey: string; id: string | null }>({ scopeKey, id: null });

  return {
    anchor, drawerId, scopeKey,
    open: drawerState?.open ?? open,
    setOpen: drawerState?.setOpen ?? setOpen,
    selected: active.scopeKey === scopeKey ? active.id : null,
    select: (id: string | null) => setActive({ scopeKey, id }),
    hovered: hover.scopeKey === scopeKey ? hover.id : null,
    hover: (id: string | null) => setHover(old => old.id === id && old.scopeKey === scopeKey ? old : { scopeKey, id }),
  };
}

type CommentController = ReturnType<typeof useDocumentComments>;

export function DocumentCommentsButton({ controller, count }: { controller: CommentController; count: number }) {
  return <button type="button" ref={controller.anchor} className="detail-pane-menu-trigger document-comments-button"
    aria-label={count ? `Comments (${count})` : 'Comments'} aria-expanded={controller.open}
    aria-controls={controller.open ? controller.drawerId : undefined} aria-haspopup="dialog" {...appTip('Comments')}
    onClick={() => controller.setOpen(!controller.open)}>
    <MessageSquare className="app-icon" aria-hidden="true" />
    {count > 0 && <span aria-hidden="true" className="sidebar-search-filter__badge">{count}</span>}
  </button>;
}

export function DocumentCommentsDrawer({ controller, threads, onNavigate }: {
  controller: CommentController;
  threads: readonly DocumentCommentThread[];
  onNavigate(thread: DocumentCommentThread): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: ThreadAction) => {
    setError(null);
    void Promise.resolve().then(action).catch(failure => setError(
      failure instanceof Error ? failure.message : String(failure),
    ));
  };
  const style = useAnchoredMenu({
    open: controller.open, anchorRef: controller.anchor, menuRef: menu, onDismiss: () => controller.setOpen(false),
  });

  if (!controller.open) return null;
  const needle = search.trim().toLocaleLowerCase();
  const items = threads.filter(thread => (showResolved || !thread.resolved)
    && (!needle || [thread.quote, thread.author, typeof thread.body === 'string' ? thread.body : '',
      ...thread.replies?.map(reply => typeof reply.body === 'string' ? reply.body : '') ?? []]
      .some(value => value?.toLocaleLowerCase().includes(needle))))
    .sort((first, next) => (first.range?.start ?? Infinity) - (next.range?.start ?? Infinity));
  const row = (thread: DocumentCommentThread) => {
    const label = typeof thread.body === 'string' ? thread.body : thread.quote;
    return <SidebarItemRow key={thread.id} label={label} selectionLabel={label} selected={controller.selected === thread.id}
      className={thread.range ? undefined : 'document-comments__detached'}
      leading={<CommentAuthor message={thread} />}
      detail={thread.range ? undefined : <s>{thread.quote}</s>}
      actions={<>
        {thread.onReopen && <CommentAction label="Reopen" icon={History} onClick={() => run(thread.onReopen!)} />}
        {!thread.range && thread.onResolve && <CommentAction label="Resolve" icon={Check} onClick={() => run(thread.onResolve!)} />}
        {!thread.range && thread.onDelete && <CommentAction label="Delete" icon={Trash2} onClick={() => run(thread.onDelete!)} />}
      </>}
      onSelect={() => {
        controller.select(thread.id);
        if (!thread.range) return;
        controller.setOpen(false);
        onNavigate(thread);
      }} />;
  };
  const detached = items.filter(thread => !thread.range);
  return <div ref={menu} id={controller.drawerId} role="dialog" aria-label="Comments" popover="manual" style={style}
    className="sidebar-search-filter__panel sidebar-search-filter__panel--popover app-anchored-menu document-comments__drawer">
    <SidebarSearchFilterHeader value={search} onValueChange={setSearch} placeholder="Search comments" searchAriaLabel="Search comments"
      clearAriaLabel="Clear search" captureFindShortcut={false} actions={[
        { icon: 'menuSelected', label: 'Show resolved', tip: 'Show resolved', disabled: false, busy: false,
          pressed: showResolved, onClick: () => setShowResolved(!showResolved) },
        { icon: 'dismiss', label: 'Close', tip: 'Close', disabled: false, busy: false,
          onClick: () => controller.setOpen(false) },
      ]} />
    {error && <DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice>}
    {items.filter(thread => thread.range).map(row)}
    {detached.length > 0 && <div className="sidebar-search-filter__section">
      <div className="sidebar-search-filter__label">Text no longer present</div>
      {detached.map(row)}
    </div>}
  </div>;
}

function CommentAuthor({ message }: { message: CommentMessage }) {
  return <span className="document-comment__author" aria-label={message.author ?? undefined}
    {...(message.author ? appTip(message.author) : {})}>
    {message.provider ? <OfficialProviderMark kind={message.provider} className="app-icon" />
      : message.author ? message.author.trim().charAt(0).toLocaleUpperCase()
      : <UserRound className="app-icon" aria-hidden="true" />}
  </span>;
}

function CommentAction({ label, icon: Glyph, onClick }: {
  label: string; icon: typeof MessageSquare; onClick: () => void;
}) {
  return <ContextualAction presentation="compact" aria-label={label} {...appTip(label)} onClick={onClick}>
    <Glyph className="app-icon" aria-hidden="true" />
  </ContextualAction>;
}

function CommentInput({ initial = '', label, autoFocus, onSend, onCancel }: {
  initial?: string;
  label: string;
  autoFocus?: boolean;
  onSend: CommentWrite;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || globalThis.CSS?.supports('field-sizing', 'content')) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  const send = async () => {
    if (pending || !value.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onSend(value.trim());
      setValue('');
      onCancel();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  return <form className="document-comment__composer" onSubmit={event => { event.preventDefault(); void send(); }}>
    <div className="document-comment__input-row">
      <textarea ref={input} rows={1} aria-label={label} placeholder={label} value={value} disabled={pending}
        onInput={event => setValue(event.currentTarget.value)} onKeyDown={event => {
          if (event.isComposing) return;
          if (event.key === 'Escape' && !pending) {
            event.stopPropagation();
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }} />
      <button type="submit" className="chat-circle-action document-comment__send" aria-label="Send" {...appTip('Send')}
        disabled={pending || !value.trim()}><ArrowUp className="app-icon" aria-hidden="true" /></button>
    </div>
    {error && <DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice>}
  </form>;
}

function ThreadCard({ controller, thread }: { controller: CommentController; thread: DocumentCommentThread }) {
  const [reply, setReply] = useState(false);
  const [edit, setEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  function act(action: ThreadAction) {
    if (busy) return;
    setError(null);
    setBusy(true);
    void Promise.resolve().then(action).catch(failure => setError(
      failure instanceof Error ? failure.message : String(failure),
    )).finally(() => setBusy(false));
  }
  const message = (entry: CommentMessage) => <>
    <div className="document-comment__meta">
      <CommentAuthor message={entry} />
      {entry.createdAt !== undefined && <time dateTime={new Date(entry.createdAt).toISOString()}>
        {formatRelativeTime(entry.createdAt, { style: 'recent' })}
      </time>}
    </div>
    <div className="document-comment__body">{entry.body}</div>
  </>;
  return <article className="sidebar-item-row document-comment contextual-action-owner"
    data-selected={controller.selected === thread.id} data-hovered={controller.hovered === thread.id}
    data-draft={Boolean(thread.draft)} aria-label="Comment thread" tabIndex={0}
    onPointerEnter={() => controller.hover(thread.id)} onPointerLeave={() => controller.hover(null)}>
    <div className="document-comment__actions contextual-action-group">
      {thread.onEdit && typeof thread.body === 'string' && <CommentAction label="Edit" icon={Pencil} onClick={() => setEdit(true)} />}
      {thread.onResolve && <CommentAction label="Resolve" icon={Check} onClick={() => act(thread.onResolve!)} />}
      {thread.onDelete && <CommentAction label="Delete" icon={Trash2} onClick={() => act(thread.onDelete!)} />}
    </div>
    {edit && thread.onEdit && typeof thread.body === 'string'
      ? <CommentInput initial={thread.body} label="Add a comment…" autoFocus onSend={thread.onEdit} onCancel={() => setEdit(false)} />
      : message(thread)}
    {thread.replies?.map(entry => <div key={entry.id} className="document-comment__reply">{message(entry)}</div>)}
    {thread.onReply && (reply
      ? <CommentInput label="Reply…" autoFocus onSend={thread.onReply} onCancel={() => setReply(false)} />
      : <button type="button" className="document-comment__reply-trigger" onClick={() => setReply(true)}
          onFocus={() => setReply(true)}>Reply…</button>)}
    {error && <DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice>}
  </article>;
}

type Geometry = { localY: number; left: number; top: number; bottom: number; paneLeft: number; paneRight: number };
type Composer = { range: MarkdownSourceRange; send: CommentWrite };

export function DocumentCommentSurface({ controller, threads, selection, documentRef, drawer = true,
  children, navigationKey, position, onNavigate, gutterSelection }: {
  controller: CommentController;
  threads: readonly DocumentCommentThread[];
  selection: DocumentCommentSelection | null;
  gutterSelection?: { range: MarkdownSourceRange; send: CommentWrite };
  documentRef?: RefObject<MarkdownDocumentHandle>;
  position?: (range: MarkdownSourceRange, id?: string) => DOMRect | null;
  drawer?: boolean;
  navigationKey?: string;
  onNavigate?: (range: MarkdownSourceRange) => void;
  children: ComponentChildren;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const documentContent = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Record<string, Geometry>>({});
  const refreshGeometry = useRef<() => void>();
  const [composer, setComposer] = useState<Composer | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const shown = threads.filter(thread => thread.range && !thread.resolved);
  const activeThread = shown.find(item => item.id === controller.selected);
  const activeRange = activeThread?.range;
  const selectionMatchesThread = selection?.range.start === activeRange?.start && selection?.range.end === activeRange?.end;
  const liveSelection = selection && selection.range.start < selection.range.end && !composer && !selectionMatchesThread
    ? selection : null;
  const previousScope = useRef(controller.scopeKey);
  useLayoutEffect(() => {
    const document = documentRef?.current;
    if (!composer || !document) return;
    document.previewComment?.(composer.range);
    return () => document.previewComment?.(null);
  }, [composer, documentRef]);
  useLayoutEffect(() => {
    if (gutterSelection) setComposer(gutterSelection);
  }, [gutterSelection]);
  const latest = useRef({ shown, liveSelection, composer, position, documentRef });
  latest.current = { shown, liveSelection, composer, position, documentRef };

  useLayoutEffect(() => {
    if (previousScope.current === controller.scopeKey) return;
    previousScope.current = controller.scopeKey;
    setComposer(null);
    setContextMenu(null);
    setPanelError(null);
  }, [controller.scopeKey]);

  function navigate(range: MarkdownSourceRange, focus = false) {
    if (onNavigate) onNavigate(range);
    else documentRef?.current?.reveal(range, focus);
  }

  useLayoutEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1)).get('comment-range');
    if (!fragment || !navigationKey) return;
    const match = /^(.*):(\d+):(\d+)$/.exec(fragment);
    if (!match || match[1] !== navigationKey) return;
    const start = Number(match[2]), end = Number(match[3]);
    if (end > start) {
      navigate({ start, end }, true);
      documentRef?.current?.select({ start, end });
    }
  }, [navigationKey]);

  useLayoutEffect(() => {
    const outer = surface.current;
    const content = documentContent.current;
    if (!outer || !content) return;
    let previous = '';
    let frame = 0;
    const positionOverlays = () => {
      const next: Record<string, Geometry> = {};
      const origin = outer.getBoundingClientRect();
      const { shown, liveSelection, composer, position, documentRef } = latest.current;
      const measure = (key: string, range: MarkdownSourceRange, id?: string) => {
        const rect = position?.(range, id) ?? documentRef?.current?.bounds(range);
        if (!rect) return;
        next[key] = { localY: rect.top - origin.top, left: (rect.left + rect.right) / 2, top: rect.top, bottom: rect.bottom,
          paneLeft: origin.left, paneRight: origin.right };
      };
      for (const thread of shown) if (thread.range) measure(thread.id, thread.range, thread.id);
      if (liveSelection) measure('selection', liveSelection.range);
      if (composer) measure('composer', composer.range);
      const serialized = JSON.stringify(next);
      if (serialized !== previous) { previous = serialized; setGeometry(next); }
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; positionOverlays(); });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(content);
    observer?.observe(outer);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const endDrag = () => { setSelecting(false); schedule(); };
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
    refreshGeometry.current = schedule;
    positionOverlays();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pointerup', endDrag, true);
      window.removeEventListener('pointercancel', endDrag, true);
      refreshGeometry.current = undefined;
    };
  }, [controller.scopeKey]);

  useLayoutEffect(() => refreshGeometry.current?.());

  useLayoutEffect(() => {
    const content = documentContent.current;
    if (!content) return;
    const mark = () => {
      for (const element of content.querySelectorAll<HTMLElement>('[data-markdown-range-id]')) {
        if (element.closest('.document-comment-surface__text') !== content) continue;
        const id = element.dataset.markdownRangeId;
        element.toggleAttribute('data-comment-active', id === controller.selected || id === controller.hovered);
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(content, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [controller.selected, controller.hovered]);

  const hoveredId = (target: EventTarget | null) => {
    if (!(target instanceof Element) || target.closest('.document-comment-surface__text') !== documentContent.current) return null;
    return target.closest<HTMLElement>('[data-markdown-range-id]')?.dataset.markdownRangeId ?? null;
  };
  const navigation = (thread: DocumentCommentThread) => {
    if (!thread.range) return;
    navigate(thread.range);
  };
  const copy = async () => {
    if (!liveSelection) return;
    try {
      if (liveSelection.onCopyLink) await liveSelection.onCopyLink();
      else {
        const url = new URL(window.location.href);
        url.hash = new URLSearchParams({
          'comment-range': `${navigationKey}:${liveSelection.range.start}:${liveSelection.range.end}`,
        }).toString();
        await navigator.clipboard.writeText(url.href);
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    }
    setContextMenu(null);
  };
  const actions = liveSelection && <>
    {liveSelection.onComment && <CommentAction label="Comment" icon={MessageSquare} onClick={() => {
      setComposer({ range: liveSelection.range, send: liveSelection.onComment! });
      setContextMenu(null);
      setPanelError(null);
    }} />}
    {liveSelection.onEdit && <CommentAction label="Edit" icon={Pencil} onClick={() => {
      liveSelection.onEdit?.(); setContextMenu(null);
    }} />}
    {(navigationKey || liveSelection.onCopyLink) && <CommentAction label="Copy link" icon={Link} onClick={() => void copy()} />}
  </>;
  const ordered = shown.filter(thread => geometry[thread.id]).sort((a, b) => geometry[a.id].localY - geometry[b.id].localY);
  const [footprints, setFootprints] = useState<Record<string, number>>({});
  const margin = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!margin.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => setFootprints(old => {
      const next = { ...old };
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.thread;
        if (id) next[id] = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      }
      return next;
    }));
    for (const element of margin.current.children) observer.observe(element);
    return () => observer.disconnect();
  }, [ordered.map(thread => thread.id).join()]);
  let lowerEdge = 0;

  const band = geometry.selection;
  const compose = geometry.composer;
  const popup = activeThread && geometry[activeThread.id];
  return <div className="document-comment-surface" ref={surface}>
    <div className="document-comment-surface__layout">
      <div className="document-comment-surface__text" ref={documentContent}
        onPointerDown={event => {
          if (event.button === 0 && event.target instanceof Element
            && event.target.closest('.document-comment-surface__text') === documentContent.current) {
            setSelecting(true);
            setContextMenu(null);
            if (!hoveredId(event.target)) controller.select(null);
          }
        }}
        onPointerOver={event => {
          const id = hoveredId(event.target);
          if (id) controller.hover(id);
        }}
        onPointerOut={event => {
          const id = hoveredId(event.target);
          if (id && id !== hoveredId(event.relatedTarget)) controller.hover(null);
        }}
        onContextMenu={event => {
          if (!liveSelection || !(event.target instanceof Element)
            || event.target.closest('.document-comment-surface__text') !== documentContent.current) return;
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}>{children}</div>
      {ordered.length > 0 && <div className="document-comments__margin" ref={margin}>
        {ordered.map(thread => {
          const top = Math.max(geometry[thread.id].localY, lowerEdge);
          const gap = top - lowerEdge;
          lowerEdge = top + (footprints[thread.id] ?? 0);
          return <div key={thread.id} data-thread={thread.id} style={{ marginBlockStart: gap }}>
            <ThreadCard controller={controller} thread={thread} />
          </div>;
        })}
      </div>}
      {composer && compose && <div className="sidebar-search-filter__panel sidebar-search-filter__panel--popover document-comments__popover document-comments__composer"
        style={{ '--comment-x': `${compose.left}px`, '--comment-y': `${compose.bottom}px`, '--comment-local-y': `${compose.localY}px`,
          '--comment-pane-left': `${compose.paneLeft}px`, '--comment-pane-right': `${compose.paneRight}px` }}>
        <CommentInput label="Add a comment…" autoFocus onSend={composer.send} onCancel={() => setComposer(null)} />
      </div>}
    </div>
    {panelError && <DetailPaneNotice severity="error" density="compact">{panelError}</DetailPaneNotice>}
    {ordered.length > 0 && <div className="document-comments__gutter">
      {ordered.map(thread => <div key={thread.id} style={{ top: geometry[thread.id].localY }}>
        <ContextualAction presentation="compact" aria-label="Open comment" {...appTip('Comment')}
          aria-pressed={controller.selected === thread.id}
          onPointerEnter={() => controller.hover(thread.id)} onPointerLeave={() => controller.hover(null)}
          onClick={() => controller.select(controller.selected === thread.id ? null : thread.id)}>
          <MessageSquare className="app-icon" aria-hidden="true" />
        </ContextualAction>
      </div>)}
    </div>}
    {liveSelection && !selecting && band && <div className="sidebar-search-filter__panel sidebar-search-filter__panel--popover document-comments__popover document-comments__rail"
      role={contextMenu ? 'group' : 'toolbar'} aria-label="Selection actions"
      data-context-menu={Boolean(contextMenu)}
      style={{ left: contextMenu?.x ?? band.left, top: contextMenu?.y ?? band.top }}
      onPointerDown={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setContextMenu(null);
          documentRef?.current?.select({ start: liveSelection.range.end, end: liveSelection.range.end });
        }
      }}>{actions}</div>}
    {activeThread && popup && !composer && <div className="sidebar-search-filter__panel sidebar-search-filter__panel--popover document-comments__popover document-comments__thread-popover"
      style={{ '--comment-x': `${popup.left}px`, '--comment-y': `${popup.bottom}px`,
        '--comment-pane-left': `${popup.paneLeft}px`, '--comment-pane-right': `${popup.paneRight}px` }}>
      <ThreadCard key={activeThread.id} controller={controller} thread={activeThread} />
    </div>}
    {drawer && <DocumentCommentsDrawer key={controller.scopeKey} controller={controller} threads={threads} onNavigate={navigation} />}
  </div>;
}
