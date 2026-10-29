// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from './helpers/dom';
import { issueDetailProjection, makeArtifactFixture, makeArtifactSeries, render } from './helpers/ui-workspace-fixture';
import { makeArtifactResolution } from './helpers/artifact-resolution-fixtures';
import { AppShellProvider, useAppShell } from '../ui/src/app-shell';
import { GraphDetailPane } from '../ui/src/views/graph';
import { ArtifactReferenceDetail, IssueReferenceDetail } from '../ui/src/views/reference-detail';
import { ArtifactsView } from '../ui/src/views/artifacts';
import { invalidateDashboardApiCacheForEvent, invalidateDashboardCaches } from '../ui/src/api';
import { writePersistedDetail } from '../ui/src/detail-cache';
import { detailKeys } from '../ui/src/query/detailKeys';

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Active({ active, children }: { active: boolean; children: preact.ComponentChildren }) {
  const shell = useAppShell();
  return <AppShellProvider value={{ ...shell, active }}>{children}</AppShellProvider>;
}

const issueId = 'a'.repeat(64);
const node = { id: issueId, type: 'issue', label: 'Issue', detail: { ledger_issue_id: issueId } };
const issue = (title: string) => issueDetailProjection({ displayId: issueId, title, body: `${title} body`, comments: [`${title} comment`] });

