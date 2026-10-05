import { establishTestClientAccess } from '../helpers/local-client-access';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { render } from './notice-test-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ArtifactContentResult,
  ArtifactRecord,
  ArtifactSeriesRecord,
  ArtifactVersionRecord,
} from '../../ui/src/api';
import {
  ArtifactDetail,
  artifactDetailIdentity,
  artifactHighlightLanguage,
  artifactPreview,
  highlightArtifactCode,
} from '../../ui/src/views/artifacts';

beforeEach(establishTestClientAccess);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact:sha256:156f240abcdef',
    algorithm: 'sha256',
    content_hash: '156f240abcdef',
    uri: 'artifact://sha256:156f240abcdef',
    media_type: 'text/plain',
    role: 'script',
    size_bytes: 24,
    provider_id: 'test',
    manifest_id: null,
    metadata: { filename: 'train.py' },
    pinned: false,
    custody_mode: 'link',
    home_repo_id: 'rlrmp',
    repo_locator: {},
    availability: 'present',
    retention: {},
    reference: {},
    created_at: 1000,
    aliases: [],
    links: [],
    ...overrides,
  };
}

function series(overrides: Partial<ArtifactSeriesRecord> = {}): ArtifactSeriesRecord {
  return {
    id: 'artifact-series:156f240abcdef',
    series_key: '156f240abcdef',
    source_kind: 'managed',
    title: null,
    repo_id: 'rlrmp',
    logical_name: null,
    latest_version_id: null,
    version_count: 1,
    metadata: {},
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function content(overrides: Partial<ArtifactContentResult> = {}): ArtifactContentResult {
  return {
    artifact_id: 'artifact:sha256:156f240abcdef',
    status: 'available',
    kind: 'text',
    media_type: 'text/plain',
    size_bytes: 24,
    source: { kind: 'managed_file', locator: '/managed/train.py' },
    preview: {
      encoding: 'utf-8',
      text: 'def train():\n    return 1\n',
      truncated: false,
    },
    download: {
      available: true,
      media_type: 'text/plain',
      size_bytes: 24,
      filename: 'train.py',
    },
    warnings: [],
    ...overrides,
  };
}

function version(overrides: Partial<ArtifactVersionRecord> = {}): ArtifactVersionRecord {
  return {
    id: 'artifact-version:v1',
    series_id: 'artifact-series:156f240abcdef',
    artifact_id: 'artifact:sha256:156f240abcdef',
    version_no: 1,
    parent_version_id: null,
    source_kind: 'managed',
    content_hash: '156f240abcdef',
    commit_sha: null,
    repo_path: null,
    observed_path: null,
    custody_mode: 'managed',
    label: null,
    note: null,
    metadata: {},
    created_at: 1000,
    ...overrides,
  };
}

function renderArtifactDetail(
  nextContent: ArtifactContentResult | null = content(),
  options: {
    contentLoading?: boolean;
    artifact?: ArtifactRecord;
    series?: ArtifactSeriesRecord;
    versions?: ArtifactVersionRecord[];
    selectedVersion?: ArtifactVersionRecord | null;
    selectedVersionNo?: number | null;
  } = {},
) {
  return render(
    <ArtifactDetail
      artifact={options.artifact ?? artifact()}
      resolution={null}
      series={options.series ?? series()}
      versions={options.versions ?? []}
      selectedVersion={options.selectedVersion ?? null}
      selectedVersionNo={options.selectedVersionNo ?? null}
      versionHistoryOpen={false}
      onVersionChange={() => undefined}
      onToggleVersionHistory={() => undefined}
      onCloseVersionHistory={() => undefined}
      content={nextContent}
      contentLoading={options.contentLoading ?? false}
      contentError={null}
      knowledgeBackrefs={[]}
      knowledgeLoading={false}
      knowledgeError={null}
    />,
  );
}

describe('artifact preview helpers', () => {
  it.each([
    {
      projection: 'linked latest',
      custodyMode: 'link',
      selectedVersion: null,
      versionPath: null,
    },
    {
      projection: 'managed pinned version',
      custodyMode: 'managed',
      selectedVersion: version({ observed_path: '/skills/coordinate-umbrella/SKILL.md' }),
      versionPath: 'SKILL.md',
    },
  ])('uses the logical Artifact title for the $projection projection', ({ custodyMode, selectedVersion, versionPath }) => {
    const selectedArtifact = artifact({
      custody_mode: custodyMode,
      metadata: versionPath ? {} : { filename: 'SKILL.md' },
      repo_locator: { repo_id: 'dotfiles', path: 'skills/coordinate-umbrella/SKILL.md' },
    });

    expect(artifactDetailIdentity(
      selectedArtifact,
      series({ title: 'Claude coordinate-umbrella skill', logical_name: 'coordinate-umbrella' }),
      selectedVersion,
    )).toEqual({
      title: 'Claude coordinate-umbrella skill',
      filename: 'SKILL.md',
    });
  });

  it('renders filename provenance below the logical Artifact title without duplicating identity', () => {
    const { rerender } = renderArtifactDetail(content(), {
      artifact: artifact({ metadata: { filename: 'SKILL.md' } }),
      series: series({ title: 'Claude coordinate-umbrella skill' }),
    });

    expect(screen.getByRole('heading', { name: 'Claude coordinate-umbrella skill' })).toBeTruthy();
    expect(screen.getByText(/File: SKILL\.md/)).toBeTruthy();

    rerender(<ArtifactDetail
      artifact={artifact({ metadata: { filename: 'Claude coordinate-umbrella skill' } })}
      resolution={null}
      series={series({ title: 'Claude coordinate-umbrella skill' })}
      versions={[]}
      selectedVersion={null}
      selectedVersionNo={null}
      versionHistoryOpen={false}
      onVersionChange={() => undefined}
      onToggleVersionHistory={() => undefined}
      onCloseVersionHistory={() => undefined}
      content={content()}
      contentLoading={false}
      contentError={null}
      knowledgeBackrefs={[]}
      knowledgeLoading={false}
      knowledgeError={null}
    />);
    expect(screen.queryByText(/File: Claude coordinate-umbrella skill/)).toBeNull();
  });

  it('creates a Briefing from the exact selected materializable Markdown version', async () => {
    const selected = version({ id: 'artifact-version:exact-v1', version_no: 1 });
    const mockFetch = vi.fn((input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/drafts') && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify({ draft: null }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url === '/api/briefings' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          artifact_version_ref: selected.id,
          title: 'AGENTS.review.md',
        });
        return Promise.resolve(new Response(JSON.stringify({
          receipt_id: 'round-full',
          briefing_id: 'briefing-full',
          run_id: 'artifact:exact-v1',
          round_id: 'round-full',
          artifact_version_id: selected.id,
          quiet: false,
        }), { status: 201, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal('fetch', mockFetch);
    window.location.hash = '#/artifacts';
    renderArtifactDetail(content({ kind: 'markdown', media_type: 'text/markdown' }), {
      artifact: artifact({ metadata: { filename: 'AGENTS.review.md' }, media_type: 'text/markdown' }),
      versions: [selected],
      selectedVersion: selected,
      selectedVersionNo: 1,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create briefing' }));
    await waitFor(() => expect(window.location.hash).toBe('#/briefing?briefing=briefing-full&round=round-full'));
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('shows store-authoritative reuse guidance when an active Briefing owns the Artifact', async () => {
    const selected = version({ id: 'artifact-version:exact-v1', version_no: 1 });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/drafts') && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify({ draft: null }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url === '/api/briefings' && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          error: 'An active Briefing already owns this logical Artifact',
          code: 'briefing_active_candidates',
          outcome: 'active_candidates',
          logical_artifact_id: 'artifact:logical',
          active_candidates: [{
            briefing_id: 'briefing-existing', title: 'Existing review', archived_at: null,
            latest_round_id: 'round-existing', matching_round_id: 'round-existing', guidance: 'reuse_round',
          }],
          archived_candidates: [],
        }), { status: 409, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));
    renderArtifactDetail(content({ kind: 'markdown', media_type: 'text/markdown' }), {
      artifact: artifact({ metadata: { filename: 'AGENTS.review.md' }, media_type: 'text/markdown' }),
      versions: [selected], selectedVersion: selected, selectedVersionNo: 1,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create briefing' }));
    expect((await screen.findByRole('alert')).textContent)
      .toContain('Existing review (briefing): reuse exact round');
  });

  it('disables Briefing creation without an exact materializable Markdown selection', () => {
    renderArtifactDetail(content(), { selectedVersion: version(), selectedVersionNo: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    expect(screen.getByRole('menuitem', { name: 'Create briefing' })).toHaveProperty('disabled', true);
  });

  it('keeps raw JSON available when a formatted JSON preview is shown', () => {
    const preview = artifactPreview(content({
      kind: 'json',
      media_type: 'application/json',
      preview: {
        encoding: 'utf-8',
        text: '{\n  "alpha": 1\n}',
        raw_text: '{"alpha":1}',
        formatted: 'json',
        truncated: false,
      },
      download: {
        available: true,
        media_type: 'application/json',
        size_bytes: 11,
        filename: 'metrics.json',
      },
    }));

    expect(preview).toMatchObject({
      kind: 'json',
      value: '{\n  "alpha": 1\n}',
      rawValue: '{"alpha":1}',
      autoFormatted: true,
      highlightLanguage: 'json',
      partial: false,
    });
  });

  it('keeps partial JSON raw and marks formatting as skipped', () => {
    const preview = artifactPreview(content({
      kind: 'json',
      media_type: 'application/json',
      size_bytes: 1024 * 1024,
      preview: {
        encoding: 'utf-8',
        text: '{"items":[1,2,3',
        truncated: true,
        preview_bytes: 15,
        total_bytes: 1024 * 1024,
        omitted_bytes: (1024 * 1024) - 15,
        format_skipped: 'partial_preview',
      },
      download: {
        available: true,
        media_type: 'application/json',
        size_bytes: 1024 * 1024,
        filename: 'large.json',
      },
    }));

    expect(preview).toMatchObject({
      kind: 'json',
      value: '{"items":[1,2,3',
      rawValue: '{"items":[1,2,3',
      autoFormatted: false,
      highlightLanguage: null,
      partial: true,
      formatSkipped: 'partial_preview',
    });
  });

  it('detects Python source artifacts and returns highlighted HTML', () => {
    const language = artifactHighlightLanguage(content());
    const highlighted = highlightArtifactCode('def train():\n    return 1\n', language);

    expect(language).toBe('python');
    expect(highlighted?.language).toBe('python');
    expect(highlighted?.html).toContain('hljs-keyword');
    expect(highlighted?.html).toContain('def');
  });

  it('opens a server-backed Markdown draft editor for editable artifacts', async () => {
    const baseVersion = version();
    const mockFetch = vi.fn((input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/drafts') && (!init || init.method === undefined)) {
        return Promise.resolve(new Response(JSON.stringify({ draft: null }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url === '/api/artifacts/drafts' && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          draft: {
            id: 'artifact-draft:1',
            series_id: baseVersion.series_id,
            base_version_id: baseVersion.id,
            base_version_no: 1,
            latest_version_id: baseVersion.id,
            latest_version_no: 1,
            stale: false,
            content: '# Draft\n',
            media_type: 'text/markdown',
            label: null,
            note: null,
            metadata: {},
            created_at: 1000,
            updated_at: 1000,
          },
        }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal('fetch', mockFetch);
    renderArtifactDetail(content({
      kind: 'markdown',
      media_type: 'text/markdown',
      preview: {
        encoding: 'utf-8',
        text: '# Draft\n',
        truncated: false,
      },
    }), {
      artifact: artifact({ custody_mode: 'managed', media_type: 'text/markdown' }),
      versions: [baseVersion],
      selectedVersion: baseVersion,
      selectedVersionNo: 1,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit content' }));

    expect(await screen.findByLabelText('Artifact editor')).toBeTruthy();
    expect(screen.getByText('Save as new version')).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledWith('/api/artifacts/drafts', expect.objectContaining({ method: 'POST' }));
  });

  it('resumes a stale draft and shows stale-base actions', async () => {
    const baseVersion = version();
    const latestVersion = version({ id: 'artifact-version:v2', version_no: 2 });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/drafts')) {
        return Promise.resolve(new Response(JSON.stringify({
          draft: {
            id: 'artifact-draft:1',
            series_id: baseVersion.series_id,
            base_version_id: baseVersion.id,
            base_version_no: 1,
            latest_version_id: latestVersion.id,
            latest_version_no: 2,
            stale: true,
            content: '# Stale draft\n',
            media_type: 'text/markdown',
            label: null,
            note: null,
            metadata: {},
            created_at: 1000,
            updated_at: 2000,
          },
        }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    renderArtifactDetail(content({
      kind: 'markdown',
      media_type: 'text/markdown',
      preview: {
        encoding: 'utf-8',
        text: '# Latest\n',
        truncated: false,
      },
    }), {
      artifact: artifact({ custody_mode: 'managed', media_type: 'text/markdown' }),
      versions: [latestVersion, baseVersion],
      selectedVersion: latestVersion,
      selectedVersionNo: 2,
    });

    expect(await screen.findByText('Publish anyway')).toBeTruthy();
    expect(screen.getByText('Rebase draft')).toBeTruthy();
    expect(screen.getByText(/Draft based on v1; v2 exists/)).toBeTruthy();
  });

  it('renders version diffs through the shared diff view', async () => {
    const older = version({ id: 'artifact-version:v1', version_no: 1 });
    const newer = version({ id: 'artifact-version:v2', version_no: 2 });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/drafts')) {
        return Promise.resolve(new Response(JSON.stringify({ draft: null }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/artifacts/diff?')) {
        return Promise.resolve(new Response(JSON.stringify({
          diff: {
            a: { ref: older.id, artifact_id: older.artifact_id, content_hash: older.content_hash, media_type: 'text/plain', size_bytes: 6, available: true },
            b: { ref: newer.id, artifact_id: newer.artifact_id, content_hash: newer.content_hash, media_type: 'text/plain', size_bytes: 9, available: true },
            diffable: true,
            identical: false,
            kind: 'text',
            unified: 'diff --git a/artifact.md b/artifact.md\n--- a/artifact.md\n+++ b/artifact.md\n@@ -1 +1 @@\n-old\n+new\n',
            stats: { added: 1, removed: 1 },
          },
        }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));
    renderArtifactDetail(content(), {
      artifact: artifact({ custody_mode: 'managed' }),
      versions: [newer, older],
      selectedVersion: newer,
      selectedVersionNo: 2,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Diff vs previous' }));

    await waitFor(() => expect(screen.getByText('Split')).toBeTruthy());
    expect(screen.getAllByLabelText('Artifact version diff').length).toBeGreaterThan(0);
  });
});

describe('ArtifactDetail artifact preview rendering', () => {
  it('opens the selected version externally, closes the menu, and preserves actionable failure state', async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'default application failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })));
    vi.stubGlobal('fetch', mockFetch);
    const selected = version({ id: 'artifact-version:selected', artifact_id: 'artifact:selected' });
    renderArtifactDetail(content(), { versions: [selected], selectedVersion: selected, selectedVersionNo: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open externally' }));

    expect(screen.queryByRole('menu')).toBeNull();
    expect((await screen.findByRole('alert')).textContent).toContain('default application failed');
    expect(screen.getByRole('heading', { name: 'train.py' })).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledWith('/api/artifacts/artifact%3Aselected/open-externally', expect.objectContaining({ method: 'POST' }));
  });

  it('disables external open with the materialization reason when no file is available', () => {
    renderArtifactDetail(content({
      status: 'unavailable',
      kind: 'unavailable',
      source: null,
      preview: null,
      reason: 'tracked checkout is unavailable',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    const action = screen.getByRole('menuitem', { name: 'Open externally' }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.title).toBe('tracked checkout is unavailable');
  });

  it('shows one clean preview loading affordance while content is pending', () => {
    const { container } = renderArtifactDetail(null, { contentLoading: true });

    expect(screen.getAllByText('Loading preview...')).toHaveLength(1);
    expect(screen.getByRole('status')?.textContent).toBe('Loading preview...');
    expect(container.querySelector('.artifact-preview-frame__loading')).toBeNull();
    expect(container.querySelector('.artifact-preview')).toBeNull();
  });

  it('uses the shared versioned header to copy typed short series and version refs', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const selected = version({
      id: 'artifact-version:e5dfd95425eb977baa7a2c7b4cf12ce7',
      version_no: 1,
    });
    const { container } = renderArtifactDetail(null, {
      series: series({
        id: 'artifact-series:9ce270d18e75438b40eb2f196fdcaf6d',
        series_key: '9ce270d18e75438b40eb2f196fdcaf6d',
      }),
      versions: [selected],
      selectedVersion: selected,
      selectedVersionNo: null,
    });
    const header = container.querySelector('.artifact-detail__header');
    const notice = container.querySelector('.artifact-detail [data-detail-pane-slot="notice"]');
    const composition = header?.querySelector('.detail-pane-header[data-detail-pane-header-variant="versioned"]');
    const main = composition?.querySelector('.detail-pane-header__main');
    const pane = container.querySelector('.artifact-detail__pane');
    const detail = container.querySelector('.artifact-detail');

    expect(detail?.classList.contains('detail-pane-shell')).toBe(true);
    expect(header?.classList.contains('detail-pane-shell__header')).toBe(true);
    expect(pane?.classList.contains('detail-pane-shell__body')).toBe(true);
    expect(main?.children).toHaveLength(2);
    expect(main?.children[0]?.classList.contains('detail-pane-header__topline')).toBe(true);
    expect(main?.children[1]?.classList.contains('detail-pane-header__title-row')).toBe(true);
    expect(composition?.querySelector('.detail-pane-header__identity')?.textContent).toContain('9ce270d');
    expect(composition?.querySelector('.detail-pane-header__identity')?.textContent).not.toContain('artifact-series:');
    expect(composition?.querySelector('.detail-pane-header__identity')?.textContent).not.toContain('rlrmp');
    expect(within(composition as HTMLElement).getByText('Latest', { selector: '.detail-pane-header__state' })).toBeTruthy();
    const selectorGroup = within(composition as HTMLElement).getByRole('group', { name: 'Artifact version' });
    const selectorControl = selectorGroup.querySelector('.detail-pane-header__selector-control') as HTMLElement;
    const selector = within(selectorGroup).getByRole('combobox', { name: 'Artifact version' });
    const selectorCopy = within(selectorGroup).getByRole('button', { name: 'Copy selected artifact-version reference' });
    expect(selectorControl.firstElementChild).toBe(selector);
    expect(selectorControl.nextElementSibling).toBe(selectorCopy);
    expect(composition?.querySelector('.artifact-detail__version-control')).toBeNull();
    expect(within(composition as HTMLElement).getByRole('heading', { name: 'train.py' })).toBeTruthy();
    expect(composition?.querySelector('.artifact-detail__header-context')?.textContent).toContain('link · script');
    expect(composition?.querySelector('.artifact-detail__header-context')?.textContent).toContain('Created:');
    expect(composition?.querySelector('.artifact-detail__header-context')?.textContent).toContain('Updated:');
    expect(within(composition as HTMLElement).getByRole('button', { name: 'Artifact actions' })).toBeTruthy();
    fireEvent.click(within(composition as HTMLElement).getByRole('button', { name: 'Copy artifact series ref' }));
    fireEvent.click(selectorCopy);
    await waitFor(() => expect(writeText.mock.calls).toEqual([
      ['artifact-series:9ce270d'],
      ['artifact-version:e5dfd95'],
    ]));
    expect(detail?.contains(header as Node)).toBe(true);
    expect(detail?.contains(pane as Node)).toBe(true);
    expect(header?.nextElementSibling).toBe(notice);
    expect(notice?.nextElementSibling).toBe(pane);
    expect(pane?.contains(header as Node)).toBe(false);
    expect(pane?.querySelector('.artifact-detail__body')).toBeNull();
    expect(pane?.querySelector('.artifact-preview-frame')).toBeNull();
  });

  it('moves formatted and exact raw JSON state into the header actions menu', () => {
    const jsonContent = content({
      kind: 'json',
      media_type: 'application/json',
      preview: {
        encoding: 'utf-8',
        text: '{\n  "alpha": 1,\n  "beta": true\n}',
        raw_text: '{"alpha":1,"beta":true}',
        formatted: 'json',
        truncated: false,
      },
      download: {
        available: true,
        media_type: 'application/json',
        size_bytes: 23,
        filename: 'metrics.json',
      },
    });
    const { container } = renderArtifactDetail(jsonContent);

    const preview = container.querySelector('.artifact-preview');
    expect(preview?.classList.contains('artifact-preview--code')).toBe(true);
    expect(preview?.parentElement?.classList.contains('artifact-detail__pane')).toBe(true);
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
    expect(preview?.textContent).toContain('"beta": true');
    expect(screen.queryByText('Auto-formatted JSON')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show raw' })).toBeNull();
    expect(screen.queryByText('Editing is limited to safe text and Markdown artifacts.')).toBeNull();

    const actionsTrigger = screen.getByRole('button', { name: 'Artifact actions' });
    fireEvent.click(actionsTrigger);
    const formatted = screen.getByRole('menuitemradio', { name: 'Formatted JSON' });
    const raw = screen.getByRole('menuitemradio', { name: 'Raw JSON' });
    expect(formatted.getAttribute('aria-checked')).toBe('true');
    expect(raw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(raw);

    expect(container.querySelector('.artifact-preview')?.classList.contains('artifact-preview--code')).toBe(true);
    expect(container.querySelector('.artifact-preview')?.textContent).toBe('{"alpha":1,"beta":true}');

    fireEvent.click(actionsTrigger);
    expect(screen.getByRole('menuitemradio', { name: 'Formatted JSON' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('menuitemradio', { name: 'Raw JSON' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menuitemradio', { name: 'Raw JSON' })).toBeNull();
    expect(document.activeElement).toBe(actionsTrigger);
  });

  it('renders syntax-highlight markup for Python source previews', () => {
    const { container } = renderArtifactDetail(content());

    const code = container.querySelector('code.language-python');
    expect(code).toBeTruthy();
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('def');
  });

  it('explains partial JSON previews without syntax-highlighting the large slice', () => {
    const { container } = renderArtifactDetail(content({
      kind: 'json',
      media_type: 'application/json',
      size_bytes: 1024 * 1024,
      preview: {
        encoding: 'utf-8',
        text: '{"items":[1,2,3',
        truncated: true,
        preview_bytes: 15,
        total_bytes: 1024 * 1024,
        omitted_bytes: (1024 * 1024) - 15,
        format_skipped: 'partial_preview',
      },
      download: {
        available: true,
        media_type: 'application/json',
        size_bytes: 1024 * 1024,
        filename: 'large.json',
      },
    }));

    expect(container.querySelector('code.language-json')).toBeNull();
    expect(container.querySelector('.artifact-preview--partial')).toBeTruthy();
    expect(container.querySelector('.artifact-preview')?.textContent).toContain('{"items":[1,2,3');
    expect(screen.getByText(/Showing the first 15 B of 1\.0 MB/)).toBeTruthy();
    expect(screen.getByText(/Formatting and highlighting are skipped/)).toBeTruthy();
  });

  it('windows large code previews and offers full-preview copy', () => {
    const largePreview = Array.from({ length: 900 }, (_, index) => `line-${index.toString().padStart(4, '0')} ${'x'.repeat(140)}`).join('\n');
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { container } = renderArtifactDetail(content({
      kind: 'text',
      media_type: 'text/plain',
      size_bytes: largePreview.length,
      preview: {
        encoding: 'utf-8',
        text: largePreview,
        truncated: false,
        preview_bytes: largePreview.length,
        total_bytes: largePreview.length,
      },
      download: {
        available: true,
        media_type: 'text/plain',
        size_bytes: largePreview.length,
        filename: 'large.log',
      },
    }));

    expect(container.querySelector('.artifact-preview--virtualized')).toBeTruthy();
    expect(container.querySelectorAll('.artifact-preview__virtual-line').length).toBeLessThan(900);
    expect(screen.getByText(/Large preview windowed/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy full preview' }));

    expect(writeText).toHaveBeenCalledWith(largePreview);
  });
});
