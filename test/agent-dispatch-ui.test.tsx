// Agent dispatch affordances — umbrella 99b74d6, issue ce83a84.
//
// These tests defend the properties that make a one-click agent launch safe in
// the UI, not the markup around them:
//
//   - "Save and start agent" is NEVER the default action of the note editor.
//     `Save note` remains the form's submit control.
//   - The confirmation shows the exact task text and the capability surface,
//     fetched from the preview route, before anything is written.
//   - Cancelling issues no dispatch and no comment: declining leaves no trace.
//   - A spawn failure is surfaced as a failure, with the reason, rather than
//     being closed over as a success.
//   - The issue header offers the same confirm-first affordance.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentDispatchDialog } from '../ui/src/components/agent-dispatch/AgentDispatchDialog';
import { LedgerIssueDetail } from '../ui/src/components/ledger/IssueDetail';
import { BriefingView } from '../ui/src/views/briefing';
import { AppShellProvider, type AppShellContextValue } from '../ui/src/app-shell';
import type { LedgerIssueDetailProjection } from '../ui/src/api';
import type {
  BriefingCandidateHistoryResponse,
  BriefingQueueResponse,
} from '../src/contracts.js';

const HOUR = 60 * 60 * 1000;

const CAPABILITIES = [
  'Starts a full interactive Claude Code session.',
  'Runs as you, with your normal permissions.',
];

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchCall = { url: string; method: string; body: unknown };

type DispatchStub = {
  dispatchOk?: boolean;
  dispatchError?: string;
  events?: unknown[];
};

function stubFetch(options: DispatchStub = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    if (url === '/api/briefing/queue') {
      // Typed as the server contract so this stub cannot drift from the real
      // payload the way it did before issue 223d090.
      const queue: BriefingQueueResponse = {
        sources: [{
          source: 'arxiv-scan',
          pending_count: 1,
          candidate_count: 1,
          last_task_identity: 'agent-schedule/daily-digest',
          last_run_id: 'run-9',
          last_digest_version: 7,
          last_ingested_at: Date.now() - HOUR,
          last_ingest_age_ms: HOUR,
          last_batch_item_count: 1,
        }],
        candidates: [{
          id: 'cand-1',
          source: 'arxiv-scan',
          candidate_key: 'key-1',
          created_at: Date.now() - HOUR,
          state: 'pending',
          revision: {
            id: 'rev-1',
            candidate_id: 'cand-1',
            title: 'A notable finding',
            why_notable: 'It matters.',
            refs: [],
            source_ref: 'https://example.com/a',
            evidence_hash: 'a'.repeat(64),
            evidence_kind: 'snapshot-item',
            captured_at: new Date(Date.now() - HOUR).toISOString(),
            run_id: 'run-9',
            digest_series_ref: 'artifact-series:abcdef123456',
            digest_version: 7,
            rank: 1,
            batch_key: 'b'.repeat(64),
            ingested_at: Date.now() - HOUR,
          },
          revision_count: 1,
          occurrences: { count: 1, first_seen_at: Date.now() - HOUR, last_seen_at: Date.now() - HOUR },
          // Required by the contract; omitting it is drift the type-only
          // annotation here does not catch under esbuild transpilation.
          task_identity: 'agent-schedule/daily-digest',
        }],
      };
      return Promise.resolve(jsonResponse(queue));
    }
    if (url.includes('/history')) {
      const history: BriefingCandidateHistoryResponse = {
        candidate: {
          id: 'cand-1',
          source: 'arxiv-scan',
          candidate_key: 'key-1',
          current_revision_id: 'rev-1',
          created_at: Date.now() - HOUR,
          state: 'pending',
        },
        revisions: [],
        decisions: [],
        comments: [],
      };
      return Promise.resolve(jsonResponse(history));
    }
    if (url.startsWith('/api/agent-dispatch/events')) {
      return Promise.resolve(jsonResponse({ events: options.events ?? [] }));
    }
    if (url === '/api/agent-dispatch/preview') {
      const request = body as { instruction: string };
      return Promise.resolve(jsonResponse({
        plan: {
          subject_kind: 'finding',
          subject_label: 'briefing finding arxiv-scan',
          instruction: request.instruction,
          cwd: '/Users/example/work',
          prompt: `# Task\n\n${request.instruction}\n\n<<<BEGIN UNTRUSTED DATA>>>\n{}\n<<<END UNTRUSTED DATA>>>`,
          capability_surface: CAPABILITIES,
        },
      }));
    }
    if (url === '/api/agent-dispatch/dispatch') {
      const ok = options.dispatchOk !== false;
      return Promise.resolve(jsonResponse({
        ok,
        event: {
          id: 'evt-1',
          subject_kind: 'finding',
          candidate_id: 'cand-1',
          comment_id: 'com-1',
          issue_id: null,
          instruction: 'x',
          cwd: '/Users/example/work',
          status: ok ? 'dispatched' : 'failed',
          session_handle: ok ? 'cc-20260812-finding-arxiv-ab12' : null,
          attach_command: ok ? 'tmux -L claude-spawn attach -t cc-20260812-finding-arxiv-ab12' : null,
          error: ok ? null : (options.dispatchError ?? 'dedicated tmux server is not running'),
          created_at: Date.now(),
        },
      }));
    }
    if (url === '/api/dashboard/badges') {
      return Promise.resolve(jsonResponse({ auth: 0, inbox: 0, work: 0, briefing: 1 }));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }));
  return calls;
}

