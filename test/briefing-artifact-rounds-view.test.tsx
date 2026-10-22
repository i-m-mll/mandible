import { UiRoundTripGate, createCopiedPreviewDatabase, exactTestInstanceEnv, installStorage, operatorSessionResponse } from '../helpers/briefing-preview-fixtures';
import { BRIEFING_EVENT_VALUES } from '../../src/contracts';
import { queryClient } from '../../ui/src/query/client';
import { browserResourceKeys, refreshBrowserResources } from '../../ui/src/query/browserResources';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getArtifactContent } from '../../src/artifact-content';
import { setSetting } from '../../src/client-auth/settings-kv';

import { resolveInstanceInfo } from '../../src/instance-policy';
import { registerBriefingRoutes } from '../../src/routes/briefing';
import { Router } from '../../src/server';
import { PRODUCTION_EFFECTS, STANDARD_PREVIEW_EFFECTS } from '../../src/security/effect-policy';
import { createUser } from '../../src/users/store';
import { recordArtifactVersion } from '../helpers/artifact-http-write-fixtures';
import { AppShellProvider } from '../../ui/src/app-shell';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../../ui/src/client-auth-token';
import {
  invalidateBriefingApiCacheForEvent,
  getBriefingBundles,
  getBriefings,
  invalidateApiGetCache,
  normalizeBriefingProjection,
  normalizeBriefings,
  type InstanceInfo,
} from '../../ui/src/api';
import { BriefingView } from '../../ui/src/views/briefing';
import { briefingRoundOptions, BriefingDocumentRenderer } from '../../ui/src/views/feedback/BriefingDocumentRenderer';
import { BRIEFING_VIEW_STATE_KEY, DEFAULT_BRIEFING_COLLECTION_VIEW_STATE, normalizeBriefingCollectionViewState } from '../../ui/src/views/feedback/collection-view-state';
import { parseBriefingDirectives } from '../../src/feedback/briefing-directives';
import { RICH_BRIEFING_DEMO } from '../../src/feedback/rich-briefing-demo';

const source = 'Intro\n:::spec-item{key="decision" type="verdict" required="true"}\nReview this round\n:::\n';
const bodyStart = source.indexOf('Review this round');
const bodyEnd = source.indexOf('\n:::', bodyStart);
const directiveEnd = bodyEnd + '\n:::'.length;
const digest = createHash('sha256').update(source.slice(source.indexOf(':::'), directiveEnd)).digest('hex');
const ROUND_ONE = '11111111-1111-4111-8111-111111111111';
const ROUND_TWO = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FULL_BRIEFING_ID = `briefing:${'65db040'.padEnd(64, 'a')}`;
const FULL_ROUND_ID = `briefing-round:${'c76f940'.padEnd(64, 'b')}`;
const FULL_ARTIFACT_VERSION_REF = `artifact-version:${'264e485'.padEnd(32, 'c')}`;
const PRODUCTION_ALLOW_INSTANCE: InstanceInfo = {
  role: 'main', db_path: '/tmp/mandible.db', db_path_source: 'default',
  allowed_effects: PRODUCTION_EFFECTS, writable_roots: ['/tmp'], preview_root: null,
  instance_id: 'production', installation_id: 'test', public_origin: 'https://app.mandible.localhost:19420', backend_generation: 'test',
  source_db_path: null, source_db_path_source: null,
};
const COPIED_PREVIEW_INSTANCE: InstanceInfo = {
  role: 'preview', db_path: '/tmp/mandible-copy.db', db_path_source: 'start_options',
  source_db_path: '/tmp/mandible.db', source_db_path_source: 'start_options',
  allowed_effects: STANDARD_PREVIEW_EFFECTS, writable_roots: ['/tmp'], preview_root: '/tmp',
  instance_id: 'preview-test', installation_id: 'test', public_origin: 'https://preview-test.mandible.localhost:19421', backend_generation: 'test',
};
const TYPED_SOURCE = [
  '# Copied preview review',
  ':::spec-item{key="verdict" type="verdict" required="true"}', 'Keep this?', ':::',
  ':::spec-item{key="single" type="single_choice" required="true"}', 'Choose one', '::option[Alpha]{key="a"}', '::option[Beta]{key="b"}', ':::',
  ':::spec-item{key="multi" type="multi_choice" required="true"}', 'Choose evidence', '::option[First]{key="first"}', '::option[Second]{key="second"}', '::option[Third]{key="third"}', ':::',
  ':::spec-item{key="short" type="short_text" required="true"}', 'Short rationale', ':::',
  ':::spec-item{key="long" type="long_text" required="true"}', 'Long rationale', ':::',
  ':::spec-item{key="rating" type="rating" required="true"}', 'Confidence rating', ':::',
].join('\n');
const TYPED_DIRECTIVES = parseBriefingDirectives(TYPED_SOURCE);

function typedDetail(roundId: string, annotations: unknown[] = []) {
  const artifactVersion = roundId === ROUND_ONE ? 'artifact-version:typed-one' : 'artifact-version:typed-two';
  return {
    briefing: { id: 'briefing-typed', briefing_key: 'typed-copy', title: 'Copied preview review', latest_round_id: ROUND_TWO, round_count: 2, created_at: 1, updated_at: 2 },
    rounds: [
      { id: ROUND_ONE, ordinal: 1, artifact_version_id: 'artifact-version:typed-one', created_at: 1, origin: null },
      { id: ROUND_TWO, ordinal: 2, artifact_version_id: 'artifact-version:typed-two', created_at: 2, origin: null },
    ],
    selected_round: {
      id: roundId, ordinal: roundId === ROUND_ONE ? 1 : 2, artifact_version_id: artifactVersion,
      previous_round_id: roundId === ROUND_ONE ? null : ROUND_ONE, profile: 'mandible-briefing.v2',
      binding_digest: `binding-${roundId}`, created_at: roundId === ROUND_ONE ? 1 : 2,
      document: {
        artifact_version_id: artifactVersion,
        content_hash: createHash('sha256').update(TYPED_SOURCE).digest('hex'),
        previous_round_id: roundId === ROUND_ONE ? null : ROUND_ONE,
        profile: 'mandible-briefing.v2',
        source: TYPED_SOURCE,
      },
      binding: { status: 'valid' },
      items: TYPED_DIRECTIVES.map((directive, position) => ({
        id: `item-${directive.key}`, directive_key: directive.key, position,
        definition_digest: directive.definition_digest, response_type: directive.type,
        required: 1, prompt: directive.body, options: directive.options,
        start_offset: directive.start_offset, end_offset: directive.end_offset,
        body_start_offset: directive.body_start_offset, body_end_offset: directive.body_end_offset,
      })),
      answers: [], annotations, latest_submission: null, latest_frozen_membership: null,
      submission_overlays: [], selected_submission_overlay: null,
    },
  };
}

function selectedRound(roundId: string, artifactVersion: string, submitted = false) {
  const exactSource = source.replace('Intro', roundId === ROUND_ONE ? 'First' : 'Later');
  return {
    id: roundId, ordinal: roundId === ROUND_ONE ? 1 : 2, artifact_version_id: artifactVersion,
    previous_round_id: roundId === ROUND_ONE ? null : ROUND_ONE, profile: 'mandible-briefing.v2',
    binding_digest: `binding-${roundId}`, created_at: roundId === ROUND_ONE ? 1 : 2,
    document: {
      artifact_version_id: artifactVersion,
      content_hash: createHash('sha256').update(exactSource).digest('hex'),
      previous_round_id: roundId === ROUND_ONE ? null : ROUND_ONE,
      profile: 'mandible-briefing.v2',
      source: exactSource,
    },
    binding: { status: 'valid' },
    items: [{ id: `item-${roundId}`, directive_key: 'decision', position: 0, definition_digest: digest,
      response_type: 'verdict', required: 1, prompt: 'Review this round', options: [],
      start_offset: source.indexOf(':::'), end_offset: directiveEnd, body_start_offset: bodyStart, body_end_offset: bodyEnd }],
    answers: submitted ? [{ response_event_id: 'answer-old', directive_instance_id: `item-${roundId}`,
      directive_key: 'decision', response_type: 'verdict', value: { verdict: 'keep' }, created_at: 1 }] : [],
    annotations: [], latest_submission: submitted ? { id: `submission-${roundId}`, ordinal: 1 } : null,
    latest_frozen_membership: submitted ? { answer_event_ids: ['answer-old'], annotation_event_ids: [] } : null,
    submission_overlays: submitted ? [{
      id: `submission-${roundId}`, ordinal: 1, supersedes_submission_id: null,
      actor_user_id: 'human', actor: { slug: 'human', display_name: 'Human' }, created_at: 1,
      answer_count: 1, annotation_count: 0,
    }] : [],
    selected_submission_overlay: null,
  };
}

