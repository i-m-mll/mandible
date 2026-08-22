import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { briefingRoute } from '../ui/src/routing';
import { normalizeBriefingBundles, type BriefingBundle } from '../ui/src/api';
import { CollectionsSidebar } from '../ui/src/views/feedback/CollectionsSidebar';
import {
  feedbackCollectionIdentity,
  resolveFeedbackCollection,
  type FeedbackCollection,
} from '../ui/src/views/feedback/collection-model';
import {
  BRIEFING_VIEW_STATE_KEY,
  DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  normalizeBriefingCollectionViewState,
  type BriefingCollectionViewState,
  useBriefingCollectionViewState,
} from '../ui/src/views/feedback/collection-view-state';

const firstId = 'e4c52737-40e4-472a-8367-fbdbe97801a2';
const secondId = '06e4aec0-cf58-4a7f-86df-415e08a4eb8e';
const thirdId = '5d186de4-075e-4228-a070-e6c5be9dcbf8';
const roundId = '9fe126c4-74c5-4aa5-af9e-48e4f3a637c6';
const briefingStylesheet = readFileSync('ui/src/styles/briefing.css', 'utf8');
const sidebarItemRowStylesheet = readFileSync('ui/src/styles/sidebar-item-row.css', 'utf8');

const collections: FeedbackCollection[] = [
  { id: feedbackCollectionIdentity(firstId), collectionId: firstId, label: 'First briefing', itemCount: 1, latestRoundId: 'round-1', createdAt: 1, updatedAt: 3 },
  { id: feedbackCollectionIdentity(secondId), collectionId: secondId, label: 'Second briefing', itemCount: 2, latestRoundId: 'round-2', createdAt: 1, updatedAt: 2 },
  { id: feedbackCollectionIdentity(thirdId), collectionId: thirdId, label: 'Third briefing', itemCount: 3, latestRoundId: 'round-3', createdAt: 1, updatedAt: 1 },
];

function Harness({
  initialViewState,
  selectedCollectionId = null,
  onSelect = () => undefined,
  bundles = [],
}: {
  initialViewState?: Partial<BriefingCollectionViewState>;
  selectedCollectionId?: string | null;
  onSelect?: (collection: FeedbackCollection) => void;
  bundles?: BriefingBundle[];
} = {}): JSX.Element {
  const [viewState, setViewState] = useState<BriefingCollectionViewState>({
    ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
    pinnedCollectionIds: [collections[0].id, collections[1].id],
    ...initialViewState,
  });
  return (
    <>
      <CollectionsSidebar
        collections={collections}
        bundles={bundles}
        selectedCollectionId={selectedCollectionId}
        viewState={viewState}
        setViewState={setViewState}
        onSelect={onSelect}
      />
      <output data-testid="pinned-state">{JSON.stringify(viewState.pinnedCollectionIds)}</output>
      <output data-testid="view-state">{JSON.stringify(viewState)}</output>
    </>
  );
}

