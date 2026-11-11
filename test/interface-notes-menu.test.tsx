// @vitest-environment jsdom
/**
 * The Send menu against the daemon's own interface-notes and issue routes:
 * notes from every page are filed by one choice and leave the toolbar, a later
 * note joins the same issue, dismissal files nothing, and Chat staging leaves
 * notes unfiled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Annotation } from 'agentation';
import { setDb, type Db } from '../src/db.js';
import { INTERFACE_NOTES_PROJECT_SETTING, type InterfaceNote } from '../src/interface-notes/contract.js';
import { inlineLedgerReader } from '../src/ledger-reads/index.js';
import { resolveProjectForCheckout } from '../src/ledger/projects.js';
import { registerInterfaceNoteRoutes } from '../src/routes/interface-notes.js';
import { registerIssueRoutes } from '../src/routes/issues.js';
import type { Router } from '../src/server.js';
import type { IssueRepoSummary } from '../src/types.js';
import { setupOperator } from '../src/users/store.js';
import { authenticatedTestRouter } from './helpers/authenticated-router.js';
import { cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { migratedMemoryDb } from './helpers/ledger-fixtures.js';

const daemon = vi.hoisted(() => ({ router: null as Router | null }));

vi.mock('../ui/src/client-auth-token', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  browserSessionFetch: async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, 'http://mandible.test');
    const response = await daemon.router!.invoke({
      method: init.method ?? 'GET',
      url: url.pathname + url.search,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      transport: 'http',
    }) as { status: number; body?: unknown };
    const empty = response.status === 204 || response.body === undefined;
    return new Response(empty ? null : JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  },
}));

let db: Db;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-notes-menu-'));
  db = migratedMemoryDb();
  setDb(db);
  resolveProjectForCheckout(db, { root, name: 'notes', workRepoId: 'notes', defaultBranch: 'main' });
  const repo = { id: 'notes', name: 'notes', root, exists: true, default_branch: 'main', excluded: false, user_modified: false, last_scanned_at: null };
  const router = authenticatedTestRouter(setupOperator(db, { display_name: 'Operator' }));
  registerIssueRoutes(router, { getRepos: () => [repo], getRepoById: () => repo, getBranches: () => [] } as never, undefined, inlineLedgerReader());
  registerInterfaceNoteRoutes(router, db);
  daemon.router = router;
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)').run(INTERFACE_NOTES_PROJECT_SETTING, 'notes');
  vi.resetModules();
  window.localStorage.clear();
  window.localStorage.setItem('mandible.agentation.migrated:v1', 'true');
  window.history.replaceState(null, '', '/timeline');
});

afterEach(() => {
  cleanup();
  document.querySelector('agentation-toolbar')?.remove();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const call = async <T,>(url: string): Promise<T> =>
  (await daemon.router!.invoke({ method: 'GET', url, transport: 'http' }) as { body: T }).body;
const unfiledIds = async () => (await call<{ notes: InterfaceNote[] }>('/api/interface-notes')).notes.map((note) => note.id);
const issuesWithNotes = async () => (await call<IssueRepoSummary[]>('/api/issues?repo=notes&status=open&has_notes=true'))
  .flatMap((repo) => repo.issues.map((issue) => [issue.title, issue.interface_notes?.count]));

function annotation(id: string, comment: string, page: string): Annotation {
  return { id, comment, x: 10, y: 20, element: 'button', elementPath: 'main > button', timestamp: Date.now(), url: `${window.location.origin}${page}` };
}

/** The toolbar's Send button, as the pinned package renders it inside its open shadow root. */
function toolbarSendButton(): void {
  const host = document.createElement('agentation-toolbar');
  const send = document.createElement('button');
  send.setAttribute('aria-label', 'Send Annotations');
  host.attachShadow({ mode: 'open' }).append(send);
  document.body.append(host);
}

async function mount() {
  const store = await import('../ui/src/annotation/interfaceNotesStore');
  const menu = await import('../ui/src/annotation/InterfaceNotesMenu');
  const { AgentationToggleButton } = await import('../ui/src/annotation/AgentationToggleButton');
  const drafts = await import('../ui/src/chat/attachmentDrafts');
  render(<>
    <AgentationToggleButton visible expandedRail={false} onToggle={() => undefined} />
    <menu.InterfaceNotesMenu receivingProject="notes" />
  </>);
  toolbarSendButton();
  const items = () => screen.queryAllByRole('menuitem').map((item) => item.textContent);
  return { store, menu, drafts, items, rail: screen.getByRole('button', { name: 'Hide Agentation' }) };
}

