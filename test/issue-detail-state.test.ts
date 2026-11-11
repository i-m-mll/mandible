// @vitest-environment jsdom
import { render } from './helpers/ui-workspace-fixture';
import { screen } from './helpers/dom.js';
import { describe, expect, it } from 'vitest';
import { h } from 'preact';
import { LedgerIssueDetail } from '../ui/src/components/ledger/IssueDetail';

describe('LedgerIssueDetail', () => {
  it('renders ledger issue evidence and sanitizes Markdown HTML', () => {
    const detail = {
      id: 'issue_1',
      display_id: 'abc123',
      project: {
        id: 'proj_1',
        display_name: 'Mandible',
        remote_identity: '',
        upstream_identity: '',
        repo_id: 'mandible',
        repo_name: 'mandible',
        repo_root: '/repo',
        default_branch: 'main',
      },
      title: 'Ledger **issue**',
      body: 'Body <img src=x onerror="alert(1)">',
      status: 'closed',
      resolution: 'merged',
      kind: 'feature',
      priority: 'normal',
      source: 'git_bug',
      author: { id: null, type: 'agent', display: 'Codex' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: Date.now(),
      aliases: [],
      labels: ['feature'],
      comments: [
        {
          id: 'com_1',
          body: '<script>alert(1)</script>Comment',
          notes: [],
          author: { id: null, type: 'agent', display: 'Codex' },
          source: 'session',
          created_at: Date.now(),
          updated_at: null,
        },
      ],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [
        {
          id: 'auth_1',
          type: 'merge',
          title: 'Merge feature/x',
          status: 'completed',
          repo: 'mandible',
          base_branch: 'main',
          head_branch: 'feature/x',
          created_at: Date.now(),
          approved_at: null,
          resolved_at: Date.now(),
          skipped_at: null,
          exit_code: 0,
          error: null,
          link_type: 'resolves',
          link_source: 'auth_queue',
          link_created_at: Date.now(),
          metadata: {},
        },
      ],
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    expect(screen.getByText('Merge feature/x')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('onerror');
    expect(document.body.innerHTML).not.toContain('<script');
  });

  it('does not linkify references inside code', () => {
    const detail = {
      id: 'issue_1',
      display_id: 'abc123',
      project: {
        id: 'proj_1',
        display_name: 'Mandible',
        remote_identity: '',
        upstream_identity: '',
        repo_id: 'mandible',
        repo_name: 'mandible',
        repo_root: '/repo',
        default_branch: 'main',
      },
      title: 'Refs',
      body: 'See [issue:def456], #789abcd, issue_legacy_alias, auth request 2257522a, [auth:2257522a], [issue:2257522a], `[auth:2257522b]`, merge 204ade09bc3a, [comment:mandible/def456#com_2], next `020a65b`, commit `7714da1`, current commit is f026c06, superseding the earlier 7714da1, [artifact:bbbbbbbbbbbb], [artifact:feedbax://runs/demo], [artifact:repo://mandible@main/results/report.md], and `#deadbee` in code.',
      status: 'open',
      resolution: null,
      kind: 'feature',
      priority: 'normal',
      source: 'mandible',
      author: { id: null, type: 'agent', display: 'Codex' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: null,
      aliases: [],
      labels: ['feature', 'merged'],
      comments: [
        {
          id: 'com_1',
          body: 'Local [comment:#com_1]',
          notes: [],
          author: { id: null, type: 'agent', display: 'Codex' },
          source: 'session',
          created_at: Date.now(),
          updated_at: null,
        },
      ],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [
        {
          id: '2257522a-39a2-467b-b3f8-491aea66754c',
          type: 'merge',
          title: 'Merge feature/x',
          status: 'completed',
          repo: 'mandible',
          base_branch: 'main',
          head_branch: 'feature/x',
          created_at: Date.now(),
          approved_at: null,
          resolved_at: Date.now(),
          skipped_at: null,
          exit_code: 0,
          error: null,
          link_type: 'references',
          link_source: 'auth_queue',
          link_created_at: Date.now(),
          metadata: {},
        },
      ],
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    const codeBlocks = Array.from(document.querySelectorAll('code'));
    expect(codeBlocks.some((node) => node.innerHTML.includes('#deadbee'))).toBe(true);
    expect(codeBlocks.some((node) => Boolean(node.querySelector('a')))).toBe(false);
  });

  it('normalizes imported comments with escaped newline sequences before Markdown rendering', () => {
    const detail = {
      id: 'issue_1',
      display_id: 'abc123',
      project: {
        id: 'proj_1',
        display_name: 'Mandible',
        remote_identity: '',
        upstream_identity: '',
        repo_id: 'mandible',
        repo_name: 'mandible',
        repo_root: '/repo',
        default_branch: 'main',
      },
      title: 'Escaped newlines',
      body: 'Body',
      status: 'open',
      resolution: null,
      kind: 'feature',
      priority: 'normal',
      source: 'mandible',
      author: { id: null, type: 'agent', display: 'Codex' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: null,
      aliases: [],
      labels: ['feature'],
      comments: [
        {
          id: 'com_1',
          body: 'Implemented on branch.\\n\\nCommit:\\n- abc1234 — summary',
          notes: [],
          author: { id: null, type: 'agent', display: 'Codex' },
          source: 'session',
          created_at: Date.now(),
          updated_at: null,
        },
      ],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [],
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    expect(document.body.textContent).not.toContain('\\n');
    expect(screen.getByText('Commit:')).toBeTruthy();
    expect(screen.getByText(/abc1234/)).toBeTruthy();
  });
});