function PersistedHarness(): JSX.Element {
  const [viewState, setViewState] = useBriefingCollectionViewState();
  return (
    <CollectionsSidebar
      collections={collections}
      selectedCollectionId={null}
      viewState={viewState}
      setViewState={setViewState}
      onSelect={() => undefined}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Briefing sidebar row actions', () => {
  it('normalizes bundle membership by its stored manual position', () => {
    const row = (id: string, title: string) => ({
      id, title, briefing_key: id, latest_round_id: `round-${id}`, round_count: 1,
      created_at: 1, updated_at: 1,
    });
    const normalized = normalizeBriefingBundles({ bundles: [{
      id: 'bundle-1', name: 'Review set', created_at: 1, updated_at: 2,
      members: [
        { position: 1, briefing: row('second', 'Second') },
        { position: 0, briefing: row('first', 'First') },
      ],
    }] });
    expect(normalized[0].members.map((member) => member.briefing.label)).toEqual(['First', 'Second']);
  });

  it('renders ordered bundle members in the shared foldable folder presentation', () => {
    const bundle: BriefingBundle = {
      id: 'bundle-1', name: 'Agent policy review', createdAt: 1, updatedAt: 2,
      members: [
        { position: 0, briefing: collections[1] },
        { position: 1, briefing: collections[0] },
      ],
    };
    render(<Harness bundles={[bundle]} initialViewState={{ pinnedCollectionIds: [] }} />);

    const toggle = screen.getByRole('button', { name: /Agent policy review/ });
    const group = toggle.closest('.sidebar-group-node');
    expect(group?.classList.contains('sidebar-group-node--folder')).toBe(true);
    expect(group?.querySelector('[data-sidebar-group-icon="briefing-bundle"]')).toBeTruthy();
    expect(within(group as HTMLElement).getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Select briefing Second briefing',
      'Select briefing First briefing',
    ]);
    expect(screen.getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Select briefing Second briefing',
      'Select briefing First briefing',
      'Select briefing Third briefing',
    ]);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}').collapsedBundleIds)
      .toEqual(['bundle-1']);
  });

  it('normalizes persisted Briefing filters and sort to supported values', () => {
    expect(normalizeBriefingCollectionViewState({
      pinnedOnly: true,
      collectionSort: 'round-count',
    })).toMatchObject({ pinnedOnly: true, collectionSort: 'round-count' });
    expect(normalizeBriefingCollectionViewState({
      pinnedOnly: 'yes',
      collectionSort: 'created',
    })).toMatchObject({ pinnedOnly: false, collectionSort: 'activity' });
  });

  it('persists Briefing filter choices through the existing browser-local view-state owner', async () => {
    const rows = new Map<string, string>();
    const storage = {
      get length() { return rows.size; },
      clear: () => rows.clear(),
      getItem: (key: string) => rows.get(key) ?? null,
      key: (index: number) => [...rows.keys()][index] ?? null,
      removeItem: (key: string) => rows.delete(key),
      setItem: (key: string, value: string) => rows.set(key, String(value)),
    } as Storage;
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
    render(<PersistedHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Briefing filters' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pinned only' }));
    fireEvent.input(screen.getByRole('combobox', { name: 'Sort briefings' }), { target: { value: 'name' } });

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}'))
      .toMatchObject({ pinnedOnly: true, collectionSort: 'name' }));
  });

  it('uses the shared filter trigger, summary, and overlay dismissal contract', async () => {
    render(<div><Harness /><button type="button">Outside</button></div>);
    const trigger = screen.getByRole('button', { name: 'Briefing filters' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Briefing filter controls' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pinned only' }));
    expect(screen.getByText('Pinned only', { selector: '.sidebar-search-filter__summary span' })).toBeTruthy();
    expect(screen.getByText('1', { selector: '.sidebar-search-filter__badge' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Briefing filter controls' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Briefing filters' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Briefing filter controls' })).toBeTruthy());
    screen.getByRole('button', { name: 'Outside' }).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Briefing filter controls' })).toBeNull());
  });

  it('keeps manual pins first while sorting and filtering unpinned rows deterministically', () => {
    render(<Harness initialViewState={{ pinnedCollectionIds: [collections[1].id] }} />);
    const labels = () => screen.getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(labels()).toEqual([
      'Select briefing Second briefing',
      'Select briefing First briefing',
      'Select briefing Third briefing',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Briefing filters' }));
    fireEvent.input(screen.getByRole('combobox', { name: 'Sort briefings' }), { target: { value: 'round-count' } });
    expect(labels()).toEqual([
      'Select briefing Second briefing',
      'Select briefing Third briefing',
      'Select briefing First briefing',
    ]);
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}')).toMatchObject({ collectionSort: 'round-count' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Pinned only' }));
    expect(labels()).toEqual(['Select briefing Second briefing']);
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}')).toMatchObject({ pinnedOnly: true });
  });

  it('renders one ordinary pinned-first list with no Pinned group or collapse contract', () => {
    render(<Harness initialViewState={{
      pinnedCollectionIds: [collections[1].id, collections[0].id],
      pinnedSectionCollapsed: true,
    }} />);

    const sidebar = screen.getByTestId('feedback-collections-sidebar');
    expect(within(sidebar).queryByRole('region', { name: /^Pinned/ })).toBeNull();
    expect(within(sidebar).queryByRole('button', { name: /^Pinned/ })).toBeNull();
    expect(within(sidebar).getAllByRole('list')).toHaveLength(1);
    expect(within(sidebar).getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Select briefing Second briefing',
      'Select briefing First briefing',
      'Select briefing Third briefing',
    ]);
  });

  it('keeps every pinned icon persistently active without changing unpinned action semantics', () => {
    render(<Harness />);

    for (const collection of collections.slice(0, 2)) {
      const pin = screen.getByRole('button', { name: `Unpin ${collection.label}` });
      expect(pin.getAttribute('aria-pressed')).toBe('true');
      expect(pin.closest('.feedback-collection-row')?.classList.contains('feedback-collection-row--pinned')).toBe(true);
      expect(pin.closest('.sidebar-item-row')?.classList.contains('sidebar-item-row--persistent-pin')).toBe(true);
    }
    const unpinnedPin = screen.getByRole('button', { name: 'Pin Third briefing' });
    expect(unpinnedPin.getAttribute('aria-pressed')).toBe('false');
    expect(unpinnedPin.closest('.sidebar-item-row')?.classList.contains('sidebar-item-row--persistent-pin')).toBe(false);
    const baseTrailingRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__trailing \{([^}]*)\}/)?.[1] ?? '';
    expect(baseTrailingRule).toContain('position: absolute');
    expect(baseTrailingRule).toContain('opacity: 0');
    const contentRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__content \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(contentRule).toContain('min(12px, var(--sidebar-item-row-reveal-width))');
    expect(contentRule).toContain('transparent calc(100% - var(--sidebar-item-row-reveal-width))');
    expect(contentRule).not.toContain('var(--sidebar-item-row-reveal-width) - 12px');
    expect(sidebarItemRowStylesheet).toMatch(/\.sidebar-item-row--persistent-pin \{[^}]*--sidebar-item-row-reveal-width: var\(--sidebar-item-row-persistent-width, 0px\);/s);
    expect(sidebarItemRowStylesheet).toMatch(/\.sidebar-item-row--persistent-pin \.sidebar-item-row__overflow \{[^}]*position: absolute;[^}]*right: calc\(100% \+ 2px\);/s);
    expect(sidebarItemRowStylesheet).toMatch(/\.sidebar-item-row--persistent-pin \.sidebar-item-row__trailing \{[^}]*opacity: 1;/s);
    expect(sidebarItemRowStylesheet).toMatch(/\.sidebar-item-row--persistent-pin:not\([^}]*\.sidebar-item-row__overflow \{[^}]*opacity: 0;[^}]*pointer-events: none;/s);
    expect(briefingStylesheet).not.toMatch(/sidebar-item-row__(?:trailing|select|label|actions|overflow)/);
  });

  it('keeps Pin before overflow on every row and copies the canonical short route', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<Harness />);

    for (const collection of collections) {
      const row = screen.getByRole('button', { name: `Select briefing ${collection.label}` })
        .closest('.sidebar-item-row') as HTMLElement;
      const actions = row.querySelector('.sidebar-item-row__actions') as HTMLElement;
      expect(within(actions).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
        .toEqual([
          `${collection === collections[2] ? 'Pin' : 'Unpin'} ${collection.label}`,
          `Briefing actions for ${collection.label}`,
        ]);
    }

    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions for Third briefing' }));
    expect(screen.getByRole('menuitem', { name: 'Copy link to Third briefing' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Move Third briefing/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link to Third briefing' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${briefingRoute(thirdId)}`);
    expect(briefingRoute(thirdId)).toBe('/#/briefing?briefing=5d186de4');
    expect(briefingRoute(thirdId, roundId)).toBe('/#/briefing?briefing=5d186de4&round=9fe126c4');
  });

  it('puts ordered pinned controls in overflow with honest endpoint states', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions for First briefing' }));
    expect((screen.getByRole('menuitem', { name: 'Move First briefing up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('menuitem', { name: 'Move First briefing down' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Move First briefing down' }));
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Select briefing Second briefing',
      'Select briefing First briefing',
      'Select briefing Third briefing',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions for First briefing' }));
    expect((screen.getByRole('menuitem', { name: 'Move First briefing down' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reorders pinned rows by pointer drag while preserving unavailable pin slots', () => {
    render(<Harness initialViewState={{
      pinnedCollectionIds: [collections[0].id, 'briefing:unavailable', collections[1].id],
    }} />);
    const firstRow = screen.getByRole('button', { name: 'Select briefing First briefing' })
      .closest('.feedback-collection-row') as HTMLElement;
    const secondRow = screen.getByRole('button', { name: 'Select briefing Second briefing' })
      .closest('.feedback-collection-row') as HTMLElement;
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => collections[1].id),
    };

    fireEvent.dragStart(secondRow, { dataTransfer });
    fireEvent.dragOver(firstRow, { dataTransfer });
    fireEvent.drop(firstRow, { dataTransfer });

    expect(screen.getByTestId('pinned-state').textContent).toBe(JSON.stringify([
      collections[1].id,
      'briefing:unavailable',
      collections[0].id,
    ]));
    expect(screen.getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Select briefing Second briefing',
      'Select briefing First briefing',
      'Select briefing Third briefing',
    ]);
  });

  it('preserves selected-row navigation and filtered list behavior', () => {
    const onSelect = vi.fn();
    render(<Harness selectedCollectionId={collections[1].id} onSelect={onSelect} />);
    const selected = screen.getByRole('button', { name: 'Select briefing Second briefing' });
    expect(selected.getAttribute('aria-current')).toBe('true');
    expect(selected.tabIndex).toBe(0);

    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith(collections[2]);

    const search = screen.getByRole('searchbox', { name: 'Search briefings' });
    fireEvent.input(search, { target: { value: 'Third' } });
    expect(screen.getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual(['Select briefing Third briefing']);
    expect(screen.getByRole('button', { name: 'Select briefing Third briefing' }).tabIndex).toBe(0);
  });

  it('keeps an unpinned selected Briefing row hidden at rest and reveals shared actions on focus', () => {
    render(<Harness selectedCollectionId={collections[2].id} />);
    const selected = screen.getByRole('button', { name: 'Select briefing Third briefing' });
    const row = selected.closest('.sidebar-item-row')!;
    expect(row.classList.contains('sidebar-item-row--selected')).toBe(true);
    expect(row.classList.contains('sidebar-item-row--persistent-pin')).toBe(false);
    expect(sidebarItemRowStylesheet).not.toMatch(
      /\.sidebar-item-row--selected \.sidebar-item-row__(?:trailing|provider-dot|actions)/,
    );
    selected.focus();
    expect(document.activeElement).toBe(selected);
    expect(sidebarItemRowStylesheet).toMatch(
      /\.sidebar-item-row:focus-within \.sidebar-item-row__trailing[^}]*\{[^}]*opacity: 1;/s,
    );
    expect(briefingStylesheet).not.toMatch(/sidebar-item-row__(?:trailing|select|label|actions|overflow)/);
  });

  it('keeps Pin and Unpin as direct stateful actions', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin First briefing' }));
    expect(screen.getByRole('button', { name: 'Pin First briefing' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Pin Third briefing' }));
    expect(screen.getByRole('button', { name: 'Unpin Third briefing' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('pinned-state').textContent).toBe(JSON.stringify([
      collections[1].id,
      collections[2].id,
    ]));
  });

  it('resolves emitted short refs only when they identify exactly one Briefing', () => {
    expect(resolveFeedbackCollection(collections, 'e4c52737')).toBe(collections[0]);
    expect(resolveFeedbackCollection(collections, firstId)).toBe(collections[0]);
    expect(resolveFeedbackCollection([
      ...collections,
      { ...collections[0], id: 'other', collectionId: 'e4c52737-0000-0000-0000-000000000000' },
    ], 'e4c52737')).toBeNull();
  });
});