describe('live issue detail ownership', () => {
  it('keeps a posted Graph comment when an older same-key refresh completes late', async () => {
    const oldRead = deferred<Response>();
    const posted = issueDetailProjection({ displayId: issueId, title: 'Commented issue', body: 'Issue body', comments: ['Posted comment'] });
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(json(posted));
      reads += 1;
      return reads === 1 ? Promise.resolve(json({ ...posted, comments: [], timeline: [] })) : oldRead.promise;
    }));
    render(<GraphDetailPane node={node} edges={[]} onNavigate={() => undefined} />);
    expect(await screen.findByRole('heading', { name: 'Commented issue' })).toBeTruthy();
    await act(async () => invalidateDashboardApiCacheForEvent('ledger:issue:updated'));
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Add Comment' }));
    fireEvent.input(screen.getByPlaceholderText('Write a comment...'), { target: { value: 'Posted comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Comment' }));
    expect(await screen.findByText('Posted comment')).toBeTruthy();
    await act(async () => oldRead.resolve(json({ ...posted, comments: [], timeline: [] })));
    expect(screen.getByText('Posted comment')).toBeTruthy();
  });

  it('reconciles Graph and Spaces through the production event boundary, retaining content, draft and scroll', async () => {
    let next = deferred<Response>();
    const fetcher = vi.fn(() => next.promise);
    vi.stubGlobal('fetch', fetcher);
    const view = render(<>
      <div data-testid="graph"><GraphDetailPane node={node} edges={[]} onNavigate={() => undefined} /></div>
      <div data-testid="reference"><IssueReferenceDetail issueRef={issueId} repoId="mandible" /></div>
    </>);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    next.resolve(json(issue('Before')));
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Before' })).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Add Comment' }));
    const draft = screen.getByPlaceholderText('Write a comment...') as HTMLTextAreaElement;
    fireEvent.input(draft, { target: { value: 'Local draft' } });
    const body = document.querySelector('.graph-detail-pane .detail-pane-shell__body') as HTMLElement;
    expect(body).toBeTruthy();
    body.scrollTop = 71;
    next = deferred<Response>();
    await act(async () => invalidateDashboardApiCacheForEvent('ledger:comment:added'));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('heading', { name: 'Before' })).toHaveLength(2);
    expect(draft.value).toBe('Local draft');
    next.resolve(json(issue('After')));
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'After' })).toHaveLength(2));
    expect(screen.getAllByText('After body')).toHaveLength(2);
    expect(screen.getAllByText('After comment')).toHaveLength(2);
    expect(screen.getByPlaceholderText('Write a comment...')).toBe(draft);
    expect(draft.value).toBe('Local draft');
    expect(body.scrollTop).toBe(71);
    next = deferred<Response>();
    await act(async () => invalidateDashboardApiCacheForEvent('ledger:issue:updated'));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    next.resolve(json({ error: 'Temporary failure' }, 503));
    await screen.findAllByText('Temporary failure');
    expect(screen.getAllByRole('heading', { name: 'After' })).toHaveLength(2);
    expect(draft.value).toBe('Local draft');
    view.unmount();
  });

  it('shares a same-key request until the final observer leaves, and isolates a late old selection', async () => {
    const reads = new Map<string, ReturnType<typeof deferred<Response>>>();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo, init?: RequestInit) => {
      const id = decodeURIComponent(String(input).split('/').pop()!);
      const read = reads.get(id) ?? deferred<Response>();
      reads.set(id, read);
      signals.push(init!.signal!);
      return read.promise;
    }));
    const secondId = 'b'.repeat(64);
    const view = render(<><IssueReferenceDetail issueRef={issueId} /><IssueReferenceDetail issueRef={issueId} /></>);
    await waitFor(() => expect(signals).toHaveLength(1));
    view.rerender(<><IssueReferenceDetail issueRef={issueId} /></>);
    expect(signals[0].aborted).toBe(false);
    view.rerender(<><IssueReferenceDetail issueRef={secondId} /></>);
    await waitFor(() => expect(reads.has(secondId)).toBe(true));
    reads.get(secondId)!.resolve(json({ ...issue('Selected B'), id: secondId, display_id: secondId }));
    expect(await screen.findByRole('heading', { name: 'Selected B' })).toBeTruthy();
    await act(async () => reads.get(issueId)!.resolve(json(issue('Late A'))));
    expect(screen.queryByRole('heading', { name: 'Late A' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Selected B' })).toBeTruthy();
  });

  it('defers hidden event bursts and reconnect reads, then converges once on activation', async () => {
    let title = 'Initial';
    const fetcher = vi.fn(() => Promise.resolve(json(issue(title))));
    vi.stubGlobal('fetch', fetcher);
    const pane = (active: boolean) => <Active active={active}><IssueReferenceDetail issueRef={issueId} /></Active>;
    const view = render(pane(true));
    expect(await screen.findByRole('heading', { name: 'Initial' })).toBeTruthy();
    view.rerender(pane(false));
    title = 'While hidden';
    await act(async () => {
      for (let i = 0; i < 5; i++) invalidateDashboardApiCacheForEvent('ledger:issue:updated');
      invalidateDashboardCaches();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender(pane(true));
    expect(await screen.findByRole('heading', { name: 'While hidden' })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
    title = 'After reconnect';
    await act(async () => invalidateDashboardCaches());
    expect(await screen.findByRole('heading', { name: 'After reconnect' })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('live artifact detail ownership', () => {
  it.each(['pending', 'failed'] as const)('retains a cold-restored version when newer history arrives during %s old revalidation', async (oldReadState) => {
    const first = makeArtifactFixture('a', 'Restored.md');
    const second = makeArtifactFixture('b', 'Published.md');
    const original = makeArtifactSeries('cold-series', [first], 'Cold report');
    const published = makeArtifactSeries('cold-series', [first, second], 'Cold report');
    const content = (artifact: typeof first, text: string) => ({
      artifact_id: artifact.id, status: 'available', kind: 'text', media_type: 'text/markdown', size_bytes: 20,
      source: null, reason: null, preview: { encoding: 'utf-8', text, truncated: false },
      download: { available: false, media_type: 'text/markdown', size_bytes: 20, filename: null },
    });
    writePersistedDetail('artifact-query-snapshot', JSON.stringify(detailKeys.versions(original.summary.ref)), original.history);
    writePersistedDetail('artifact-query-snapshot', JSON.stringify(detailKeys.record(first.id)), first);
    writePersistedDetail('artifact-query-snapshot', JSON.stringify(detailKeys.content(first.id)), content(first, 'Restored preview'));
    const history = deferred<Response>();
    const oldRecord = deferred<Response>();
    const oldContent = deferred<Response>();
    const newRecord = deferred<Response>();
    const newContent = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/artifacts/series') return Promise.resolve(json({ series: [published.summary] }));
      if (url.pathname === '/api/artifacts/versions') return history.promise;
      if (url.pathname === '/api/artifacts/drafts') return Promise.resolve(json({ draft: null }));
      if (url.pathname.endsWith('/knowledge-backrefs')) return Promise.resolve(json({ backrefs: [] }));
      const old = decodeURIComponent(url.pathname).includes(first.id);
      if (url.pathname.endsWith('/content')) return old ? oldContent.promise : newContent.promise;
      if (url.pathname === `/api/artifacts/${encodeURIComponent(old ? first.id : second.id)}`) return old ? oldRecord.promise : newRecord.promise;
      return Promise.reject(new Error(`Unexpected cold-restart request: ${url.pathname}`));
    }));
    render(<ArtifactsView initialSeriesRef={original.summary.ref} />);
    expect(screen.getByText('Restored preview')).toBeTruthy();
    const body = document.querySelector('.artifact-detail .detail-pane-shell__body') as HTMLElement;
    body.scrollTop = 59;
    if (oldReadState === 'failed') {
      await act(async () => {
        oldRecord.resolve(json({ error: 'Old record unavailable' }, 503));
        oldContent.resolve(json({ error: 'Old content unavailable' }, 503));
      });
      await screen.findByText(/Old record unavailable/);
    }
    await act(async () => history.resolve(json({ history: published.history })));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Artifact version' }).querySelectorAll('option')).toHaveLength(3));
    expect(screen.getByText('Restored preview')).toBeTruthy();
    expect(document.querySelector('.artifact-detail .detail-pane-shell__body')).toBe(body);
    expect(body.scrollTop).toBe(59);
    newRecord.resolve(json({ artifact: second }));
    if (oldReadState === 'pending') {
      await act(async () => {
        oldRecord.resolve(json({ error: 'Late old record failure' }, 503));
        oldContent.resolve(json({ error: 'Late old content failure' }, 503));
      });
    }
    expect(screen.getByText('Restored preview')).toBeTruthy();
    newContent.resolve(json({ content: content(second, 'Published preview') }));
    expect(await screen.findByText('Published preview')).toBeTruthy();
    expect(screen.queryByText('Restored preview')).toBeNull();
  });

  it('updates list, history, latest and backrefs while a pinned reference retains its content', async () => {
    const first = makeArtifactFixture('c', 'First.md');
    const second = makeArtifactFixture('d', 'Second.md');
    const original = makeArtifactSeries('live-series', [first], 'Shared report');
    const published = makeArtifactSeries('live-series', [first, second], 'Shared report');
    const unrelated = makeArtifactSeries('unrelated-series', [makeArtifactFixture('e', 'Other.md')], 'Other report');
    unrelated.summary.updated_at += 100_000;
    let current = original;
    let backref = 'original-external-ref';
    let secondContent = deferred<Response>();
    const clipboard = vi.fn(async (_value: string) => undefined);
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText: clipboard } } }));
    const fetcher = vi.fn((input: RequestInfo) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/artifacts/series') return Promise.resolve(json({ series: current === original
        ? [current.summary] : [unrelated.summary, current.summary] }));
      if (url.pathname === '/api/artifacts/versions') return Promise.resolve(json({ history: current.history }));
      if (url.pathname === '/api/artifacts/drafts') return Promise.resolve(json({ draft: null }));
      if (url.pathname === '/api/artifacts/resolve') return Promise.resolve(json({ resolution: makeArtifactResolution({
        status: 'resolved', ref: first.id, target_type: 'artifact_version', artifact: first,
        series: original.history.series, version: original.history.versions[0], warnings: [],
      }) }));
      const artifact = decodeURIComponent(url.pathname).includes(second.id) ? second : first;
      if (url.pathname.endsWith('/content') && artifact === second) return secondContent.promise.then((response) => response.clone());
      if (url.pathname.endsWith('/content')) return Promise.resolve(json({ content: {
        artifact_id: artifact.id, status: 'available', kind: 'text', media_type: 'text/markdown', size_bytes: 20,
        source: null, reason: null, preview: { encoding: 'utf-8', text: artifact === first ? 'First preview' : 'Second preview', truncated: false },
        download: { available: false, media_type: 'text/markdown', size_bytes: 20, filename: null },
      } }));
      if (url.pathname.endsWith('/knowledge-backrefs')) return Promise.resolve(json({ backrefs: [{
        id: 'backref-1', external_ref: backref, external_id: backref, ref_type: 'document', provider_id: 'test', status: 'active',
      }] }));
      if (url.pathname === `/api/artifacts/${encodeURIComponent(artifact.id)}`) return Promise.resolve(json({ artifact }));
      return Promise.reject(new Error(`Unexpected artifact request: ${url.pathname}`));
    });
    vi.stubGlobal('fetch', fetcher);
    const pane = (active: boolean) => <Active active={active}>
      <div data-testid="latest"><ArtifactsView /></div>
      <div data-testid="pinned"><ArtifactReferenceDetail artifactRef={first.id} /></div>
    </Active>;
    const view = render(pane(true));
    const latest = within(screen.getByTestId('latest'));
    const pinned = within(screen.getByTestId('pinned'));
    expect(await latest.findByText('First preview')).toBeTruthy();
    expect(await pinned.findByText('First preview')).toBeTruthy();
    const firstContentPath = `/api/artifacts/${encodeURIComponent(first.id)}/content`;
    expect(fetcher.mock.calls.filter(([input]) => String(input) === firstContentPath)).toHaveLength(1);
    const beforeUnrelated = fetcher.mock.calls.length;
    await act(async () => invalidateDashboardApiCacheForEvent('conversation:message:added'));
    expect(fetcher).toHaveBeenCalledTimes(beforeUnrelated);
    current = published;
    backref = 'published-external-ref';
    await act(async () => invalidateDashboardApiCacheForEvent('artifact:version-published'));
    await waitFor(() => expect(latest.getByRole('combobox', { name: 'Artifact version' }).querySelectorAll('option')).toHaveLength(3));
    expect(latest.getByText('First preview')).toBeTruthy();
    const latestCopy = latest.getByRole('button', { name: 'Copy selected artifact-version reference' });
    fireEvent.click(latestCopy);
    expect(clipboard).toHaveBeenLastCalledWith(first.id);
    secondContent.resolve(json({ error: 'Published content temporarily unavailable' }, 503));
    await screen.findByText(/Published content temporarily unavailable/);
    expect(latest.getByText('First preview')).toBeTruthy();
    fireEvent.click(latestCopy);
    expect(clipboard).toHaveBeenLastCalledWith(first.id);
    secondContent = deferred<Response>();
    await act(async () => invalidateDashboardApiCacheForEvent('artifact:changed'));
    fireEvent.change(latest.getByRole('combobox', { name: 'Artifact version' }), { target: { value: '1' } });
    secondContent.resolve(json({ content: {
      artifact_id: second.id, status: 'available', kind: 'text', media_type: 'text/markdown', size_bytes: 20,
      source: null, reason: null, preview: { encoding: 'utf-8', text: 'Second preview', truncated: false },
      download: { available: false, media_type: 'text/markdown', size_bytes: 20, filename: null },
    } }));
    await act(async () => { await secondContent.promise; });
    expect(latest.getByText('First preview')).toBeTruthy();
    expect(latest.queryByText('Second preview')).toBeNull();
    fireEvent.change(latest.getByRole('combobox', { name: 'Artifact version' }), { target: { value: '' } });
    expect(await latest.findByText('Second preview')).toBeTruthy();
    fireEvent.click(latestCopy);
    expect(clipboard).toHaveBeenLastCalledWith(second.id);
    expect(pinned.getByText('First preview')).toBeTruthy();
    expect(pinned.queryByText('Second preview')).toBeNull();
    await waitFor(() => expect(pinned.getByRole('combobox', { name: 'Artifact version' }).querySelectorAll('option')).toHaveLength(3));
    expect(await pinned.findByText('published-external-ref')).toBeTruthy();
    expect(await latest.findByText('published-external-ref')).toBeTruthy();
    expect((latest.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('');
    expect((pinned.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('1');
    view.rerender(pane(false));
    const beforeHidden = fetcher.mock.calls.length;
    backref = 'hidden-external-ref';
    await act(async () => {
      for (let i = 0; i < 4; i++) invalidateDashboardApiCacheForEvent('artifact:changed');
    });
    expect(fetcher).toHaveBeenCalledTimes(beforeHidden);
    view.rerender(pane(true));
    expect(await pinned.findByText('hidden-external-ref')).toBeTruthy();
    expect(await latest.findByText('hidden-external-ref')).toBeTruthy();
    expect(pinned.getByText('First preview')).toBeTruthy();
    expect(latest.getByText('Second preview')).toBeTruthy();
  });
});
