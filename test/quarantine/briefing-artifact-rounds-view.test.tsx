// Quarantined: 3280dce — the detail body renders neither the prompt nor the heading.
import { createHash } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getArtifactContent } from '../../src/artifact-content';
import { setSetting } from '../../src/client-auth/settings-kv';
import { migrate, type Db } from '../../src/db';
import { evaluateInstanceMutation, resolveInstanceInfo } from '../../src/instance-policy';
import { registerBriefingRoutes } from '../../src/routes/briefing';
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from '../../src/server';
import { createUser } from '../../src/users/store';
import { recordArtifactVersion } from '../../src/provider-artifacts';
import { AppShellProvider } from '../../ui/src/app-shell';
import {
  getBriefingBundles,
  getBriefings,
  invalidateApiGetCache,
  normalizeBriefingProjection,
  normalizeBriefings,
  type InstanceInfo,
} from '../../ui/src/api';
import { BriefingView } from '../../ui/src/views/briefing';
import { briefingRoundOptions, BriefingDocumentRenderer } from '../../ui/src/views/feedback/BriefingDocumentRenderer';
import { BRIEFING_VIEW_STATE_KEY, DEFAULT_BRIEFING_COLLECTION_VIEW_STATE } from '../../ui/src/views/feedback/collection-view-state';
import { parseBriefingDirectives } from '../../src/feedback/briefing-directives';
import { RICH_BRIEFING_DEMO, seedRichBriefingDemo } from '../../src/feedback/rich-briefing-demo';

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
  role: 'main', operational_mutations: 'allow', operational_mutations_overridden: false,
  briefing_response_mutations: 'allow', db_path: '/tmp/mandible.db', db_path_source: 'default',
};
const COPIED_PREVIEW_INSTANCE: InstanceInfo = {
  role: 'preview', operational_mutations: 'reject', operational_mutations_overridden: true,
  briefing_response_mutations: 'allow', db_path: '/tmp/mandible-copy.db', db_path_source: 'start_options',
  source_db_path: '/tmp/mandible.db', source_db_path_source: 'start_options',
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

class UiRoundTripGate implements ClientAuthGate {
  constructor(private readonly db: Db) {}

  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const user = this.db.prepare('SELECT id, slug FROM users WHERE slug = ?').get(credential) as { id: string; slug: string } | undefined;
    return user ? { user_id: user.id, slug: user.slug, method: 'api_token', credential_id: null, source: 'in_process' } : null;
  }

  mode() { return 'compat' as const; }
  recordUnattributedWrite() {}
}

function createCopiedPreviewDatabase(root: string): {
  db: Db;
  dbPath: string;
  sourceDbPath: string;
} {
  const sourceDbPath = path.join(root, 'source.db');
  const dbPath = path.join(root, 'copy.db');
  const sourceDb = new Database(sourceDbPath);
  try {
    migrate(sourceDb);
  } finally {
    sourceDb.close();
  }
  fs.copyFileSync(sourceDbPath, dbPath);
  return { db: new Database(dbPath), dbPath, sourceDbPath };
}

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

function installStorage(): void {
  const rows = new Map<string, string>();
  const storage = { get length() { return rows.size; }, clear: () => rows.clear(), getItem: (key: string) => rows.get(key) ?? null,
    key: (index: number) => [...rows.keys()][index] ?? null, removeItem: (key: string) => rows.delete(key), setItem: (key: string, value: string) => rows.set(key, String(value)) } as Storage;
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

beforeEach(() => { installStorage(); invalidateApiGetCache(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('artifact-backed Briefing rounds', () => {

  it('composes the no-selection prompt inside the detail body without round jargon', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/briefings') {
        return new Response(JSON.stringify({ briefings: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ incidents: [], counts: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);

    const prompt = await screen.findByText('Select a Briefing.');
    expect(prompt.classList.contains('briefing-empty--selection')).toBe(true);
    expect(prompt.textContent).not.toMatch(/latest|immutable|round/i);
    const css = readFileSync('ui/src/styles/briefing.css', 'utf8');
    expect(css).toMatch(/\.briefing-empty--selection\s*\{[^}]*flex:\s*1;[^}]*align-self:\s*stretch;[^}]*display:\s*grid;[^}]*place-items:\s*center;/s);
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

    render(<AppShellProvider value={{ active: true, bottomPanel: null, registerBottomPanel: () => () => undefined, setViewSidebarWidth: () => undefined }}><BriefingView instance={PRODUCTION_ALLOW_INSTANCE} /></AppShellProvider>);
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
    expect(screen.getByRole('button', { name: 'Select briefing Renamed policy' })).toBeTruthy();
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([{
      url: '/api/briefings/briefing-1', method: 'PATCH', body: { title: 'Renamed policy' },
    }]);
  });

});
