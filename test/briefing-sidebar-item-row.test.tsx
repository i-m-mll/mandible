
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api';
import {
  type BriefingBundle,
  type BriefingGroup,
} from '../ui/src/api';
import { CollectionsSidebar } from '../ui/src/views/feedback/CollectionsSidebar';
import { BriefingGroupDetail } from '../ui/src/views/feedback/BriefingGroupDetail';
import {
  feedbackCollectionIdentity,
  resolveFeedbackCollection,
  type FeedbackCollection,
} from '../ui/src/views/feedback/collection-model';
import {
  DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  normalizeBriefingCollectionViewState,
  type BriefingCollectionViewState,
} from '../ui/src/views/feedback/collection-view-state';

const firstId = 'e4c52737-40e4-472a-8367-fbdbe97801a2';
const secondId = '06e4aec0-cf58-4a7f-86df-415e08a4eb8e';
const thirdId = '5d186de4-075e-4228-a070-e6c5be9dcbf8';
const roundId = '9fe126c4-74c5-4aa5-af9e-48e4f3a637c6';

const collections: FeedbackCollection[] = [
  { id: feedbackCollectionIdentity(firstId), collectionId: firstId, label: 'First briefing', unansweredDirectiveCount: 0, latestRoundId: 'round-1', createdAt: 1, updatedAt: 3 },
  { id: feedbackCollectionIdentity(secondId), collectionId: secondId, label: 'Second briefing', unansweredDirectiveCount: 2, latestRoundId: 'round-2', createdAt: 1, updatedAt: 2 },
  { id: feedbackCollectionIdentity(thirdId), collectionId: thirdId, label: 'Third briefing', unansweredDirectiveCount: 0, latestRoundId: 'round-3', createdAt: 1, updatedAt: 1 },
];

function Harness({
  initialViewState,
  selectedCollectionId = null,
  onSelect = () => undefined,
  bundles = [],
  groups = [],
}: {
  initialViewState?: Partial<BriefingCollectionViewState>;
  selectedCollectionId?: string | null;
  onSelect?: (collection: FeedbackCollection) => void;
  bundles?: BriefingBundle[];
  groups?: BriefingGroup[];
} = {}): JSX.Element {
  const [viewState, setViewState] = useState<BriefingCollectionViewState>({
    ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
    ...initialViewState,
  });
  return (
    <>
      <CollectionsSidebar
      confirmedLoaded
        collections={collections}
        bundles={bundles}
        groups={groups}
        selectedCollectionId={selectedCollectionId}
        viewState={viewState}
        setViewState={setViewState}
        onSelect={onSelect}
      />
      <output data-testid="view-state">{JSON.stringify(viewState)}</output>
    </>
  );
}

const groupedUpdates: BriefingGroup = {
  id: '12345678-1234-4123-8123-123456789abc',
  key: 'release-review',
  name: 'Release review',
  createdAt: 1,
  updatedAt: 2,
  destinations: [],
  destinationHistory: [],
  current: {
    id: '00000000-1234-4123-8123-123456789abc',
    name: 'Accepted layout',
    createdAt: 1,
    updatedAt: 1,
    members: [{ position: 0, briefing: collections[0] }],
    layout: [{ kind: 'briefing', briefing: collections[0] }],
  },
  updates: [
    {
      id: '11111111-1234-4123-8123-123456789abc',
      name: 'First proposal',
      createdAt: 1,
      updatedAt: 1,
      members: [{ position: 0, briefing: collections[0] }],
      layout: [{ kind: 'briefing', briefing: collections[0] }],
    },
    {
      id: '22222222-1234-4123-8123-123456789abc',
      name: 'Second proposal',
      createdAt: 1,
      updatedAt: 2,
      members: [
        { position: 0, briefing: collections[1] },
        { position: 1, briefing: collections[2] },
      ],
      layout: [{ kind: 'subgroup', name: 'Research', briefings: [collections[1], collections[2]] }],
    },
  ],
};

function GroupHarness(): JSX.Element {
  const [viewState, setViewState] = useState<BriefingCollectionViewState>(DEFAULT_BRIEFING_COLLECTION_VIEW_STATE);
  const selectedUpdateId = groupedUpdates.updates.find((update) => update.id === viewState.selectedGroupUpdateIds[groupedUpdates.id])?.id
    ?? null;
  return (
    <>
      <CollectionsSidebar
      confirmedLoaded
        collections={collections}
        groups={[groupedUpdates]}
        selectedCollectionId={viewState.selectedCollectionId}
        selectedGroupId={viewState.selectedGroupId}
        viewState={viewState}
        setViewState={setViewState}
        onSelect={(collection) => setViewState((current) => ({ ...current, selectedCollectionId: collection.id, selectedGroupId: null }))}
        onSelectGroup={(group) => setViewState((current) => ({ ...current, selectedGroupId: group.id, selectedCollectionId: null }))}
      />
      {viewState.selectedGroupId === groupedUpdates.id ? (
        <BriefingGroupDetail
          group={groupedUpdates}
          selectedUpdateId={selectedUpdateId}
          onSelectUpdate={(updateId) => setViewState((current) => {
            const selectedGroupUpdateIds = { ...current.selectedGroupUpdateIds };
            if (updateId) selectedGroupUpdateIds[groupedUpdates.id] = updateId;
            else delete selectedGroupUpdateIds[groupedUpdates.id];
            return { ...current, selectedGroupUpdateIds };
          })}
        />
      ) : null}
      <output data-testid="view-state">{JSON.stringify(viewState)}</output>
    </>
  );
}

