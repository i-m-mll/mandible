import { cleanup, fireEvent, render, screen, waitFor, within } from './helpers/dom.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../ui/src/api';
import type { BriefingBundle, BriefingGroup } from '../ui/src/api';
import { CollectionsSidebar } from '../ui/src/views/feedback/CollectionsSidebar';
import type { FeedbackCollection } from '../ui/src/views/feedback/collection-model';
import {
  BRIEFING_VIEW_STATE_KEY, briefingSubgroupKey, migrateBriefingSubgroupKeys,
  useBriefingCollectionViewState,
} from '../ui/src/views/feedback/collection-view-state';

const rows: FeedbackCollection[] = ['One', 'Two', 'Three'].map((label, index) => ({
  id: `briefing:${index}`, collectionId: String(index), label,
  unansweredDirectiveCount: 0, latestRoundId: `round-${index}`, createdAt: 1, updatedAt: 1,
}));
const bundle = (id: string, name = 'Skills', position = 0): BriefingBundle => ({
  id, name: id, createdAt: 1, updatedAt: 1, members: [],
  layout: position === 0
    ? [{ kind: 'subgroup', name, briefings: [rows[0]] }]
    : [{ kind: 'briefing', briefing: rows[1] }, { kind: 'subgroup', name, briefings: [rows[2]] }],
});
const group = (current: BriefingBundle, id = 'policy'): BriefingGroup => ({
  id, key: id, name: id, current, updates: [], destinations: [], destinationHistory: [], createdAt: 1, updatedAt: 1,
});
function Harness({ groups, loaded = true }: { groups: BriefingGroup[]; loaded?: boolean }) {
  const [viewState, setViewState] = useBriefingCollectionViewState();
  return <CollectionsSidebar collections={rows} groups={groups} confirmedLoaded={loaded}
    selectedCollectionId={null} viewState={viewState} setViewState={setViewState} onSelect={() => {}} />;
}
const saved = () => JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}');
const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  } });
  vi.spyOn(api, 'getSidebarOrderPreference').mockResolvedValue({
    version: 1, key: 'sidebar_order', value: { pinnedConversationIds: null, briefingTopLevelIds: null }, revision: 0,
  });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
});

it('keeps the last disclosure choice across replacement, reordering, search, and remount', async () => {
  const first = group(bundle('base-one'));
  const next = group(bundle('base-two', 'Skills', 1));
  const view = render(<Harness groups={[first]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Skills' }));
  await waitFor(() => expect(saved().collapsedGroupSubgroupKeys).toEqual([briefingSubgroupKey('policy', 'Skills')]));
  view.rerender(<Harness groups={[next]} />);
  expect(screen.getByRole('button', { name: 'Expand Skills' }).getAttribute('aria-expanded')).toBe('false');
  // Searching reveals matches without changing the stored choice.
  const search = screen.getByRole('searchbox');
  fireEvent.input(search, { target: { value: 'Three' } });
  expect(screen.getByRole('button', { name: 'Collapse Skills' })).toBeTruthy();
  fireEvent.input(search, { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Expand Skills' })).toBeTruthy();
  view.unmount();
  const restored = render(<Harness groups={[next]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand Skills' }));
  await waitFor(() => expect(saved().collapsedGroupSubgroupKeys).toEqual([]));
  restored.unmount();
  render(<Harness groups={[group(bundle('base-three'))]} />);
  expect(screen.getByRole('button', { name: 'Collapse Skills' }).getAttribute('aria-expanded')).toBe('true');
});

it('scopes matching to the same parent and exact name', () => {
  window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({
    collapsedGroupSubgroupKeys: [briefingSubgroupKey('policy', 'Skills')],
  }));
  const view = render(<Harness groups={[group(bundle('one')), group(bundle('two'), 'other')]} />);
  const parent = (name: string) => screen.getByRole('button', { name: `Select Briefing group ${name}` }).closest('.sidebar-group-node') as HTMLElement;
  expect(within(parent('policy')).getByRole('button', { name: 'Expand Skills' })).toBeTruthy();
  expect(within(parent('other')).getByRole('button', { name: 'Collapse Skills' })).toBeTruthy();
  view.rerender(<Harness groups={[group(bundle('three', 'skills'))]} />);
  expect(screen.getByRole('button', { name: 'Collapse skills' })).toBeTruthy();
  expect(briefingSubgroupKey('a:b', 'c')).not.toBe(briefingSubgroupKey('a', 'b:c'));
});

it('migrates positional choices only after loading and only from unambiguous layouts', async () => {
  const old = bundle('old');
  const next = group(bundle('new', 'Skills', 1));
  next.history = [{ id: 'promotion', kind: 'promoted', priorBase: old, proposal: next.current!,
    resultingBase: next.current, authRequestId: null, mergeHeadSha: null, createdAt: 2 }];
  const keys = ['policy:old:0'];
  window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({ collapsedGroupSubgroupKeys: keys }));
  const view = render(<Harness groups={[]} loaded={false} />);
  expect(saved().collapsedGroupSubgroupKeys).toEqual(keys);
  view.rerender(<Harness groups={[next]} />);
  expect(screen.getByRole('button', { name: 'Expand Skills' })).toBeTruthy();
  await waitFor(() => expect(saved().collapsedGroupSubgroupKeys).toEqual([briefingSubgroupKey('policy', 'Skills')]));
  const conflicting = { ...next, updates: [bundle('old', 'Different')] };
  expect(migrateBriefingSubgroupKeys([...keys, 'policy:missing:0'], [conflicting])).toEqual([]);
  const named = [briefingSubgroupKey('policy', 'Skills')];
  expect(migrateBriefingSubgroupKeys(named, [])).toBe(named);
});
