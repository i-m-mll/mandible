// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useCompleteReading } from '../ui/src/chat/useCompleteReading';
import { queryClient } from '../ui/src/query/client';

const boundary = vi.hoisted(() => ({ calls: [] as { refs: any[]; signal: AbortSignal; resolve: () => void; reject: (error: Error) => void }[] }));
vi.mock('../ui/src/query/readingPresentation', () => ({
  readingManifestOptions: (scope: string) => ({ queryKey: ['prefetch-manifest', scope], queryFn: async () => ({ revision: '1' }) }),
  isReadingPublicationChanged: () => false,
  ReadingPresentationError: class extends Error {},
  acquirePresentationRows: (_scope: string, request: any, signal: AbortSignal) => new Promise((resolve, reject) => {
    const call = { refs: request.rows, signal, reject, resolve: () => resolve({ rows: request.rows.map((ref: any) => ({ ...ref, kind: 'content', sources: [], nodes: [], items: [] })), release: () => {} }) };
    boundary.calls.push(call);
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }),
}));
vi.mock('../src/presentation/reading-composition', () => ({
  composeConversationReading: ({ manifest }: any) => ({ plan: { rows: Array.from({ length: 50 }, (_, index) => ({ key: `row:${index}`, revision: manifest.revision, sourcePositions: [] })), membership: new Map() }, actionRuns: new Map() }),
  readingCompositionRequests: (_composition: any, refs: any) => refs,
  materializeConversationReading: (_composition: any, _refs: any, rows: any) => ({ status: 'source', rows }),
}));
const events: [] = []; const extraRows: [] = []; const expanded = {}; const disclosureRevisions = {};
const local = { rows: [], membership: new Map(), viewMembership: new Map(), actionRuns: new Map() };
let reading: ReturnType<typeof useCompleteReading>;
function Harness({ scope = 'conv' }: { scope?: string }) {
  reading = useCompleteReading({ scope, space: 'space', events, extraRows, expanded, disclosureRevisions, local,
    enabled: true, initial: false, actionIdentity: '' });
  return null;
}
function demand(required: number[], prefetch: number[]) {
  reading.onRange({ vector: reading.rows, required: required.map(index => reading.rows[index]), prefetch: prefetch.map(index => reading.rows[index]), start: 0, end: 1000, height: 400 });
}
afterEach(() => { cleanup(); queryClient.clear(); boundary.calls = []; });

it('prioritizes required bodies, retains overlapping work, promotes cached prefetch and evicts the old window', async () => {
  render(<Harness />);
  await waitFor(() => expect(boundary.calls).toHaveLength(1));
  act(() => demand([0], [1, 2, 3]));
  expect(boundary.calls[0].signal.aborted).toBe(false);
  await act(async () => boundary.calls[0].resolve());
  await waitFor(() => expect(boundary.calls).toHaveLength(2));
  expect(boundary.calls[1].refs.map(ref => ref.key)).toEqual(['row:1', 'row:2', 'row:3']);
  act(() => demand([1], [2, 3, 4]));
  expect(boundary.calls[1].signal.aborted).toBe(false);
  await act(async () => boundary.calls[1].resolve());
  await waitFor(() => expect(reading.getBody(reading.rows[1])).toBeTruthy());
  await waitFor(() => expect(boundary.calls).toHaveLength(3));
  act(() => demand([2], [3, 4]));
  expect(reading.getBody(reading.rows[2])).toBeTruthy();
  expect(boundary.calls[2].signal.aborted).toBe(false);
  act(() => demand([40], [41, 42]));
  await waitFor(() => expect(boundary.calls).toHaveLength(4));
  expect(boundary.calls[2].signal.aborted).toBe(true);
  expect(boundary.calls[3].refs.map(ref => ref.key)).toEqual(['row:40']);
  await waitFor(() => expect(reading.getBody(reading.rows[2])).toBeUndefined());
});

it('preempts unrelated speculation through its own lease and keeps failures from retrying or replacing displayed content', async () => {
  const view = render(<Harness />);
  await waitFor(() => expect(boundary.calls).toHaveLength(1));
  act(() => demand([0], [1, 2]));
  await act(async () => boundary.calls[0].resolve());
  await waitFor(() => expect(boundary.calls).toHaveLength(2));
  const measurementController = new AbortController();
  let measurement!: ReturnType<typeof reading.acquireMeasurement>;
  act(() => { measurement = reading.acquireMeasurement([reading.rows[30]], measurementController.signal); });
  await waitFor(() => expect(boundary.calls).toHaveLength(3));
  act(() => demand([0, 10], [1, 2]));
  await waitFor(() => expect(boundary.calls).toHaveLength(4));
  expect(boundary.calls[1].signal.aborted).toBe(true);
  expect(boundary.calls[2].signal.aborted).toBe(false);
  expect(boundary.calls[3].refs.map(ref => ref.key)).toEqual(['row:10']);
  await act(async () => boundary.calls[3].resolve());
  await waitFor(() => expect(boundary.calls).toHaveLength(5));
  await act(async () => boundary.calls[4].reject(new Error('speculation unavailable')));
  await waitFor(() => expect(reading.error).toBeNull());
  expect(reading.getBody(reading.rows[0])).toBeTruthy();
  act(() => reading.protect());
  await act(async () => { await Promise.resolve(); });
  expect(boundary.calls).toHaveLength(5);
  await act(async () => { boundary.calls[2].resolve(); (await measurement).release(); });
  view.rerender(<Harness scope="next" />);
  await waitFor(() => expect(boundary.calls).toHaveLength(6));
  expect(boundary.calls[5].refs.map(ref => ref.key)).toEqual(['row:0']);
});

it('cancels a stale revision and a prior scope while keeping required failures explicit and bounded', async () => {
  const view = render(<Harness />);
  await waitFor(() => expect(boundary.calls).toHaveLength(1));
  act(() => demand([0], [1, 2]));
  await act(async () => boundary.calls[0].resolve());
  await waitFor(() => expect(boundary.calls).toHaveLength(2));
  await act(async () => queryClient.setQueryData(['prefetch-manifest', 'conv'], { revision: '2' }));
  await waitFor(() => expect(boundary.calls).toHaveLength(3));
  expect(boundary.calls[1].signal.aborted).toBe(true);
  expect(boundary.calls[2].refs).toMatchObject([{ key: 'row:0', revision: '2' }]);
  view.rerender(<Harness scope="next" />);
  await waitFor(() => expect(boundary.calls).toHaveLength(4));
  expect(boundary.calls[2].signal.aborted).toBe(true);
  await act(async () => boundary.calls[3].reject(new Error('required unavailable')));
  await waitFor(() => expect(reading.error).toBe('required unavailable'));
  act(() => reading.protect());
  await act(async () => { await Promise.resolve(); });
  expect(boundary.calls).toHaveLength(4);
});
