// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from './helpers/dom';
import { render } from './helpers/notice-test-render';
import { establishTestClientAccess } from './helpers/local-client-access';
import { queryClient } from '../ui/src/query/client';
import { clearPersistedDetailCache } from '../ui/src/detail-cache';
import { invalidateDashboardApiCacheForEvent } from '../ui/src/api';
import { SpaceItemPicker } from '../ui/src/views/spaces/SpaceItemPicker';
import { SpaceSeedDialog } from '../ui/src/views/spaces/SpaceSeedDialog';

beforeEach(async () => {
  queryClient.clear();
  clearPersistedDetailCache();
  await establishTestClientAccess();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});

it('shares dialog Graph reads and reconciles membership without losing search or selections', async () => {
  const first = { id: 'issue:first', type: 'issue', label: 'First issue', detail: { ledger_issue_id: 'first', project_id: 'proj1' } };
  const second = { id: 'issue:second', type: 'issue', label: 'Second issue', detail: { ledger_issue_id: 'second', project_id: 'proj1' } };
  let nodes = [first];
  const fetcher = vi.fn(async (input: RequestInfo) => {
    expect(new URL(String(input), 'http://localhost').pathname).toBe('/api/graph');
    return new Response(JSON.stringify({ mode: 'issue', nodes, edges: [] }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<>
    <div data-testid="items"><SpaceItemPicker spaceId="sp1" projectId="proj1" includeArtifacts={false} /></div>
    <div data-testid="seed"><SpaceSeedDialog spaceId="sp1" projectId="proj1" /></div>
  </>);
  const items = within(screen.getByTestId('items'));
  const seed = within(screen.getByTestId('seed'));
  fireEvent.click(seed.getByTestId('seed-source-graph'));
  fireEvent.click(await items.findByText('First issue'));
  const seedSelection = await seed.findByTestId('seed-graph-node-issue:first') as HTMLInputElement;
  fireEvent.click(seedSelection);
  fireEvent.input(items.getByRole('searchbox', { name: 'Search items to add' }), { target: { value: 'issue' } });
  expect(fetcher).toHaveBeenCalledTimes(1);
  nodes = [first, second];
  act(() => invalidateDashboardApiCacheForEvent('ledger:relationship:added'));
  expect(await items.findByText('Second issue')).toBeTruthy();
  expect(await seed.findByText('Second issue')).toBeTruthy();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect((items.getByRole('searchbox', { name: 'Search items to add' }) as HTMLInputElement).value).toBe('issue');
  expect(items.getByRole('option', { name: /First issue/ }).getAttribute('aria-selected')).toBe('true');
  expect(seed.getByTestId('seed-graph-node-issue:first')).toBe(seedSelection);
  expect(seedSelection.checked).toBe(true);
});
