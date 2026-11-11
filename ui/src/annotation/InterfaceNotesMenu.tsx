import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  interfaceNoteAttachment,
  interfaceNotePagePath,
  type InterfaceNote,
  type InterfaceNoteDestination,
} from '../../../src/interface-notes/contract';
import type { IssueRepoSummary } from '../../../src/types';
import { getLedgerIssueInitialDetailByIssueId } from '../api';
import { getSelectedWritableChatTarget, getWritableChatTarget, highlightDraftAttachments } from '../chat/attachmentDrafts';
import { appTip } from '../components/shared/AppHoverTips';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { useAnchoredMenu, type AnchoredMenuPlacement } from '../hooks/useAnchoredMenu';
import { navigateTo, viewHref } from '../routing';
import { stageAnnotationAttachments } from './agentationAdapter';
import { fileInterfaceNotes, InterfaceNotesApiError, listIssuesWithInterfaceNotes } from './interfaceNotesApi';
import { getInterfaceNotesSnapshot, markFiled, reconcile, setLoadedIssue, useInterfaceNotes } from './interfaceNotesStore';
import './InterfaceNotesMenu.css';

/**
 * The Send menu: files every unfiled note in the app onto an issue, or stages
 * them to the selected Chat. One menu is open at a time, opened by the toolbar's
 * Send (whose promise the menu settles) or by the rail control's context menu.
 */

type MenuRequest = {
  key: number;
  anchor: HTMLElement;
  placement: AnchoredMenuPlacement;
  /** The rail control's menu also offers to unload the loaded issue. */
  offersUnload: boolean;
  resolve(): void;
  reject(error: Error): void;
};

type RecentIssue = { ref: string; id: string; title: string };

let request: MenuRequest | null = null;
let nextKey = 0;
const listeners = new Set<() => void>();

function settle(outcome: { ok: true } | { ok: false; error: string }): void {
  const settled = request;
  request = null;
  listeners.forEach((listener) => listener());
  if (!settled) return;
  if (outcome.ok) settled.resolve();
  else settled.reject(new Error(outcome.error));
}

function open(next: Omit<MenuRequest, 'key'>): void {
  settle({ ok: false, error: 'Another menu replaced this one.' });
  request = { ...next, key: (nextKey += 1) };
  listeners.forEach((listener) => listener());
}

const SEND_BUTTON = 'button[aria-label="Send Annotations"]';

/** The toolbar's `onSubmit`: resolves when the notes are filed or staged, rejects when the menu is dismissed. */
export function openInterfaceNotesMenuFromSend(): Promise<void> {
  const anchor = document.querySelector('agentation-toolbar')?.shadowRoot?.querySelector<HTMLElement>(SEND_BUTTON);
  if (!anchor) return Promise.reject(new Error('The toolbar has no Send button to anchor the menu to.'));
  return new Promise((resolve, reject) => open({ anchor, placement: 'top-end', offersUnload: false, resolve, reject }));
}

export function openInterfaceNotesMenuAt(anchor: HTMLElement): void {
  open({ anchor, placement: 'top-start', offersUnload: true, resolve: () => undefined, reject: () => undefined });
}

