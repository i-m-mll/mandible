import { issueDetailProjection, render } from '../helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { LedgerIssueDetail } from '../../ui/src/components/ledger/IssueDetail';

describe('LedgerIssueDetail', () => {
  it('renders issue status in the top metadata row after the copy affordance', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const detail = issueDetailProjection({
      displayId: 'abc123',
      title: 'Status placement',
    });
    detail.id = 'abc123-full-canonical-id';

    render(h(LedgerIssueDetail, { detail }));

    const canonicalHeaders = document.querySelectorAll('[data-detail-pane-header-variant="standard"]');
    const canonicalHeader = canonicalHeaders[0] as HTMLElement | undefined;
    const topline = canonicalHeader?.querySelector('.detail-pane-header__topline') as HTMLElement | null;
    const identity = canonicalHeader?.querySelector('.detail-pane-header__identity') as HTMLElement | null;
    const status = canonicalHeader?.querySelector('.detail-pane-header__status') as HTMLElement | null;
    const controls = status?.parentElement;
    const copyButton = screen.getByRole('button', { name: 'Copy mandible/abc123' });
    const statusPill = status?.querySelector('.status-pill') as HTMLElement | null;
    const toplineChildren = Array.from(topline?.children ?? []);

    expect(canonicalHeaders).toHaveLength(1);
    expect(canonicalHeader?.classList.contains('detail-pane-header')).toBe(true);
    expect(statusPill?.textContent).toBe('open');
    expect(copyButton.parentElement).toBe(identity);
    expect(statusPill?.parentElement).toBe(status);
    expect(toplineChildren.indexOf(controls as Element)).toBe(toplineChildren.indexOf(identity as Element) + 1);
    const detailPane = document.querySelector('.ledger-issue-detail');
    const header = document.querySelector('.ledger-issue-detail__header');
    const notice = document.querySelector('.ledger-issue-detail [data-detail-pane-slot="notice"]');
    const body = document.querySelector('.ledger-issue-detail__body');
    expect(detailPane?.classList.contains('detail-pane-shell')).toBe(true);
    expect(header?.classList.contains('detail-pane-shell__header')).toBe(true);
    expect(body?.classList.contains('detail-pane-shell__body')).toBe(true);
    expect(header?.querySelector('.detail-pane-shell__header-primary.ledger-issue-detail__header-primary')).toBeTruthy();
    expect(detailPane?.contains(header as Node)).toBe(true);
    expect(detailPane?.contains(body as Node)).toBe(true);
    expect(header?.nextElementSibling).toBe(notice);
    expect(notice?.nextElementSibling).toBe(body);
    expect(body?.contains(header as Node)).toBe(false);
    const overflowAction = screen.getByRole('button', { name: 'Issue actions' });
    expect(canonicalHeader?.querySelector('.detail-pane-header__actions')?.contains(overflowAction)).toBe(true);
    expect(body?.contains(overflowAction)).toBe(false);

    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith('mandible/abc123');
  });

  it('prefers canonical project keys over checkout repo ids in copy refs', () => {
    const detail = issueDetailProjection({
      displayId: 'fbx1234',
      title: 'Feedbax ref',
      projectKey: 'feedbax',
      repoId: '20-widgets-widgets',
      repoName: 'Feedbax',
    });

    render(h(LedgerIssueDetail, { detail }));

    expect(screen.getByRole('button', { name: 'Copy feedbax/fbx1234' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy 20-widgets-widgets/fbx1234' })).toBeNull();
  });

  it('uses canonical project keys for local rendered issue and comment links', () => {
    const detail = issueDetailProjection({
      displayId: 'fbx1234',
      title: 'Feedbax rendered refs',
      body: 'See [issue:def456] and [comment:#com_1].',
      projectKey: 'feedbax',
      repoId: '20-widgets-widgets',
      repoName: 'Feedbax',
    });

    render(h(LedgerIssueDetail, { detail }));

    const issueLinks = Array.from(document.querySelectorAll('a.ledger-xref')).map((node) => ({
      text: node.textContent,
      href: (node as HTMLAnchorElement).getAttribute('href'),
    }));
    expect(issueLinks).toContainEqual({
      text: 'def456',
      href: '#/issues?repo=feedbax&issue=def456',
    });
    expect(issueLinks).toContainEqual({
      text: 'fbx1234#com_1',
      href: '#/issues?repo=feedbax&issue=fbx1234&comment=com_1',
    });
    expect(issueLinks.some((link) => link.href?.includes('20-widgets-widgets'))).toBe(false);
  });

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

    expect(screen.queryByRole('heading', { name: 'Approval Evidence' })).toBeNull();
    expect(screen.getByText('resolved by')).toBeTruthy();
    expect(screen.getByText('Merge feature/x')).toBeTruthy();
    expect(screen.queryByText('Timeline')).toBeNull();
    expect(document.body.innerHTML).not.toContain('onerror');
    expect(document.body.innerHTML).not.toContain('<script');
  });

  it('linkifies typed ledger issue and comment references outside code', () => {
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
      body: 'See [issue:def456], #789abcd, issue_legacy_alias, auth request 2257522a, merge 204ade09bc3a, [comment:mandible/def456#com_2], next `020a65b`, commit `7714da1`, current commit is f026c06, superseding the earlier 7714da1, [artifact:bbbbbbbbbbbb], [artifact:feedbax://runs/demo], [artifact:repo://mandible@main/results/report.md], and `#deadbee` in code.',
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

    const issueLinks = Array.from(document.querySelectorAll('a.ledger-xref')).map((node) => ({
      text: node.textContent,
      href: (node as HTMLAnchorElement).getAttribute('href'),
    }));
    expect(issueLinks).toContainEqual({ text: 'def456', href: '#/issues?repo=mandible&issue=def456' });
    expect(issueLinks.some((link) => link.text === '#789abcd')).toBe(false);
    expect(issueLinks.some((link) => link.text === 'issue_legacy_alias')).toBe(false);
    expect(issueLinks.some((link) => link.text === '2257522a')).toBe(false);
    expect(issueLinks.some((link) => link.text === '204ade09bc3a')).toBe(false);
    expect(issueLinks).toContainEqual({
      text: 'def456#com_2',
      href: '#/issues?repo=mandible&issue=def456&comment=com_2',
    });
    expect(issueLinks.some((link) => link.text === '020a65b')).toBe(false);
    expect(issueLinks.some((link) => link.text === '7714da1')).toBe(false);
    expect(issueLinks.some((link) => link.text === 'f026c06')).toBe(false);
    expect(issueLinks).toContainEqual({
      text: 'abc123#com_1',
      href: '#/issues?repo=mandible&issue=abc123&comment=com_1',
    });
    const artifactLinks = Array.from(document.querySelectorAll('a.artifact-xref')).map((node) => ({
      text: node.textContent,
      href: (node as HTMLAnchorElement).getAttribute('href'),
    }));
    expect(artifactLinks).toContainEqual({
      text: 'artifact:bbbbbbbbbbbb',
      href: '#/artifacts?ref=artifact%3Abbbbbbbbbbbb',
    });
    expect(artifactLinks).toContainEqual({
      text: 'feedbax://runs/demo',
      href: '#/artifacts?ref=feedbax%3A%2F%2Fruns%2Fdemo',
    });
    expect(artifactLinks).toContainEqual({
      text: 'repo://mandible@main/results/report.md',
      href: '#/artifacts?ref=repo%3A%2F%2Fmandible%40main%2Fresults%2Freport.md',
    });
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

  it('renders associated artifacts as compact links into the artifacts view', () => {
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
      title: 'Artifacts',
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
      comments: [],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [],
      associated_artifacts: [
        {
          id: 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ref: 'artifact-blob:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          title: 'R0 audit report',
          logical_name: 'r0-audit.md',
          algorithm: 'sha256',
          content_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          uri: 'artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          media_type: 'text/markdown',
          role: 'report',
          provider_id: 'provider_1',
          manifest_id: 'manifest_1',
          custody_mode: 'managed',
          availability: 'present',
          created_at: Date.now(),
          refs: ['artifact-version:version-1'],
          links: [
            {
              id: 'link_1',
              entity_type: 'issue',
              entity_id: 'issue_1',
              link_type: 'produced_by',
              role: 'report',
              repo_id: 'mandible',
              provider_id: 'provider_1',
              source: 'artifact_registry',
              metadata: {},
              link_kind: 'pinned',
              series_id: 'artifact-series:report',
              series_ref: 'artifact-series:report',
              resolved_version_no: null,
              target_type: 'artifact_version',
              target_id: 'artifact-version:version-1',
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ],
        },
        {
          id: 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          ref: 'artifact-blob:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          title: null,
          logical_name: null,
          algorithm: 'sha256',
          content_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          uri: 'artifact:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          media_type: null,
          role: null,
          provider_id: null,
          manifest_id: null,
          custody_mode: 'external',
          availability: 'remote_only',
          created_at: Date.now(),
          refs: [],
          links: [
            {
              id: 'link_blob',
              entity_type: 'issue',
              entity_id: 'issue_1',
              link_type: 'references',
              role: null,
              repo_id: null,
              provider_id: null,
              source: 'artifact_registry',
              metadata: {},
              link_kind: 'pinned',
              series_id: null,
              series_ref: null,
              resolved_version_no: null,
              target_type: 'artifact_blob',
              target_id: 'artifact-blob:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ],
        },
        {
          id: 'artifact:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          ref: 'artifact-blob:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          title: 'Live report',
          logical_name: 'live-report.md',
          algorithm: 'sha256',
          content_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          uri: 'artifact:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          media_type: 'application/json',
          role: 'dataset',
          provider_id: 'provider_1',
          manifest_id: null,
          custody_mode: 'managed',
          availability: 'present',
          created_at: Date.now(),
          refs: ['artifact-series:live-report'],
          links: [
            {
              id: 'link_2',
              entity_type: 'issue',
              entity_id: 'issue_1',
              link_type: 'evidence',
              role: null,
              repo_id: 'mandible',
              provider_id: 'provider_1',
              source: 'artifact_registry',
              metadata: {},
              link_kind: 'living',
              series_id: 'artifact-series:live-report',
              series_ref: 'artifact-series:live-report',
              resolved_version_no: 2,
              target_type: 'artifact',
              target_id: 'artifact:live-report',
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ],
        },
      ],
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    const artifactsPanel = screen.getByText('Associated Artifacts').closest('.collapsible-panel') as HTMLElement;
    fireEvent.click(artifactsPanel.querySelector('button') as HTMLButtonElement);
    expect(screen.getAllByText('R0 audit report')).toHaveLength(2);
    const versionRefs = screen.getAllByText('artifact-version:version-1');
    const link = versionRefs.find((node) => node.closest('a')?.textContent?.includes('referenced'))
      ?.closest('a') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe(
      '#/artifacts?ref=artifact-version%3Aversion-1',
    );
    expect(link?.textContent).toContain('R0 audit report');
    expect(link?.textContent).not.toContain('v1');
    expect(link?.textContent).not.toContain('latest');
    const pinnedLink = versionRefs.find((node) => node.closest('a')?.textContent?.includes('produced by'))
      ?.closest('a') as HTMLAnchorElement | null;
    expect(pinnedLink?.getAttribute('href')).toBe('#/artifacts?ref=artifact-version%3Aversion-1');
    expect(pinnedLink?.textContent).toContain('artifact-version:version-1');
    const compactLink = screen.getByText('artifact-blob:bbbbbbbbbbbb').closest('a') as HTMLAnchorElement | null;
    expect(compactLink?.getAttribute('href')).toBe(
      '#/artifacts?ref=artifact-blob%3Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const livingLinks = screen.getAllByText('artifact-series:live-report');
    expect(livingLinks).toHaveLength(1);
    const authoredLivingLink = livingLinks.find((node) => node.closest('a')?.textContent?.includes('referenced'))
      ?.closest('a') as HTMLAnchorElement | null;
    expect(authoredLivingLink?.getAttribute('href')).toBe('#/artifacts?series=artifact-series%3Alive-report');
    const livingLink = screen.getByText('latest → v2').closest('a') as HTMLAnchorElement | null;
    expect(livingLink?.getAttribute('href')).toBe('#/artifacts?ref=artifact%3Alive-report');
    expect(livingLink?.textContent).toContain('artifact:live-report');
    expect(screen.getAllByText('report · text/markdown · provider_1 · present')).toHaveLength(2);
  });

  it('keeps issue and comment provenance behind metadata controls', async () => {
    const now = Date.now();
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
      title: 'Metadata',
      body: 'Body',
      status: 'open',
      resolution: null,
      kind: 'umbrella',
      priority: 'high',
      source: 'git_bug',
      author: { id: null, type: 'external_adapter', display: 'MLL' },
      created_at: now,
      updated_at: now,
      closed_at: null,
      aliases: [],
      labels: ['feature'],
      comments: [
        {
          id: 'com_1',
          body: 'Comment',
          author: { id: null, type: 'external_adapter', display: 'MLL' },
          source: 'git_bug',
          created_at: now,
          updated_at: null,
        },
      ],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [],
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    const issueHeader = document.querySelector('.ledger-issue-detail__header');
    const issueMeta = document.querySelector('.ledger-issue-detail__meta');
    const issueVisibleMeta = Array.from(issueMeta?.querySelectorAll(':scope > span') ?? [])
      .map((node) => node.textContent)
      .join(' ');
    expect(issueVisibleMeta).toContain('MLL');
    expect(issueVisibleMeta).not.toContain('git_bug');
    expect(issueVisibleMeta).not.toContain('umbrella');
    expect(issueHeader?.querySelector('[aria-label="Issue metadata"]')).toBeNull();
    const detailScroller = document.querySelector('.ledger-issue-detail__body') as HTMLElement | null;
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getIssueRect() {
      if (this.classList.contains('ledger-issue-detail__body')) {
        return {
          x: 300,
          y: 176,
          top: 176,
          right: 1180,
          bottom: 800,
          left: 300,
          width: 880,
          height: 624,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    if (detailScroller) detailScroller.scrollTop = 320;
    fireEvent.click(screen.getByLabelText('Issue actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const issueMetadataDialog = screen.getByRole('dialog', { name: 'Issue metadata' });
    await waitFor(() => expect(detailScroller?.className).toContain('detail-pane-shell__body--overlay-open'));
    expect(detailScroller?.scrollTop).toBe(320);
    expect(issueMetadataDialog.closest('.ledger-issue-detail__body')).toBeNull();
    expect(issueMetadataDialog.parentElement?.hasAttribute('data-detail-pane-overlay-host')).toBe(true);
    expect((issueMetadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-top')).toBe('176px');
    expect((issueMetadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-left')).toBe('300px');
    expect((issueMetadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-right')).toBe('100px');
    expect((issueMetadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-bottom')).toBe('0px');
    expect(within(issueMetadataDialog).getByText('Identity')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('Status')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('Provenance')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('abc123')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('umbrella')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('git_bug')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue metadata' })).toBeNull());
    await waitFor(() => expect(detailScroller?.className).not.toContain('detail-pane-shell__body--overlay-open'));
    rectSpy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });

    const commentHeader = document.querySelectorAll('.ledger-comment-card__header')[1];
    const commentVisibleMeta = Array.from(commentHeader?.querySelectorAll(':scope > span, :scope > time') ?? [])
      .map((node) => node.textContent)
      .join(' ');
    expect(commentVisibleMeta).toContain('MLL');
    expect(commentVisibleMeta).not.toContain('external adapter');
    expect(commentVisibleMeta).not.toContain('git_bug');
    expect(commentHeader?.querySelector('[aria-label="Comment metadata"]')).toBeTruthy();
  });

  it('scopes issue metadata to embedded graph detail panes', async () => {
    const detail = issueDetailProjection({
      displayId: 'embed123',
      title: 'Embedded metadata',
    });

    render(h('div', { class: 'graph-detail-pane' }, h(LedgerIssueDetail, { detail })));

    const embeddedScroller = document.querySelector('.ledger-issue-detail__body') as HTMLElement | null;
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 760, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getEmbeddedIssueRect() {
      if (this.classList.contains('ledger-issue-detail__body')) {
        return {
          x: 720,
          y: 196,
          top: 196,
          right: 1180,
          bottom: 740,
          left: 720,
          width: 460,
          height: 544,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    if (embeddedScroller) embeddedScroller.scrollTop = 144;

    fireEvent.click(screen.getByLabelText('Issue actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const metadataDialog = screen.getByRole('dialog', { name: 'Issue metadata' });

    await waitFor(() => expect(embeddedScroller?.className).toContain('detail-pane-shell__body--overlay-open'));
    expect(embeddedScroller?.scrollTop).toBe(144);
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-top')).toBe('196px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-left')).toBe('720px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-right')).toBe('20px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-bottom')).toBe('20px');
    expect(within(metadataDialog).getByText('embed123')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue metadata' })).toBeNull());
    await waitFor(() => expect(embeddedScroller?.className).not.toContain('detail-pane-shell__body--overlay-open'));
    rectSpy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
  });


  it('keeps issue actions in the header overflow menu while preserving the comment composer button', () => {
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
      title: 'Actions',
      body: 'Body',
      status: 'open',
      resolution: null,
      kind: 'feature',
      priority: 'normal',
      source: 'mandible',
      author: { id: null, type: 'mandible_user', display: 'Mandible' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: null,
      aliases: [],
      labels: ['feature'],
      comments: [],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [],
    } as const;

    const onSetStatus = vi.fn();
    render(h(LedgerIssueDetail, {
      detail,
      onAddComment: () => undefined,
      onSetStatus,
      onStartAgent: () => undefined,
    }));

    expect(document.querySelector('.ledger-issue-detail__actions')).toBeNull();
    expect(screen.getByText('Add Comment')).toBeTruthy();
    const visibleLabels = Array.from(document.querySelectorAll('.ledger-label')).map((node) => node.textContent);
    expect(visibleLabels).toContain('feature');
    expect(visibleLabels).not.toContain('merged');
    expect(screen.queryByText('Start Agent')).toBeNull();
    expect(screen.queryByText('Close Issue')).toBeNull();

    fireEvent.click(screen.getByLabelText('Issue actions'));

    expect(screen.getByText('Start Agent')).toBeTruthy();
    expect(screen.getByText('Close Issue')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Show metadata' })).toBeTruthy();
    expect(screen.getAllByText('Add Comment')).toHaveLength(2);

    fireEvent.click(screen.getByText('Close Issue'));
    expect(screen.getByRole('group', { name: 'Close issue resolution' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Close as delivered' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Close as duplicate' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Close as wontfix' })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Close as duplicate' }));
    expect(onSetStatus).toHaveBeenCalledWith('closed', 'duplicate');
  });
});

