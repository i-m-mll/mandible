
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api';
import { briefingRoute } from '../ui/src/routing';
import {
  normalizeBriefingBundles,
  normalizeBriefingGroups,
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

function PersistedHarness(): JSX.Element {
  const [viewState, setViewState] = useBriefingCollectionViewState();
  return (
    <CollectionsSidebar
      confirmedLoaded
      collections={collections}
      selectedCollectionId={null}
      viewState={viewState}
      setViewState={setViewState}
      onSelect={() => undefined}
    />
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
    }] }, []);
    expect(normalized[0].members.map((member) => member.briefing.label)).toEqual(['First', 'Second']);
  });

  it('normalizes group Current separately from proposals with one canonical subgroup level', () => {
    const row = (id: string, title: string) => ({
      id, title, latest_round_id: `round-${id}`, round_count: 1, created_at: 1, updated_at: 1,
    });
    const groups = normalizeBriefingGroups({ groups: [{
      id: 'group-1', key: 'review-group', name: 'Review group', created_at: 1, updated_at: 2,
      destinations: [],
      destination_history: [],
      current: {
        id: 'current-1', name: 'Current', created_at: 1, updated_at: 2,
        layout: [{ kind: 'briefing', briefing: row('baseline', 'Baseline') }],
      },
      updates: [{
        id: 'update-1', name: 'Proposal', created_at: 1, updated_at: 2,
        layout: [
          { kind: 'briefing', briefing: row('first', 'First') },
          { kind: 'subgroup', name: 'Research', briefings: [
            { position: 0, briefing: row('second', 'Second') },
          ] },
          { kind: 'subgroup', name: '', briefings: [
            { position: 0, briefing: row('ignored', 'Ignored') },
          ] },
        ],
      }],
    }] }, []);

    expect(groups[0].current?.layout).toMatchObject([
      { kind: 'briefing', briefing: { label: 'Baseline' } },
    ]);
    expect(groups[0].updates[0].layout).toMatchObject([
      { kind: 'briefing', briefing: { label: 'First' } },
      { kind: 'subgroup', name: 'Research', briefings: [{ label: 'Second' }] },
    ]);
    expect(groups[0].updates[0].members.map((member) => member.briefing.label)).toEqual(['First', 'Second']);
  });

  it('selects a group separately from its reorder handle and chevron without replacing Current', async () => {
    render(<GroupHarness />);

    const groupSelect = screen.getByRole('button', { name: 'Select Briefing group Release review' });
    const group = groupSelect.closest('.sidebar-group-node') as HTMLElement;
    const reorderHandle = await within(group).findByRole('button', { name: 'Reorder Release review' });
    const disclosure = within(group).getByRole('button', { name: 'Collapse Release review' });
    expect(reorderHandle.dataset.sidebarReorderHandle).toBe(`group:${groupedUpdates.id}`);
    expect(groupSelect.hasAttribute('data-sidebar-reorder-handle')).toBe(false);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Select briefing First briefing' })).toBeTruthy();

    fireEvent.click(groupSelect);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Release review' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Base' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Proposed updates' })).toBeTruthy();
    expect(screen.getByText('release-review', { selector: '.detail-pane-header__display-ref' })).toBeTruthy();
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

  it('keeps Base distinct when a group has no proposed updates', () => {
    const group = { ...groupedUpdates, updates: [] };
    render(<BriefingGroupDetail group={group} selectedUpdateId={null} onSelectUpdate={() => undefined} />);

    expect(screen.getByRole('heading', { name: 'Base' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show Base layout Accepted layout' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Proposed updates' })).toBeTruthy();
    expect(screen.getByText('No proposed updates are available.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Preview proposed update/ })).toBeNull();
  });

  it('describes published-report destinations without human review actions', () => {
    const group: BriefingGroup = {
      ...groupedUpdates,
      destinations: [{ logicalArtifactId: 'digest-report', publicationMode: 'published-report', routeKeys: [] }],
      updates: [],
      reviewCandidates: [],
    };
    render(<BriefingGroupDetail group={group} selectedUpdateId={null} onSelectUpdate={() => undefined} />);

    expect(screen.getByText(/1 published report/)).toBeTruthy();
    expect(screen.getByText(/advance Current without Accept or Reject/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept as Base' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject proposal' })).toBeNull();
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

    expect(screen.getByText('Frozen review ready for 1 changed document.')).toBeTruthy();
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

  it('keeps promotion history collapsed but visibly available', () => {
    const priorBase = { ...groupedUpdates.current!, id: '33333333-1234-4123-8123-123456789abc', name: 'Original' };
    const group: BriefingGroup = {
      ...groupedUpdates,
      updates: [],
      history: [{
        id: 'history-1',
        kind: 'promoted',
        priorBase,
        proposal: groupedUpdates.current!,
        resultingBase: groupedUpdates.current!,
        authRequestId: 'auth-1',
        mergeHeadSha: 'a'.repeat(40),
        createdAt: 1,
      }],
    };
    render(<BriefingGroupDetail group={group} selectedUpdateId={null} onSelectUpdate={() => undefined} />);

    const summary = screen.getByText('History (1)');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText('Promoted to Base')).toBeTruthy();
    expect(screen.getByText('Previous Base: Base')).toBeTruthy();
  });

  it('renders grouped proposal bundles only through their stable group', () => {
    render(
      <Harness
        groups={[groupedUpdates]}
        initialViewState={{ pinnedCollectionIds: [] }}
      />,
    );

    const groupSelect = screen.getByRole('button', { name: 'Select Briefing group Release review' });
    const group = groupSelect.closest('.sidebar-group-node') as HTMLElement;
    expect(within(group).getByRole('button', { name: 'Select briefing First briefing' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Select briefing First briefing' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /First proposal/ })).toBeNull();
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
      .closest('.sidebar-group-node') as HTMLElement;
    const sara = () => screen.getByRole('button', { name: "Select Briefing group Sara's skill, breakdown" })
      .closest('.sidebar-group-node') as HTMLElement;

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

  it('renders the sparse-policy proposal as direct policies plus one Skills subgroup', () => {
    const briefing = (id: string, label: string): FeedbackCollection => ({
      id: feedbackCollectionIdentity(id),
      collectionId: id,
      label,
      unansweredDirectiveCount: 0,
      latestRoundId: `round-${id}`,
      createdAt: 1,
      updatedAt: 1,
    });
    const direct = [briefing('global', 'Global'), briefing('codex', 'Codex'), briefing('claude', 'Claude')];
    const skills = [
      briefing('reliability-design', 'Reliability design'),
      briefing('performance', 'Performance'),
      briefing('squeeze', 'Squeeze'),
      briefing('strict-engineering', 'Strict engineering'),
    ];
    const policyGroup: BriefingGroup = {
      id: 'sparse-policy-group',
      key: 'sparse-testing-policy',
      name: 'Sparse testing policy',
      createdAt: 1,
      updatedAt: 1,
      current: {
        id: 'sparse-policy-current',
        name: 'Current organization',
        createdAt: 1,
        updatedAt: 1,
        members: [...direct, ...skills].map((entry, position) => ({ position, briefing: entry })),
        layout: [
          ...direct.map((entry) => ({ kind: 'briefing' as const, briefing: entry })),
          { kind: 'subgroup', name: 'Skills', briefings: skills },
        ],
      },
      updates: [],
      destinations: [],
      destinationHistory: [],
    };

    render(<Harness groups={[policyGroup]} initialViewState={{ pinnedCollectionIds: [] }} />);
    const sidebar = screen.getByTestId('feedback-collections-sidebar');
    const group = screen.getByRole('button', { name: 'Select Briefing group Sparse testing policy' })
      .closest('.sidebar-group-node') as HTMLElement;
    const groupLayout = group.querySelector(':scope > .sidebar-disclosure-region > .feedback-collections-sidebar__group-layout');
    expect(groupLayout).toBeTruthy();
    expect(group.classList.contains('feedback-collections-sidebar__group')).toBe(true);
    expect(group.classList.contains('sidebar-group-node--nested')).toBe(true);
    expect(group.classList.contains('sidebar-group-node--category')).toBe(false);
    expect(within(group).getAllByRole('button', { name: /Select briefing/ }).map((button) => button.getAttribute('aria-label')))
      .toEqual([
        'Select briefing Global',
        'Select briefing Codex',
        'Select briefing Claude',
        'Select briefing Reliability design',
        'Select briefing Performance',
        'Select briefing Squeeze',
        'Select briefing Strict engineering',
      ]);
    expect(within(group).getByRole('button', { name: 'Collapse Skills' })).toBeTruthy();
    expect(within(group).queryByRole('button', { name: /^(?:Expand|Collapse) Policy$/ })).toBeNull();
    const unrelatedTopLevelList = within(sidebar).getByRole('button', { name: 'Select briefing First briefing' }).closest('ul');
    expect(group.contains(unrelatedTopLevelList)).toBe(false);
    expect(unrelatedTopLevelList?.classList.contains('feedback-collections-sidebar__group-layout')).toBe(false);
  });

  it('renders ordered bundle members in the shared foldable folder presentation', () => {
    const bundle: BriefingBundle = {
      id: 'bundle-1', name: 'Agent policy review', createdAt: 1, updatedAt: 2,
      members: [
        { position: 0, briefing: collections[1] },
        { position: 1, briefing: collections[0] },
      ],
      layout: [
        { kind: 'briefing', briefing: collections[1] },
        { kind: 'briefing', briefing: collections[0] },
      ],
    };
    render(<Harness bundles={[bundle]} initialViewState={{ pinnedCollectionIds: [] }} />);

    const toggle = screen.getByRole('button', { name: 'Collapse Agent policy review' });
    const group = toggle.closest('.sidebar-group-node');
    expect(group?.classList.contains('sidebar-group-node--folder')).toBe(true);
    expect(group?.querySelector('[data-sidebar-group-icon="briefing-bundle"][data-sidebar-group-icon-state="layers"]')).toBeTruthy();
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
    expect(group?.querySelector('[data-sidebar-group-icon="briefing-bundle"][data-sidebar-group-icon-state="briefcase"]')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}').collapsedBundleIds)
      .toEqual(['bundle-1']);
  });

  it('omits an empty ungrouped bundle instead of rendering a dead heading', () => {
    const emptyBundle: BriefingBundle = {
      id: 'empty-bundle', name: 'Superseded proposal', createdAt: 1, updatedAt: 2,
      members: [], layout: [],
    };
    render(<Harness bundles={[emptyBundle]} />);

    expect(screen.queryByRole('button', { name: /Superseded proposal/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Select briefing/ })).toHaveLength(collections.length);
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
    fireEvent.input(screen.getByRole('combobox', { name: 'Sort briefings' }), { target: { value: 'name' } });
    fireEvent.input(screen.getByRole('combobox', { name: 'Briefing collection lifecycle' }),
      { target: { value: 'archived' } });

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}'))
      .toMatchObject({ collectionSort: 'name', collectionLifecycle: 'archived' }));
  });

  it('projects Active, All, and Archived without leaking archived-group contents into the root', () => {
    const archivedGroup: BriefingGroup = { ...groupedUpdates, archivedAt: 42 };
    const view = render(<Harness bundles={[groupedUpdates.current!]} groups={[archivedGroup]} />);

    expect(screen.queryByRole('button', { name: 'Select Briefing group Release review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select briefing First briefing' })).toBeNull();

    view.rerender(<Harness key="all" bundles={[groupedUpdates.current!]} groups={[archivedGroup]}
      initialViewState={{ collectionLifecycle: 'all' }} />);
    expect(screen.getAllByRole('button', { name: 'Select Briefing group Release review' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Select briefing First briefing' })).toHaveLength(1);

    view.rerender(<Harness key="archived" bundles={[groupedUpdates.current!]} groups={[archivedGroup]}
      initialViewState={{ collectionLifecycle: 'archived' }} />);
    expect(screen.getAllByRole('button', { name: 'Select Briefing group Release review' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Select briefing First briefing' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Select briefing Second briefing' })).toBeNull();
  });

  it('uses the shared filter trigger, summary, and overlay dismissal contract', async () => {
    render(<div><Harness /><button type="button">Outside</button></div>);
    const trigger = screen.getByRole('button', { name: 'Briefing filters' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Briefing filter controls' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Pinned only' })).toBeNull();
    fireEvent.input(screen.getByRole('combobox', { name: 'Sort briefings' }), { target: { value: 'name' } });
    expect(screen.getByText('By name', { selector: '.sidebar-search-filter__summary span' })).toBeTruthy();
    expect(screen.getByText('1', { selector: '.sidebar-search-filter__badge' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Briefing filter controls' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Briefing filters' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Briefing filter controls' })).toBeTruthy());
    screen.getByRole('button', { name: 'Outside' }).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Briefing filter controls' })).toBeNull());
  });

  it('keeps ordinary sorting deterministic while legacy pin state remains inert', () => {
    render(<Harness initialViewState={{ pinnedOnly: true, pinnedCollectionIds: [collections[1].id] }} />);
    const labels = () => screen.getAllByRole('button', { name: /Select briefing/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(labels()).toEqual([
      'Select briefing First briefing',
      'Select briefing Second briefing',
      'Select briefing Third briefing',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Briefing filters' }));
    fireEvent.input(screen.getByRole('combobox', { name: 'Sort briefings' }), { target: { value: 'unanswered-count' } });
    expect(labels()).toEqual([
      'Select briefing Second briefing',
      'Select briefing First briefing',
      'Select briefing Third briefing',
    ]);
    expect(JSON.parse(screen.getByTestId('view-state').textContent ?? '{}')).toMatchObject({ collectionSort: 'unanswered-count' });
  });

  it('renders only positive unanswered-directive badges and no pin or reorder controls', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<Harness initialViewState={{ pinnedCollectionIds: [collections[1].id] }} />);
    const sidebar = screen.getByTestId('feedback-collections-sidebar');
    expect(within(sidebar).getByLabelText('2 unanswered directives').textContent).toBe('2');
    expect(within(sidebar).queryByLabelText('0 unanswered directives')).toBeNull();
    expect(within(sidebar).queryByRole('button', { name: /^(?:Pin|Unpin) / })).toBeNull();
    expect(within(sidebar).queryByRole('checkbox', { name: 'Pinned only' })).toBeNull();
    for (const collection of collections) {
      const row = screen.getByRole('button', { name: `Select briefing ${collection.label}` })
        .closest('.sidebar-item-row') as HTMLElement;
      const actions = row.querySelector('.sidebar-item-row__actions') as HTMLElement;
      expect(within(actions).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
        .toEqual([`Briefing actions for ${collection.label}`]);
      expect(row.classList.contains('sidebar-item-row--persistent-pin')).toBe(false);
      expect(row.closest('.feedback-collection-row')?.hasAttribute('draggable')).toBe(false);
    }

    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions for Third briefing' }));
    expect(screen.getByRole('menuitem', { name: 'Copy link to Third briefing' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Move .* briefing/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link to Third briefing' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${briefingRoute(thirdId)}`);
    expect(briefingRoute(thirdId)).toBe('/#/briefing?briefing=5d186de4');
    expect(briefingRoute(thirdId, roundId)).toBe('/#/briefing?briefing=5d186de4&round=9fe126c4');
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


  it('resolves emitted short refs only when they identify exactly one Briefing', () => {
    expect(resolveFeedbackCollection(collections, 'e4c52737')).toBe(collections[0]);
    expect(resolveFeedbackCollection(collections, firstId)).toBe(collections[0]);
    expect(resolveFeedbackCollection([
      ...collections,
      { ...collections[0], id: 'other', collectionId: 'e4c52737-0000-0000-0000-000000000000' },
    ], 'e4c52737')).toBeNull();
  });
});