function renderBriefing(): void {
  const context: AppShellContextValue = {
    bottomPanel: null,
    registerBottomPanel: () => () => undefined,
    active: true,
  };
  render(
    <AppShellProvider value={context}>
      <BriefingView instance={null} />
    </AppShellProvider>,
  );
}

async function openFindingEditor(): Promise<HTMLTextAreaElement> {
  renderBriefing();
  fireEvent.click(await screen.findByText('A notable finding'));
  const textarea = await screen.findByLabelText('Add a note') as HTMLTextAreaElement;
  fireEvent.input(textarea, { target: { value: 'Check whether this replicates.' } });
  return textarea;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('briefing save-and-start-agent affordance', () => {
  it('keeps "Save note" as the default action and dispatch as a separate button', async () => {
    stubFetch();
    await openFindingEditor();

    const save = screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement;
    const dispatch = screen.getByRole('button', { name: /Save and start agent/ }) as HTMLButtonElement;
    expect(save.type).toBe('submit');
    // A submit-typed dispatch button would fire on Enter in the textarea.
    expect(dispatch.type).toBe('button');
  });

  it('shows the exact task text and capability surface before writing anything', async () => {
    const calls = stubFetch();
    await openFindingEditor();
    fireEvent.click(screen.getByRole('button', { name: /Save and start agent/ }));

    const dialog = await screen.findByTestId('agent-dispatch-dialog');
    expect(dialog).toBeTruthy();
    expect((await screen.findByTestId('agent-dispatch-task')).textContent)
      .toBe('Check whether this replicates.');
    const capabilities = await screen.findByTestId('agent-dispatch-capabilities');
    for (const line of CAPABILITIES) expect(capabilities.textContent).toContain(line);
    expect((await screen.findByTestId('agent-dispatch-prompt')).textContent)
      .toContain('<<<BEGIN UNTRUSTED DATA>>>');

    // Only the read-only preview has been called.
    expect(calls.some((call) => call.url === '/api/agent-dispatch/preview')).toBe(true);
    expect(calls.some((call) => call.url === '/api/agent-dispatch/dispatch')).toBe(false);
    expect(calls.some((call) => call.url.includes('/comments'))).toBe(false);
  });

  it('writes nothing when the confirmation is declined', async () => {
    const calls = stubFetch();
    await openFindingEditor();
    fireEvent.click(screen.getByRole('button', { name: /Save and start agent/ }));
    await screen.findByTestId('agent-dispatch-dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('agent-dispatch-dialog')).toBeNull());
    expect(calls.some((call) => call.method === 'POST' && call.url !== '/api/agent-dispatch/preview'))
      .toBe(false);
    // The note is still in the editor, unsent.
    expect((screen.getByLabelText('Add a note') as HTMLTextAreaElement).value)
      .toBe('Check whether this replicates.');
  });

  it('dispatches on confirmation and reports the session handle', async () => {
    const calls = stubFetch();
    await openFindingEditor();
    fireEvent.click(screen.getByRole('button', { name: /Save and start agent/ }));
    await screen.findByTestId('agent-dispatch-dialog');
    fireEvent.click(await screen.findByRole('button', { name: 'Start agent' }));

    const outcome = await screen.findByTestId('agent-dispatch-outcome');
    expect(outcome.textContent).toContain('cc-20260812-finding-arxiv-ab12');
    expect(outcome.textContent).toContain('tmux -L claude-spawn attach');

    const dispatchCall = calls.find((call) => call.url === '/api/agent-dispatch/dispatch');
    expect(dispatchCall?.body).toMatchObject({
      subject: { kind: 'finding', candidate_id: 'cand-1' },
      instruction: 'Check whether this replicates.',
    });
    // The server stored the note as part of the dispatch; the UI must not also
    // post it as a separate comment.
    expect(calls.some((call) => call.url.includes('/comments'))).toBe(false);
  });

  it('reports a spawn failure honestly instead of claiming success', async () => {
    stubFetch({ dispatchOk: false, dispatchError: "tmux server 'claude-spawn' is not running" });
    await openFindingEditor();
    fireEvent.click(screen.getByRole('button', { name: /Save and start agent/ }));
    await screen.findByTestId('agent-dispatch-dialog');
    fireEvent.click(await screen.findByRole('button', { name: 'Start agent' }));

    const outcome = await screen.findByTestId('agent-dispatch-outcome');
    expect(outcome.textContent).toContain('The agent did not start');
    expect(outcome.textContent).toContain("tmux server 'claude-spawn' is not running");
    expect(outcome.textContent).not.toContain('Agent started');
  });

  it('lists the recorded dispatch chain for a finding', async () => {
    stubFetch({
      events: [{
        id: 'evt-old',
        subject_kind: 'finding',
        candidate_id: 'cand-1',
        comment_id: 'com-0',
        issue_id: null,
        instruction: 'earlier work',
        cwd: '/Users/example/work',
        status: 'dispatched',
        session_handle: 'cc-20260811-finding-arxiv-77aa',
        attach_command: 'tmux -L claude-spawn attach -t cc-20260811-finding-arxiv-77aa',
        error: null,
        created_at: Date.now() - HOUR,
      }],
    });
    renderBriefing();
    fireEvent.click(await screen.findByText('A notable finding'));

    const list = await screen.findByTestId('briefing-dispatches-cand-1');
    expect(list.textContent).toContain('cc-20260811-finding-arxiv-77aa');
    expect(list.textContent).toContain('dispatched');
  });
});

describe('issue header launch-agent affordance', () => {
  function detail(): LedgerIssueDetailProjection {
    return {
      id: 'ledger-issue-1',
      display_id: 'ce83a84',
      detail_stage: 'full',
      project: {
        id: 'proj-1',
        display_name: 'mandible',
        remote_identity: '',
        upstream_identity: '',
        repo_id: 'mandible',
        repo_name: 'mandible',
        repo_root: null,
        default_branch: 'main',
      },
      title: 'Agent dispatch affordances',
      body: 'Body',
      status: 'open',
      resolution: null,
      kind: 'feature',
      priority: 'unknown',
      source: 'mandible',
      created_at: 0,
      updated_at: 0,
      closed_at: null,
      author: { id: null, type: 'mandible_user', display: 'Mandible' },
      labels: [],
      aliases: [],
      comments: [],
      relationships: [],
      sessions: [],
      work_units: [],
      auth_requests: [],
      associated_artifacts: [],
      timeline: [],
      checkpoints: [],
      conflicts: [],
      sync: { state: 'clean', outbox: {} },
    } as unknown as LedgerIssueDetailProjection;
  }

  it('offers a confirm-first "Launch agent" item in the actions menu', async () => {
    const calls = stubFetch();
    render(<LedgerIssueDetail detail={detail()} onAddComment={() => undefined} />);

    fireEvent.click(screen.getByLabelText('Issue actions'));
    const item = screen.getByText('Launch agent…');
    fireEvent.click(item);

    await screen.findByTestId('agent-dispatch-dialog');
    // Confirm-first: the menu click previews, it does not dispatch.
    expect(calls.some((call) => call.url === '/api/agent-dispatch/preview')).toBe(true);
    expect(calls.some((call) => call.url === '/api/agent-dispatch/dispatch')).toBe(false);
    const previewCall = calls.find((call) => call.url === '/api/agent-dispatch/preview');
    expect(previewCall?.body).toMatchObject({ subject: { kind: 'issue', issue_ref: 'ce83a84' } });
  });
});

describe('dispatch dialog contract', () => {
  it('surfaces a preview failure instead of offering a confirm button', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ error: 'human credential required' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ))));

    render(
      <AgentDispatchDialog
        subject={{ kind: 'finding', candidate_id: 'cand-1' }}
        instruction="do the thing"
        title="Start an agent"
        onClose={() => undefined}
      />,
    );

    expect((await screen.findByTestId('agent-dispatch-error')).textContent)
      .toContain('human credential required');
    expect((screen.getByRole('button', { name: 'Start agent' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});
