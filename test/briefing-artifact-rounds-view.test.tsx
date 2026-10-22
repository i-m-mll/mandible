import { installStorage, operatorSessionResponse } from './helpers/briefing-preview-fixtures';
import { BRIEFING_EVENT_VALUES } from '../src/contracts';
import { queryClient } from '../ui/src/query/client';
import { browserResourceKeys, refreshBrowserResources } from '../ui/src/query/browserResources';
import { createHash } from 'node:crypto';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import { PRODUCTION_EFFECTS, STANDARD_PREVIEW_EFFECTS } from '../src/security/effect-policy';
import { AppShellProvider } from '../ui/src/app-shell';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../ui/src/client-auth-token';
import {
  invalidateBriefingApiCacheForEvent,
  getBriefingBundles,
  getBriefings,
  invalidateApiGetCache,
  normalizeBriefingProjection,
  type InstanceInfo,
} from '../ui/src/api';
import { BriefingView } from '../ui/src/views/briefing';
import { BriefingDocumentRenderer } from '../ui/src/views/feedback/BriefingDocumentRenderer';
import { BRIEFING_VIEW_STATE_KEY, DEFAULT_BRIEFING_COLLECTION_VIEW_STATE, normalizeBriefingCollectionViewState } from '../ui/src/views/feedback/collection-view-state';
import { parseBriefingDirectives } from '../src/feedback/briefing-directives';

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

    expect(screen.queryByRole('button', { name: 'Select briefing Claude policy' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Agent policy proposal/ })).toBeNull();
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

    expect(screen.queryByText(FULL_BRIEFING_ID)).toBeNull();
    const roundCopy = await screen.findByRole('button', { name: 'Copy selected round reference' });
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
    const roundOptions = await screen.findAllByRole('option');
    expect(roundOptions.map((option) => option.getAttribute('value'))).toEqual([ROUND_TWO, ROUND_ONE]);
    expect((screen.getByRole('combobox', { name: 'Round occurrence' }) as HTMLSelectElement).value).toBe(ROUND_TWO);
    expect(await screen.findByText('Later')).toBeTruthy();

    const latestSubmit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(latestSubmit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(latestSubmit, { key: 'Enter' });
    fireEvent.click(latestSubmit);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
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
    expect(await screen.findByText('First')).toBeTruthy();
    expect(screen.queryByText('Later')).toBeNull();
    await act(async () => { await refreshBrowserResources(queryClient, [browserResourceKeys.briefings]); });
    expect((screen.getByRole('combobox', { name: 'Round occurrence' }) as HTMLSelectElement).value).toBe(ROUND_ONE);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Dismiss' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Submit' }).getAttribute('aria-disabled')).toBe('true');
    expect(JSON.parse(window.localStorage.getItem(BRIEFING_VIEW_STATE_KEY) ?? '{}').selectedRoundIds).toMatchObject({ 'briefing:briefing-1': ROUND_ONE });
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

  it('renames the selected Briefing from the header menu and updates the header and sidebar from the PATCH result', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/briefings' && method === 'GET') {
        return new Response(JSON.stringify({ briefings: [detail().briefing] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/briefing-bundles') {
        return new Response(JSON.stringify({ bundles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/briefing-groups') {
        return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/client-auth/whoami') {
        return new Response(JSON.stringify({ authenticated: true, user: { id: 'human', kind: 'human' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/briefings/briefing-1' && method === 'GET') {
        return new Response(JSON.stringify(detail()), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/briefings/briefing-1' && method === 'PATCH') {
        return new Response(JSON.stringify({ briefing_id: 'briefing-1', title: 'Renamed policy', changed: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/artifacts/') && url.endsWith('/content')) {
        const exactSource = source.replace('Intro', 'Later');
        return new Response(JSON.stringify({ content: { artifact_id: 'artifact:doc', status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: new TextEncoder().encode(exactSource).byteLength, source: null, preview: { encoding: 'utf-8', text: exactSource, raw_text: exactSource, truncated: false }, download: { available: true, media_type: 'text/markdown', size_bytes: exactSource.length, filename: 'briefing.md' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));
    window.localStorage.setItem(BRIEFING_VIEW_STATE_KEY, JSON.stringify({
      ...DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
      selectedCollectionId: 'briefing:briefing-1',
    }));

    render(<AppShellProvider value={{ active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);
    expect(await screen.findByRole('heading', { name: 'Recurring review' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select briefing Recurring review' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Briefing actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Briefing' }));

    const dialog = screen.getByRole('dialog', { name: 'Rename Briefing' });
    const input = within(dialog).getByRole('textbox', { name: 'Briefing title' }) as HTMLInputElement;
    expect(input.value).toBe('Recurring review');
    fireEvent.input(input, { target: { value: 'Renamed policy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename Briefing' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Renamed policy' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Select briefing Renamed policy' })).toBeTruthy();
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([{
      url: '/api/briefings/briefing-1', method: 'PATCH', body: { title: 'Renamed policy' },
    }]);
  });
});
