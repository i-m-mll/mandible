// @vitest-environment jsdom
import { establishTestClientAccess } from './helpers/local-client-access';
import { cleanup, fireEvent, screen, waitFor } from './helpers/dom.js';
import { render } from './helpers/notice-test-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ArtifactContentResult,
  ArtifactRecord,
  ArtifactSeriesRecord,
  ArtifactVersionRecord,
} from '../ui/src/api';
import {
  ArtifactDetail,
  artifactPreview,
} from '../ui/src/views/artifacts';

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

  it('disables Briefing creation without an exact materializable Markdown selection', () => {
    renderArtifactDetail(content(), { selectedVersion: version(), selectedVersionNo: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    expect(screen.getByRole('menuitem', { name: 'Create briefing' })).toHaveProperty('disabled', true);
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
    expect(mockFetch).toHaveBeenCalledWith('/api/artifacts/drafts', expect.objectContaining({ method: 'POST' }));
  });

  it('resumes the content of a stale draft and offers stale-base actions', async () => {
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

    const editor = await screen.findByLabelText('Artifact editor');
    await waitFor(() => expect(editor.textContent).toContain('Stale draft'));
    expect(screen.getByRole('button', { name: 'Publish anyway' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rebase draft' })).toBeTruthy();
  });
});
