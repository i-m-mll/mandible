import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  ArtifactContentResult,
  ArtifactRecord,
  ArtifactSeriesRecord,
} from '../ui/src/api';
import {
  ArtifactDetail,
  artifactHighlightLanguage,
  artifactPreview,
  highlightArtifactCode,
} from '../ui/src/views/artifacts';

afterEach(() => {
  cleanup();
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
    source: null,
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

function renderArtifactDetail(nextContent: ArtifactContentResult | null = content()) {
  return render(
    <ArtifactDetail
      artifact={artifact()}
      resolution={null}
      series={series()}
      versions={[]}
      selectedVersion={null}
      selectedVersionNo={null}
      versionHistoryOpen={false}
      onVersionChange={() => undefined}
      onToggleVersionHistory={() => undefined}
      onCloseVersionHistory={() => undefined}
      content={nextContent}
      contentLoading={false}
      contentError={null}
      knowledgeBackrefs={[]}
      knowledgeLoading={false}
      knowledgeError={null}
    />,
  );
}

describe('artifact preview helpers', () => {
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
});

describe('ArtifactDetail artifact preview rendering', () => {
  it('keeps custody and role metadata out of the header eyebrow', () => {
    const { container } = renderArtifactDetail(null);
    const eyebrow = container.querySelector('.artifact-detail__eyebrow');
    const header = container.querySelector('.artifact-detail__header');
    const pane = container.querySelector('.artifact-detail__pane');
    const body = container.querySelector('.artifact-detail__body');

    expect(eyebrow?.textContent).toContain('rlrmp');
    expect(eyebrow?.textContent).toContain('156f240');
    expect(eyebrow?.textContent).not.toContain('link');
    expect(eyebrow?.textContent).not.toContain('script');
    expect(pane?.contains(header as Node)).toBe(false);
    expect(pane?.contains(body as Node)).toBe(true);
  });

  it('shows compact raw JSON after toggling without changing the code preview surface', () => {
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
    expect(preview?.textContent).toContain('"beta": true');

    fireEvent.click(screen.getByRole('button', { name: 'Show raw' }));

    expect(container.querySelector('.artifact-preview')?.classList.contains('artifact-preview--code')).toBe(true);
    expect(container.querySelector('.artifact-preview')?.textContent).toContain('{"alpha":1,"beta":true}');
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
    expect(container.querySelector('.artifact-preview')?.textContent).toContain('{"items":[1,2,3');
    expect(screen.getByText(/Showing the first 15 B of 1\.0 MB/)).toBeTruthy();
    expect(screen.getByText(/Formatting and highlighting are skipped/)).toBeTruthy();
  });
});
