import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  interfaceNotePagePath,
  type InterfaceNote,
  type InterfaceNoteDestination,
  type InterfaceNoteIssue,
} from '../../../src/interface-notes/contract';
import { appTip } from '../components/shared/AppHoverTips';
import { useAnchoredMenu, type AnchoredMenuPlacement } from '../hooks/useAnchoredMenu';
import { InterfaceNotesApiError, type InterfaceNotesTransport } from './notesTransport';
import { getInterfaceNotesSnapshot, markFiled, reconcile, setLoadedIssue, useInterfaceNotes } from './interfaceNotesStore';
import './InterfaceNotesMenu.css';

/**
 * The Send menu: files every unfiled note of the app onto an issue, or, in
 * Mandible, stages them to the selected Chat. One menu is open at a time, opened
 * by the toolbar's Send (whose promise the menu settles) or by the rail control's
 * context menu.
 */

export type InterfaceNotesMenuPorts = {
  transport: InterfaceNotesTransport;
  /** How a refusal is shown. */
  Notice(props: { children: string }): JSX.Element | null;
  /** Mandible only: the Chat destination. */
  chat?: {
    /** The selected writable Chat, or null when there is none. */
    target(): string | null;
    /** Stages the notes, in this order, on the selected Chat's draft and shows it; returns a refusal message or null. */
    stage(notes: readonly InterfaceNote[]): string | null;
  };
  /** Mandible only: the display id and title of the loaded issue. */
  issueTitle?(issueRef: string): Promise<{ id: string; title: string }>;
};

type MenuRequest = {
  key: number;
  anchor: HTMLElement;
  placement: AnchoredMenuPlacement;
  /** The rail control's menu also offers to unload the loaded issue. */
  offersUnload: boolean;
  resolve(): void;
  reject(error: Error): void;
};

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

const NO_RECEIVING_PROJECT = 'This app’s repository is not a registered project';

const FILING_REFUSALS: Partial<Record<string, string>> = {
  nothing_to_file: 'These notes were filed or deleted elsewhere.',
  no_receiving_project: NO_RECEIVING_PROJECT,
  issue_not_found: 'That issue no longer exists.',
};

function filingError(error: unknown): string {
  if (error instanceof InterfaceNotesApiError && error.code && FILING_REFUSALS[error.code]) return FILING_REFUSALS[error.code]!;
  return error instanceof Error ? error.message : String(error);
}

function focusItem(menu: HTMLElement | null, step: number | 'first'): void {
  const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
  if (!menu || !items.length) return;
  // In the embed the menu lives in a shadow root, whose focused element the document does not expose.
  const focused = (menu.getRootNode() as Document | ShadowRoot).activeElement;
  const index = step === 'first' ? 0 : items.indexOf(focused as HTMLElement) + step;
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

export function InterfaceNotesMenu({ ports }: { ports: InterfaceNotesMenuPorts }): JSX.Element | null {
  const current = useMenuRequest();
  return current ? <OpenMenu key={current.key} request={current} ports={ports} /> : null;
}

function OpenMenu({ request: opened, ports }: { request: MenuRequest; ports: InterfaceNotesMenuPorts }): JSX.Element {
  const { transport, Notice, chat, issueTitle } = ports;
  const { unfiled, loadedIssue } = useInterfaceNotes();
  const anchorRef = useMemo(() => ({ current: opened.anchor }), [opened]);
  const menuRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<InterfaceNoteIssue[]>([]);
  /** Unknown until the daemon answers, when New issue is offered as if there were one. */
  const [project, setProject] = useState<string | null | undefined>(undefined);
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
    let live = true;
    transport.destinations()
      .then((destinations) => {
        if (!live) return;
        setProject(destinations.project);
        setRecent(destinations.issues);
      })
      .catch((reason: unknown) => { if (live) setError(filingError(reason)); });
    return () => { live = false; };
  }, []);

  const loadedId = loadedIssue?.id ?? null;
  useEffect(() => {
    if (!loadedId || !issueTitle) return undefined;
    let live = true;
    // Without the title the loaded issue is still offered under its ref.
    issueTitle(loadedId)
      .then((detail) => { if (live) setLoadedDetail({ ref: loadedId, ...detail }); })
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
      const result = await transport.file({ note_ids: ids, destination });
      markFiled(result.filed);
      settle({ ok: true });
      void reconcile();
    } catch (reason) {
      if (reason instanceof InterfaceNotesApiError && reason.code === 'nothing_to_file') void reconcile();
      setError(filingError(reason));
      setBusy(false);
    }
  };

  const chatTarget = chat?.target() ?? null;
  const stageToChat = () => {
    const refusal = chat?.stage(chatOrder(getInterfaceNotesSnapshot().unfiled));
    if (refusal) {
      setError(refusal);
      return;
    }
    settle({ ok: true });
  };

  const unload = () => {
    settle({ ok: true });
    void setLoadedIssue(null);
  };

  const inert = busy || unfiled.length === 0;
  const unreceived = project === null;
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
      {error ? <Notice>{error}</Notice> : null}
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
          {loaded ? (
            <button type="button" role="menuitem" className="interface-notes-menu__item" disabled={inert}
              onClick={() => void file({ issue: loaded.ref })}>
              <IssueLabel id={loaded.id} title={loaded.title} />
            </button>
          ) : null}
          <button type="button" role="menuitem" className="interface-notes-menu__item" disabled={inert || unreceived}
            {...(unreceived ? appTip(NO_RECEIVING_PROJECT) : {})}
            onClick={() => setTitle(newIssueTitle(unfiled))}>
            New issue
          </button>
          {recentShown.map((issue) => (
            <button key={issue.ref} type="button" role="menuitem" className="interface-notes-menu__item" disabled={inert}
              onClick={() => void file({ issue: issue.ref })}>
              <IssueLabel id={issue.id} title={issue.title} />
            </button>
          ))}
          {chat ? <div role="separator" className="interface-notes-menu__separator" /> : null}
          {chat ? (
            <button type="button" role="menuitem" className="interface-notes-menu__item" disabled={inert || !chatTarget}
              {...(chatTarget ? {} : appTip('Select a writable Chat first'))}
              onClick={stageToChat}>
              Chat
            </button>
          ) : null}
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