function useMenuRequest(): MenuRequest | null {
  const [current, setCurrent] = useState(request);
  useEffect(() => {
    setCurrent(request);
    const listener = () => setCurrent(request);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return current;
}

function recentIssues(repos: readonly IssueRepoSummary[]): RecentIssue[] {
  return repos
    .flatMap((repo) => repo.issues.map((issue) => ({
      ref: repo.project_key ? `${repo.project_key}/${issue.id}` : issue.id,
      id: issue.id,
      title: issue.title,
      lastAt: issue.interface_notes?.last_at ?? 0,
    })))
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(({ lastAt: _lastAt, ...issue }) => issue);
}

/** Page, then creation order: the order Chat staging delivers notes in. */
function chatOrder(notes: readonly InterfaceNote[]): InterfaceNote[] {
  return [...notes].sort((a, b) => (
    interfaceNotePagePath(a).localeCompare(interfaceNotePagePath(b)) || a.created_at - b.created_at
  ));
}

function newIssueTitle(notes: readonly InterfaceNote[]): string {
  const line = notes[0]?.text.split('\n').find((text) => text.trim()) ?? '';
  return line.trim().slice(0, 120);
}

const FILING_REFUSALS: Partial<Record<string, string>> = {
  nothing_to_file: 'These notes were filed or deleted elsewhere.',
  receiving_project_unset: 'Choose the project for interface notes in Settings.',
  issue_not_found: 'That issue no longer exists.',
};

function filingError(error: unknown): string {
  if (error instanceof InterfaceNotesApiError && error.code && FILING_REFUSALS[error.code]) return FILING_REFUSALS[error.code]!;
  return error instanceof Error ? error.message : String(error);
}

function focusItem(menu: HTMLElement | null, step: number | 'first'): void {
  const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
  if (!items.length) return;
  const index = step === 'first' ? 0 : items.indexOf(document.activeElement as HTMLElement) + step;
  items[(index + items.length) % items.length]?.focus({ preventScroll: true });
}

function IssueLabel({ id, title }: { id: string; title: string }): JSX.Element {
  return (
    <>
      <span className="interface-notes-menu__issue-id">{id}</span>
      {title ? <span className="interface-notes-menu__issue-title">{title}</span> : null}
    </>
  );
}

export function InterfaceNotesMenu({ receivingProject }: { receivingProject: string | null }): JSX.Element | null {
  const current = useMenuRequest();
  return current ? <OpenMenu key={current.key} request={current} receivingProject={receivingProject} /> : null;
}

function OpenMenu({ request: opened, receivingProject }: { request: MenuRequest; receivingProject: string | null }): JSX.Element {
  const { unfiled, loadedIssue } = useInterfaceNotes();
  const anchorRef = useMemo(() => ({ current: opened.anchor }), [opened]);
  const menuRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentIssue[]>([]);
  const [loadedDetail, setLoadedDetail] = useState<{ ref: string; id: string; title: string } | null>(null);
  const dismiss = () => settle({ ok: false, error: 'Nothing was sent.' });
  const style = useAnchoredMenu({
    open: true,
    anchorRef,
    menuRef,
    onDismiss: dismiss,
    onEscape: title === null ? undefined : () => setTitle(null),
    placement: opened.placement,
  });
  const visible = style?.visibility === 'visible';

  useEffect(() => {
    if (!receivingProject) return undefined;
    let live = true;
    listIssuesWithInterfaceNotes(receivingProject)
      .then((repos) => { if (live) setRecent(recentIssues(repos)); })
      .catch((reason: unknown) => { if (live) setError(filingError(reason)); });
    return () => { live = false; };
  }, [receivingProject]);

  const loadedId = loadedIssue?.id ?? null;
  useEffect(() => {
    if (!loadedId) return undefined;
    let live = true;
    // Without the title the loaded issue is still offered under its ref.
    getLedgerIssueInitialDetailByIssueId(loadedId)
      .then((detail) => { if (live) setLoadedDetail({ ref: loadedId, id: detail.display_id, title: detail.title }); })
      .catch((reason: unknown) => console.error('Loading the loaded issue’s title failed.', reason));
    return () => { live = false; };
  }, [loadedId]);

  useLayoutEffect(() => {
    if (!visible) return;
    if (title === null) focusItem(menuRef.current, 'first');
    else {
      titleRef.current?.focus({ preventScroll: true });
      titleRef.current?.select();
    }
  }, [visible, title === null]);

  const file = async (destination: InterfaceNoteDestination) => {
    const ids = unfiled.map((note) => note.id);
    setBusy(true);
    setError(null);
    // Notes made just now may still be pending creates; they land before filing names them.
    await reconcile();
    try {
      const result = await fileInterfaceNotes({ note_ids: ids, destination });
      markFiled(result.filed);
      settle({ ok: true });
      void reconcile();
    } catch (reason) {
      if (reason instanceof InterfaceNotesApiError && reason.code === 'nothing_to_file') void reconcile();
      setError(filingError(reason));
      setBusy(false);
    }
  };

  const chatTarget = getSelectedWritableChatTarget();
  const stageToChat = () => {
    const staged = stageAnnotationAttachments(chatOrder(getInterfaceNotesSnapshot().unfiled)
      .map((note, index) => interfaceNoteAttachment(note, index + 1)));
    if (!staged.ok) {
      setError(staged.error);
      return;
    }
    highlightDraftAttachments(staged.value.target, staged.value.addedIds);
    settle({ ok: true });
    // Opening a conversation reloads it, so a Chat that is already showing is left as it is.
    if (getWritableChatTarget() !== staged.value.target) navigateTo(viewHref('console', { conversation: staged.value.target }));
  };

  const unload = () => {
    settle({ ok: true });
    void setLoadedIssue(null);
  };

  const inert = busy || unfiled.length === 0;
  const loaded = loadedId
    ? (loadedDetail?.ref === loadedId ? loadedDetail : recent.find((issue) => issue.ref === loadedId) ?? { ref: loadedId, id: loadedId, title: '' })
    : null;
  const recentShown = recent.filter((issue) => issue.ref !== loadedId && issue.id !== loaded?.id);
  const count = `${unfiled.length} ${unfiled.length === 1 ? 'note' : 'notes'}`;

  return (
    <div
      ref={menuRef}
      className="interface-notes-menu app-anchored-menu"
      role="menu"
      aria-label={`Send ${count}`}
      popover="manual"
      style={style}
      data-feedback-toolbar
      onKeyDown={(event) => {
        if (title !== null || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
        event.preventDefault();
        focusItem(menuRef.current, event.key === 'ArrowDown' ? 1 : -1);
      }}
    >
      <div className="interface-notes-menu__count">{count}</div>
      {error ? <DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice> : null}
      {title !== null ? (
        <form
          className="interface-notes-menu__title"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && !inert) void file({ new_issue: { title: title.trim() } });
          }}
        >
          <input
            ref={titleRef}
            className="interface-notes-menu__title-input"
            aria-label="New issue title"
            value={title}
            disabled={busy}
            onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
          />
        </form>
      ) : (
        <>
          {receivingProject && loaded ? (
            <button type="button" role="menuitem" className="interface-notes-menu__item" disabled={inert}
              onClick={() => void file({ issue: loaded.ref })}>
              <IssueLabel id={loaded.id} title={loaded.title} />
            </button>
          ) : null}
          {receivingProject ? (
            <button type="button" role="menuitem" className="interface-notes-menu__item" disabled={inert}
              onClick={() => setTitle(newIssueTitle(unfiled))}>
              New issue
            </button>
          ) : null}
          {receivingProject ? recentShown.map((issue) => (
            <button key={issue.ref} type="button" role="menuitem" className="interface-notes-menu__item" disabled={inert}
              onClick={() => void file({ issue: issue.ref })}>
              <IssueLabel id={issue.id} title={issue.title} />
            </button>
          )) : null}
          {receivingProject ? <div role="separator" className="interface-notes-menu__separator" /> : null}
          <button type="button" role="menuitem" className="interface-notes-menu__item" disabled={inert || !chatTarget}
            {...(chatTarget ? {} : appTip('Select a writable Chat first'))}
            onClick={stageToChat}>
            Chat
          </button>
          {opened.offersUnload && loadedId ? (
            <>
              <div role="separator" className="interface-notes-menu__separator" />
              <button type="button" role="menuitem" className="interface-notes-menu__item" disabled={busy} onClick={unload}>
                Hide pins
              </button>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
