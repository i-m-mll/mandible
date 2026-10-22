import { detailRequestKey, writePersistedDetail } from '../ui/src/detail-cache';
import { makeArtifactResolution } from "./helpers/artifact-resolution-fixtures";
import { makeArtifactFixture, makeArtifactSeries, jsonResponse, render } from './helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, act, within } from './helpers/dom.js';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { ArtifactsView } from '../ui/src/views/artifacts';

const selectedTitle = () => screen.queryByRole('heading', { level: 2 });

describe('ArtifactsView', () => {
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

  // Obsolete standalone-blob preview contract: canonical blob navigation is covered below by explicit unsupported guidance (issue 7da339a).

  // Obsolete standalone-blob preview contract: canonical blob navigation is covered below by explicit unsupported guidance (issue 7da339a).

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

    await waitFor(() => expect(selectedTitle()?.textContent).toBe('early-one.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(firstArtifact.id)))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /early-two\.md/ }));

    await waitFor(() => expect(selectedTitle()?.textContent).toBe('early-two.md'));
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
    expect(selectedTitle()?.textContent).toBe('early-two.md');
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

    await waitFor(() => expect(selectedTitle()?.textContent).toBe('deep-link.md'));
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

    await waitFor(() => expect(selectedTitle()?.textContent).toBe('report-v1.md'));
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

    await waitFor(() => expect(screen.getByText((text) => text.includes(invalidSeriesRef))).toBeTruthy());
    expect(versionRequests).toEqual([]);
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
    await waitFor(() => expect(screen.getByText((text) => text.includes(invalidSeriesRef))).toBeTruthy());

    resolveHistory(new Response(JSON.stringify({ history: artifactSeries.history }), {
      headers: { 'content-type': 'application/json' },
    }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(selectedTitle()).toBeNull();
    expect(screen.getByText(`Invalid series reference: ${invalidSeriesRef}`)).toBeTruthy();
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

    await waitFor(() => expect(selectedTitle()?.textContent).toBe('pinned-report.md'));
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Version history' }));
    expect(screen.getAllByText('v1').length).toBeGreaterThan(0);

    fireEvent.input(screen.getByPlaceholderText('Search artifacts'), { target: { value: 'pinned' } });

    await waitFor(() => expect(seriesCalls).toBeGreaterThan(2));
    expect(selectedTitle()?.textContent).toBe('pinned-report.md');
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

    await waitFor(() => expect(selectedTitle()?.textContent).toBe('hash-self-v1.md'));
    fireEvent.click(screen.getByRole('button', { name: /hash-self-v2\.md/ }));
    await waitFor(() => expect(selectedTitle()?.textContent).toBe('hash-self-v2.md'));

    rerender(h(ArtifactsView, { initialSeriesRef: secondSeries.summary.ref }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(selectedTitle()?.textContent).toBe('hash-self-v2.md');

    rerender(h(ArtifactsView, { initialSeriesRef: firstSeries.summary.ref, initialVersionNo: 1 }));

    await waitFor(() => expect(selectedTitle()?.textContent).toBe('hash-self-v1.md'));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('1'));
  });
});
