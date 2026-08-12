// Finding-reference rendering tests (umbrella 99b74d6, lane d7e51a1).
//
// Covers the acceptance criteria on the view side:
//   - The pure presentation model (latest vs pinned, review state, warnings).
//   - Read-only rendering in all four renderers: collection rows, board cards,
//     the canvas node inspector's detail component, and document embeds.
//   - Review state is DISPLAYED but never mutable from Spaces (no control of
//     any kind is rendered around it).
//   - Findings are selectable in the Space item picker, and selecting one adds
//     an ordinary latest-tracking `finding` item (a placement fact).

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import {
  describeFindingRef,
  isFindingItem,
  presentFinding,
  readFindingMetadata,
  reviewStateLabel,
  shortRevisionId,
} from '../ui/src/views/spaces/findingModel';
import {
  SpaceFindingRef,
  SpaceFindingRefView,
  findingSourceFromItem,
  type FindingResolver,
} from '../ui/src/views/spaces/SpaceFindingRef';
import { FindingReferenceDetail, detailTargetFromResourceRef } from '../ui/src/views/spaces/SpaceReferenceDetailPanel';
import {
  SpaceItemPicker,
  findingsToCandidates,
  type PickerCandidate,
} from '../ui/src/views/spaces/SpaceItemPicker';
import { DocumentBody, renderSpaceBlocks } from '../ui/src/views/spaces/DocumentRenderer';
import { itemRefString } from '../ui/src/views/spaces/collectionModel';
import { cardRefString } from '../ui/src/views/spaces/boardModel';
import { parseFindingRef, findingDetailHref } from '../ui/src/resource-refs';
import type { SpaceBlock, SpaceFindingResolution, SpaceItem } from '../ui/src/api';

const NOW = 1_700_000_000_000;

