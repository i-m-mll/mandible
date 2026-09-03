import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { LedgerIssueDetail } from '../../ui/src/components/ledger/IssueDetail';
import type { LedgerIssueDetailProjection } from '../../ui/src/api';

afterEach(cleanup);

function detail(labels: string[]): LedgerIssueDetailProjection {
  return {
    id: 'issue-1',
    display_id: 'issue-1',
    detail_stage: 'full',
    project: {
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
    priority: 'unknown',
    source: 'mandible',
    author: { id: null, type: 'mandible_user', display: 'Mandible' },
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
  } as LedgerIssueDetailProjection;
}

describe('issue detail label presentation', () => {
  it('hides known branch and status mirror labels with other presentation metadata', () => {
    render(<LedgerIssueDetail detail={detail([
      'mandible:branch:feature/example',
      'mandible:status:in_progress',
      'merged',
      'visible',
    ])} />);

    expect(screen.queryByText('mandible:branch:feature/example')).toBeNull();
    expect(screen.queryByText('mandible:status:in_progress')).toBeNull();
    expect(screen.queryByText('merged')).toBeNull();
    expect(screen.getByText('visible').textContent).toBe('visible');
  });

  it('preserves ordinary and colon-bearing labels while retaining error display mapping', () => {
    const preserved = ['team:frontend', 'mandible:priority:high', 'mandible:branch', 'status:open'];
    render(<LedgerIssueDetail detail={detail([...preserved, 'error'])} />);

    for (const label of preserved) {
      expect(screen.getByText(label).textContent).toBe(label);
    }
    expect(screen.queryByText('error')).toBeNull();
    expect(screen.getByText('bug').textContent).toBe('bug');
  });

  it('starts secondary issue shelves in shared collapsed panels', () => {
    const projection = detail(['umbrella']);
    projection.relationships = [
      {
        id: 'child-edge', direction: 'outgoing', relationship_type: 'parent_child',
        related_issue: { id: 'child', display_id: 'child-1', title: 'Child issue', status: 'open', resolution: null },
      },
      {
        id: 'reference-edge', direction: 'outgoing', relationship_type: 'references',
        related_issue: { id: 'reference', display_id: 'ref-1', title: 'Referenced issue', status: 'open', resolution: null },
      },
    ] as LedgerIssueDetailProjection['relationships'];
    projection.associated_artifacts = [{
      id: 'artifact-1', ref: 'artifact:artifact-1', title: 'Decision brief', logical_name: null,
      uri: 'file:///tmp/decision.md', content_hash: 'a'.repeat(64), role: 'reference', media_type: 'text/markdown',
      provider_id: null, availability: 'present', refs: [], links: [],
    }] as LedgerIssueDetailProjection['associated_artifacts'];

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
});