it('files notes from two pages with one Send, adds a later note to the same issue, and settles Send', async () => {
  const { store, menu, items, rail } = await mount();
  store.recordAdd(annotation('a', 'Tighten the gap', '/settings'));
  store.recordAdd(annotation('b', 'Wrong colour', '/issues'));
  await store.reconcile();
  expect(window.localStorage.getItem('feedback-annotations-/settings')).not.toBeNull();

  // From a page with no notes, through the rail control.
  fireEvent.contextMenu(rail);
  expect(await screen.findByText('2 notes')).toBeTruthy();
  expect(items()).toEqual(['New issue', 'Chat']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'New issue' }));
  const title = screen.getByRole('textbox', { name: 'New issue title' }) as HTMLInputElement;
  expect(title.value).toBe('Tighten the gap');
  fireEvent.keyDown(title, { key: 'Escape' });
  expect(items()).toEqual(['New issue', 'Chat']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'New issue' }));
  fireEvent.submit(screen.getByRole('textbox', { name: 'New issue title' }).closest('form')!);
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  await waitFor(() => expect(window.localStorage.getItem('feedback-annotations-/settings')).toBeNull());
  expect(window.localStorage.getItem('feedback-annotations-/issues')).toBeNull();
  expect(await unfiledIds()).toEqual([]);
  expect(await issuesWithNotes()).toEqual([['Tighten the gap', 2]]);

  // A later note, through the toolbar's Send: the issue that carries notes is offered first among issues.
  store.recordAdd(annotation('c', 'Missing tooltip', '/timeline'));
  const sent = menu.openInterfaceNotesMenuFromSend();
  expect(await screen.findByText('1 note')).toBeTruthy();
  const issueItem = await screen.findByRole('menuitem', { name: /Tighten the gap/ });
  expect(items()).toEqual(['New issue', issueItem.textContent, 'Chat']);
  fireEvent.click(issueItem);
  await expect(sent).resolves.toBeUndefined();
  await waitFor(async () => expect(await issuesWithNotes()).toEqual([['Tighten the gap', 3]]));
  expect(await unfiledIds()).toEqual([]);

  // A loaded issue is first and preselected; the rail's menu can unload it.
  const [{ issues: [filed] }] = await call<IssueRepoSummary[]>('/api/issues?repo=notes&status=open&has_notes=true');
  await store.setLoadedIssue(filed!.id);
  store.recordAdd(annotation('d', 'Clipped label', '/timeline'));
  fireEvent.contextMenu(rail);
  await waitFor(() => expect(document.activeElement?.textContent).toContain('Tighten the gap'));
  expect(items()).toEqual([document.activeElement?.textContent, 'New issue', 'Chat', 'Hide pins']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide pins' }));
  await waitFor(() => expect(store.getInterfaceNotesSnapshot().loadedIssue).toBeNull());
});

it('files nothing when dismissed, and stages every unfiled note to Chat without filing it', async () => {
  const { store, menu, drafts } = await mount();
  store.recordAdd(annotation('a', 'Tighten the gap', '/settings'));
  store.recordAdd(annotation('b', 'Wrong colour', '/timeline'));
  await store.reconcile();

  const dismissed = menu.openInterfaceNotesMenuFromSend();
  await screen.findByText('2 notes');
  fireEvent.keyDown(window, { key: 'Escape' });
  await expect(dismissed).rejects.toThrow();
  expect(screen.queryByRole('menu')).toBeNull();

  drafts.registerWritableChatTarget('chat-a', false);
  const staged = menu.openInterfaceNotesMenuFromSend();
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Chat' }));
  await expect(staged).resolves.toBeUndefined();
  expect(drafts.getConversationDraft('chat-a').attachments.map((item) => item.kind === 'annotation' && item.id)).toEqual(['a', 'b']);
  expect((await unfiledIds()).sort()).toEqual(['a', 'b']);
});
