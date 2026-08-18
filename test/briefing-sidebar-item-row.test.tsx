import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { briefingRoute } from '../ui/src/routing';
import { CollectionsSidebar } from '../ui/src/views/feedback/CollectionsSidebar';
import {
  feedbackCollectionIdentity,
  resolveFeedbackCollection,
  type FeedbackCollection,
} from '../ui/src/views/feedback/collection-model';
import {
  DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  type BriefingCollectionViewState,
} from '../ui/src/views/feedback/collection-view-state';

const firstId = 'e4c52737-40e4-472a-8367-fbdbe97801a2';
const secondId = '06e4aec0-cf58-4a7f-86df-415e08a4eb8e';
const thirdId = '5d186de4-075e-4228-a070-e6c5be9dcbf8';
const roundId = '9fe126c4-74c5-4aa5-af9e-48e4f3a637c6';

const collections: FeedbackCollection[] = [
  { id: feedbackCollectionIdentity(firstId), collectionId: firstId, label: 'First briefing', itemCount: 1, latestRoundId: 'round-1', createdAt: 1, updatedAt: 3 },
  { id: feedbackCollectionIdentity(secondId), collectionId: secondId, label: 'Second briefing', itemCount: 2, latestRoundId: 'round-2', createdAt: 1, updatedAt: 2 },
  { id: feedbackCollectionIdentity(thirdId), collectionId: thirdId, label: 'Third briefing', itemCount: 3, latestRoundId: 'round-3', createdAt: 1, updatedAt: 1 },
];

function Harness(): JSX.Element {
  const [viewState, setViewState] = useState<BriefingCollectionViewState>({
    ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
    pinnedCollectionIds: [collections[0].id, collections[1].id],
  });
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
    const pinned = document.querySelector('#briefing-pinned-list');
    expect(within(pinned as HTMLElement).getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Select briefing Second briefing',
      'Select briefing First briefing',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions for First briefing' }));
    expect((screen.getByRole('menuitem', { name: 'Move First briefing down' }) as HTMLButtonElement).disabled).toBe(true);
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
