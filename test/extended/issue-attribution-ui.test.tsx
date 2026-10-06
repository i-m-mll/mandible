import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { LedgerIssueDetail } from '../../ui/src/components/ledger/IssueDetail';
import type { LedgerIssueDetailActor, LedgerIssueDetailProjection } from '../../ui/src/api';

afterEach(cleanup);

function attributedActor(): LedgerIssueDetailActor {
  return {
    id: null,
    type: 'mandible_user',
    display: 'Projection Agent',
    legacy_display: 'Mandible',
    attribution: {
      user: { id: 'user-1', display_name: 'Projection Agent', kind: 'agent' },
      evidence_method: 'credential_signature',
      evidence_id: 'evidence-1',
      credential: { id: 'credential-1', type: 'ssh_key', label: 'Agent signing key' },
    },
  };
}

function detail(): LedgerIssueDetailProjection {
  const author = attributedActor();
  const legacyAuthor: LedgerIssueDetailActor = {
    id: null,
    type: 'external_adapter',
    display: 'Imported Author (verbatim)',
    legacy_display: 'Imported Author (verbatim)',
    attribution: null,
  };
  return {
    associated_artifacts: [],
    detail_stage: 'full',
    work_notes: '', work_notes_revision: null, worker_status: 'none',
    issue_branches: [], dependencies: [], dependency_warning: false, timeline_partial: false,
    id: 'issue-1',
    display_id: 'issue-1',
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
    title: 'Attribution presentation',
    body: 'Body',
    status: 'open',
    resolution: null,
    kind: 'feature',
    priority: 'unknown',
    source: 'mandible',
    author,
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    aliases: [],
    labels: [],
    comments: [{
      id: 'comment-1',
      ordinal: 1,
      body: 'Legacy body',
      author: legacyAuthor,
      source: 'git_bug',
      created_at: 2,
      updated_at: null,
    }],
    checkpoints: [],
    timeline: [
      {
        id: 'issue-1:body',
        kind: 'body',
        ordinal: 0,
        body: 'Body',
        author,
        source: 'mandible',
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'comment-1',
        kind: 'comment',
        comment_id: 'comment-1',
        ordinal: 1,
        body: 'Legacy body',
        author: legacyAuthor,
        source: 'git_bug',
        created_at: 2,
        updated_at: null,
      },
    ],
    relationships: [],
    work_units: [],
    sessions: [],
    auth_requests: [],
  };
}

describe('issue attribution presentation', () => {
  it('shows resolved identity provenance and leaves legacy display text unchanged', () => {
    render(<LedgerIssueDetail detail={detail()} />);

    const attributed = screen.getAllByLabelText('Show attribution for Projection Agent');
    expect(attributed.length).toBeGreaterThan(0);
    fireEvent.click(attributed[0]);
    expect(screen.getAllByText('credential signature').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agent signing key').length).toBeGreaterThan(0);
    expect(screen.getByText('Imported Author (verbatim)').textContent)
      .toBe('Imported Author (verbatim)');
    expect(screen.queryByText('external')).toBeNull();
  });
});
