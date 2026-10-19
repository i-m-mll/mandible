import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LedgerIssueDetail } from '../../ui/src/components/ledger/IssueDetail';
import { ApiError } from '../../ui/src/api';
import type { LedgerIssueDetailProjection } from '../../ui/src/api';

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
  it('displays labels as free-form metadata without hiding metadata-shaped names', () => {
    render(<LedgerIssueDetail detail={detail([
      'mandible:branch:feature/example',
      'mandible:status:in_progress',
      'merged',
      'visible',
    ])} />);

    expect(screen.getByText('mandible:branch:feature/example').textContent).toBe('mandible:branch:feature/example');
    expect(screen.getByText('mandible:status:in_progress').textContent).toBe('mandible:status:in_progress');
    expect(screen.getByText('merged').textContent).toBe('merged');
    expect(screen.getByText('visible').textContent).toBe('visible');
  });

  it('preserves ordinary and colon-bearing labels without aliasing kind names', () => {
    const preserved = ['team:frontend', 'mandible:priority:high', 'mandible:branch', 'status:open'];
    render(<LedgerIssueDetail detail={detail([...preserved, 'error'])} />);

    for (const label of preserved) {
      expect(screen.getByText(label).textContent).toBe(label);
    }
    expect(screen.getByText('error').textContent).toBe('error');
    expect(screen.queryByText('bug')).toBeNull();
  });

  it('starts secondary issue shelves in shared collapsed panels', () => {
    const projection = detail([]);
    projection.relationships = [
      {
        id: 'child-edge', direction: 'outgoing', relationship_type: 'parent_child', link_type: 'parent_child', note: null,
        provenance: 'manual', confidence: 'explicit', metadata: {}, created_at: 1, updated_at: 1,
        related_issue: { id: 'child', display_id: 'child-1', project_id: 'project-1', kind: 'feature', priority: 'normal', labels: [], title: 'Child issue', status: 'open', resolution: null },
      },
      {
        id: 'reference-edge', direction: 'outgoing', relationship_type: 'references', link_type: 'references', note: null,
        provenance: 'manual', confidence: 'explicit', metadata: {}, created_at: 1, updated_at: 1,
        related_issue: { id: 'reference', display_id: 'ref-1', project_id: 'project-1', kind: 'feature', priority: 'normal', labels: [], title: 'Referenced issue', status: 'open', resolution: null },
      },
    ];
    projection.associated_artifacts = [{
      id: 'artifact-1', ref: 'artifact:artifact-1', title: 'Decision brief', logical_name: null,
      uri: 'file:///tmp/decision.md', content_hash: 'a'.repeat(64), role: 'reference', media_type: 'text/markdown',
      algorithm: 'sha256', manifest_id: null, custody_mode: 'managed', created_at: 1,
      pin_state: 'pinned', is_latest: null, resolved_version_no: null, series_id: null, warnings: [],
      provider_id: null, availability: 'present', refs: [], links: [],
    }];

    render(<LedgerIssueDetail detail={projection} />);

    const children = screen.getByRole('button', { name: /Children/ });
    const relationships = screen.getByRole('button', { name: /Relationships/ });
    const artifacts = screen.getByRole('button', { name: /Associated Artifacts/ });
    expect(children.getAttribute('aria-expanded')).toBe('false');
    expect(relationships.getAttribute('aria-expanded')).toBe('false');
    expect(artifacts.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Child issue')).toBeNull();
    expect(screen.queryByText('Referenced issue')).toBeNull();
    expect(screen.queryByText('Decision brief')).toBeNull();

    fireEvent.click(children);
    fireEvent.click(relationships);
    fireEvent.click(artifacts);
    expect(screen.getByText('Child issue').textContent).toBe('Child issue');
    expect(screen.getByText('ref-1 Referenced issue').textContent).toBe('ref-1 Referenced issue');
    expect(screen.getByText('Decision brief').textContent).toBe('Decision brief');
  });

  it('renders current and immutable historical working notes', () => {
    const projection = detail([]);
    projection.work_notes = 'Current **notes**';
    projection.work_notes_revision = 'notes-rev-2';
    projection.timeline = [{
      id: 'notes-event-1',
      kind: 'event',
      event_type: 'issue.work_notes_updated',
      author: { id: null, type: 'agent', display: 'Agent', legacy_display: 'Agent', attribution: null },
      source: 'mandible',
      created_at: 2,
      payload: { work_notes: 'Historical notes before the current edit' },
    }];

    render(<LedgerIssueDetail detail={projection} />);

    expect(document.querySelector('.ledger-issue-detail__body .ledger-work-notes-body')).toBeNull();
    openWorkingNotes();
    expect(document.querySelector('.ledger-work-notes-body')?.textContent).toContain('Current notes');
    expect(screen.getByText('Working notes updated')).toBeTruthy();
    expect(document.querySelector('.ledger-work-notes-history')?.hasAttribute('open')).toBe(false);
    fireEvent.click(screen.getByText('View saved working notes'));
    expect(document.querySelector('.ledger-work-notes-history')?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('Historical notes before the current edit').textContent)
      .toBe('Historical notes before the current edit');
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
    expect(screen.getByRole('alert').textContent).toContain('changed while you were editing');
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

  it('shows open dependency warnings without blocking issue actions', () => {
    const projection = detail([]);
    projection.dependencies = [{
      id: 'dependency-1',
      display_id: 'dep-1',
      project_id: 'project-1',
      title: 'Open prerequisite',
      status: 'open',
      resolution: null,
      kind: 'bug',
      priority: 'normal',
      labels: [],
    }];

    render(<LedgerIssueDetail detail={projection} onSetStatus={vi.fn()} />);

    const dependency = screen.getByRole('button', { name: /dep-1 Open prerequisite open Open prerequisite/ });
    expect(dependency).toBeTruthy();
    expect(dependency.textContent).toContain('Open prerequisite');
    expect(dependency).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Issue actions' })).toBeTruthy();
  });
});
