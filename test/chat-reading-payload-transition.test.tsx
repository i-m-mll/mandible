// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useCompleteReading } from '../ui/src/chat/useCompleteReading';
import { queryClient } from '../ui/src/query/client';
const boundary = vi.hoisted(() => ({ revision: 'old', release: null as null | (() => void) }));
vi.mock('../ui/src/query/readingPresentation', () => ({
  readingManifestOptions: () => ({ queryKey: ['payload-transition-manifest'], queryFn: async () => ({ revision: boundary.revision }) }),
  isReadingPublicationChanged: () => false,
  ReadingPresentationError: class extends Error {},
  acquirePresentationRows: async (_id: string, request: any) => {
    if (request.rows[0].revision === 'new') await new Promise<void>(resolve => { boundary.release = resolve; });
    return { rows: request.rows.map((ref: any) => ({ ...ref, kind: 'content', sources: [], nodes: [], items: [] })), release: () => {} };
  },
}));
vi.mock('../src/presentation/reading-composition', () => ({
  composeConversationReading: ({ manifest }: any) => ({ plan: { rows: [{ key: 'row', revision: manifest.revision, sourcePositions: [] }], membership: new Map() }, actionRuns: new Map() }),
  readingCompositionRequests: (_composition: any, refs: any) => refs,
  materializeConversationReading: (_composition: any, _refs: any, rows: any) => ({ status: 'source', rows }),
}));
const events: [] = []; const extraRows: [] = []; const expanded = {}; const disclosureRevisions = {};
const local = { rows: [], membership: new Map(), viewMembership: new Map(), actionRuns: new Map() };
let reading: ReturnType<typeof useCompleteReading>;
function Harness() {
  reading = useCompleteReading({ scope: 'conv', space: 'space', events, extraRows, expanded, disclosureRevisions, local,
    enabled: true, initial: false, actionIdentity: '' });
  return null;
}
afterEach(() => { cleanup(); queryClient.clear(); boundary.revision = 'old'; boundary.release = null; });

it('keeps the applied payload paintable until matching pending geometry replaces it', async () => {
  render(<Harness />);
  await waitFor(() => expect(reading!.rows[0] && reading!.getBody(reading!.rows[0])).toBeTruthy());
  const old = reading!.rows[0];
  act(() => { reading!.onRange({ vector: [old], required: [old], prefetch: [], start: 0, end: 100, height: 100 }); reading!.retainGeometry([old]); });
  boundary.revision = 'new';
  await act(async () => { queryClient.setQueryData(['payload-transition-manifest'], { revision: 'new' }); });
  await waitFor(() => expect(boundary.release).toBeTruthy());
  const pending = reading!.rows[0];
  expect(reading!.getBody(old)?.revision).toBe('old');
  expect(reading!.getBody(pending)).toBeUndefined();
  await act(async () => { boundary.release!(); await Promise.resolve(); });
  await waitFor(() => expect(reading!.getBody(pending)).toBeTruthy());
  act(() => reading!.retainGeometry([pending]));
  expect(reading!.getBody(old)?.revision).toBe('old');
  await act(async () => { reading!.commitGeometry(reading!.rows); reading!.onRange({ vector: [pending], required: [pending], prefetch: [], start: 0, end: 100, height: 100 }); });
  await waitFor(() => expect(reading!.getBody(old)).toBeUndefined());
  expect(reading!.getBody(pending)?.revision).toBe('new');
});
