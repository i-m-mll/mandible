// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterfaceNote } from '../src/interface-notes/contract';
import type { LedgerIssueDetailActor, LedgerIssueDetailProjection } from '../ui/src/api';

const store = vi.hoisted(() => ({ loaded: null as string | null, calls: [] as Array<string | null> }));
const navigation = vi.hoisted(() => ({ hrefs: [] as string[] }));

vi.mock('../ui/src/annotation/interfaceNotesStore', () => ({
  useInterfaceNotes: () => ({
    ready: true, unfiled: [], pendingWrites: 0, epoch: 0,
    loadedIssue: store.loaded ? { id: store.loaded, notes: [] } : null,
  }),
  setLoadedIssue: async (issue: string | null) => {
    store.calls.push(issue);
    store.loaded = issue;
    return { ok: true };
  },
}));

vi.mock('../ui/src/routing', async (importOriginal) => ({
  ...await importOriginal<typeof import('../ui/src/routing')>(),
  navigateTo: (href: string) => { navigation.hrefs.push(href); },
}));

const { LedgerIssueDetail } = await import('../ui/src/components/ledger/IssueDetail');

const author: LedgerIssueDetailActor = { id: null, type: 'mandible_user', display: 'Operator', legacy_display: 'Operator', attribution: null };

function note(id: string, text: string, path: string): InterfaceNote {
  return {
    id, text, created_at: 1, updated_at: 1,
    owner: { kind: 'comment', issue_id: 'issue-1', comment_id: 'comment-1' },
    target: { url: `https://mandible.test${path}`, rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 800, height: 600 } },
    pin: { id, comment: text, x: 10, y: 20 },
  };
}

function detail(): LedgerIssueDetailProjection {
  const notes = [note('n1', 'Header is too tall', '/timeline'), note('n2', 'Label wraps', '/settings')];
  const comment = { id: 'comment-1', ordinal: 1, body: 'Annotation 1: generated body text', notes, author, source: 'mandible' as const, created_at: 2, updated_at: null };
  return {
    associated_artifacts: [], detail_stage: 'full', work_notes: '', work_notes_revision: null, worker_status: 'none',
    issue_branches: [], dependencies: [], dependency_warning: false, timeline_partial: false,
    id: 'issue-1', display_id: 'abc1234',
    project: { work_repo_id: null, project_key: 'demo', id: 'project-1', display_name: 'Demo', remote_identity: '', upstream_identity: '',
      repo_id: 'demo', repo_name: 'demo', repo_root: null, default_branch: 'main' },
    title: 'Notes', body: 'Body', status: 'open', resolution: null, kind: 'feature', priority: 'normal', source: 'mandible', author,
    created_at: 1, updated_at: 1, closed_at: null, aliases: [], labels: [], checkpoints: [],
    comments: [comment],
    timeline: [
      { id: 'issue-1:body', kind: 'body', ordinal: 0, body: 'Body', author, source: 'mandible', created_at: 1, updated_at: 1 },
      { ...comment, kind: 'comment', comment_id: 'comment-1' },
    ],
    relationships: [], work_units: [], sessions: [], auth_requests: [],
  };
}

function menuItem(name: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Issue actions' }));
  return within(screen.getByRole('menu')).getByRole('menuitem', { name });
}

describe('interface notes in the issue view', () => {
  beforeEach(() => {
    store.loaded = null;
    store.calls = [];
    navigation.hrefs = [];
  });
  afterEach(cleanup);

  it('shows a carrying comment as note pills, and removes the chosen note from its comment', async () => {
    const removed: Array<[string, string]> = [];
    render(<LedgerIssueDetail detail={detail()} onRemoveNote={async (noteId, commentId) => { removed.push([noteId, commentId]); }} />);

    expect(screen.queryByText(/generated body text/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Annotation 2' }));
    expect(screen.getByRole('dialog').textContent).toContain('Label wraps');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Annotation 2' }));
    await waitFor(() => expect(removed).toEqual([['n2', 'comment-1']]));
  });

  it('loads the issue as pins and opens the page of its first note, or of the previewed note', async () => {
    const { rerender } = render(<LedgerIssueDetail detail={detail()} />);

    fireEvent.click(menuItem('Show pins'));
    await waitFor(() => expect(navigation.hrefs).toEqual(['/timeline']));

    fireEvent.click(screen.getByRole('button', { name: 'Annotation 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show pin' }));
    await waitFor(() => expect(navigation.hrefs).toEqual(['/timeline', '/settings']));

    rerender(<LedgerIssueDetail detail={detail()} />);
    fireEvent.click(menuItem('Hide pins'));
    await waitFor(() => expect(store.calls).toEqual(['demo/abc1234', 'demo/abc1234', null]));
  });
});
