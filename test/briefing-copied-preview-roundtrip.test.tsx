// @vitest-environment jsdom
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { UiRoundTripGate, createCopiedPreviewDatabase, exactTestInstanceEnv, installStorage, operatorSessionResponse } from './helpers/briefing-preview-fixtures';
import { testRuntimeRoot } from './helpers/runtime-isolation';

import { queryClient } from '../ui/src/query/client';

import fs from 'node:fs';

import path from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getArtifactContent } from '../src/artifact-content';
import { setSetting } from '../src/client-auth/settings-kv';

import { resolveInstanceInfo } from '../src/instance-policy';
import { registerBriefingRoutes } from '../src/routes/briefing';
import { Router } from '../src/server';
import { STANDARD_PREVIEW_EFFECTS } from '../src/security/effect-policy';
import { createUser } from '../src/users/store';

import { AppShellProvider } from '../ui/src/app-shell';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../ui/src/client-auth-token';
import { clearApiGetCache } from '../ui/src/api';

import { BriefingDocumentRenderer } from '../ui/src/views/feedback/BriefingDocumentRenderer';

import { seedRichBriefingDemo } from '../src/feedback/rich-briefing-demo';

let noticeHost: HTMLElement;
beforeEach(async () => {
  queryClient.clear();
  installStorage();
  clearApiGetCache();
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

describe('copied-preview Briefing publication boundary', () => {
  it('round-trips the selected rich-demo round for the active operator on a private copied-preview database', async () => {
    const privateRoot = fs.mkdtempSync(path.join(testRuntimeRoot, 'briefing-selected-round-'));
    const { db: privateDb, dbPath: privateDbPath, sourceDbPath, previewRoot, sourceRoot } = createCopiedPreviewDatabase(privateRoot);
    try {
      const artifactRoot = path.join(previewRoot, 'artifacts');
      const operatorId = createUser(privateDb, { slug: 'active-operator', kind: 'human', display_name: 'Active operator' }).id;
      setSetting(privateDb, 'user.operator_id', operatorId);
      const manifest = seedRichBriefingDemo(privateDb, { databasePath: privateDbPath, artifactRoot });
      const roundOneId = manifest.rounds[0].id;
      const selectedRoundId = manifest.rounds[1].id;
      const briefingId = manifest.briefing.id;
      const previewInstance = resolveInstanceInfo({
        env: exactTestInstanceEnv('preview', { previewRoot, sourceRoot }),
        dbPath: privateDbPath, sourceDbPath,
      });
      expect(previewInstance).toMatchObject({
        role: 'preview', allowed_effects: STANDARD_PREVIEW_EFFECTS,
        db_path: privateDbPath, source_db_path: sourceDbPath,
      });
      const preview = new Router({ clientAuth: new UiRoundTripGate(privateDb), instance: previewInstance });
      registerBriefingRoutes(preview, privateDb, inlineLedgerReader(() => privateDb));
      expect(privateDb.prepare(
        'SELECT COUNT(*) AS count FROM briefing_members WHERE briefing_id = ? AND user_id = ?',
      ).get(briefingId, operatorId)).toEqual({ count: 0 });
      const selectedBeforeMutation = await preview.invoke({
        method: 'GET', url: `/api/briefings/${briefingId}?round=${selectedRoundId}`,
        credential: 'active-operator', transport: 'http',
      });
      expect(selectedBeforeMutation).toMatchObject({
        status: 200,
        body: { briefing: { id: briefingId }, selected_round: { id: selectedRoundId, answers: [], annotations: [] } },
      });
      const roundOneSnapshot = () => ({
        responses: privateDb.prepare('SELECT * FROM briefing_response_events WHERE round_id = ? ORDER BY rowid').all(roundOneId),
        annotations: privateDb.prepare('SELECT * FROM briefing_annotation_events WHERE round_id = ? ORDER BY rowid').all(roundOneId),
        submissions: privateDb.prepare('SELECT * FROM briefing_submissions WHERE round_id = ? ORDER BY rowid').all(roundOneId),
        frozenAnswers: privateDb.prepare('SELECT * FROM briefing_submission_answers WHERE round_id = ? ORDER BY position').all(roundOneId),
        frozenAnnotations: privateDb.prepare('SELECT * FROM briefing_submission_annotations WHERE round_id = ? ORDER BY position').all(roundOneId),
      });
      const roundOneBefore = roundOneSnapshot();
      const mutationResponses: Array<{ url: string; status: number }> = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/client-auth/whoami') {
          return new Response(JSON.stringify({ authenticated: true, user: {
            id: operatorId, slug: 'active-operator', kind: 'human', display_name: 'Active operator',
          } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const artifactMatch = /^\/api\/artifacts\/([^/]+)\/content$/.exec(url);
        if (method === 'GET' && artifactMatch) {
          const content = getArtifactContent(privateDb, decodeURIComponent(artifactMatch[1]));
          return new Response(JSON.stringify({ content }), { status: content ? 200 : 404, headers: { 'content-type': 'application/json' } });
        }
        if (!url.startsWith('/api/briefings')) throw new Error(`unexpected copied-preview request ${method} ${url}`);
        const result = await preview.invoke({
          method, url, credential: 'active-operator', transport: 'http',
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (method !== 'GET') mutationResponses.push({ url, status: result.status });
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
      }));
      const shell = () => <AppShellProvider value={{ noticeHost, active: true, rightSidebar: null, registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined }}>
        <BriefingDocumentRenderer briefingId={briefingId} roundId={selectedRoundId} instance={previewInstance} />
      </AppShellProvider>;
      const view = render(shell());

      const keep = await screen.findByRole('button', { name: 'Keep' }) as HTMLButtonElement;
      await waitFor(() => expect(keep.disabled).toBe(false));
      fireEvent.click(keep);
      fireEvent.click(screen.getByRole('radio', { name: 'Authorize the 10% regional canary' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Integrity alarm during reconciliation' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Write latency exceeds the canary budget' }));
      fireEvent.input(screen.getByRole('textbox', { name: 'Record the canary owner and the first expansion checkpoint.' }), {
        target: { value: 'Avery Chen — verify the first regional checkpoint.' },
      });
      fireEvent.input(screen.getByRole('textbox', { name: /Summarize how the new downgrade/ }), {
        target: { value: 'Authorize only the bounded canary; stop on integrity alarms, missed paging, or excess write latency.' },
      });
      const rating = screen.getByRole('radio', { name: '4' }) as HTMLInputElement;
      fireEvent.click(rating);
      expect(rating.checked).toBe(true);

      fireEvent.click(screen.getAllByRole('button', { name: 'Comment' })[0]);
      const annotationDialog = await screen.findByRole('dialog', { name: 'Add annotation' });
      fireEvent.input(within(annotationDialog).getByLabelText('Comment'), { target: { value: 'Final IAB acceptance annotation.' } });
      fireEvent.click(within(annotationDialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add annotation' })).toBeNull());
      fireEvent.click(await screen.findByTitle('Comment · 1'));
      expect(within(screen.getByRole('dialog')).getByText(/Final IAB acceptance annotation/)).toBeTruthy();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close annotation editor' }));

      const submit = screen.getByRole('button', { name: 'Submit' });
      await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('false'));
      fireEvent.click(submit);
      await waitFor(() => expect(mutationResponses).toHaveLength(3));
      expect(mutationResponses).toEqual([
        { url: `/api/briefings/${briefingId}/rounds/${selectedRoundId}/annotations`, status: 200 },
        { url: `/api/briefings/${briefingId}/rounds/${selectedRoundId}/answers`, status: 200 },
        { url: `/api/briefings/${briefingId}/rounds/${selectedRoundId}/submit`, status: 200 },
      ]);

      const selectedDetail = await preview.invoke({
        method: 'GET', url: `/api/briefings/${briefingId}?round=${selectedRoundId}`,
        credential: 'active-operator', transport: 'http',
      });
      const selectedRound = (selectedDetail.body as any).selected_round;
      expect(selectedRound.answers.map((answer: any) => [answer.directive_key, answer.value])).toEqual([
        ['release.verdict', { verdict: 'keep' }],
        ['release.posture', { option_key: 'authorize-canary' }],
        ['release.residual_risks', { option_keys: ['integrity-alarm', 'write-latency'] }],
        ['release.owner', { text: 'Avery Chen — verify the first regional checkpoint.' }],
        ['release.rationale', { text: 'Authorize only the bounded canary; stop on integrity alarms, missed paging, or excess write latency.' }],
        ['release.confidence', { rating: 4 }],
      ]);
      expect(selectedRound.annotations).toMatchObject([{ body: 'Final IAB acceptance annotation.' }]);
      expect(selectedRound.latest_submission.actor_user_id).toBe(operatorId);
      expect(selectedRound.latest_frozen_membership).toEqual({
        answer_event_ids: selectedRound.answers.map((answer: any) => answer.response_event_id),
        annotation_event_ids: selectedRound.annotations.map((annotation: any) => annotation.annotation_event_id),
      });
      expect(privateDb.prepare(
        'SELECT COUNT(*) AS count FROM briefing_members WHERE briefing_id = ? AND user_id = ?',
      ).get(briefingId, operatorId)).toEqual({ count: 1 });
      expect(privateDb.prepare(
        `SELECT DISTINCT briefing_id, round_id, actor_user_id
           FROM briefing_response_events WHERE round_id = ? AND actor_user_id = ?`,
      ).all(selectedRoundId, operatorId)).toEqual([{ briefing_id: briefingId, round_id: selectedRoundId, actor_user_id: operatorId }]);
      expect(privateDb.prepare(
        `SELECT DISTINCT briefing_id, round_id, actor_user_id
           FROM briefing_annotation_events WHERE round_id = ? AND actor_user_id = ?`,
      ).all(selectedRoundId, operatorId)).toEqual([{ briefing_id: briefingId, round_id: selectedRoundId, actor_user_id: operatorId }]);
      expect(roundOneSnapshot()).toEqual(roundOneBefore);

      view.unmount();
      clearApiGetCache();
      const reloadedView = render(shell());
      fireEvent.click(await screen.findByTitle('Comment · 1'));
      expect(within(screen.getByRole('dialog')).getByText(/Final IAB acceptance annotation/)).toBeTruthy();
      await waitFor(() => expect((screen.getByRole('radio', { name: '4' }) as HTMLInputElement).checked).toBe(true));
      expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
      expect(roundOneSnapshot()).toEqual(roundOneBefore);
      reloadedView.unmount();

      expect(await preview.invoke({
        method: 'POST', url: `/api/briefings/${briefingId}-stale/rounds/${selectedRoundId}/annotations`, credential: 'active-operator',
        body: { annotations: [{ operation: 'set', kind: 'comment', start_offset: 0, end_offset: 1,
          quote: '#', body: 'wrong round', replacement_text: null }] }, transport: 'http',
      })).toMatchObject({ status: 404, body: { code: 'not_found' } });
      expect(await preview.invoke({
        method: 'POST', url: `/api/briefings/${briefingId}/rounds/00000000-0000-4000-8000-000000000000/submit`, credential: 'active-operator',
        body: { answers: [], annotation_event_ids: [], supersedes_submission_id: null }, transport: 'http',
      })).toMatchObject({ status: 404, body: { code: 'not_found' } });
    } finally {
      privateDb.close();
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });

});