function findingItem(overrides: Partial<SpaceItem> = {}): SpaceItem {
  return {
    id: 'item-1',
    space_id: 'sp1',
    ref_type: 'finding',
    ref_id: 'cand-1',
    ref_uri: null,
    title: 'Saved finding',
    metadata: { revision_mode: 'latest' },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as SpaceItem;
}

function revision(id: string, title: string) {
  return {
    id,
    candidate_id: 'cand-1',
    title,
    why_notable: 'because it matters',
    source_ref: null,
    evidence_hash: `hash-${id}`,
    evidence_kind: 'snapshot-item' as const,
    captured_at: '2026-08-11T09:00:00Z',
    run_id: 'run-1',
    digest_series_ref: null,
    digest_version: 7,
    rank: 1,
    batch_key: 'batch-1',
    ingested_at: NOW,
    refs: [],
  };
}

function latestResolution(): SpaceFindingResolution {
  return {
    ref: 'finding:cand-1',
    candidate_id: 'cand-1',
    resolved: true,
    source: 'hn-scan',
    candidate_key: 'key-1',
    revision_mode: 'latest',
    pinned_revision_id: null,
    effective_revision: revision('rev-2', 'Second revision'),
    current_revision: revision('rev-2', 'Second revision'),
    revision_state: 'latest',
    review_state: 'pending',
    warnings: ['finding_latest_not_pinned'],
  };
}

function pinnedSupersededResolution(): SpaceFindingResolution {
  return {
    ref: 'finding:cand-1',
    candidate_id: 'cand-1',
    resolved: true,
    source: 'hn-scan',
    candidate_key: 'key-1',
    revision_mode: 'pinned',
    pinned_revision_id: 'rev-1abcdef0',
    effective_revision: { ...revision('rev-1abcdef0', 'First revision') },
    current_revision: revision('rev-2', 'Second revision'),
    revision_state: 'pinned_superseded',
    review_state: 'kept',
    warnings: ['finding_pinned_revision_superseded'],
  };
}

const resolverFor = (resolution: SpaceFindingResolution): FindingResolver =>
  vi.fn(async () => resolution);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('finding ref parsing and item ref strings', () => {
  it('parses the canonical finding ref and points navigation at the Briefing view', () => {
    const parsed = parseFindingRef('finding:cand-1');
    expect(parsed).toMatchObject({ canonical: 'finding:cand-1', candidateId: 'cand-1' });
    expect(parseFindingRef('issue:abc')).toBeNull();
    expect(findingDetailHref('cand-1')).toBe('#/briefing?candidate=cand-1');
  });

  it('uses the finding ref form in collection and board ref strings', () => {
    const item = findingItem();
    expect(itemRefString(item)).toBe('finding:cand-1');
    expect(cardRefString(item)).toBe('finding:cand-1');
    expect(isFindingItem(item)).toBe(true);
  });

  it('routes a finding ref to the finding detail target', () => {
    expect(detailTargetFromResourceRef('finding:cand-1')).toEqual({ kind: 'finding', ref: 'cand-1' });
  });
});

describe('finding presentation model', () => {
  it('renders from placement metadata alone before any resolution', () => {
    const view = presentFinding(findingSourceFromItem(findingItem()));
    expect(view.title).toBe('Saved finding');
    expect(view.revisionMode).toBe('latest');
    expect(view.revisionLabel).toBe('Tracking latest');
    expect(view.warningCode).toBe('finding_latest_not_pinned');
    expect(view.reviewState).toBe('unknown');
    expect(view.resolved).toBe(false);
  });

  it('reads pinned semantics and degrades a pin with no id to latest', () => {
    expect(readFindingMetadata({ revision_mode: 'pinned', pinned_revision_id: 'rev-1' })).toEqual({
      revisionMode: 'pinned',
      pinnedRevisionId: 'rev-1',
    });
    expect(readFindingMetadata({ revision_mode: 'pinned' })).toEqual({
      revisionMode: 'latest',
      pinnedRevisionId: null,
    });
    expect(describeFindingRef({ ref_id: 'cand-1' }).ref).toBe('finding:cand-1');
    expect(shortRevisionId('rev-1abcdef0123')).toBe('rev-1abc');
    expect(reviewStateLabel('expired_unreviewed')).toBe('Expired unreviewed');
  });

  it('says a latest-tracking reference is following the newest revision', () => {
    const view = presentFinding(findingSourceFromItem(findingItem()), latestResolution());
    expect(view.title).toBe('Second revision');
    expect(view.source).toBe('hn-scan');
    expect(view.revisionState).toBe('latest');
    expect(view.revisionWarning).toMatch(/not pinned/i);
    expect(view.reviewLabel).toBe('Pending review');
  });

  it('keeps a pinned reference on its revision and warns that a newer one exists', () => {
    const item = findingItem({
      metadata: { revision_mode: 'pinned', pinned_revision_id: 'rev-1abcdef0' },
    });
    const view = presentFinding(findingSourceFromItem(item), pinnedSupersededResolution());
    expect(view.title).toBe('First revision');
    expect(view.revisionMode).toBe('pinned');
    expect(view.revisionLabel).toBe('Pinned rev-1abc');
    expect(view.revisionState).toBe('pinned_superseded');
    expect(view.warningCode).toBe('finding_pinned_revision_superseded');
    expect(view.revisionWarning).toMatch(/newer revision/i);
    expect(view.reviewLabel).toBe('Kept');
  });
});

describe('finding reference component', () => {
  it('renders title, source chip, revision indicator, and review badge', async () => {
    render(
      h(SpaceFindingRef, {
        source: findingSourceFromItem(findingItem()),
        resolve: resolverFor(latestResolution()),
      }),
    );
    await waitFor(() => expect(screen.getByTestId('space-finding-source').textContent).toBe('hn-scan'));
    expect(screen.getByTestId('space-finding-title').textContent).toBe('Second revision');
    expect(screen.getByTestId('space-finding-revision').textContent).toBe('Tracking latest');
    expect(screen.getByTestId('space-finding-review').textContent).toBe('Pending review');
    expect(screen.getByTestId('space-finding-warning').getAttribute('data-warning-code')).toBe(
      'finding_latest_not_pinned',
    );
  });

  it('exposes NO control that could change review state', () => {
    const { container } = render(
      h(SpaceFindingRefView, {
        view: presentFinding(findingSourceFromItem(findingItem()), pinnedSupersededResolution()),
      }),
    );
    expect(container.querySelectorAll('button, input, select, textarea, [role="button"]')).toHaveLength(0);
    const review = screen.getByTestId('space-finding-review');
    expect(review.getAttribute('data-state')).toBe('kept');
    expect(review.tagName).toBe('SPAN');
  });

  it('renders from placement metadata when resolution fails, never dropping the ref', async () => {
    const failing: FindingResolver = vi.fn(async () => {
      throw new Error('daemon down');
    });
    render(h(SpaceFindingRef, { source: findingSourceFromItem(findingItem()), resolve: failing }));
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(screen.getByTestId('space-finding-title').textContent).toBe('Saved finding');
    expect(screen.getByTestId('space-finding-ref').getAttribute('data-resolved')).toBe('false');
  });
});

describe('renderer integration (read-only in all four renderers)', () => {
  it('renders a finding row in the collection renderer', async () => {
    const { SpaceCollectionRenderer } = await import('../ui/src/views/spaces/space-collection');
    const packet = {
      space: {
        id: 'sp1',
        project_id: 'prj1',
        title: 'Space',
        default_renderer: 'collection',
        description: null,
        metadata: {},
        created_at: NOW,
        updated_at: NOW,
      },
      items: [findingItem()],
      occurrences: [],
      edges: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/spaces/findings')) {
          return new Response(JSON.stringify({ resolution: latestResolution(), findings: [] }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(packet), { headers: { 'content-type': 'application/json' } });
      }),
    );
    render(h(SpaceCollectionRenderer, { spaceId: 'sp1', projectId: 'prj1' }));
    await waitFor(() => expect(screen.getAllByTestId('space-finding-ref').length).toBeGreaterThan(0));
    // The row is a read-only reference: no review control anywhere in it.
    const ref = screen.getAllByTestId('space-finding-ref')[0];
    expect(ref.querySelectorAll('button, input, select')).toHaveLength(0);
  });

  it('renders a finding card in the board renderer', async () => {
    const { SpaceBoardRenderer } = await import('../ui/src/views/spaces/SpaceBoard');
    const packet = {
      space: {
        id: 'sp1',
        project_id: 'prj1',
        title: 'Board',
        default_renderer: 'board',
        description: null,
        metadata: {},
        created_at: NOW,
        updated_at: NOW,
      },
      items: [findingItem()],
      occurrences: [
        {
          id: 'occ-1',
          space_id: 'sp1',
          item_id: 'item-1',
          renderer: 'board',
          parent_id: null,
          x: null,
          y: null,
          width: null,
          height: null,
          z_index: null,
          sort_key: 'a',
          section_id: null,
          note: null,
          metadata: {},
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      edges: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/spaces/findings')) {
          return new Response(JSON.stringify({ resolution: latestResolution(), findings: [] }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/resolve')) {
          return new Response(
            JSON.stringify({ resolution: { ref: 'x', kind: 'issue', resolved: false, entity: null } }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify(packet), { headers: { 'content-type': 'application/json' } });
      }),
    );
    render(h(SpaceBoardRenderer, { spaceId: 'sp1', projectId: 'prj1' }));
    await waitFor(() => expect(screen.getAllByTestId('space-finding-ref').length).toBeGreaterThan(0));
  });

  it('renders the canvas inspector detail for a finding node', async () => {
    render(
      h(FindingReferenceDetail, {
        item: findingSourceFromItem(
          findingItem({ metadata: { revision_mode: 'pinned', pinned_revision_id: 'rev-1abcdef0' } }),
        ),
        resolve: resolverFor(pinnedSupersededResolution()),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('space-finding-detail-revision').textContent).toBe('rev-1abcdef0'),
    );
    expect(screen.getByTestId('space-finding-detail-current').textContent).toBe('rev-2');
    expect(screen.getByTestId('space-finding-detail-mode').textContent).toContain('pinned');
    expect(screen.getByTestId('space-finding-why').textContent).toBe('because it matters');
    // Read-only: the detail panel offers no decision affordance either.
    expect(
      screen.getByTestId('space-finding-detail').querySelectorAll('button, input, select'),
    ).toHaveLength(0);
  });

  it('renders a finding embed in the document renderer', () => {
    const block: SpaceBlock = {
      id: 'blk-1',
      space_id: 'sp1',
      parent_id: null,
      block_type: 'reference',
      item_id: 'item-1',
      item_snapshot: {
        item_id: 'item-1',
        ref_type: 'finding',
        ref_id: 'cand-1',
        ref_uri: null,
        title: 'Saved finding',
        metadata: { revision_mode: 'pinned', pinned_revision_id: 'rev-1abcdef0' },
      },
      sort_key: 'a',
      markdown: '',
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
    };
    const doc = renderSpaceBlocks([block], 'sp1');
    render(
      h(DocumentBody, { document: doc, sources: new Map([[block.id, block]]) }),
    );
    const ref = screen.getByTestId('space-finding-ref');
    expect(ref.getAttribute('data-revision-mode')).toBe('pinned');
    expect(screen.getByTestId('space-finding-revision').textContent).toBe('Pinned rev-1abc');
    expect(ref.querySelectorAll('button, input, select')).toHaveLength(0);
  });
});

describe('item picker: findings are selectable', () => {
  it('projects candidates into latest-tracking picker rows', () => {
    const rows = findingsToCandidates([
      {
        candidate_id: 'cand-1',
        source: 'hn-scan',
        candidate_key: 'key-1',
        title: 'Interesting thing',
        current_revision_id: 'rev-1',
        review_state: 'pending',
        created_at: NOW,
      },
    ]);
    expect(rows[0]).toMatchObject({
      ref_type: 'finding',
      ref_id: 'cand-1',
      title: 'Interesting thing',
      projectLabel: 'hn-scan',
      metadata: { revision_mode: 'latest' },
    });
  });

  it('adds a selected finding as an ordinary latest-tracking Space item', async () => {
    const candidate: PickerCandidate = {
      key: 'finding:cand-1',
      ref_type: 'finding',
      ref_id: 'cand-1',
      title: 'Interesting thing',
      projectLabel: 'hn-scan',
      metadata: { revision_mode: 'latest' },
    };
    const addItem = vi.fn(async () => ({
      item: findingItem(),
      created: true,
      already_present: false,
    }));
    render(
      h(SpaceItemPicker, {
        spaceId: 'sp1',
        projectId: 'prj1',
        includeIssues: false,
        includeArtifacts: false,
        includeFindings: true,
        loadFindings: async () => [candidate],
        addItem: addItem as never,
      }),
    );

    const option = await screen.findByTestId('space-item-picker-option');
    expect(option.getAttribute('data-ref-type')).toBe('finding');
    fireEvent.click(option);
    fireEvent.click(screen.getByTestId('space-item-picker-add'));

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));
    expect(addItem.mock.calls[0][1]).toMatchObject({
      ref_type: 'finding',
      ref_id: 'cand-1',
      metadata: { revision_mode: 'latest' },
    });
  });
});
