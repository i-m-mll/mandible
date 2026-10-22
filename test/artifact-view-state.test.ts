import { detailRequestKey, writePersistedDetail } from '../ui/src/detail-cache';
import { makeArtifactResolution } from "./helpers/artifact-resolution-fixtures";
import { changeSelect, installMemoryLocalStorage, makeArtifactFixture, makeArtifactSeries, jsonResponse, render } from './helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { ArtifactsView } from '../ui/src/views/artifacts';

describe('ArtifactsView', () => {
  it('replaces a removed saved series with the first available artifact', async () => {
    const artifact = makeArtifactFixture('e', 'available-report.md');
    const artifactSeries = makeArtifactSeries('available-report', [artifact], 'available-report.md');
    installMemoryLocalStorage({
      'mandible:artifacts:list-controls:v1': JSON.stringify({
        filters: {},
        sortField: 'updated',
        sortDirection: 'desc',
        selectedSeriesRef: 'artifact-series:removed',
        selectedVersionNo: null,
      }),
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) {
        const ref = new URLSearchParams(url.split('?')[1] ?? '').get('ref');
        if (ref === 'artifact-series:removed') {
          return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: artifact.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.includes(encodeURIComponent(artifact.id))) return jsonResponse({ artifact });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    expect(await screen.findByRole('heading', { name: 'available-report.md' })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(String(window.localStorage.getItem(
      'mandible:artifacts:list-controls:v1',
    ))).selectedSeriesRef).toBe(artifactSeries.summary.ref));
  });

  it('keeps an explicit missing series deep link visible instead of selecting a fallback', async () => {
    const artifact = makeArtifactFixture('a', 'available.md');
    const series = makeArtifactSeries('available', [artifact]);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [series.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return Promise.resolve(new Response(
        JSON.stringify({ error: 'Explicit series is missing' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ));
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));
    render(h(ArtifactsView, { initialSeriesRef: 'artifact-series:removed' }));
    expect(await screen.findByText('Explicit series is missing')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'available.md' })).toBeNull();
  });

  it.each(['valid', 'wrong record', 'wrong content', 'wrong fetched identity'] as const)(
    'hydrates coherent artifact caches before paint while revalidating (%s)', async (cacheCase) => {
      const artifact = makeArtifactFixture('a', 'cached.md');
      const series = makeArtifactSeries('cached-series', [artifact]);
      const content = {
        artifact_id: artifact.id, status: 'available', kind: 'text', media_type: 'text/markdown',
        size_bytes: 32, source: null, reason: null,
        preview: { encoding: 'utf-8', text: 'Cached selected preview', truncated: false },
        download: { available: false, media_type: 'text/markdown', size_bytes: 32, filename: null },
      };
      writePersistedDetail('artifact-versions', detailRequestKey('artifact-versions', { ref: series.summary.ref }), series.history);
      writePersistedDetail('artifact-record', detailRequestKey('artifact-record', { id: artifact.id }),
        cacheCase === 'wrong record' ? { ...artifact, id: 'other-artifact', metadata: { title: 'Wrong cached record' } } : artifact);
      writePersistedDetail('artifact-content', detailRequestKey('artifact-content', { id: artifact.id }),
        cacheCase === 'wrong content' ? { ...content, artifact_id: 'other-artifact', preview: { ...content.preview, text: 'Wrong cached content' } } : content);
      let finishRecord!: (value: Response) => void;
      let finishContent!: (value: Response) => void;
      const recordRead = new Promise<Response>((resolve) => { finishRecord = resolve; });
      const contentRead = new Promise<Response>((resolve) => { finishContent = resolve; });
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
        const url = String(input);
        if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [series.summary] });
        if (url.startsWith('/api/artifacts/versions?')) return new Promise<Response>(() => {});
        if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
        if (url.endsWith('/content')) return contentRead;
        if (url.includes(encodeURIComponent(artifact.id))) return recordRead;
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }));
      render(h(ArtifactsView, { initialSeriesRef: series.summary.ref }));
      expect(screen.queryByText('Wrong cached record')).toBeNull();
      expect(screen.queryByText('Wrong cached content')).toBeNull();
      if (cacheCase === 'valid' || cacheCase === 'wrong fetched identity') {
        expect(screen.getByRole('heading', { name: 'cached.md' })).toBeTruthy();
        expect(screen.getByText('Cached selected preview')).toBeTruthy();
      } else if (cacheCase === 'wrong record') {
        expect(screen.queryByRole('heading', { name: 'cached.md' })).toBeNull();
      } else {
        expect(screen.getByRole('heading', { name: 'cached.md' })).toBeTruthy();
        expect(screen.queryByText('Cached selected preview')).toBeNull();
      }
      await act(async () => {
        finishRecord(await jsonResponse({ artifact: cacheCase === 'wrong fetched identity' ? { ...artifact, id: 'other-artifact', metadata: { title: 'Wrong fetched record' } } : artifact }));
        finishContent(await jsonResponse({ content: { ...content, artifact_id: cacheCase === 'wrong fetched identity' ? 'other-artifact' : artifact.id, preview: { ...content.preview, text: 'Fresh selected preview' } } }));
      });
      if (cacheCase === 'wrong fetched identity') {
        expect(screen.getByText('Cached selected preview')).toBeTruthy();
        expect(screen.queryByText('Fresh selected preview')).toBeNull();
        expect(screen.queryByText('Wrong fetched record')).toBeNull();
      } else {
        expect(await screen.findByText('Fresh selected preview')).toBeTruthy();
      }
    },
  );

  it('shows artifact load failures once below the detail header', async () => {
    const artifact = makeArtifactFixture('d', 'failed-detail.md', {
      id: 'artifact:dddddddddddd',
    });
    const artifactSeries = makeArtifactSeries('failed-detail', [artifact], 'failed-detail.md');
    const notFound = () => Promise.resolve(new Response(JSON.stringify({ error: 'artifact not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: artifactSeries.history });
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.endsWith('/content')) return notFound();
      if (url.includes(encodeURIComponent(artifact.id))) return notFound();
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(screen.getAllByText('Artifact detail: artifact not found')).toHaveLength(1));
    const error = screen.getByText('Artifact detail: artifact not found');
    const header = document.querySelector('.artifact-detail__header');
    const body = document.querySelector('.artifact-detail__pane');
    const anchoredNotice = document.querySelector('#app-operational-notices');
    expect(header).toBeTruthy();
    expect(anchoredNotice?.contains(error)).toBe(true);
    expect(document.querySelector('.artifact-detail .detail-pane-notice')).toBeNull();
    expect(body?.contains(error)).toBe(false);
  });

  it('renders HumbleB knowledge backrefs in artifact detail', async () => {
    const artifact = {
      id: 'artifact:aaaaaaaaaaaa',
      algorithm: 'sha256',
      content_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      uri: 'artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: {
        title: 'demo-report.md',
        filename: 'demo-report.md',
      },
      pinned: true,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: { repo_id: 'mandible', path: 'reports/demo-report.md' },
      availability: 'present',
      retention: {},
      reference: {},
      created_at: Date.now(),
      aliases: [],
      links: [
        {
          id: 'link-pinned',
          artifact_id: 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          entity_type: 'issue',
          entity_id: 'abc123',
          link_type: 'evidence',
          role: null,
          repo_id: 'mandible',
          provider_id: null,
          source: 'artifact_registry',
          metadata: {},
          link_kind: 'pinned',
          series_id: 'artifact-series:demo-report',
          series_ref: 'artifact-series:demo-report',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        {
          id: 'link-living',
          artifact_id: 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          entity_type: 'issue',
          entity_id: 'def456',
          link_type: 'evidence',
          role: 'latest-evidence',
          repo_id: 'mandible',
          provider_id: null,
          source: 'artifact_registry',
          metadata: {},
          link_kind: 'living',
          series_id: 'artifact-series:demo-report',
          series_ref: 'artifact-series:demo-report',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
    };
    const artifactSeries = makeArtifactSeries('demo-report', [artifact], 'demo-report.md');
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: makeArtifactResolution({
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          }),
        });
      }
      if (url.endsWith('/content')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            content: {
              artifact_id: artifact.id,
              status: 'unavailable',
              kind: 'unavailable',
              media_type: 'text/markdown',
              size_bytes: 0,
              source: null,
              preview: null,
              download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
              reason: 'No inline preview is available.',
            },
          }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            backrefs: [
              {
                id: 'kb_1',
                source_type: 'artifact',
                source_id: artifact.id,
                provider_id: 'humbleb',
                ref_type: 'claim',
                external_id: 'claim_1',
                external_ref: 'humbleb://claims/claim_1',
                status: 'indexed',
                metadata: {},
                created_at: Date.now(),
                updated_at: Date.now(),
              },
            ],
          }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes(encodeURIComponent(artifact.id))) {
        return Promise.resolve(
          new Response(JSON.stringify({ artifact }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal('fetch', mockFetch);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => expect(screen.getByText('humbleb://claims/claim_1')).toBeTruthy());
    expect(screen.getAllByText('demo-report.md').length).toBeGreaterThan(0);
    const detailShell = document.querySelector('.artifact-detail');
    const detailHeader = document.querySelector('.artifact-detail__header');
    const detailBody = document.querySelector('.artifact-detail__pane');
    expect(detailShell?.classList.contains('detail-pane-shell')).toBe(true);
    expect(detailHeader?.classList.contains('detail-pane-shell__header')).toBe(true);
    expect(detailBody?.classList.contains('detail-pane-shell__body')).toBe(true);
    expect(detailHeader?.querySelector('.detail-pane-shell__header-primary > .detail-pane-header--versioned')).toBeTruthy();
    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('demo-report.md');
    expect(detailHeader?.textContent).not.toContain('present');
    expect(detailHeader?.textContent).not.toContain('pinned');
    const sidebarItem = screen.getByRole('button', { name: /demo-report\.md/ });
    expect(sidebarItem.textContent).not.toContain('present');
    expect(sidebarItem.textContent).not.toContain('pinned');
    expect(sidebarItem.querySelector('.artifacts-sidebar__badges')).toBeNull();
    const sidebarMeta = sidebarItem.querySelector('.artifacts-sidebar__meta');
    expect(sidebarMeta?.textContent).toContain('demo-re');
    expect(sidebarMeta?.textContent).toContain('report');
    const filterButton = screen.getByLabelText('Artifact filters');
    expect(filterButton.textContent).not.toContain('⋯');
    expect(filterButton.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('Knowledge Backrefs')).toBeTruthy();
    expect(screen.getByText('claim')).toBeTruthy();
    expect(screen.getByText('indexed')).toBeTruthy();
    const sectionHeadings = Array.from(document.querySelectorAll('.artifact-detail__section h3')).map((node) => node.textContent);
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull();
    expect(sectionHeadings).not.toContain('Identity');
    expect(sectionHeadings).not.toContain('Custody');
    expect(sectionHeadings[0]).toBe('Links');
    expect(sectionHeadings.indexOf('Links')).toBeLessThan(sectionHeadings.indexOf('Knowledge Backrefs'));
    expect(screen.getByRole('combobox', { name: 'Artifact version' })).toBeTruthy();
    expect(screen.queryByText('Version')).toBeNull();
    expect(detailHeader?.textContent).not.toContain('MANAGED ARTIFACT');
    expect(detailHeader?.textContent).toContain('demo-rep');
    expect(detailHeader?.textContent).not.toContain('mandible');
    expect(detailHeader?.querySelector('.artifact-detail__header-context')?.textContent).toContain('managed · report');
    expect(detailHeader?.querySelector('.artifact-detail__header-context')?.textContent).toContain('Created:');
    expect(detailHeader?.querySelector('.artifact-detail__header-context')?.textContent).toContain('Updated:');
    expect(detailBody?.querySelector('.artifact-detail__context')).toBeNull();
    const seriesCopyButton = screen.getByRole('button', { name: 'Copy artifact series ref' });
    fireEvent.click(seriesCopyButton);
    fireEvent.pointerUp(seriesCopyButton);
    expect(writeText).toHaveBeenCalledWith('artifact-series:demo-report');
    expect(seriesCopyButton.className).not.toContain('active');
    expect(document.activeElement).not.toBe(seriesCopyButton);
    const artifactCopyButton = screen.getByRole('button', { name: 'Copy selected artifact-version reference' });
    fireEvent.click(artifactCopyButton);
    fireEvent.pointerUp(artifactCopyButton);
    expect(writeText).toHaveBeenCalledWith('artifact-version:artifact-series:demo-report:1');
    expect(artifactCopyButton.className).not.toContain('active');
    expect(document.activeElement).not.toBe(artifactCopyButton);
    expect(document.querySelector('.artifact-detail__badge')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    const actionsMenu = screen.getByRole('menu');
    expect(actionsMenu.className).toContain('artifact-detail__actions-menu');
    expect((actionsMenu as HTMLElement).style.top).toBeTruthy();
    expect((actionsMenu as HTMLElement).style.left).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Add to Space' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Show metadata' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Version history' })).toBeTruthy();
    const detailScroller = document.querySelector('.artifact-detail__pane');
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getArtifactRect() {
      if (this.classList.contains('artifact-detail__pane')) {
        return {
          x: 376,
          y: 219,
          top: 219,
          right: 1123,
          bottom: 900,
          left: 376,
          width: 747,
          height: 681,
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
    if (detailScroller) detailScroller.scrollTop = 480;
    expect(detailScroller?.className).not.toContain('detail-pane-shell__body--overlay-open');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const metadataDialog = screen.getByRole('dialog', { name: 'Artifact metadata' });
    await waitFor(() => expect(detailScroller?.className).toContain('detail-pane-shell__body--overlay-open'));
    expect(detailScroller?.scrollTop).toBe(480);
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-top')).toBe('219px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-left')).toBe('376px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-right')).toBe('317px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-bottom')).toBe('0px');
    expect(document.querySelector('.artifact-detail')?.contains(metadataDialog)).toBe(true);
    expect(document.querySelector('.artifact-detail__pane')?.contains(metadataDialog)).toBe(false);
    expect(document.querySelector('.artifact-detail__body')).toBeNull();
    expect(within(metadataDialog).getByText('Identity')).toBeTruthy();
    expect(within(metadataDialog).getByText('Custody')).toBeTruthy();
    expect(within(metadataDialog).getByText('Short ID')).toBeTruthy();
    fireEvent.click(within(metadataDialog).getByTitle('Copy Short ID') as HTMLButtonElement);
    expect(writeText).toHaveBeenCalledWith(artifact.id);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Artifact metadata' })).toBeNull());
    await waitFor(() => expect(detailScroller?.className).not.toContain('detail-pane-shell__body--overlay-open'));
    rectSpy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
    const pinnedBadge = document.querySelector('a.artifact-link-badge--pinned') as HTMLAnchorElement | null;
    expect(pinnedBadge?.textContent).toBe('pinned');
    expect(pinnedBadge?.textContent).not.toContain('latest');
    expect(pinnedBadge?.getAttribute('href')).toBe(
      '#/artifacts?ref=artifact-blob%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const livingBadge = document.querySelector('a.artifact-link-badge--living') as HTMLAnchorElement | null;
    expect(livingBadge?.textContent).toBe('latest');
    expect(livingBadge?.getAttribute('href')).toBe('#/artifacts?series=artifact-series%3Ademo-report');
    const entityLink = screen.getByText('issue:abc123').closest('a') as HTMLAnchorElement | null;
    expect(entityLink?.getAttribute('href')).toBe('#/issues?issue=abc123&repo=mandible');
  });

  it('auto-formats compact JSON-like text previews with header-owned raw state', async () => {
    const artifact = makeArtifactFixture('9', 'metrics.txt', {
      media_type: 'text/plain',
      metadata: {
        title: 'metrics.txt',
        filename: 'metrics.txt',
      },
      home_repo_id: 'rlrmp',
      repo_locator: { repo_id: 'rlrmp', path: 'results/metrics.txt' },
    });
    const artifactSeries = makeArtifactSeries('metrics-text', [artifact], 'metrics.txt');
    const compact = '{"loss":0.125,"tags":["compact","json"]}';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: makeArtifactResolution({
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          }),
        });
      }
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: artifact.id,
            status: 'available',
            kind: 'text',
            media_type: 'text/plain',
            size_bytes: compact.length,
            source: { kind: 'managed_file', locator: 'artifact-storage' },
            preview: { encoding: 'utf-8', text: compact, truncated: false },
            download: { available: true, media_type: 'text/plain', size_bytes: compact.length, filename: 'metrics.txt' },
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(artifact.id))) return jsonResponse({ artifact });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => expect(document.querySelector('.artifact-preview code')?.textContent).toContain('\n  "loss": 0.125,'));
    expect(document.querySelector('.artifact-detail__repo')).toBeNull();
    const previewCode = document.querySelector('.artifact-preview code');
    expect(previewCode?.textContent).toContain('\n  "loss": 0.125,');
    expect(screen.queryByText('Auto-formatted JSON-like text')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show raw' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    expect(screen.getByRole('menuitemradio', { name: 'Formatted JSON' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Raw JSON' }));

    expect(document.querySelector('.artifact-preview code')?.textContent).toBe(compact);
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    expect(screen.getByRole('menuitemradio', { name: 'Raw JSON' }).getAttribute('aria-checked')).toBe('true');
  });

  // Obsolete standalone-blob preview contract: canonical blob navigation is covered below by explicit unsupported guidance (issue 7da339a).

  // Obsolete standalone-blob preview contract: canonical blob navigation is covered below by explicit unsupported guidance (issue 7da339a).

  it('keeps the sidebar list mounted when artifact selection changes', async () => {
    const makeArtifact = (hashChar: string, title: string) => ({
      id: `artifact:sha256:${hashChar.repeat(64)}`,
      algorithm: 'sha256',
      content_hash: hashChar.repeat(64),
      uri: `artifact:${hashChar.repeat(64)}`,
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: {
        title,
        filename: title,
      },
      pinned: false,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: {},
      availability: 'present',
      retention: {},
      reference: {},
      created_at: Date.now(),
      aliases: [],
      links: [],
    });
    const firstArtifact = makeArtifact('1', 'one.md');
    const secondArtifact = makeArtifact('2', 'two.md');
    const firstSeries = makeArtifactSeries('one-series', [firstArtifact], 'one.md');
    const secondSeries = makeArtifactSeries('two-series', [secondArtifact], 'two.md');
    let listCalls = 0;
    const contentCalls: string[] = [];
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        if (params.get('limit') === '200') listCalls += 1;
        if (params.get('limit') === '200' && listCalls > 1) {
          return new Promise<Response>(() => undefined);
        }
        return jsonResponse({ series: [firstSeries.summary, secondSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({
          history: url.includes('two-series') ? secondSeries.history : firstSeries.history,
        });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: makeArtifactResolution({
            status: 'resolved',
            ref: firstArtifact.id,
            scheme: 'artifact',
            normalized_ref: firstArtifact.id,
            artifact: firstArtifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          }),
        });
      }
      if (url.endsWith('/content')) {
        contentCalls.push(url);
        const artifact = url.includes(encodeURIComponent(secondArtifact.id)) ? secondArtifact : firstArtifact;
        return Promise.resolve(new Response(JSON.stringify({
          content: {
            artifact_id: artifact.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(firstArtifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact: firstArtifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(secondArtifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact: secondArtifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal('fetch', mockFetch);

    render(h(ArtifactsView, { initialArtifactId: firstArtifact.id }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('one.md'));
    await waitFor(() => expect(screen.getByRole('button', { name: /one\.md/ })).toBeTruthy());
    expect(listCalls).toBe(1);
    expect(screen.queryByText('Loading artifacts...')).toBeNull();

    const secondButton = screen.getByRole('button', { name: /two\.md/ });
    fireEvent.click(secondButton);

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('two.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(secondArtifact.id)))).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listCalls).toBe(1);
    expect(screen.queryByText('Loading artifacts...')).toBeNull();
    expect(screen.getByRole('button', { name: /one\.md/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /two\.md/ })).toBeTruthy();
  });

  it('uses lightweight list records and renders selected identity before preview content resolves', async () => {
    const summaryArtifact = {
      id: 'artifact:sha256:5555555555555555555555555555555555555555555555555555555555555555',
      algorithm: 'sha256',
      content_hash: '5555555555555555555555555555555555555555555555555555555555555555',
      uri: 'repo://mandible@main/results/fast-summary.md',
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: {
        title: 'fast-summary.md',
        filename: 'fast-summary.md',
      },
      pinned: false,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: { repo_id: 'mandible', ref: 'main', path: 'results/fast-summary.md' },
      availability: 'present',
      retention: {},
      reference: {},
      created_at: Date.now(),
      alias_schemes: ['artifact', 'repo'],
    };
    const artifactSeries = makeArtifactSeries('fast-summary', [summaryArtifact], 'fast-summary.md');
    const fullArtifact = {
      ...summaryArtifact,
      metadata: {
        ...summaryArtifact.metadata,
        nested: { full: true },
      },
      reference: { owner_system: 'repo' },
      aliases: [
        {
          id: 'alias-1',
          artifact_id: summaryArtifact.id,
          scheme: 'repo',
          alias: summaryArtifact.uri,
          normalized_ref: summaryArtifact.uri,
          locator: {},
          resolution_status: 'resolved',
          source: 'artifact_registry',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
      links: [],
    };
    let listUrl = '';
    let resolveDetail: (response: Response) => void = () => undefined;
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const contentPromise = new Promise<Response>(() => undefined);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        listUrl = url;
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.endsWith('/content')) {
        return contentPromise;
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(summaryArtifact.id))) {
        return detailPromise;
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(listUrl).toContain('summary=true'));
    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('fast-summary.md'));
    await waitFor(() => expect(screen.getAllByText('Loading preview...')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    expect(within(screen.getByRole('dialog', { name: 'Artifact metadata' })).getByText('repo://mandible@main/results/fast-summary.md')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Artifact metadata' })).toBeNull());

    await act(async () => {
      resolveDetail(new Response(JSON.stringify({ artifact: fullArtifact }), {
        headers: { 'content-type': 'application/json' },
      }));
    });

    await waitFor(() => expect(screen.queryByText('Locators')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const hydratedMetadata = screen.getByRole('dialog', { name: 'Artifact metadata' });
    await waitFor(() => expect(within(hydratedMetadata).getByText('Locators')).toBeTruthy());
    expect(within(hydratedMetadata).getAllByText(summaryArtifact.uri).length).toBeGreaterThan(1);
    expect(screen.getAllByText('Loading preview...')).toHaveLength(1);
  });

  it('renders the artifact list as soon as the list request resolves while preview content remains pending', async () => {
    const artifact = makeArtifactFixture('6', 'cold-load-report.md', {
      uri: 'repo://mandible@main/results/cold-load-report.md',
      repo_locator: { repo_id: 'mandible', ref: 'main', path: 'results/cold-load-report.md' },
      alias_schemes: ['artifact', 'repo'],
    });
    const artifactSeries = makeArtifactSeries('cold-load-report', [artifact], 'cold-load-report.md');
    let resolveList: (response: Response) => void = () => undefined;
    const listPromise = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const contentCalls: string[] = [];
    let listRequestSeen = false;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        if (url.includes('limit=200')) {
          listRequestSeen = true;
          return listPromise;
        }
        return jsonResponse({ series: [] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.endsWith('/content')) {
        contentCalls.push(url);
        return new Promise<Response>(() => undefined);
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return jsonResponse({ backrefs: [] });
      }
      if (url.includes(encodeURIComponent(artifact.id))) {
        return jsonResponse({ artifact });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(listRequestSeen).toBe(true));
    expect(contentCalls).toHaveLength(0);
    expect(screen.getByText('Loading artifacts...')).toBeTruthy();

    await act(async () => {
      resolveList(new Response(JSON.stringify({ series: [artifactSeries.summary] }), {
        headers: { 'content-type': 'application/json' },
      }));
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /cold-load-report\.md/ })).toBeTruthy());
    expect(screen.queryByText('Loading artifacts...')).toBeNull();
    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('cold-load-report.md'));
    await waitFor(() => expect(contentCalls).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText('Loading preview...')).toHaveLength(1));
  });

  it('starts artifact metadata and content requests in parallel for direct artifact links', async () => {
    const artifact = makeArtifactFixture('7', 'parallel-detail.md');
    const artifactSeries = makeArtifactSeries('parallel-detail', [artifact], 'parallel-detail.md');
    const calls: string[] = [];
    let resolveDetail: (response: Response) => void = () => undefined;
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: artifactSeries.history });
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: makeArtifactResolution({
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          }),
        });
      }
      if (url.endsWith('/content')) {
        return new Promise<Response>(() => undefined);
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(artifact.id))) return detailPromise;
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => {
      expect(calls.some((url) => url.includes(encodeURIComponent(artifact.id)) && !url.endsWith('/content'))).toBe(true);
      expect(calls.some((url) => url.endsWith('/content') && url.includes(encodeURIComponent(artifact.id)))).toBe(true);
    });

    await act(async () => {
      resolveDetail(new Response(JSON.stringify({ artifact }), {
        headers: { 'content-type': 'application/json' },
      }));
    });
  });

  it('ignores stale preview content when artifact selection changes early', async () => {
    const firstArtifact = makeArtifactFixture('1', 'early-one.md');
    const secondArtifact = makeArtifactFixture('2', 'early-two.md');
    const firstSeries = makeArtifactSeries('early-one-series', [firstArtifact], 'early-one.md');
    const secondSeries = makeArtifactSeries('early-two-series', [secondArtifact], 'early-two.md');
    let resolveFirstContent: (response: Response) => void = () => undefined;
    let resolveSecondContent: (response: Response) => void = () => undefined;
    const firstContent = new Promise<Response>((resolve) => {
      resolveFirstContent = resolve;
    });
    const secondContent = new Promise<Response>((resolve) => {
      resolveSecondContent = resolve;
    });
    const contentCalls: string[] = [];

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [firstSeries.summary, secondSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: url.includes('early-two-series') ? secondSeries.history : firstSeries.history });
      }
      if (url.endsWith('/content')) {
        contentCalls.push(url);
        return url.includes(encodeURIComponent(secondArtifact.id)) ? secondContent : firstContent;
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(firstArtifact.id))) return jsonResponse({ artifact: firstArtifact });
      if (url.includes(encodeURIComponent(secondArtifact.id))) return jsonResponse({ artifact: secondArtifact });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('early-one.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(firstArtifact.id)))).toBe(true));
    expect(screen.getAllByText('Loading preview...')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /early-two\.md/ }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('early-two.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(secondArtifact.id)))).toBe(true));

    resolveFirstContent(new Response(JSON.stringify({
      content: {
        artifact_id: firstArtifact.id,
        status: 'available',
        kind: 'text',
        media_type: 'text/plain',
        size_bytes: 16,
        source: { kind: 'managed_file', locator: 'artifact-storage' },
        preview: { encoding: 'utf-8', text: 'stale first preview', truncated: false },
        download: { available: true, media_type: 'text/plain', size_bytes: 16, filename: 'early-one.md' },
      },
    }), { headers: { 'content-type': 'application/json' } }));
    resolveSecondContent(new Response(JSON.stringify({
      content: {
        artifact_id: secondArtifact.id,
        status: 'available',
        kind: 'text',
        media_type: 'text/plain',
        size_bytes: 18,
        source: { kind: 'managed_file', locator: 'artifact-storage' },
        preview: { encoding: 'utf-8', text: 'current second preview', truncated: false },
        download: { available: true, media_type: 'text/plain', size_bytes: 18, filename: 'early-two.md' },
      },
    }), { headers: { 'content-type': 'application/json' } }));

    await waitFor(() => expect(screen.getByText('current second preview')).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText('stale first preview')).toBeNull();
    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('early-two.md');
  });



  it('keeps artifact facet options available after selecting a facet value', async () => {
    const storedViewState = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storedViewState.get(key) ?? null,
        setItem: (key: string, value: string) => storedViewState.set(key, value),
        removeItem: (key: string) => storedViewState.delete(key),
      },
    });
    const makeArtifact = (
      hashChar: string,
      title: string,
      role: string,
      repo: string,
      provider: string,
      custody: string,
      availability: string,
    ) => ({
      id: `artifact:sha256:${hashChar.repeat(64)}`,
      algorithm: 'sha256',
      content_hash: hashChar.repeat(64),
      uri: `repo://${repo}@main/results/${title}`,
      media_type: 'text/markdown',
      role,
      size_bytes: 42,
      provider_id: provider,
      manifest_id: null,
      metadata: {
        title,
        filename: title,
      },
      pinned: false,
      custody_mode: custody,
      home_repo_id: repo,
      repo_locator: { repo_id: repo, ref: 'main', path: `results/${title}` },
      availability,
      retention: {},
      reference: {},
      created_at: Date.now(),
      alias_schemes: ['repo'],
    });
    const inputArtifact = makeArtifact('6', 'input.md', 'input', 'repo-a', 'provider-a', 'linked', 'present');
    const outputArtifact = makeArtifact('7', 'output.md', 'output', 'repo-b', 'provider-b', 'managed', 'remote_only');
    const artifacts = [inputArtifact, outputArtifact];
    const seriesRows = [
      makeArtifactSeries('input-series', [inputArtifact], 'input.md').summary,
      makeArtifactSeries('output-series', [outputArtifact], 'output.md').summary,
    ];
    const listUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        listUrls.push(url);
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        let rows = seriesRows;
        const role = params.get('role');
        const repo = params.get('repo');
        if (role) rows = rows.filter((series) => series.latest_artifact?.role === role);
        if (repo) rows = rows.filter((series) => series.latest_artifact?.home_repo_id === repo);
        return jsonResponse({ series: rows });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        const artifact = url.includes('output-series') ? outputArtifact : inputArtifact;
        const seriesId = url.includes('output-series') ? 'output-series' : 'input-series';
        return jsonResponse({ history: makeArtifactSeries(seriesId, [artifact]).history });
      }
      if (url.endsWith('/content')) {
        return new Promise<Response>(() => undefined);
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      for (const artifact of artifacts) {
        if (url.includes(encodeURIComponent(artifact.id))) {
          return Promise.resolve(new Response(JSON.stringify({ artifact }), {
            headers: { 'content-type': 'application/json' },
          }));
        }
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(screen.getByRole('button', { name: /input\.md/ })).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Artifact filters'));

    const filterDialog = screen.getByRole('dialog', { name: 'Artifact filter and sort controls' });
    expect(filterDialog.classList.contains('sidebar-search-filter__panel--popover')).toBe(true);
    expect(filterDialog.classList.contains('sidebar-search-filter__panel--inline')).toBe(false);

    const sortField = screen.getByLabelText('Field') as HTMLSelectElement;
    changeSelect(sortField, 'title');
    fireEvent.click(screen.getByRole('button', { name: 'Descending' }));
    await waitFor(() => {
      const names = Array.from(document.querySelectorAll('.artifacts-sidebar__name')).map((node) => node.textContent);
      expect(names).toEqual(['output.md', 'input.md']);
    });
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('mandible:artifacts:list-controls:v1') ?? '{}');
      expect(stored.sortField).toBe('title');
      expect(stored.sortDirection).toBe('desc');
    });

    const roleSelect = screen.getByLabelText('Role') as HTMLSelectElement;
    const repoSelect = screen.getByLabelText('Repo') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(roleSelect.options).map((option) => option.value)).toEqual(['', 'input', 'output']);
    });
    expect(Array.from(repoSelect.options).map((option) => option.value)).toEqual(['', 'repo-a', 'repo-b']);

    changeSelect(roleSelect, 'output');

    await waitFor(() => expect(screen.getByRole('button', { name: /output\.md/ })).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('button', { name: /input\.md/ })).toBeNull());
    expect(Array.from(roleSelect.options).map((option) => option.value)).toEqual(['', 'input', 'output']);
    expect(Array.from(repoSelect.options).map((option) => option.value)).toEqual(['', 'repo-a', 'repo-b']);

    changeSelect(roleSelect, 'input');

    await waitFor(() => expect(screen.getByRole('button', { name: /input\.md/ })).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('button', { name: /output\.md/ })).toBeNull());
    expect(listUrls.length).toBeGreaterThan(1);
    expect(listUrls.every((url) => url.includes('summary=true'))).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Artifact filter and sort controls' })).toBeNull();
  });

  it('resolves direct artifact refs without selecting the first sidebar item', async () => {
    const listArtifact = {
      id: 'artifact:sha256:3333333333333333333333333333333333333333333333333333333333333333',
      algorithm: 'sha256',
      content_hash: '3333333333333333333333333333333333333333333333333333333333333333',
      uri: 'artifact:3333333333333333333333333333333333333333333333333333333333333333',
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: {
        title: 'sidebar-first.md',
        filename: 'sidebar-first.md',
      },
      pinned: false,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: {},
      availability: 'present',
      retention: {},
      reference: {},
      created_at: Date.now(),
      aliases: [],
      links: [],
    };
    const linkedArtifact = {
      ...listArtifact,
      id: 'artifact:sha256:4444444444444444444444444444444444444444444444444444444444444444',
      content_hash: '4444444444444444444444444444444444444444444444444444444444444444',
      uri: 'artifact:4444444444444444444444444444444444444444444444444444444444444444',
      metadata: {
        title: 'deep-link.md',
        filename: 'deep-link.md',
      },
    };
    const ref = 'repo://mandible@main/results/deep-link.md';
    const listSeries = makeArtifactSeries('sidebar-series', [listArtifact], 'sidebar-first.md');
    const linkedSeries = makeArtifactSeries('deep-link-series', [linkedArtifact], 'deep-link.md');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [listSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: linkedSeries.history });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return Promise.resolve(new Response(JSON.stringify({
          resolution: makeArtifactResolution({
            status: 'resolved',
            ref,
            scheme: 'repo',
            normalized_ref: ref,
            artifact: linkedArtifact,
            alias: null,
            series: linkedSeries.history.series,
            version: linkedSeries.history.versions[0],
            warnings: [],
          }),
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/content')) {
        return Promise.resolve(new Response(JSON.stringify({
          content: {
            artifact_id: linkedArtifact.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(linkedArtifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact: linkedArtifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialRef: ref }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('deep-link.md'));
    expect(await screen.findByText('sidebar-first.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    expect(within(screen.getByRole('dialog', { name: 'Artifact metadata' })).getByText(ref)).toBeTruthy();
  });

  it('pins legacy artifact deep links to the exact resolved version', async () => {
    const v1 = makeArtifactFixture('8', 'report-v1.md');
    const v2 = makeArtifactFixture('9', 'report-v2.md');
    const artifactSeries = makeArtifactSeries('report-series', [v1, v2], 'report.md');
    const versionRefs: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) {
        const ref = new URLSearchParams(url.split('?')[1] ?? '').get('ref') ?? '';
        versionRefs.push(ref);
        if (ref === v1.id || ref === artifactSeries.summary.ref) return jsonResponse({ history: artifactSeries.history });
        return Promise.reject(new Error(`unexpected versions ref ${ref}`));
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: makeArtifactResolution({
            status: 'resolved',
            ref: v1.id,
            scheme: 'artifact',
            normalized_ref: v1.id,
            artifact: v1,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          }),
        });
      }
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: v1.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(v1.id))) return jsonResponse({ artifact: v1 });
      if (url.includes(encodeURIComponent(v2.id))) return jsonResponse({ artifact: v2 });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: v1.id }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('report-v1.md'));
    const versionSelect = screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement;
    await waitFor(() => expect(versionSelect.value).toBe('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    expect(screen.getByRole('menuitem', { name: 'Jump to latest' })).toBeTruthy();
    expect(screen.queryByText('series_latest_not_pinned')).toBeNull();
    // The resolver supplies the exact saved version; history is fetched once by its logical identity.
    expect(versionRefs).toEqual([artifactSeries.summary.ref]);
    await waitFor(() => expect(versionRefs).toContain(artifactSeries.summary.ref));
    expect(versionRefs).not.toContain(`artifact-series:${artifactSeries.summary.ref}`);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    expect(within(screen.getByRole('dialog', { name: 'Artifact metadata' })).getByText(artifactSeries.summary.ref)).toBeTruthy();
  });

  it('keeps artifact-series @latest refs latest-tracking and shows the resolver warning badge', async () => {
    const v1 = makeArtifactFixture('a', 'latest-v1.md');
    const v2 = makeArtifactFixture('b', 'latest-v2.md');
    const artifactSeries = makeArtifactSeries('latest-series', [v1, v2], 'latest-report.md');
    const ref = 'artifact-series:latest-series@latest';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: artifactSeries.history });
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: makeArtifactResolution({
            status: 'resolved',
            ref,
            scheme: 'artifact-series',
            normalized_ref: ref,
            artifact: v2,
            alias: null,
            logical_artifact: { ...artifactSeries.history.series, id: 'artifact:latest-series' },
            artifact_version: artifactSeries.history.versions[1],
            warnings: ['series_latest_not_pinned'],
          }),
        });
      }
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: v2.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(v2.id))) return jsonResponse({ artifact: v2 });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: ref }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('latest-report.md'));
    expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('');
    expect(document.querySelector('.artifact-detail__badge')).toBeNull();
    expect(screen.getByText('series_latest_not_pinned')).toBeTruthy();
  });

  it.each([
    `artifact-blob:${'b'.repeat(64)}`,
    'artifact-version:version-1',
    `artifact:sha256:${'c'.repeat(64)}`,
  ])('rejects immutable typed refs supplied through series= without loading version history: %s', async (invalidSeriesRef) => {
    const versionRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [] });
      if (url.startsWith('/api/artifacts/versions?')) {
        versionRequests.push(url);
        return Promise.reject(new Error(`unexpected versions request ${url}`));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialSeriesRef: invalidSeriesRef, initialVersionNo: 1 }));

    await waitFor(() => expect(screen.getByText(`Invalid series reference: ${invalidSeriesRef}`)).toBeTruthy());
    expect(versionRequests).toEqual([]);
    expect(screen.getByText('No artifacts in this view.')).toBeTruthy();
  });

  it('ignores delayed version history after navigation clears the selected series', async () => {
    const artifact = makeArtifactFixture('e', 'stale-series.md');
    const artifactSeries = makeArtifactSeries('stale-series', [artifact], 'stale-series.md');
    let resolveHistory: (response: Response) => void = () => undefined;
    const delayedHistory = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    const versionRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [] });
      if (url.startsWith('/api/artifacts/versions?')) {
        versionRequests.push(url);
        return delayedHistory;
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    const { rerender } = render(h(ArtifactsView, { initialSeriesRef: artifactSeries.summary.ref }));
    await waitFor(() => expect(versionRequests).toHaveLength(1));

    const invalidSeriesRef = `artifact-blob:${artifact.content_hash}`;
    rerender(h(ArtifactsView, { initialSeriesRef: invalidSeriesRef }));
    await waitFor(() => expect(screen.getByText(`Invalid series reference: ${invalidSeriesRef}`)).toBeTruthy());

    resolveHistory(new Response(JSON.stringify({ history: artifactSeries.history }), {
      headers: { 'content-type': 'application/json' },
    }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('.artifact-detail h2')).toBeNull();
    expect(screen.getByText(`Invalid series reference: ${invalidSeriesRef}`)).toBeTruthy();
  });

  it.each(['blob', 'version', 'series'] as const)(
    'preserves canonical ref= %s selection semantics',
    async (kind) => {
      const v1 = makeArtifactFixture('4', 'typed-v1.md');
      const v2 = makeArtifactFixture('5', 'typed-v2.md');
      const artifactSeries = makeArtifactSeries('typed-series', [v1, v2], 'typed-report.md');
      const ref = kind === 'blob'
        ? `artifact-blob:${v1.content_hash}`
        : kind === 'version'
          ? artifactSeries.history.versions[0].id
          : 'artifact-series:typed-series@latest';
      const artifact = kind === 'series' ? v2 : v1;
      const version = kind === 'blob'
        ? undefined
        : kind === 'series'
          ? artifactSeries.history.versions[1]
          : artifactSeries.history.versions[0];
      const versionRequests: string[] = [];
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
        const url = String(input);
        if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
        if (url.startsWith('/api/artifacts/versions?')) {
          versionRequests.push(url);
          return jsonResponse({ history: artifactSeries.history });
        }
        if (url.startsWith('/api/artifacts/resolve?')) {
          return jsonResponse({
            resolution: makeArtifactResolution({
              status: 'resolved',
              ref,
              scheme: kind === 'series' ? 'artifact-series' : `artifact-${kind}`,
              normalized_ref: ref,
              target_type: kind === 'blob' ? 'artifact_blob' : kind === 'version' ? 'artifact_version' : 'artifact',
              artifact_blob: kind === 'blob' ? { id: ref, ref } : undefined,
              artifact,
              alias: null,
              logical_artifact: kind === 'blob' ? undefined : { ...artifactSeries.history.series, id: 'artifact:typed-series' },
              artifact_version: version,
              warnings: kind === 'series' ? ['series_latest_not_pinned'] : [],
            }),
          });
        }
        if (url.endsWith('/content')) {
          return jsonResponse({
            content: {
              artifact_id: artifact.id,
              status: 'unavailable',
              kind: 'unavailable',
              media_type: artifact.media_type,
              size_bytes: artifact.size_bytes,
              source: null,
              preview: null,
              download: { available: false, media_type: artifact.media_type, size_bytes: 0, filename: null },
              reason: 'No inline preview is available.',
            },
          });
        }
        if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }));

      render(h(ArtifactsView, { initialRef: ref }));

      if (kind === 'blob') {
        await screen.findByRole('heading', { name: ref });
        expect(screen.getByText(/Artifact blobs identify bytes/)).toBeTruthy();
        expect(screen.getByRole('link', { name: '7da339a' }).getAttribute('href')).toContain('issue=7da339a');
        expect(versionRequests).toEqual([]);
      } else {
        await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('typed-report.md'));
        await waitFor(() => expect(versionRequests).toHaveLength(1));
        await waitFor(() => {
          expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value)
            .toBe(kind === 'series' ? '' : '1');
        });
      }
    },
  );

  it('keeps artifact detail mounted while switching versions', async () => {
    const v1 = makeArtifactFixture('1', 'stable-v1.md');
    const v2 = makeArtifactFixture('2', 'stable-v2.md');
    const artifactSeries = makeArtifactSeries('stable-series', [v1, v2], 'stable-report.md');
    let resolveV2Detail: (response: Response) => void = () => undefined;
    const v2Detail = new Promise<Response>((resolve) => {
      resolveV2Detail = resolve;
    });
    const contentCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: artifactSeries.history });
      if (url.endsWith('/content')) {
        contentCalls.push(url);
        const artifact = url.includes(encodeURIComponent(v1.id)) ? v1 : v2;
        return jsonResponse({
          content: {
            artifact_id: artifact.id,
            status: 'available',
            kind: 'text',
            media_type: 'text/plain',
            size_bytes: artifact.id.length,
            source: { kind: 'managed_file', locator: 'artifact-storage' },
            preview: { encoding: 'utf-8', text: artifact.metadata.title, truncated: false },
            download: { available: true, media_type: 'text/plain', size_bytes: artifact.id.length, filename: null },
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(v1.id))) return jsonResponse({ artifact: v1 });
      if (url.includes(encodeURIComponent(v2.id))) return v2Detail;
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialSeriesRef: artifactSeries.summary.ref, initialVersionNo: 1 }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('stable-report.md'));
    await waitFor(() => expect(screen.getAllByText('stable-v1.md').length).toBeGreaterThan(0));

    changeSelect(screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement, '2');

    await waitFor(() => expect(screen.getByRole('status')?.textContent).toBe('Loading artifact...'));
    expect(document.querySelector('.artifact-detail h2')).toBeNull();
    expect(screen.queryByText('Loading preview...')).toBeNull();

    resolveV2Detail(new Response(JSON.stringify({ artifact: v2 }), {
      headers: { 'content-type': 'application/json' },
    }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('stable-report.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(v2.id)))).toBe(true));
  });

  it('keeps pinned version and open history stable when the series sidebar refetches with a newer latest', async () => {
    const v1 = makeArtifactFixture('c', 'pinned-v1.md');
    const v2 = makeArtifactFixture('d', 'pinned-v2.md');
    const v3 = makeArtifactFixture('e', 'pinned-v3.md');
    const initialSeries = makeArtifactSeries('pinned-series', [v1, v2], 'pinned-report.md');
    const refreshedSeries = makeArtifactSeries('pinned-series', [v1, v2, v3], 'pinned-report.md');
    let seriesCalls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        seriesCalls += 1;
        return jsonResponse({ series: [seriesCalls > 2 ? refreshedSeries.summary : initialSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: initialSeries.history });
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: v1.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(v1.id))) return jsonResponse({ artifact: v1 });
      if (url.includes(encodeURIComponent(v2.id))) return jsonResponse({ artifact: v2 });
      if (url.includes(encodeURIComponent(v3.id))) return jsonResponse({ artifact: v3 });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialSeriesRef: 'artifact-series:pinned-series', initialVersionNo: 1 }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('pinned-report.md'));
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Version history' }));
    expect(screen.getAllByText('v1').length).toBeGreaterThan(0);

    fireEvent.input(screen.getByPlaceholderText('Search artifacts'), { target: { value: 'pinned' } });

    await waitFor(() => expect(seriesCalls).toBeGreaterThan(2));
    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('pinned-report.md');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('1'));
    expect(screen.getAllByText('v1').length).toBeGreaterThan(0);
    const pinnedRow = screen.getByRole('button', { name: /pinned-report\.md/ });
    expect(pinnedRow.textContent).toContain('pinned-');
    expect(pinnedRow.textContent).toContain('report');
    expect(pinnedRow.textContent).not.toContain('v3');
  });

  it('ignores self-written series hash updates but reconciles external series changes', async () => {
    const firstArtifact = makeArtifactFixture('f', 'hash-self-v1.md');
    const secondArtifact = makeArtifactFixture('0', 'hash-self-v2.md', {
      id: `artifact:sha256:${'10'.repeat(32)}`,
      content_hash: '10'.repeat(32),
      uri: `artifact:${'10'.repeat(32)}`,
    });
    const firstSeries = makeArtifactSeries('hash-self-first', [firstArtifact], 'hash-self-v1.md');
    const secondSeries = makeArtifactSeries('hash-self-second', [secondArtifact], 'hash-self-v2.md');
    const artifactById = new Map([
      [firstArtifact.id, firstArtifact],
      [secondArtifact.id, secondArtifact],
    ]);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [firstSeries.summary, secondSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) {
        const ref = new URLSearchParams(url.split('?')[1] ?? '').get('ref');
        if (ref === firstSeries.summary.ref) return jsonResponse({ history: firstSeries.history });
        if (ref === secondSeries.summary.ref) return jsonResponse({ history: secondSeries.history });
        return Promise.reject(new Error(`unexpected versions ref ${ref}`));
      }
      if (url.endsWith('/content')) {
        const artifact = [...artifactById.values()].find((candidate) => url.includes(encodeURIComponent(candidate.id))) ?? firstArtifact;
        return jsonResponse({
          content: {
            artifact_id: artifact.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      for (const [id, artifact] of artifactById) {
        if (url.includes(encodeURIComponent(id))) return jsonResponse({ artifact });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    const { rerender } = render(h(ArtifactsView, {}));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('hash-self-v1.md'));
    fireEvent.click(screen.getByRole('button', { name: /hash-self-v2\.md/ }));
    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('hash-self-v2.md'));

    rerender(h(ArtifactsView, { initialSeriesRef: secondSeries.summary.ref }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('hash-self-v2.md');
    expect(screen.queryByText('No artifacts in this view.')).toBeNull();

    rerender(h(ArtifactsView, { initialSeriesRef: firstSeries.summary.ref, initialVersionNo: 1 }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('hash-self-v1.md'));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('1'));
  });

  it('renders bundle artifacts as member navigation before manifest JSON', async () => {
    const bundleId = 'artifact:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const memberId = 'artifact:sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const artifact = {
      id: bundleId,
      algorithm: 'sha256',
      content_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      uri: 'artifact:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      media_type: 'application/vnd.mandible.artifact-bundle+json',
      role: 'artifact_bundle',
      size_bytes: 160,
      provider_id: null,
      manifest_id: null,
      metadata: {
        title: 'run packet',
        bundle: true,
      },
      pinned: false,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: {},
      availability: 'present',
      retention: {},
      reference: { identity_kind: 'artifact_bundle' },
      created_at: Date.now(),
      aliases: [],
      links: [],
    };
    const artifactSeries = makeArtifactSeries('bundle-series', [artifact], 'run packet');
    const manifest = JSON.stringify({
      schema_version: 'mandible.artifact_bundle.v1',
      name: 'run packet',
      members: [
        { artifact_id: memberId, role: 'figure', order: 0, recoverability: 'repo_commit' },
      ],
    }, null, 2);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: makeArtifactResolution({
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          }),
        });
      }
      if (url.endsWith('/content')) {
        return Promise.resolve(new Response(JSON.stringify({
          content: {
            artifact_id: artifact.id,
            status: 'available',
            kind: 'json',
            media_type: 'application/vnd.mandible.artifact-bundle+json',
            size_bytes: manifest.length,
            source: { kind: 'managed_file', locator: 'artifact-storage' },
            preview: { encoding: 'utf-8', text: manifest, truncated: false },
            download: {
              available: true,
              media_type: 'application/vnd.mandible.artifact-bundle+json',
              size_bytes: manifest.length,
              filename: 'run-packet.json',
            },
          },
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(artifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => expect(screen.getByText(memberId)).toBeTruthy());
    const memberLink = screen.getByText(memberId).closest('a') as HTMLAnchorElement | null;
    expect(memberLink?.getAttribute('href')).toBe(
      `#/artifacts?ref=${encodeURIComponent(memberId.replace(/^artifact:sha256:/, 'artifact-blob:'))}`,
    );
    expect(screen.getByText('figure')).toBeTruthy();
    expect(screen.getByText('repo_commit')).toBeTruthy();
    expect(screen.getByText('Manifest JSON')).toBeTruthy();
  });
});