function detail(roundId = ROUND_TWO) {
  return {
    briefing: { id: 'briefing-1', briefing_key: 'recurring-review', title: 'Recurring review',
      description: 'Explains why this review exists. It represents a durable source snapshot.',
      latest_round_id: ROUND_TWO, round_count: 2, created_at: 1, updated_at: 2 },
    rounds: [
      { id: ROUND_ONE, ordinal: 1, artifact_version_id: ARTIFACT_VERSION, created_at: 1, origin: { source: 'scheduled-review', run_id: 'run-1', task_identity: 'task-1' } },
      { id: ROUND_TWO, ordinal: 2, artifact_version_id: ARTIFACT_VERSION, created_at: 2, origin: { source: 'scheduled-review', run_id: 'run-2', task_identity: 'task-1' } },
    ],
    selected_round: selectedRound(roundId, ARTIFACT_VERSION, roundId === ROUND_ONE),
  };
}

let noticeHost: HTMLElement;
beforeEach(async () => {
  queryClient.clear();
  installStorage();
  invalidateApiGetCache();
  __resetBrowserSessionForTests();
  await ensureClientAccess(async () => operatorSessionResponse());
  noticeHost = document.createElement('div');
  noticeHost.id = 'app-operational-notices';
  document.body.append(noticeHost);
});
afterEach(async () => {
  await queryClient.cancelQueries();
  cleanup(); queryClient.clear(); noticeHost.remove();
  __resetBrowserSessionForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('artifact-backed Briefing rounds', () => {
  it.each([
    ['retained', 'briefing:briefing-1'],
    ['default', null],
  ])('restores a saved incident selection to a %s Briefing', async (_case, selectedCollectionId) => {
    const saved = { ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE, selectedSurface: 'incidents', selectedCollectionId };
    expect(normalizeBriefingCollectionViewState(saved)).toMatchObject({ selectedCollectionId });
    expect('selectedSurface' in normalizeBriefingCollectionViewState(saved)).toBe(false);
    window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify(saved));
    window.history.replaceState(null, '', '/#/briefing');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/briefings') return new Response(JSON.stringify({ briefings: [{
        id: 'briefing-1', title: 'Recurring review', latest_round_id: ROUND_TWO,
        created_at: 1, updated_at: 2,
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/briefing-bundles') return new Response(JSON.stringify({ bundles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/briefing-groups') return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);
    await waitFor(() => expect(window.location.hash).toBe('#/briefing?briefing=briefing-1'));
    expect(screen.queryByRole('button', { name: 'Operational incidents' })).toBeNull();
    expect(screen.queryByTestId('operational-incidents-region')).toBeNull();
    expect(screen.getByRole('button', { name: 'Select briefing Recurring review' })).toBeTruthy();
  });

  it('does not hydrate root rows from a partial Briefing containment cache', async () => {
    const row = { id: 'claude-policy', title: 'Claude policy', latest_round_id: 'round-1', round_count: 1,
      created_at: 1, updated_at: 1 };
    let warming = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return operatorSessionResponse();
      if (warming) {
        if (url === '/api/briefings') return new Response(JSON.stringify({ briefings: [row] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
        if (url === '/api/briefing-bundles') return new Response(JSON.stringify({ bundles: [{
          id: 'proposal', name: 'Agent policy proposal', created_at: 1, updated_at: 1,
          members: [{ position: 0, briefing: row }],
          layout: [{ kind: 'briefing', position: 0, briefing: row }],
        }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (!['/api/briefings', '/api/briefing-bundles', '/api/briefing-groups'].includes(url)) {
        return new Response(JSON.stringify({ incidents: [], counts: {} }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }));

    await Promise.all([getBriefings(), getBriefingBundles([])]);
    warming = false;
    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined,
      registerInitialRouteLoad: () => undefined,
      setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);

    expect(screen.queryByText('No Briefings have been reported yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select briefing Claude policy' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Agent policy proposal/ })).toBeNull();
  });

  it('normalizes stable logical rows and exact immutable selected-round bindings', () => {
    expect(normalizeBriefings({ briefings: [{ id: 'briefing-1', title: 'Recurring review',
      description: 'Durable source snapshot.', latest_round_id: 'round-2', unanswered_directive_count: 1,
      created_at: 1, updated_at: 2 }] }).briefings[0])
      .toMatchObject({ collectionId: 'briefing-1', description: 'Durable source snapshot.',
        latestRoundId: 'round-2', unansweredDirectiveCount: 1 });
    const projection = normalizeBriefingProjection(detail(ROUND_ONE));
    expect(projection).toMatchObject({
      briefing_id: 'briefing-1',
      selected_round_id: ROUND_ONE,
      latest_round_id: ROUND_TWO,
      latest_submission_for_actor: { id: `submission-${ROUND_ONE}` },
      document: {
        artifact_version_id: ARTIFACT_VERSION,
        content_hash: createHash('sha256').update(source.replace('Intro', 'First')).digest('hex'),
        source: source.replace('Intro', 'First'),
      },
    });
    expect(projection).not.toHaveProperty('latest_submission');
  });

  it('unions one selected immutable annotation set with only current unsubmitted annotations', () => {
    const payload = detail(ROUND_ONE) as any;
    payload.selected_round.latest_frozen_membership = {
      answer_event_ids: [], annotation_event_ids: ['current-frozen'],
    };
    payload.selected_round.annotations = [
      { annotation_event_id: 'current-frozen', annotation_kind: 'comment', start_offset: 0, end_offset: 5,
        quote: 'First', body: 'Already submitted current annotation.', replacement_text: null, created_at: 10 },
      { annotation_event_id: 'current-draft', annotation_kind: 'comment', start_offset: 0, end_offset: 5,
        quote: 'First', body: 'Unsubmitted current annotation.', replacement_text: null, created_at: 30 },
    ];
    payload.selected_round.selected_submission_overlay = {
      id: 'selected-set', ordinal: 1, supersedes_submission_id: null, actor_user_id: 'reviewer-id',
      actor: { slug: 'reviewer', display_name: 'Reviewer' }, created_at: 20, answer_count: 0, annotation_count: 1,
      answers: [], annotations: [{ annotation_event_id: 'immutable-selected', annotation_kind: 'comment',
        start_offset: 0, end_offset: 5, quote: 'First', body: 'Selected immutable annotation.',
        replacement_text: null, created_at: 20 }],
    };

    const projection = normalizeBriefingProjection(payload);
    expect(projection.annotations?.map((annotation) => [annotation.annotation_event_id,
      annotation.presentation?.source, annotation.presentation?.actor?.display_name ?? null])).toEqual([
      ['immutable-selected', 'annotation_set', 'Reviewer'],
      ['current-draft', 'current_draft', null],
    ]);
  });

  it('keeps the annotation-set shelf folded, sorts rows, and clears a keyboard-selected frozen overlay', async () => {
    const older = {
      id: 'submission-old', ordinal: 1, supersedes_submission_id: null,
      actor_user_id: 'amy-id', actor: { slug: 'amy', display_name: 'Amy' }, created_at: 100,
      answer_count: 1, annotation_count: 3,
    };
    const newer = {
      id: 'submission-new', ordinal: 2, supersedes_submission_id: 'submission-old',
      actor_user_id: 'zed-id', actor: { slug: 'zed', display_name: 'Zed' }, created_at: 200,
      answer_count: 1, annotation_count: 1,
    };
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith(`/api/briefings/briefing-1?round=${ROUND_ONE}`)) {
        const payload = detail(ROUND_ONE) as any;
        payload.selected_round.submission_overlays = [newer, older];
        payload.selected_round.selected_submission_overlay = url.includes('submission=submission-new') ? {
          ...newer,
          answers: [{
            directive_instance_id: `item-${ROUND_ONE}`, directive_key: 'decision',
            response_event_id: 'answer-frozen-dismiss', value: { verdict: 'dismiss' }, created_at: 200,
          }],
          annotations: [],
        } : null;
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: {
        artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown',
        size_bytes: new TextEncoder().encode(source.replace('Intro', 'First')).byteLength, source: null,
        preview: { encoding: 'utf-8', text: source.replace('Intro', 'First'), raw_text: source.replace('Intro', 'First'), truncated: false },
        download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' },
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
      <BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_ONE} instance={PRODUCTION_ALLOW_INSTANCE} />
    </AppShellProvider>);
    await screen.findByText('First');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true'));
    const shelf = screen.getByText('Annotation sets (2)').closest('details') as HTMLDetailsElement;
    expect(shelf.open).toBe(false);
    fireEvent.click(within(shelf).getByText('Annotation sets (2)'));
    expect(within(shelf).getAllByRole('row', { name: /^View annotation set/ }).map((row) => row.getAttribute('aria-label')))
      .toEqual(['View annotation set by Zed', 'View annotation set by Amy']);
    expect(within(shelf).queryByRole('button', { name: /^View annotation set/ })).toBeNull();
    fireEvent.click(within(shelf).getByRole('button', { name: 'Actor' }));
    expect(within(shelf).getAllByRole('row', { name: /^View annotation set/ }).map((row) => row.getAttribute('aria-label')))
      .toEqual(['View annotation set by Amy', 'View annotation set by Zed']);
    fireEvent.keyDown(within(shelf).getByRole('row', { name: 'View annotation set by Zed' }), { key: 'Enter' });
    await waitFor(() => expect(within(shelf).getByRole('row', { name: 'View annotation set by Zed' }).getAttribute('aria-selected')).toBe('true'));
    expect(requested).toContain(`/api/briefings/briefing-1?round=${ROUND_ONE}&submission=submission-new`);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(dismiss.disabled).toBe(true);
      expect(dismiss.getAttribute('aria-pressed')).toBe('true');
    });
    expect(screen.queryByText(/Viewing immutable submission/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Return to draft' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('renders a zero annotation-set count as inactive footer text without disclosure semantics', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_TWO}`) return new Response(JSON.stringify(detail(ROUND_TWO)), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
      <BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO} instance={PRODUCTION_ALLOW_INSTANCE} />
    </AppShellProvider>);
    await screen.findByText('Later');
    const inactive = screen.getByText('Annotation sets (0)');
    expect(inactive.tagName).toBe('DIV');
    expect(inactive.classList.contains('briefing-submission-shelf--inactive')).toBe(true);
    expect(inactive.getAttribute('role')).toBeNull();
    expect(inactive.tabIndex).toBe(-1);
    expect(inactive.closest('details')).toBeNull();
    fireEvent.click(inactive);
    fireEvent.keyDown(inactive, { key: 'Enter' });
    expect(screen.queryByText('No annotation sets for this round.')).toBeNull();
    expect(screen.queryByRole('grid', { name: 'Annotation sets for this round' })).toBeNull();
  });

  it('presents a published report as Current with report history', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/briefings/briefing-1') {
        const payload = detail(ROUND_TWO) as any;
        payload.briefing.publication_mode = 'published-report';
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: {
        artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown',
        size_bytes: new TextEncoder().encode(source.replace('Intro', 'Later')).byteLength, source: null,
        preview: { encoding: 'utf-8', text: source.replace('Intro', 'Later'), raw_text: source.replace('Intro', 'Later'), truncated: false },
        download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' },
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
      <BriefingDocumentRenderer briefingId="briefing-1" instance={PRODUCTION_ALLOW_INSTANCE} />
    </AppShellProvider>);

    expect(await screen.findByText('Current report', { selector: '.detail-pane-header__state' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Report history' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Round occurrence' })).toBeNull();
  });

  it('normalizes ordered v3 text variants with exact Markdown bodies and ranges', () => {
    const variantSource = ':::spec-item{key="wording" type="text_variant"}\n::alternative[Short]{key="short"}\nShort.\n::alternative[Long]{key="long"}\nLonger wording.\n:::';
    const start = variantSource.indexOf(':::');
    const bodyStart = variantSource.indexOf('Short.');
    const bodyEnd = variantSource.lastIndexOf('\n:::');
    const longBodyStart = variantSource.indexOf('Longer wording.');
    const payload = detail(ROUND_TWO) as any;
    payload.selected_round.profile = 'mandible-briefing.v3';
    payload.selected_round.document = {
      ...payload.selected_round.document,
      profile: 'mandible-briefing.v3',
      source: variantSource,
      content_hash: createHash('sha256').update(variantSource).digest('hex'),
    };
    payload.selected_round.items = [{
      id: 'item-wording', directive_key: 'wording', position: 0,
      definition_digest: createHash('sha256').update(variantSource).digest('hex'),
      response_type: 'text_variant', required: 1, prompt: 'Choose wording', options: [],
      variants: [
        { key: 'short', label: 'Short', body: 'Short.', start_offset: variantSource.indexOf('::alternative[Short]'), end_offset: bodyStart + 6, body_start_offset: bodyStart, body_end_offset: bodyStart + 6 },
        { key: 'long', label: 'Long', body: 'Longer wording.', start_offset: variantSource.indexOf('::alternative[Long]'), end_offset: longBodyStart + 15, body_start_offset: longBodyStart, body_end_offset: longBodyStart + 15 },
      ],
      start_offset: start, end_offset: variantSource.length,
      body_start_offset: bodyStart, body_end_offset: bodyEnd,
    }];
    payload.selected_round.answers = [];

    const projection = normalizeBriefingProjection(payload);
    expect(projection.valid).toBe(true);
    expect(projection.document?.profile).toBe('mandible-briefing.v3');
    expect(projection.items[0].revision).toMatchObject({
      response_type: 'text_variant',
      variants: [
        { key: 'short', label: 'Short', body: 'Short.' },
        { key: 'long', label: 'Long', body: 'Longer wording.' },
      ],
    });
  });

  it('gates reviewed Markdown export on the active actor frozen submission and surfaces refusal locally', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_ONE}`) return new Response(JSON.stringify(detail(ROUND_ONE)), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith(`/submissions/submission-${ROUND_ONE}/export`)) return new Response(JSON.stringify({ error: 'Frozen export is unavailable.' }), { status: 403, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
      <BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_ONE} instance={PRODUCTION_ALLOW_INSTANCE} />
    </AppShellProvider>);
    await screen.findByText('First');
    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export reviewed Markdown' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Frozen export is unavailable.');
    expect(calls).toContain(`/api/briefings/briefing-1/rounds/${ROUND_ONE}/submissions/submission-${ROUND_ONE}/export`);
  });

  it('does not offer reviewed Markdown export before the active actor has a frozen submission', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_TWO}`) return new Response(JSON.stringify(detail(ROUND_TWO)), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
      <BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO} instance={PRODUCTION_ALLOW_INSTANCE} />
    </AppShellProvider>);
    await screen.findByText('Later');
    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Export reviewed Markdown' })).toBeNull();
  });

  it('rejects a selectable stale typed detail whose copied database has no authoritative round identity', () => {
    const authoritative = typedDetail(ROUND_ONE);
    expect(normalizeBriefingProjection(authoritative).valid).toBe(true);
    const stale = structuredClone(authoritative);
    stale.briefing.round_count = 0;
    stale.rounds = [];
    expect(normalizeBriefingProjection(stale).valid).toBe(false);
  });

  it('keeps the rich demo old submission and empty revised round pinned to distinct artifact versions', () => {
    const versionOne = 'artifact-version:11111111-aaaa-4111-8111-111111111111';
    const versionTwo = 'artifact-version:22222222-bbbb-4222-8222-222222222222';
    const oldPayload = detail(ROUND_ONE) as any;
    oldPayload.briefing.title = RICH_BRIEFING_DEMO.title;
    oldPayload.rounds[0].artifact_version_id = versionOne;
    oldPayload.rounds[1].artifact_version_id = versionTwo;
    oldPayload.selected_round.artifact_version_id = versionOne;
    oldPayload.selected_round.document.artifact_version_id = versionOne;
    const latestPayload = detail(ROUND_TWO) as any;
    latestPayload.briefing.title = RICH_BRIEFING_DEMO.title;
    latestPayload.rounds[0].artifact_version_id = versionOne;
    latestPayload.rounds[1].artifact_version_id = versionTwo;
    latestPayload.selected_round.artifact_version_id = versionTwo;
    latestPayload.selected_round.document.artifact_version_id = versionTwo;
    const oldRound = normalizeBriefingProjection(oldPayload);
    const latestRound = normalizeBriefingProjection(latestPayload);

    expect(oldRound.document?.artifact_version_id).toBe(versionOne);
    expect(oldRound.latest_submission_for_actor).toMatchObject({ id: `submission-${ROUND_ONE}` });
    expect(oldRound.items[0].effective_response?.value).toEqual({ verdict: 'keep' });
    expect(latestRound.document?.artifact_version_id).toBe(versionTwo);
    expect(latestRound.latest_submission_for_actor).toBeNull();
    expect(latestRound.items[0].effective_response).toBeNull();
    expect(versionTwo).not.toBe(versionOne);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['unsupported', 'mandible-briefing.v1'],
  ])('fails closed for a %s selected-document profile', (_label, profile) => {
    const payload = detail() as any;
    if (profile === undefined) delete payload.selected_round.document.profile;
    else payload.selected_round.document.profile = profile;
    const projection = normalizeBriefingProjection(payload);
    expect(projection.valid).toBe(false);
    expect(projection.document).toBeNull();
  });

  it('never renders a raw-source fallback for an invalid profile', async () => {
    const payload = detail() as any;
    payload.selected_round.document.profile = 'mandible-briefing.v1';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_TWO}`) return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO} instance={null} /></AppShellProvider>);

    expect((await screen.findByRole('alert')).textContent).toContain('invalid or unsupported');
    expect(screen.queryByLabelText('Briefing document')).toBeNull();
    expect(screen.queryByLabelText('Pinned briefing document source')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/artifacts/'))).toBe(false);
  });

  it('formats every occurrence in browser-local date/time and sorts newest first with deterministic invalid fallbacks', () => {
    const localFormatter = new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const rounds = [
      { id: 'daily', ordinal: 1, artifact_version_id: ARTIFACT_VERSION, created_at: Date.UTC(2026, 7, 18, 8), origin: { source: 'scan', run_id: '1', task_identity: 'agent-schedule/daily-digest' } },
      { id: 'weekly', ordinal: 2, artifact_version_id: ARTIFACT_VERSION, created_at: Date.UTC(2026, 7, 18, 8), origin: { source: 'scan', run_id: '2', task_identity: 'agent-schedule/weekly-digest' } },
      { id: 'adhoc-1', ordinal: 3, artifact_version_id: ARTIFACT_VERSION, created_at: Date.UTC(2026, 7, 18, 8, 30), origin: { source: 'manual', run_id: '3', task_identity: 'ad-hoc' } },
      { id: 'adhoc-2', ordinal: 4, artifact_version_id: ARTIFACT_VERSION, created_at: Date.UTC(2026, 7, 18, 8, 30), origin: { source: 'manual', run_id: '4', task_identity: 'ad-hoc' } },
      { id: 'invalid-low', ordinal: 5, artifact_version_id: ARTIFACT_VERSION, created_at: Number.NaN, origin: { source: 'manual', run_id: '5', task_identity: 'ad-hoc' } },
      { id: 'invalid-high', ordinal: 6, artifact_version_id: ARTIFACT_VERSION, created_at: Number.NaN, origin: { source: 'manual', run_id: '6', task_identity: 'ad-hoc' } },
    ];
    const options = briefingRoundOptions(rounds);
    const labels = new Map(options.map(({ round, label }) => [round.id, label]));
    const eightThirty = localFormatter.format(Date.UTC(2026, 7, 18, 8, 30));
    const eight = localFormatter.format(Date.UTC(2026, 7, 18, 8));
    expect(options.map(({ round }) => round.id)).toEqual(['adhoc-2', 'adhoc-1', 'weekly', 'daily', 'invalid-high', 'invalid-low']);
    expect(labels.get('adhoc-2')).toBe(`${eightThirty} · #4`);
    expect(labels.get('adhoc-1')).toBe(`${eightThirty} · #3`);
    expect(labels.get('weekly')).toBe(`${eight} · #2`);
    expect(labels.get('daily')).toBe(`${eight} · #1`);
    expect(labels.get('invalid-high')).toBe('Unknown occurrence · #6');
    expect([...labels.values()].every((label) => !label.includes('Latest') && !label.includes('UTC'))).toBe(true);
  });

  it('keeps full Briefing identities as copy and mutation authority while displaying and routing compact refs', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    window.history.replaceState(null, '', '/#/briefing');
    const payload = detail() as any;
    payload.briefing = {
      ...payload.briefing,
      id: FULL_BRIEFING_ID,
      title: 'arxiv-scan',
      latest_round_id: FULL_ROUND_ID,
      round_count: 1,
    };
    payload.rounds = [{
      id: FULL_ROUND_ID,
      ordinal: 1,
      artifact_version_id: FULL_ARTIFACT_VERSION_REF,
      created_at: 2,
      origin: { source: 'arxiv-scan', run_id: 'run-1', task_identity: 'ad-hoc' },
    }];
    payload.selected_round = {
      ...selectedRound(FULL_ROUND_ID, FULL_ARTIFACT_VERSION_REF),
      ordinal: 1,
      previous_round_id: null,
    };
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/briefings') return new Response(JSON.stringify({ briefings: [payload.briefing] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/briefing-bundles') return new Response(JSON.stringify({ bundles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/briefing-groups') return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url === `/api/briefings/${encodeURIComponent(FULL_BRIEFING_ID)}`) return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, source: null, preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/answers')) return new Response(JSON.stringify({ answer_event_ids: ['answer-new'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/submit')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${method} ${url}`);
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Select briefing arxiv-scan' }));
    expect(window.location.hash).toBe('#/briefing?briefing=briefing%3A65db040');

    const headerRef = await screen.findByText('65db040');
    expect(headerRef.closest('.detail-pane-header__identity')?.textContent).toContain('65db040');
    expect(headerRef.closest('.detail-pane-header__identity')?.textContent).not.toContain('Briefing');
    expect(headerRef.closest('.detail-pane-header__identity')?.textContent).not.toContain('briefing:');
    expect(screen.queryByText(FULL_BRIEFING_ID)).toBeNull();
    await screen.findByRole('button', { name: 'Briefing actions' });
    const header = headerRef.closest('.detail-pane-shell__header') as HTMLElement;
    const composition = header.querySelector('.detail-pane-header[data-detail-pane-header-variant="versioned"]') as HTMLElement;
    expect(composition.querySelector('.detail-pane-header__main')?.children).toHaveLength(2);
    expect(within(composition).getByText('65db040')).toBeTruthy();
    expect(within(composition).getByRole('heading', { name: 'arxiv-scan' })).toBeTruthy();
    const description = within(composition).getByText(
      'Explains why this review exists. It represents a durable source snapshot.',
    );
    expect(description.classList.contains('briefing-detail__description')).toBe(true);
    expect(description.closest('.detail-pane-header__title-block')).toBeTruthy();
    expect(within(composition).getByRole('button', { name: 'Briefing actions' })).toBeTruthy();
    expect(within(composition).getByRole('group', { name: 'Round occurrence' })).toBeTruthy();
    const roundSelect = within(composition).getByRole('combobox', { name: 'Round occurrence' });
    const roundCopy = within(composition).getByRole('button', { name: 'Copy selected round reference' });
    const selectorControl = roundSelect.closest('.detail-pane-header__selector-control');
    expect(selectorControl?.firstElementChild).toBe(roundSelect);
    expect(selectorControl?.nextElementSibling).toBe(roundCopy);
    expect(roundCopy.tagName).toBe('BUTTON');
    expect(roundCopy.getAttribute('tabindex')).not.toBe('-1');
    roundCopy.focus();
    expect(document.activeElement).toBe(roundCopy);
    fireEvent.click(roundCopy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('briefing-round:c76f940'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Briefing reference' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('briefing:65db040'));

    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions' }));
    expect(screen.getByRole('menuitem', { name: 'Go to artifact version' }).getAttribute('href'))
      .toBe('#/artifacts?ref=artifact-version%3A264e485');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Metadata' }));
    const metadata = screen.getByRole('dialog', { name: 'Briefing metadata' });
    expect(within(metadata).getByText('briefing-round:c76f940')).toBeTruthy();
    expect(within(metadata).queryByText(FULL_ROUND_ID)).toBeNull();
    expect(within(metadata).getByText('artifact-version:264e485')).toBeTruthy();
    expect(within(metadata).queryByText(FULL_ARTIFACT_VERSION_REF)).toBeNull();
    fireEvent.click(within(metadata).getByRole('button', { name: 'Copy full round ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FULL_ROUND_ID));
    fireEvent.click(within(metadata).getByRole('button', { name: 'Copy exact artifact-version ref' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FULL_ARTIFACT_VERSION_REF));
    fireEvent.click(within(metadata).getByRole('button', { name: 'Close Briefing metadata' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const submit = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(submit);
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      `/api/briefings/${encodeURIComponent(FULL_BRIEFING_ID)}/rounds/${encodeURIComponent(FULL_ROUND_ID)}/answers`,
      `/api/briefings/${encodeURIComponent(FULL_BRIEFING_ID)}/rounds/${encodeURIComponent(FULL_ROUND_ID)}/submit`,
    ]));
  });

  it('refreshes mounted Briefing groups for every declared external event and retains last-good content on malformed reads', async () => {
    let name = 'Initial external group';
    let malformed = false;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      const body = url === '/api/client-auth/whoami' ? { authenticated: true, user: { id: 'human', kind: 'human' } }
        : url === '/api/briefings' ? { briefings: [] }
        : url === '/api/briefing-bundles' ? { bundles: [] }
        : url === '/api/briefing-groups' ? malformed ? { groups: null } : { groups: [{ id: 'group-external', key: 'external', name, current: null, updates: [] }] }
        : { incidents: [], counts: {} };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }));
    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);
    await screen.findAllByText(name);
    for (const [index, type] of BRIEFING_EVENT_VALUES.entries()) {
      name = `Externally updated group ${index}`;
      expect(invalidateBriefingApiCacheForEvent(type)).toBe(true);
      await screen.findAllByText(name);
    }
    malformed = true;
    invalidateBriefingApiCacheForEvent('briefing:group-name-updated');
    await screen.findByRole('alert');
    expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    expect(screen.queryByText('No Briefings in this view.')).toBeNull();
  });

  it('reports an independent read failure in the main area instead of a false empty Briefing list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/client-auth/whoami') {
        return operatorSessionResponse();
      }
      if (String(input) === '/api/briefings') {
        return new Response(JSON.stringify({ error: 'briefing_reader_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ incidents: [], counts: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);

    const sidebar = await screen.findByRole('complementary', { name: 'Briefings' });
    expect((await screen.findByRole('alert')).textContent).toContain('briefing_reader_unavailable');
    expect(within(sidebar).queryByRole('alert')).toBeNull();
    expect(within(sidebar).queryByText('No Briefings have been reported yet.')).toBeNull();
  });

  it('keeps a local access interruption out of Briefing notices and empty states', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return operatorSessionResponse();
      if (url === '/api/briefings') return new Response(JSON.stringify({ error: 'local_access_unavailable' }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
      return new Response(JSON.stringify({ incidents: [], counts: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);

    const sidebar = await screen.findByRole('complementary', { name: 'Briefings' });
    expect(await within(sidebar).findByText('Briefings have not loaded.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(sidebar).queryByText('No Briefings have been reported yet.')).toBeNull();
  });

  it('defaults to latest, preserves explicit history across reconciliation, isolates drafts, and uses Submit/correction gates', async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/briefings') return new Response(JSON.stringify({ briefings: [{ id: 'briefing-1', title: 'Recurring review', latest_round_id: 'round-2', unanswered_directive_count: 1, created_at: 1, updated_at: 2 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/briefing-bundles') return new Response(JSON.stringify({ bundles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/briefing-groups') return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url.startsWith('/api/briefings/briefing-1')) return new Response(JSON.stringify(detail(new URL(url, 'http://x').searchParams.get('round') ?? ROUND_TWO)), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, source: null, preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/answers')) return new Response(JSON.stringify({ answer_event_ids: ['answer-new'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/submit')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${method} ${url}`);
    }));
    window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({ ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE, selectedCollectionId: 'briefing:briefing-1' }));
    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);
    const sidebar = await screen.findByRole('complementary', { name: 'Briefings' });
    expect((sidebar as HTMLElement).style.width).toBe('360px');
    expect(screen.getByRole('searchbox', { name: 'Search briefings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pin Recurring review/ })).toBeNull();
    const roundOptions = await screen.findAllByRole('option');
    expect(roundOptions.map((option) => option.getAttribute('value'))).toEqual([ROUND_TWO, ROUND_ONE]);
    expect(roundOptions.every((option) => !option.textContent?.includes('Latest') && !option.textContent?.includes('UTC'))).toBe(true);
    const latestMarker = screen.getByText('Latest', { selector: '.detail-pane-header__state' });
    expect(latestMarker.nextElementSibling).toBe(screen.getByRole('group', { name: 'Round occurrence' }));
    const roundSelectorControl = latestMarker.nextElementSibling?.querySelector('.detail-pane-header__selector-control');
    expect(roundSelectorControl?.firstElementChild).toBe(screen.getByRole('combobox', { name: 'Round occurrence' }));
    expect(roundSelectorControl?.nextElementSibling).toBe(screen.getByRole('button', { name: 'Copy selected round reference' }));
    expect(screen.getByRole('combobox', { name: 'Round occurrence' }).getAttribute('value') ?? (screen.getByRole('combobox') as HTMLSelectElement).value).toBe(ROUND_TWO);
    expect(await screen.findByText('Later')).toBeTruthy();
    const shell = screen.getByTestId('briefing-document-renderer').closest('.detail-pane-shell') as HTMLElement;
    expect(shell.querySelector(':scope > .detail-pane-shell__header')).toBeTruthy();
    expect(shell.querySelector(':scope > .detail-pane-shell__body')).toBeTruthy();
    expect(shell.querySelector(':scope > .detail-pane-shell__footer')).toBeTruthy();
    expect(within(shell.querySelector('.detail-pane-shell__body') as HTMLElement).queryByText(/Immutable round|Briefing round|Pinned document|Review source|Source and existing annotations/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Briefing actions' }));
    expect(screen.getByRole('menuitem', { name: 'Go to artifact version' }).getAttribute('href')).toBe('#/artifacts?ref=artifact-version%3Aaaaaaaaa');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Metadata' }));
    const metadata = screen.getByRole('dialog', { name: 'Briefing metadata' });
    expect(within(metadata).getByText('Round occurrence')).toBeTruthy();
    expect(within(metadata).getByText('22222222')).toBeTruthy();
    expect(within(metadata).queryByText(ROUND_TWO)).toBeNull();
    expect(within(metadata).getByText('artifact-version:aaaaaaaa')).toBeTruthy();
    fireEvent.click(within(metadata).getByRole('button', { name: 'Close Briefing metadata' }));
    const latestSubmit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(latestSubmit.getAttribute('aria-disabled')).toBe('true');
    await waitFor(() => expect(latestSubmit.getAttribute('title')).toBe('Complete the required directives before submitting.'));
    fireEvent.keyDown(latestSubmit, { key: 'Enter' });
    fireEvent.click(latestSubmit);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(await screen.findByText('This answer is required.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' })));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await waitFor(() => expect(latestSubmit.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(latestSubmit);
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      `/api/briefings/briefing-1/rounds/${ROUND_TWO}/answers`,
      `/api/briefings/briefing-1/rounds/${ROUND_TWO}/submit`,
    ]));
    const roundSelect = screen.getByRole('combobox', { name: 'Round occurrence' }) as HTMLSelectElement;
    roundSelect.value = ROUND_ONE;
    fireEvent.input(roundSelect);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}').selectedRoundIds).toMatchObject({ 'briefing:briefing-1': ROUND_ONE }));
    await waitFor(() => expect(screen.queryByText('Latest', { selector: '.detail-pane-header__state' })).toBeNull());
    expect(await screen.findByText('First')).toBeTruthy();
    expect(screen.queryByText('Later')).toBeNull();
    void refreshBrowserResources(queryClient, [browserResourceKeys.briefings]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((screen.getByRole('combobox', { name: 'Round occurrence' }) as HTMLSelectElement).value).toBe(ROUND_ONE);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Dismiss' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Submit' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/No answer or annotation changes/)).toBeTruthy();
    expect(screen.queryByText(/producer|finding/i)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}').selectedRoundIds).toMatchObject({ 'briefing:briefing-1': ROUND_ONE });
  });

  it('loads a short round deep link but keeps the resolved full round ID for mutations', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_TWO.slice(0, 8)}`) return new Response(JSON.stringify(detail(ROUND_TWO)), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, source: null, preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/answers')) return new Response(JSON.stringify({ answer_event_ids: ['answer-new'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/submit')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${method} ${url}`);
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO.slice(0, 8)} instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const submit = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(submit);

    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      `/api/briefings/briefing-1/rounds/${ROUND_TWO}/answers`,
      `/api/briefings/briefing-1/rounds/${ROUND_TWO}/submit`,
    ]));
    expect(calls).toContainEqual({ url: `/api/briefings/briefing-1?round=${ROUND_TWO.slice(0, 8)}`, method: 'GET' });
  });

  it('revokes mutation authority on reconnect and retains last-good content when the round read fails', async () => {
    let detailReads = 0;
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (!init?.method && url === `/api/briefings/briefing-1?round=${ROUND_TWO}`) {
        detailReads += 1;
        return detailReads === 1
          ? new Response(JSON.stringify(detail(ROUND_TWO)), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ error: 'briefing round not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, source: null, preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST') posts.push(url);
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    }));

    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO} instance={COPIED_PREVIEW_INSTANCE} /></AppShellProvider>);
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' }) as HTMLButtonElement;
    await waitFor(() => expect(dismiss.disabled).toBe(false));

    void refreshBrowserResources(queryClient, [browserResourceKeys.briefings]);
    await waitFor(() => expect(dismiss.disabled).toBe(true));
    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('briefing round not found'));
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toEqual([]);
  });

  it.each([
    ['correction', 'Dismiss', { directive_key: 'decision', operation: 'set', expected_response_event_id: 'answer-old', value: { verdict: 'dismiss' } }],
    ['retraction', 'Clear response', { directive_key: 'decision', operation: 'retract', expected_response_event_id: 'answer-old' }],
  ])('preserves the exact current response event ID for %s payloads', async (_label, action, expectedAnswer) => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (!init?.method && url === `/api/briefings/briefing-1?round=${ROUND_ONE}`) {
        const payload = detail(ROUND_ONE) as any;
        if (action === 'Clear response') payload.selected_round.items[0].required = 0;
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(source).byteLength, source: null, preview: { encoding: 'utf-8', text: source, raw_text: source, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: source.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith('/answers')) return new Response(JSON.stringify({ answer_event_ids: ['answer-result'] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.endsWith('/submit')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_ONE} instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);
    fireEvent.click(await screen.findByRole('button', { name: action }));
    const submit = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(submit);
    await waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(2));
    expect(posts[0].body).toEqual({ answers: [expectedAnswer] });
  });

  it('enables the six typed controls in a copied preview and freezes exact actor-scoped answer and annotation membership', async () => {
    const posts: Array<{ url: string; body: any }> = [];
    let annotationSaved = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human-1', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (!init?.method && url.startsWith('/api/briefings/briefing-typed')) {
        const selected = new URL(url, 'http://x').searchParams.get('round') ?? ROUND_TWO;
        const annotations = annotationSaved && selected === ROUND_ONE ? [{
          annotation_event_id: 'annotation-new', annotation_kind: 'comment',
          start_offset: TYPED_DIRECTIVES[0].body_start_offset, end_offset: TYPED_DIRECTIVES[0].body_end_offset,
          quote: 'Keep this?', body: 'Copied-preview note.', replacement_text: null, created_at: 3,
        }] : [];
        return new Response(JSON.stringify(typedDetail(selected, annotations)), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: {
        artifact_id: 'artifact:typed', status: 'available', kind: 'markdown', media_type: 'text/markdown',
        size_bytes: new TextEncoder().encode(TYPED_SOURCE).byteLength, source: null,
        preview: { encoding: 'utf-8', text: TYPED_SOURCE, raw_text: TYPED_SOURCE, truncated: false },
        download: { available: true, media_type: 'text/markdown', size_bytes: TYPED_SOURCE.length, filename: 'typed.md' },
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push({ url, body });
        if (url.endsWith('/annotations')) {
          annotationSaved = true;
          return new Response(JSON.stringify({ annotation_event_ids: ['annotation-new'] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/answers')) return new Response(JSON.stringify({ answer_event_ids: TYPED_DIRECTIVES.map((directive) => `answer-${directive.key}`) }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.endsWith('/submit')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    }));
    const shell = (roundId: string) => <AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
      <BriefingDocumentRenderer briefingId="briefing-typed" roundId={roundId} instance={COPIED_PREVIEW_INSTANCE} />
    </AppShellProvider>;
    const view = render(shell(ROUND_ONE));

    const keep = await screen.findByRole('button', { name: 'Keep' });
    await waitFor(() => expect((keep as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Third' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'First' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Short rationale' }), { target: { value: 'Short answer' } });
    fireEvent.input(screen.getByRole('textbox', { name: 'Long rationale' }), { target: { value: 'Long answer' } });
    fireEvent.click(screen.getByRole('radio', { name: '5' }));

    expect(keep.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('radio', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'First' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Third' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Short rationale' }) as HTMLInputElement).value).toBe('Short answer');
    expect((screen.getByRole('textbox', { name: 'Long rationale' }) as HTMLTextAreaElement).value).toBe('Long answer');
    expect((screen.getByRole('radio', { name: '5' }) as HTMLInputElement).checked).toBe(true);

    view.rerender(shell(ROUND_TWO));
    const roundTwoKeep = await screen.findByRole('button', { name: 'Keep' });
    await waitFor(() => expect(roundTwoKeep.getAttribute('aria-pressed')).toBe('false'));
    expect((screen.getByRole('radio', { name: 'Beta' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('textbox', { name: 'Short rationale' }) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('textbox', { name: 'Long rationale' }) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByRole('radio', { name: '5' }) as HTMLInputElement).checked).toBe(false);

    view.rerender(shell(ROUND_ONE));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Short rationale' }) as HTMLInputElement).value).toBe('Short answer'));
    const addComment = screen.getAllByRole('button', { name: 'Comment' })[0] as HTMLButtonElement;
    await waitFor(() => expect(addComment.disabled).toBe(false));
    fireEvent.click(addComment);
    const annotationDialog = await screen.findByRole('dialog', { name: 'Add annotation' });
    fireEvent.input(within(annotationDialog).getByLabelText('Comment'), { target: { value: 'Copied-preview note.' } });
    fireEvent.click(within(annotationDialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts.some((post) => post.url.endsWith('/annotations'))).toBe(true));
    fireEvent.click(await screen.findByTitle('Comment · 1'));
    expect(within(screen.getByRole('dialog')).getByText(/Copied-preview note/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close annotation editor' }));

    const submit = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(submit);
    await waitFor(() => expect(posts.some((post) => post.url.endsWith('/submit'))).toBe(true));
    expect(posts.map((post) => post.url)).toEqual([
      `/api/briefings/briefing-typed/rounds/${ROUND_ONE}/annotations`,
      `/api/briefings/briefing-typed/rounds/${ROUND_ONE}/answers`,
      `/api/briefings/briefing-typed/rounds/${ROUND_ONE}/submit`,
    ]);
    expect(posts[1].body).toEqual({ answers: [
      { directive_key: 'verdict', operation: 'set', expected_response_event_id: null, value: { verdict: 'keep' } },
      { directive_key: 'single', operation: 'set', expected_response_event_id: null, value: { option_key: 'b' } },
      { directive_key: 'multi', operation: 'set', expected_response_event_id: null, value: { option_keys: ['first', 'third'] } },
      { directive_key: 'short', operation: 'set', expected_response_event_id: null, value: { text: 'Short answer' } },
      { directive_key: 'long', operation: 'set', expected_response_event_id: null, value: { text: 'Long answer' } },
      { directive_key: 'rating', operation: 'set', expected_response_event_id: null, value: { rating: 5 } },
    ] });
    expect(posts[2].body).toEqual({
      supersedes_submission_id: null,
      answers: TYPED_DIRECTIVES.map((directive) => ({ directive_key: directive.key, response_event_id: `answer-${directive.key}` })),
      annotation_event_ids: ['annotation-new'],
    });
  });

  it('renders and annotates directive-free v3 Markdown through the exact-version route while runs stay strict', async () => {
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-annotation-only-ui-roundtrip-'));
    const { db: privateDb, dbPath: privateDbPath, sourceDbPath, previewRoot, sourceRoot } = createCopiedPreviewDatabase(privateRoot);
    try {
      setSetting(privateDb, 'artifact_root', path.join(previewRoot, 'artifacts'));
      createUser(privateDb, { slug: 'agent-schedule', kind: 'agent', display_name: 'Scheduled publisher' });
      const humanId = createUser(privateDb, { slug: 'annotation-human', kind: 'human', display_name: 'Annotation human' }).id;
      const markdown = '# Policy\n\nReview this paragraph.\n\n## Scope\n\nKeep exact custody.\n';
      const sourcePath = path.join(privateRoot, 'AGENTS.review.md');
      fs.writeFileSync(sourcePath, markdown);
      const artifact = recordArtifactVersion(privateDb, {
        source_kind: 'local_only', path: sourcePath, logical_name: 'AGENTS.review.md',
        role: 'review-document', media_type: 'text/markdown',
      });
      const production = new Router({
        clientAuth: new UiRoundTripGate(privateDb),
        instance: resolveInstanceInfo({
          env: exactTestInstanceEnv('test'),
          dbPath: privateDbPath,
        }),
      });
      registerBriefingRoutes(production, privateDb);
      const created = await production.invoke({
        method: 'POST', url: '/api/briefings', credential: 'annotation-human', transport: 'http',
        body: { artifact_version_ref: artifact.version.id, title: 'AGENTS review' },
      });
      expect(created).toMatchObject({ status: 201, body: { artifact_version_id: artifact.version.id } });
      const ids = created.body as { briefing_id: string; round_id: string };
      const strictRun = await production.invoke({
        method: 'POST', url: '/api/briefings/runs', credential: 'agent-schedule', transport: 'http',
        body: {
          schema: 'mandible-briefing-run@1', briefing_key: 'strict-run', title: 'Strict run',
          task_identity: 'agent-schedule/daily-digest', run_id: 'plain-run', run_key: 'plain-run-key',
          responder_user_ids: [humanId], evidence: { series_ref: 'artifact-series:plain', version: 1, digest: 'a'.repeat(64) },
          source_health: { source: 'arxiv-scan', status: 'healthy', detail: null, observed_at: 1 },
          document: { markdown }, quiet_reason: null, occurrences: [],
        },
      });
      expect(strictRun).toMatchObject({ status: 400, body: { error: expect.stringContaining('no spec-item directives') } });

      const previewInstance = resolveInstanceInfo({
        env: exactTestInstanceEnv('preview', { previewRoot, sourceRoot }),
        dbPath: privateDbPath, sourceDbPath,
      });
      const preview = new Router({ clientAuth: new UiRoundTripGate(privateDb), instance: previewInstance });
      registerBriefingRoutes(preview, privateDb);
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/client-auth/whoami') {
          return new Response(JSON.stringify({ authenticated: true, user: {
            id: humanId, slug: 'annotation-human', kind: 'human', display_name: 'Annotation human',
          } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (!url.startsWith('/api/briefings')) throw new Error(`unexpected annotation-only request ${method} ${url}`);
        const result = await preview.invoke({
          method, url, credential: 'annotation-human', transport: 'http',
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
      }));
      render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
        <BriefingDocumentRenderer briefingId={ids.briefing_id} roundId={ids.round_id} instance={previewInstance} />
      </AppShellProvider>);

      expect((await screen.findByLabelText('Pinned briefing document')).textContent).toContain('Review this paragraph.');
      const submit = screen.getByRole('button', { name: 'Submit' });
      expect(submit.getAttribute('aria-disabled')).toBe('true');
      expect(submit.getAttribute('title')).toBe('Add an answer or annotation before submitting.');
      const comment = await screen.findByRole('button', { name: 'Comment on section Policy' }) as HTMLButtonElement;
      await waitFor(() => expect(comment.disabled).toBe(false));
      fireEvent.click(comment);
      const dialog = await screen.findByRole('dialog', { name: 'Add annotation' });
      fireEvent.input(within(dialog).getByLabelText('Comment'), { target: { value: 'Annotation-only review note.' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      const populatedPolicyAction = await screen.findByRole('button', { name: 'Comment on section Policy' });
      await waitFor(() => expect(populatedPolicyAction.getAttribute('title')).toContain('· 1'));
      fireEvent.click(populatedPolicyAction);
      expect(within(screen.getByRole('dialog')).getByText(/Annotation-only review note/)).toBeTruthy();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close annotation editor' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Comment on section Policy' }));
      const secondDialog = await screen.findByRole('dialog', { name: 'Add annotation' });
      fireEvent.input(within(secondDialog).getByLabelText('Comment'), { target: { value: 'Second pending review note.' } });
      fireEvent.click(within(secondDialog).getByRole('button', { name: 'Save' }));
      const twicePopulatedPolicyAction = await screen.findByRole('button', { name: 'Comment on section Policy' });
      await waitFor(() => expect(twicePopulatedPolicyAction.getAttribute('title')).toContain('· 2'));
      fireEvent.click(twicePopulatedPolicyAction);
      expect(within(screen.getByRole('dialog')).getByText(/Second pending review note/)).toBeTruthy();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close annotation editor' }));
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      const clearDialog = await screen.findByRole('dialog', { name: 'Clear 2 annotations?' });
      expect(within(clearDialog).getByText('This will permanently delete exactly 2 pending annotations. Submitted annotation sets remain unchanged.')).toBeTruthy();
      fireEvent.click(within(clearDialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: 'Clear 2 annotations?' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Comment on section Policy' }));
      expect(within(screen.getByRole('dialog')).getByText(/Second pending review note/)).toBeTruthy();
      expect(within(screen.getByRole('dialog')).getByText(/Annotation-only review note/)).toBeTruthy();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close annotation editor' }));
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      fireEvent.click(within(await screen.findByRole('dialog', { name: 'Clear 2 annotations?' })).getByRole('button', { name: 'Delete 2 annotations' }));
      await waitFor(() => expect(screen.queryByTitle(/Comment on whole section ·/)).toBeNull());
      expect(submit.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(await screen.findByRole('button', { name: 'Comment on section Policy' }));
      const replacementDialog = await screen.findByRole('dialog', { name: 'Add annotation' });
      fireEvent.input(within(replacementDialog).getByLabelText('Comment'), { target: { value: 'Annotation-only review note.' } });
      fireEvent.click(within(replacementDialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add annotation' })).toBeNull());
      const currentSubmit = screen.getByRole('button', { name: 'Submit' });
      await waitFor(() => expect(currentSubmit.getAttribute('aria-disabled')).toBe('false'));
      fireEvent.click(currentSubmit);
      const copyResult = await screen.findByRole('button', { name: 'Copy result ID' });
      expect(copyResult.classList.contains('btn--success')).toBe(true);
      expect(copyResult.nextElementSibling).toBe(screen.getByRole('button', { name: 'Submit' }));
      expect((await screen.findByText('Annotation sets (1)')).closest('details')?.hasAttribute('open')).toBe(false);
      expect(screen.queryByRole('button', { name: /Annotation-only review note/ })).toBeNull();
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      fireEvent.click(copyResult);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.any(String)));
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(screen.queryByRole('dialog', { name: /Clear \d+ annotations?/ })).toBeNull();
      const detail = await preview.invoke({
        method: 'GET', url: `/api/briefings/${ids.briefing_id}?round=${ids.round_id}`,
        credential: 'annotation-human', transport: 'http',
      });
      expect((detail.body as any).selected_round).toMatchObject({
        id: ids.round_id, items: [], annotations: [{ body: 'Annotation-only review note.' }],
      });
    } finally {
      privateDb.close();
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });

  it('clicks all six controls through the production API/store and freezes only the selected actor round', async () => {
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-typed-ui-roundtrip-'));
    const { db: privateDb, dbPath: privateDbPath, sourceDbPath, previewRoot, sourceRoot } = createCopiedPreviewDatabase(privateRoot);
    try {
      setSetting(privateDb, 'artifact_root', path.join(previewRoot, 'artifacts'));
      createUser(privateDb, { slug: 'agent-schedule', kind: 'agent', display_name: 'Typed publisher' });
      const humanId = createUser(privateDb, { slug: 'typed-human', kind: 'human', display_name: 'Typed human' }).id;
      const production = new Router({
        clientAuth: new UiRoundTripGate(privateDb),
        instance: resolveInstanceInfo({
          env: exactTestInstanceEnv('test'),
          dbPath: privateDbPath,
        }),
      });
      registerBriefingRoutes(production, privateDb);
      const runPayload = (ordinal: number) => ({
        schema: 'mandible-briefing-run@1', briefing_key: 'typed-ui-roundtrip', title: 'Typed UI round-trip',
        task_identity: 'agent-schedule/daily-digest', run_id: `typed-run-${ordinal}`, run_key: `typed-key-${ordinal}`,
        responder_user_ids: [humanId],
        evidence: { series_ref: 'artifact-series:typed-ui-roundtrip', version: ordinal, digest: String(ordinal).repeat(64) },
        source_health: { source: 'arxiv-scan', status: 'healthy', detail: null, observed_at: ordinal },
        document: { markdown: ordinal === 1 ? TYPED_SOURCE : `${TYPED_SOURCE}\n\nRun ${ordinal}.` }, quiet_reason: null,
        occurrences: TYPED_DIRECTIVES.map((directive, index) => ({
          directive_key: directive.key, evidence_digest: (index + ordinal).toString(16).slice(-1).repeat(64), occurred_at: ordinal, metadata: {},
        })),
      });
      const first = await production.invoke({ method: 'POST', url: '/api/briefings/runs', credential: 'agent-schedule', body: runPayload(1), transport: 'http' });
      const second = await production.invoke({ method: 'POST', url: '/api/briefings/runs', credential: 'agent-schedule', body: runPayload(2), transport: 'http' });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstIds = first.body as { briefing_id: string; round_id: string };
      const secondIds = second.body as { briefing_id: string; round_id: string };
      expect(secondIds.briefing_id).toBe(firstIds.briefing_id);
      expect(secondIds.round_id).not.toBe(firstIds.round_id);

      const previewInstance = resolveInstanceInfo({
        env: exactTestInstanceEnv('preview', { previewRoot, sourceRoot }),
        dbPath: privateDbPath, sourceDbPath,
      });
      expect(previewInstance).toMatchObject({
        role: 'preview', allowed_effects: STANDARD_PREVIEW_EFFECTS,
        db_path: privateDbPath, source_db_path: sourceDbPath,
      });
      const preview = new Router({
        clientAuth: new UiRoundTripGate(privateDb),
        instance: previewInstance,
      });
      registerBriefingRoutes(preview, privateDb);
      expect(await preview.invoke({ method: 'POST', url: '/api/briefings/runs', credential: 'agent-schedule', body: runPayload(3), transport: 'http' }))
        .toMatchObject({ status: 200, body: { quiet: false } });
      const mutationResponses: Array<{ url: string; status: number }> = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/client-auth/whoami') {
          return new Response(JSON.stringify({ authenticated: true, user: { id: humanId, slug: 'typed-human', kind: 'human', display_name: 'Typed human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const artifactMatch = /^\/api\/artifacts\/([^/]+)\/content$/.exec(url);
        if (method === 'GET' && artifactMatch) {
          const content = getArtifactContent(privateDb, decodeURIComponent(artifactMatch[1]));
          return new Response(JSON.stringify({ content }), { status: content ? 200 : 404, headers: { 'content-type': 'application/json' } });
        }
        if (!url.startsWith('/api/briefings')) throw new Error(`unexpected production-path request ${method} ${url}`);
        const result = await preview.invoke({
          method, url, credential: 'typed-human', transport: 'http',
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (method !== 'GET') mutationResponses.push({ url, status: result.status });
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
      }));

      render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
        <BriefingDocumentRenderer briefingId={firstIds.briefing_id} roundId={firstIds.round_id} instance={previewInstance} />
      </AppShellProvider>);
      const keep = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
      await waitFor(() => expect(keep.disabled).toBe(false));
      fireEvent.click(keep);
      fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Third' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'First' }));
      fireEvent.input(screen.getByRole('textbox', { name: 'Short rationale' }), { target: { value: 'Exact short answer' } });
      fireEvent.input(screen.getByRole('textbox', { name: 'Long rationale' }), { target: { value: 'Exact long answer' } });
      const rating = screen.getByRole('radio', { name: '5' }) as HTMLInputElement;
      fireEvent.click(rating);
      expect(keep.getAttribute('aria-pressed')).toBe('true');
      expect((screen.getByRole('radio', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole('checkbox', { name: 'First' }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole('checkbox', { name: 'Third' }) as HTMLInputElement).checked).toBe(true);
      expect(rating.checked).toBe(true);

      fireEvent.click(screen.getAllByRole('button', { name: 'Comment' })[0]);
      const annotationDialog = await screen.findByRole('dialog', { name: 'Add annotation' });
      fireEvent.input(within(annotationDialog).getByLabelText('Comment'), { target: { value: 'Persisted through the real route.' } });
      fireEvent.click(within(annotationDialog).getByRole('button', { name: 'Save' }));
      fireEvent.click(await screen.findByTitle('Comment · 1'));
      expect(within(screen.getByRole('dialog')).getByText(/Persisted through the real route/)).toBeTruthy();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close annotation editor' }));

      const submit = screen.getByRole('button', { name: 'Submit' });
      await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('false'));
      fireEvent.click(submit);
      await waitFor(() => expect(mutationResponses).toHaveLength(3));
      expect(mutationResponses).toEqual([
        { url: `/api/briefings/${firstIds.briefing_id}/rounds/${firstIds.round_id}/annotations`, status: 200 },
        { url: `/api/briefings/${firstIds.briefing_id}/rounds/${firstIds.round_id}/answers`, status: 200 },
        { url: `/api/briefings/${firstIds.briefing_id}/rounds/${firstIds.round_id}/submit`, status: 200 },
      ]);

      const firstDetail = await preview.invoke({ method: 'GET', url: `/api/briefings/${firstIds.briefing_id}?round=${firstIds.round_id}`, credential: 'typed-human', transport: 'http' });
      const firstRound = (firstDetail.body as any).selected_round;
      expect(firstRound.answers.map((answer: any) => [answer.directive_key, answer.value])).toEqual([
        ['verdict', { verdict: 'keep' }],
        ['single', { option_key: 'b' }],
        ['multi', { option_keys: ['first', 'third'] }],
        ['short', { text: 'Exact short answer' }],
        ['long', { text: 'Exact long answer' }],
        ['rating', { rating: 5 }],
      ]);
      expect(firstRound.annotations).toHaveLength(1);
      expect(firstRound.latest_submission.actor_user_id).toBe(humanId);
      expect(firstRound.latest_frozen_membership.answer_event_ids).toEqual(firstRound.answers.map((answer: any) => answer.response_event_id));
      expect(firstRound.latest_frozen_membership.annotation_event_ids).toEqual(firstRound.annotations.map((annotation: any) => annotation.annotation_event_id));
      expect(privateDb.prepare('SELECT COUNT(*) AS count FROM briefing_submissions WHERE actor_user_id = ? AND round_id = ?').get(humanId, firstIds.round_id)).toEqual({ count: 1 });

      const secondDetail = await preview.invoke({ method: 'GET', url: `/api/briefings/${secondIds.briefing_id}?round=${secondIds.round_id}`, credential: 'typed-human', transport: 'http' });
      expect((secondDetail.body as any).selected_round).toMatchObject({
        id: secondIds.round_id, answers: [], annotations: [], latest_submission: null, latest_frozen_membership: null,
      });
    } finally {
      privateDb.close();
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['rejected response capability', { ...COPIED_PREVIEW_INSTANCE, allowed_effects: ['ledger:read'] } as InstanceInfo, { authenticated: true, user: { id: 'human-1', kind: 'human' } }, 'valid'],
    ['missing instance capability', null, { authenticated: true, user: { id: 'human-1', kind: 'human' } }, 'valid'],
    ['agent identity', COPIED_PREVIEW_INSTANCE, { authenticated: true, user: { id: 'agent-1', kind: 'agent' } }, 'valid'],
    ['anonymous identity', COPIED_PREVIEW_INSTANCE, { authenticated: false, user: null }, 'valid'],
    ['invalid immutable binding', COPIED_PREVIEW_INSTANCE, { authenticated: true, user: { id: 'human-1', kind: 'human' } }, 'invalid'],
  ])('fails closed for %s', async (_label, instance, identity, bindingStatus) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify(identity), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('/api/briefings/briefing-typed')) {
        const payload = typedDetail(ROUND_ONE) as any;
        payload.selected_round.binding = { status: bindingStatus, ...(bindingStatus === 'invalid' ? { reason: 'Binding mismatch.' } : {}) };
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) return new Response(JSON.stringify({ content: {
        artifact_id: 'artifact:typed', status: 'available', kind: 'markdown', media_type: 'text/markdown',
        size_bytes: new TextEncoder().encode(TYPED_SOURCE).byteLength, source: null,
        preview: { encoding: 'utf-8', text: TYPED_SOURCE, raw_text: TYPED_SOURCE, truncated: false },
        download: { available: true, media_type: 'text/markdown', size_bytes: TYPED_SOURCE.length, filename: 'typed.md' },
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    }));
    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
      <BriefingDocumentRenderer briefingId="briefing-typed" roundId={ROUND_ONE} instance={instance} />
    </AppShellProvider>);
    const keep = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Submit' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('fails closed when detail source bytes do not match the server-verified whole-document hash', async () => {
    const tampered = source.replace('Review this round', 'Changed after binding');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/briefings/briefing-1?round=${ROUND_TWO}`) {
        const payload = detail() as any;
        payload.selected_round.document.source = tampered;
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingDocumentRenderer briefingId="briefing-1" roundId={ROUND_TWO} instance={COPIED_PREVIEW_INSTANCE} /></AppShellProvider>);
    await waitFor(() => expect(screen.getAllByText(/does not match its verified hash/)).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Submit' }).getAttribute('aria-disabled')).toBe('true');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/artifacts/'))).toBe(false);
  });
});
