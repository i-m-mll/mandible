// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LedgerIssueDetail } from '../ui/src/components/ledger/IssueDetail';
import { ApiError } from '../ui/src/api';
import type { LedgerIssueDetailProjection } from '../ui/src/api';

afterEach(cleanup);

function detail(labels: string[]): LedgerIssueDetailProjection {
  return {
    work_notes: '', work_notes_revision: null, worker_status: 'none',
    issue_branches: [], dependencies: [], dependency_warning: false, timeline_partial: false,
    id: 'issue-1',
    display_id: 'issue-1',
    detail_stage: 'full',
    project: { work_repo_id: null, project_key: 'mandible',
      id: 'project-1',
      display_name: 'Mandible',
      remote_identity: '',
      upstream_identity: '',
      repo_id: 'mandible',
      repo_name: 'mandible',
      repo_root: null,
      default_branch: 'main',
    },
    title: 'Label presentation',
    body: 'Body',
    status: 'open',
    resolution: null,
    kind: 'feature',
    priority: 'normal',
    source: 'mandible',
    author: { id: null, type: 'mandible_user', display: 'Mandible', legacy_display: 'Mandible', attribution: null },
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    aliases: [],
    labels,
    comments: [],
    checkpoints: [],
    timeline: [],
    relationships: [],
    work_units: [],
    sessions: [],
    auth_requests: [],
    associated_artifacts: [],
  };
}

function openWorkingNotes(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Issue actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Working notes' }));
}

describe('issue detail label presentation', () => {
  it('preserves ordinary and colon-bearing labels without aliasing kind names', () => {
    const preserved = ['team:frontend', 'mandible:priority:high', 'mandible:branch', 'status:open'];
    render(<LedgerIssueDetail detail={detail([...preserved, 'error'])} />);

    for (const label of preserved) {
      expect(screen.getByText(label).textContent).toBe(label);
    }
    expect(screen.getByText('error').textContent).toBe('error');
    expect(screen.queryByText('bug')).toBeNull();
  });

  it('keeps an active draft and its base revision across refresh and stale-save conflict', async () => {
    const initial = detail([]);
    initial.work_notes = 'Original notes';
    initial.work_notes_revision = 'notes-rev-1';
    const onUpdateWorkNotes = vi.fn(async () => {
      throw new ApiError('stale work-notes revision', 409, 'stale_work_notes_revision');
    });
    const view = render(
      <LedgerIssueDetail detail={initial} onUpdateWorkNotes={onUpdateWorkNotes} />,
    );

    openWorkingNotes();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox', { name: 'Working notes' }) as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: 'Draft kept locally' } });

    view.rerender(
      <LedgerIssueDetail
        detail={{ ...initial, work_notes: 'Remote replacement', work_notes_revision: 'notes-rev-2' }}
        onUpdateWorkNotes={onUpdateWorkNotes}
      />,
    );

    expect((screen.getByRole('textbox', { name: 'Working notes' }) as HTMLTextAreaElement).value)
      .toBe('Draft kept locally');
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));

    await waitFor(() => expect(onUpdateWorkNotes).toHaveBeenCalledWith('Draft kept locally', 'notes-rev-1'));
    expect(screen.getByRole('textbox', { name: 'Working notes' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('keeps unsaved notes scoped to the issue when switching away and back', async () => {
    const initial = detail([]);
    initial.work_notes = 'Issue one notes';
    initial.work_notes_revision = null;
    const other = { ...initial, id: 'issue-2', display_id: 'issue-2', work_notes: 'Issue two notes', work_notes_revision: 'issue-two-rev' };
    const onUpdateWorkNotes = vi.fn(async () => undefined);
    const view = render(<LedgerIssueDetail detail={initial} onUpdateWorkNotes={onUpdateWorkNotes} />);

    openWorkingNotes();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Working notes' }), { target: { value: 'Issue one draft' } });
    view.rerender(<LedgerIssueDetail detail={other} onUpdateWorkNotes={onUpdateWorkNotes} />);
    expect(screen.queryByRole('textbox', { name: 'Working notes' })).toBeNull();
    expect(screen.queryByText('Issue two notes')).toBeNull();

    view.rerender(<LedgerIssueDetail detail={{ ...initial, work_notes: 'Remote first notes', work_notes_revision: 'remote-first-revision' }} onUpdateWorkNotes={onUpdateWorkNotes} />);
    openWorkingNotes();
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Working notes' }) as HTMLTextAreaElement).value).toBe('Issue one draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await waitFor(() => expect(onUpdateWorkNotes).toHaveBeenCalledWith('Issue one draft', null));
  });

  it('does not let an old in-flight save alter the newly selected issue', async () => {
    const initial = detail([]);
    initial.work_notes = 'Issue one notes';
    const other = { ...initial, id: 'issue-2', display_id: 'issue-2', work_notes: 'Issue two notes' };
    let resolveSave: (() => void) | undefined;
    const onUpdateWorkNotes = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const view = render(<LedgerIssueDetail detail={initial} onUpdateWorkNotes={onUpdateWorkNotes} />);

    openWorkingNotes();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Working notes' }), { target: { value: 'Old issue save' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    view.rerender(<LedgerIssueDetail detail={other} onUpdateWorkNotes={onUpdateWorkNotes} />);
    resolveSave?.();
    openWorkingNotes();
    await waitFor(() => expect(screen.getByText('Issue two notes')).toBeTruthy());
    expect(screen.queryByText('Old issue save')).toBeNull();
  });
});