beforeEach(() => {
  vi.spyOn(api, 'getSidebarOrderPreference').mockResolvedValue({
    version: 1, key: 'sidebar_order', value: { pinnedConversationIds: null, briefingTopLevelIds: null }, revision: 0,
  });
  vi.spyOn(api, 'updateSidebarOrderPreference').mockImplementation(async (value, revision) => ({
    version: 1, key: 'sidebar_order', value, revision: revision + 1,
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Briefing sidebar row actions', () => {
  it('selects a group separately from its reorder handle and chevron without replacing Current', async () => {
    render(<GroupHarness />);

    const groupSelect = screen.getByRole('button', { name: 'Select Briefing group Release review' });
    const group = groupSelect.closest('section') as HTMLElement;
    const reorderHandle = await within(group).findByRole('button', { name: 'Reorder Release review' });
    const disclosure = within(group).getByRole('button', { name: 'Collapse Release review' });
    expect(reorderHandle.dataset.sidebarReorderHandle).toBe(`group:${groupedUpdates.id}`);
    expect(groupSelect.hasAttribute('data-sidebar-reorder-handle')).toBe(false);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Select briefing First briefing' })).toBeTruthy();

    fireEvent.click(groupSelect);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Release review' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Proposed updates' })).toBeTruthy();
    const currentLayout = screen.getByRole('button', { name: 'Show Base layout Accepted layout' });
    const proposedUpdates = screen.getByRole('heading', { name: 'Proposed updates' }).closest('section') as HTMLElement;
    expect(proposedUpdates.contains(currentLayout)).toBe(false);
    expect(currentLayout.getAttribute('aria-pressed')).toBe('true');

    const secondProposal = screen.getByRole('button', { name: 'Preview proposed update Second proposal' });
    fireEvent.click(secondProposal);
    expect(currentLayout.getAttribute('aria-pressed')).toBe('false');
    expect(secondProposal.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(disclosure);
    expect(within(group).queryByRole('button', { name: 'Select briefing First briefing' })).toBeNull();
    expect(within(group).getAllByRole('button', { name: /Select briefing/ }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Select briefing Second briefing', 'Select briefing Third briefing']);
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}').selectedGroupUpdateIds)
      .toEqual({ [groupedUpdates.id]: groupedUpdates.updates[1].id });

    fireEvent.click(currentLayout);
    expect(currentLayout.getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Select briefing First briefing' })).toBeTruthy();
    expect(within(group).queryByRole('button', { name: /Research/ })).toBeNull();
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}').selectedGroupUpdateIds).toEqual({});

    fireEvent.click(secondProposal);
    const subgroupToggle = within(group).getByRole('button', { name: 'Collapse Research' });
    fireEvent.click(subgroupToggle);
    expect(subgroupToggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(group).queryByRole('button', { name: 'Select briefing Second briefing' })).toBeNull();
    expect(group.querySelector('[data-sidebar-group-icon-state="briefcase"]')).toBeTruthy();

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}').selectedGroupId).toBe(groupedUpdates.id);

    fireEvent.click(disclosure);
    fireEvent.click(subgroupToggle);
    fireEvent.click(within(group).getByRole('button', { name: 'Select briefing Second briefing' }));
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}')).toMatchObject({
      selectedCollectionId: collections[1].id,
      selectedGroupId: null,
    });
  });

  it('shows operator actions only for an exact frozen human-review candidate', () => {
    const selected = groupedUpdates.updates[0];
    const readyGroup: BriefingGroup = {
      ...groupedUpdates,
      reviewCandidates: [{
        proposalBundleId: selected.id,
        expectedBaseBundleId: groupedUpdates.current!.id,
        compositionRunId: 'composition-run-1',
        bindingDigest: 'b'.repeat(64),
        ready: true,
        blockerCode: null,
        blockerMessage: null,
        layoutChanged: false,
        destinationChanges: [],
        items: [{
          position: 0,
          layoutPosition: 0,
          subgroupPosition: -1,
          proposalBriefingId: firstId,
          proposalRoundId: roundId,
          proposalArtifactVersionId: 'artifact-version-2',
          proposalContentHash: 'b'.repeat(64),
          baseBriefingId: firstId,
          baseRoundId: 'base-round',
          baseArtifactVersionId: 'artifact-version-1',
          baseContentHash: 'a'.repeat(64),
          changed: true,
          submissionId: 'submission-1',
        }],
      }],
    };
    const view = render(
      <BriefingGroupDetail group={readyGroup} selectedUpdateId={selected.id} onSelectUpdate={() => undefined} />,
    );

    expect(screen.getByRole('button', { name: 'Accept as Base' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject proposal' })).toBeTruthy();

    view.rerender(
      <BriefingGroupDetail
        group={{
          ...readyGroup,
          reviewCandidates: [{
            ...readyGroup.reviewCandidates![0],
            ready: false,
            bindingDigest: null,
            blockerCode: 'briefing_review_submission_required',
            blockerMessage: 'A frozen operator submission is required.',
          }],
        }}
        selectedUpdateId={selected.id}
        onSelectUpdate={() => undefined}
      />,
    );
    expect(screen.getByText('A frozen operator submission is required.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept as Base' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject proposal' })).toBeNull();
  });

  it('fails closed across adjacent groups while stale proposal ownership reconciles', () => {
    const saraGroup: BriefingGroup = {
      id: 'aaaaaaaa-1234-4123-8123-123456789abc',
      key: 'saras-skill-breakdown',
      name: "Sara's skill, breakdown",
      createdAt: 1,
      updatedAt: 2,
      current: {
        id: 'bbbbbbbb-1234-4123-8123-123456789abc',
        name: 'Sara current layout',
        createdAt: 1,
        updatedAt: 1,
        members: [{ position: 0, briefing: collections[2] }],
        layout: [{ kind: 'briefing', briefing: collections[2] }],
      },
      updates: [],
      destinations: [],
      destinationHistory: [],
    };
    const selectedGroupUpdateIds = {
      [groupedUpdates.id]: groupedUpdates.updates[1].id,
      [saraGroup.id]: groupedUpdates.updates[1].id,
    };
    const staleSaraGroup = { ...saraGroup, updates: [groupedUpdates.updates[1]] };
    const view = render(
      <Harness
        groups={[staleSaraGroup, groupedUpdates]}
        initialViewState={{ selectedGroupUpdateIds }}
      />,
    );

    const agentPolicy = () => screen.getByRole('button', { name: 'Select Briefing group Release review' })
      .closest('section') as HTMLElement;
    const sara = () => screen.getByRole('button', { name: "Select Briefing group Sara's skill, breakdown" })
      .closest('section') as HTMLElement;

    expect(within(agentPolicy()).queryByRole('button', { name: /Research/ })).toBeNull();
    expect(within(agentPolicy()).getByRole('button', { name: 'Select briefing First briefing' })).toBeTruthy();
    expect(within(sara()).queryByRole('button', { name: /Research/ })).toBeNull();
    expect(within(sara()).getByRole('button', { name: 'Select briefing Third briefing' })).toBeTruthy();

    view.rerender(
      <Harness
        groups={[groupedUpdates, saraGroup]}
        initialViewState={{ selectedGroupUpdateIds }}
      />,
    );

    expect(within(agentPolicy()).getByRole('button', { name: 'Collapse Research' })).toBeTruthy();
    expect(within(agentPolicy()).getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Select briefing Second briefing',
      'Select briefing Third briefing',
    ]);
    expect(within(sara()).queryByRole('button', { name: /Research/ })).toBeNull();
    expect(within(sara()).getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'))).toEqual(['Select briefing Third briefing']);
  });

  it('normalizes persisted Briefing filters and sort to supported values', () => {
    expect(normalizeBriefingCollectionViewState({
      pinnedOnly: true,
      collectionSort: 'round-count',
      pinnedCollectionIds: [collections[0].id],
    })).toMatchObject({ pinnedOnly: true, pinnedCollectionIds: [collections[0].id], collectionSort: 'activity' });
    expect(normalizeBriefingCollectionViewState({
      pinnedOnly: 'yes',
      collectionSort: 'unanswered-count',
    })).toMatchObject({ pinnedOnly: false, collectionSort: 'unanswered-count' });
    expect(normalizeBriefingCollectionViewState({
      selectedGroupId: 'group-1',
      selectedCollectionId: 'briefing:old-selection',
      selectedGroupUpdateIds: { 'group-1': 'update-2', ignored: 4 },
      collapsedGroupIds: ['group-1', 'group-1'],
      collapsedGroupSubgroupKeys: ['group-1:update-2:0'],
    })).toMatchObject({
      selectedGroupId: 'group-1',
      selectedCollectionId: null,
      selectedGroupUpdateIds: { 'group-1': 'update-2' },
      collapsedGroupIds: ['group-1'],
      collapsedGroupSubgroupKeys: ['group-1:update-2:0'],
    });
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
