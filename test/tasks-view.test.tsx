// Tasks view tests — issue 0bc2279.
//
// The fixtures below are built by the REAL server projection
// (getTaskInventoryView over a real generation the real parser accepted), so a
// test can no longer assert against a payload shape the server never sends.
// What the assertions are actually protecting:
//
//   - `unknown` renders as the word "unknown", not as a blank or a zero.
//   - config-enabled and locally-activated stay two separate readings.
//   - the never-registered empty state says so in those words and offers no
//     way to create anything.
//   - a stale executor report is visibly stale in the list.
import { cleanup, render, screen, waitFor, within } from '@testing-library/preact';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TASK_INVENTORY_SCHEMA, type TaskInventoryResponse } from '../src/contracts.js';
import { migrate, setDb, type Db } from '../src/db.js';
import {
  getTaskInventoryView,
  parseTaskInventoryGeneration,
  recordTaskInventoryGeneration,
  TASK_INVENTORY_STALE_AFTER_MS,
} from '../src/task-inventory.js';
import { createUser } from '../src/users/store.js';
import { createManagedReminder } from '../src/managed-reminders.js';
import { parseManagedReminderCreateRequest } from '../src/managed-reminder-parser.js';
import { resolveProjectForCheckout } from '../src/ledger/projects.js';
import { normalizeTaskInventory } from '../ui/src/api';
import { parseRouteFromHash } from '../ui/src/routing';
import { taskFact, TasksView } from '../ui/src/views/tasks';

const HOUR = 60 * 60 * 1000;

let db: Db;
let publisherId: string;
let projectId: string;

function knownTask(): Record<string, unknown> {
  return {
    task_id: 'daily-digest',
    display_name: 'Daily digest',
    management_mode: 'external',
    bundle: {
      commit: 'a'.repeat(40),
      content_hash: 'sha256:content',
      execution_hash: 'sha256:execution',
      deployed_at: Date.now() - 4 * HOUR,
    },
    activation: { config_enabled: true, locally_activated: false },
    guards: {
      circuit: 'open',
      retry_attempt: 2,
      retry_next_at: 'none',
      kill_switch: 'clear',
      staleness: 'stale',
    },
    last_run: {
      run_id: 'run-1',
      started_at: Date.now() - HOUR,
      finished_at: Date.now() - HOUR + 1000,
      outcome: 'failure',
      // Predates the bundle bindings: the executor says so rather than
      // borrowing whatever is deployed now.
      bundle_commit: 'unknown',
      content_hash: 'unknown',
      execution_hash: 'unknown',
      config_hash: 'unknown',
      detail: 'exit 1',
    },
    last_failure: 'never',
  };
}

function unknownTask(): Record<string, unknown> {
  return {
    task_id: 'unknown-task',
    display_name: 'Unknown task',
    management_mode: 'external',
    bundle: 'unknown',
    activation: { config_enabled: 'unknown', locally_activated: 'unknown' },
    guards: {
      circuit: 'unknown',
      retry_attempt: 'unknown',
      retry_next_at: 'unknown',
      kill_switch: 'unknown',
      staleness: 'unknown',
    },
    last_run: 'unknown',
    last_failure: 'unknown',
  };
}

function post(tasks: Array<Record<string, unknown>>, observedAt = Date.now()): void {
  const generation = parseTaskInventoryGeneration({
    schema: TASK_INVENTORY_SCHEMA,
    executor: { name: 'agent-schedule', version: '0.4.2', capabilities: ['cron'] },
    observed_at: observedAt,
    tasks,
  });
  recordTaskInventoryGeneration(db, generation, { postedByUserId: publisherId });
}

function stubInventory(payload: TaskInventoryResponse | (() => TaskInventoryResponse)): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (String(input) === '/api/tasks') {
      const body = typeof payload === 'function' ? payload() : payload;
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (String(input).startsWith('/api/tasks/commands?')) {
      return Promise.resolve(new Response(JSON.stringify({ commands: [], polling: 'tick_aligned' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
  }));
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  setDb(db);
  publisherId = createUser(db, {
    slug: 'agent-schedule',
    kind: 'agent',
    display_name: 'Agent Schedule',
  }).id;
  projectId = resolveProjectForCheckout(db, {
    root: '/tmp/tasks-view-reminder-project',
    name: 'tasks-view-reminder-project',
    remoteUrl: 'https://example.test/tasks-view-reminder-project.git',
    defaultBranch: 'develop',
  }).project.id;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

describe('tasks route registration', () => {
  it('resolves #/tasks instead of silently falling back to spaces', () => {
    expect(parseRouteFromHash('#/tasks')).toEqual({ tab: 'tasks', params: {} });
  });
});

describe('taskFact', () => {
  it('renders an explicit unknown as the word, and booleans as yes/no', () => {
    expect(taskFact('unknown')).toEqual({ text: 'unknown', unknown: true });
    // A field the server omitted entirely is still unknown, never blank.
    expect(taskFact(undefined)).toEqual({ text: 'unknown', unknown: true });
    expect(taskFact(false)).toEqual({ text: 'no', unknown: false });
    expect(taskFact(0)).toEqual({ text: '0', unknown: false });
  });
});

describe('TasksView', () => {
  it('renders a Mandible reminder as a read-only first-party row with exact provenance', async () => {
    const created = createManagedReminder(
      db,
      parseManagedReminderCreateRequest({
        schema: 'mandible-reminder@1',
        idempotency_key: 'tasks-view-reminder',
        project: 'tasks-view-reminder-project',
        message: 'Review the twentieth canonical merge',
        predicate: {
          kind: 'auth_merge_count_gte',
          project: 'tasks-view-reminder-project',
          base_branch: 'develop',
          canonical_message: true,
          threshold: 20,
        },
      }),
      { userId: publisherId, evidenceMethod: 'api_token' },
      { projectId },
    );
    const response: TaskInventoryResponse = {
      ...getTaskInventoryView(db),
      tasks: [{
        source_kind: 'mandible',
        key: `mandible-reminder:${created.reminder.id}`,
        reminder: created.reminder,
      }],
    };
    stubInventory(normalizeTaskInventory(response));
    render(<TasksView initialTaskKey={`mandible-reminder:${created.reminder.id}`} />);

    await waitFor(() => expect(screen.getAllByText('Review the twentieth canonical merge')).toHaveLength(2));
    const detail = document.querySelector('.tasks-detail') as HTMLElement;
    expect(within(detail).getByText('Immutable predicate')).toBeTruthy();
    expect(within(detail).getByText('20')).toBeTruthy();
    expect(within(detail).getByText('develop')).toBeTruthy();
    expect(within(detail).getByText(created.reminder.revision.payload_digest)).toBeTruthy();
    expect(within(detail).getByText(created.reminder.created_by_user_id)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /request disable|new|create|edit|\+/i })).toBeNull();
  });

  it('says plainly that no executor has registered an inventory', async () => {
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView />);

    await waitFor(() => {
      expect(screen.getAllByText(/No executor has registered an inventory/i).length)
        .toBeGreaterThan(0);
    });
    // Read-only surface: nothing here creates or runs a task.
    expect(screen.queryByRole('button', { name: /new|create|\+/i })).toBeNull();
  });

  it('distinguishes a registered executor that reported an empty task set', async () => {
    post([]);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView />);

    await waitFor(() => {
      expect(screen.getAllByText(/executor reported no tasks|executor has reported, but listed no tasks/i))
        .toHaveLength(2);
    });
    expect(screen.queryByText(/No executor has registered an inventory/i)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button', { name: /new|create|run|enable|edit|delete|\+/i })).toBeNull();
  });

  it('renders reported facts, keeps activation as two readings, and shows unknown as unknown', async () => {
    post([knownTask()]);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView />);

    // The name appears in both the sidebar row and the detail header.
    await waitFor(() => expect(screen.getAllByText('Daily digest').length).toBe(2));

    // The surface names its own trust boundary.
    expect(screen.getByText(/Reported by executor/i)).toBeTruthy();

    const detail = document.querySelector('.tasks-detail') as HTMLElement;
    const factValue = (label: string): HTMLElement => {
      const term = within(detail).getAllByText(label)[0];
      return term.nextElementSibling as HTMLElement;
    };

    expect(factValue('Mode').textContent).toBe('external');
    expect(factValue('Commit').textContent).toBe('a'.repeat(40));
    expect(factValue('Enabled in config').textContent).toBe('yes');
    expect(factValue('Activated on this host').textContent).toBe('no');
    expect(within(detail).getByText(/not activated on the reporting host/i)).toBeTruthy();

    expect(factValue('Circuit').textContent).toBe('open');
    expect(factValue('Retry attempts').textContent).toBe('2');
    expect(factValue('Next retry').textContent).toBe('none queued');
    expect(factValue('Kill switch').textContent).toBe('clear');
    expect(factValue('Executor staleness claim').textContent).toBe('stale');

    // Last run's binding identities are unknown, and they say so.
    const bundleCommit = factValue('Bundle commit');
    expect(bundleCommit.textContent).toBe('unknown');
    expect(bundleCommit.className).toContain('tasks-fact__value--unknown');
    expect(factValue('Outcome').textContent).toBe('failure');

    // `never` is a claim, not an unknown.
    expect(within(detail).getByText(/never having happened/i)).toBeTruthy();
    expect(within(detail).getByText(/take up to one scheduler tick/i)).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Request disable' })).toBeTruthy();
  });

  it('keeps a stale reported no-op request enabled but de-emphasized', async () => {
    post([knownTask()], Date.now() - TASK_INVENTORY_STALE_AFTER_MS - HOUR);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView />);

    const button = await screen.findByRole('button', { name: 'Request disable' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(button.classList.contains('btn--ghost')).toBe(true);
    expect(button.classList.contains('btn--danger')).toBe(false);
    expect(screen.getByText(
      /already disabled per last executor report — request would be a no-op/i,
    )).toBeTruthy();
    expect(document.querySelector('.tasks-freshness--stale')).toBeTruthy();
  });

  it('keeps disable safety emphasis when config is off but the host remains activated', async () => {
    const task = knownTask();
    task.activation = { config_enabled: false, locally_activated: true };
    post([task]);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView />);

    const button = await screen.findByRole('button', { name: 'Request disable' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(button.classList.contains('btn--danger')).toBe(true);
    expect(button.classList.contains('btn--ghost')).toBe(false);
    expect(screen.getByText(
      /configuration says disabled, but the reporting host still says locally activated/i,
    )).toBeTruthy();
    expect(screen.getByText(/requesting disable is not expected to be a no-op/i)).toBeTruthy();
    expect(screen.queryByText(/already disabled per last executor report/i)).toBeNull();
  });

  it('renders a new disable as requested rather than applied', async () => {
    post([knownTask()]);
    const inventory = normalizeTaskInventory(getTaskInventoryView(db));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks') {
        return Promise.resolve(new Response(JSON.stringify(inventory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/tasks/commands?') && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify({ commands: [], polling: 'tick_aligned' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url === '/api/tasks/commands' && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({
          stored: true,
          command: {
            id: 'command-1',
            schema: 'task-command@1',
            request_key: 'request-1',
            request_digest: 'a'.repeat(64),
            executor: 'agent-schedule',
            task_id: 'daily-digest',
            verb: 'disable',
            payload: {},
            requested_by_user_id: 'operator',
            requested_by_slug: 'operator',
            requested_at: Date.now(),
            state: 'requested',
            no_op: null,
            rejection_reason: null,
            events: [],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }));

    render(<TasksView />);
    const button = await screen.findByRole('button', { name: 'Request disable' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    button.click();
    await waitFor(() => {
      expect(screen.getByText(/Requested, not yet seen by executor/i)).toBeTruthy();
    });
    expect(screen.queryByText(/executor reported the local task disabled/i)).toBeNull();
    expect((screen.getByRole('button', { name: 'Request disable' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getByRole('button', { name: 'Cancel unseen request' })).toBeTruthy();
  });

  it('keeps inventory readable when operator command authorization is unavailable', async () => {
    post([knownTask()]);
    const inventory = normalizeTaskInventory(getTaskInventoryView(db));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/tasks') {
        return Promise.resolve(new Response(JSON.stringify(inventory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (String(input).startsWith('/api/tasks/commands?')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Only the local operator may perform this action.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    }));

    render(<TasksView />);
    await waitFor(() => expect(screen.getAllByText('Daily digest')).toHaveLength(2));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Only the local operator/i);
    });
    expect((screen.getByRole('button', { name: 'Request disable' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('reuses the request key after an ambiguous transport failure', async () => {
    post([knownTask()]);
    const inventory = normalizeTaskInventory(getTaskInventoryView(db));
    const postedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks') {
        return Promise.resolve(new Response(JSON.stringify(inventory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/tasks/commands?') && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify({ commands: [], polling: 'tick_aligned' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url === '/api/tasks/commands' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        postedBodies.push(body);
        if (postedBodies.length === 1) return Promise.reject(new Error('connection reset'));
        return Promise.resolve(new Response(JSON.stringify({
          stored: false,
          command: {
            id: 'command-replayed',
            schema: 'task-command@1',
            request_key: body.request_key,
            request_digest: 'a'.repeat(64),
            executor: 'agent-schedule',
            task_id: 'daily-digest',
            verb: 'disable',
            payload: {},
            requested_by_user_id: 'operator',
            requested_by_slug: 'operator',
            requested_at: Date.now(),
            state: 'requested',
            no_op: null,
            rejection_reason: null,
            events: [],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }));

    render(<TasksView />);
    const button = await screen.findByRole('button', { name: 'Request disable' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    button.click();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('connection reset'));
    button.click();
    await waitFor(() => expect(screen.getByText(/Requested, not yet seen by executor/i)).toBeTruthy());
    expect(postedBodies).toHaveLength(2);
    expect(postedBodies[1].request_key).toBe(postedBodies[0].request_key);
  });

  it('uses a fresh request key after a definitive client refusal', async () => {
    post([knownTask()]);
    const inventory = normalizeTaskInventory(getTaskInventoryView(db));
    const postedKeys: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks') {
        return Promise.resolve(new Response(JSON.stringify(inventory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/tasks/commands?') && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify({ commands: [], polling: 'tick_aligned' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url === '/api/tasks/commands' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { request_key: string };
        postedKeys.push(body.request_key);
        return Promise.resolve(new Response(JSON.stringify({ error: 'definitive refusal' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }));

    render(<TasksView />);
    const button = await screen.findByRole('button', { name: 'Request disable' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    button.click();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('definitive refusal'));
    button.click();
    await waitFor(() => expect(postedKeys).toHaveLength(2));
    expect(postedKeys[1]).not.toBe(postedKeys[0]);
  });

  it('surfaces an unresolved command ahead of newer terminal history', async () => {
    post([knownTask()]);
    const inventory = normalizeTaskInventory(getTaskInventoryView(db));
    const command = (id: string, state: 'accepted' | 'applied', requestedAt: number) => ({
      id,
      schema: 'task-command@1',
      request_key: `request-${id}`,
      request_digest: 'a'.repeat(64),
      executor: 'agent-schedule',
      task_id: 'daily-digest',
      verb: 'disable',
      payload: {},
      requested_by_user_id: 'operator',
      requested_by_slug: 'operator',
      requested_at: requestedAt,
      state,
      no_op: state === 'applied' ? false : null,
      rejection_reason: null,
      events: [],
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/tasks') {
        return Promise.resolve(new Response(JSON.stringify(inventory), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/tasks/commands?')) {
        return Promise.resolve(new Response(JSON.stringify({
          commands: [command('newer-terminal', 'applied', 2), command('older-active', 'accepted', 1)],
          polling: 'tick_aligned',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }));

    render(<TasksView />);
    await waitFor(() => expect(screen.getByText(/Accepted by executor and durably journaled/i)).toBeTruthy());
    expect(screen.queryByText(/executor reported the local task disabled/i)).toBeNull();
    expect((screen.getByRole('button', { name: 'Request disable' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('marks a stale executor report in the sidebar list', async () => {
    post([knownTask()], Date.now() - TASK_INVENTORY_STALE_AFTER_MS - HOUR);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView />);

    await waitFor(() => expect(screen.getAllByText('Daily digest').length).toBe(2));
    const sidebar = document.querySelector('.tasks-sidebar') as HTMLElement;
    const row = within(sidebar).getByText('Daily digest').closest('.tasks-row') as HTMLElement;
    expect(within(row).getByText('agent-schedule')).toBeTruthy();
    expect(row.querySelector('.tasks-freshness--stale')).toBeTruthy();
  });

  it('keeps every explicit unknown visible, including unknown freshness', async () => {
    post([unknownTask()], Date.now() + HOUR);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView />);

    await waitFor(() => expect(screen.getAllByText('Unknown task').length).toBe(2));
    const detail = document.querySelector('.tasks-detail') as HTMLElement;
    const factValue = (label: string): HTMLElement => {
      const term = within(detail).getAllByText(label)
        .find((element) => element.classList.contains('tasks-fact__label')) as HTMLElement;
      return term.nextElementSibling as HTMLElement;
    };
    for (const label of [
      'Active bundle',
      'Enabled in config',
      'Activated on this host',
      'Circuit',
      'Retry attempts',
      'Next retry',
      'Kill switch',
      'Executor staleness claim',
    ]) {
      expect(factValue(label).textContent, label).toBe('unknown');
    }
    expect(within(detail).getAllByText(/unknown — the executor could not say/i)).toHaveLength(2);
    const row = within(document.querySelector('.tasks-sidebar') as HTMLElement)
      .getByText('Unknown task').closest('.tasks-row') as HTMLElement;
    expect(row.querySelector('.tasks-freshness--unknown')).toBeTruthy();
  });

  it('labels a report exactly at the staleness horizon as current', async () => {
    const observedAt = Date.now();
    post([knownTask()], observedAt);
    const view = getTaskInventoryView(db, {
      now: observedAt + TASK_INVENTORY_STALE_AFTER_MS,
    });
    stubInventory(normalizeTaskInventory(view));
    render(<TasksView />);

    await waitFor(() => expect(screen.getAllByText('Daily digest').length).toBe(2));
    const row = within(document.querySelector('.tasks-sidebar') as HTMLElement)
      .getByText('Daily digest').closest('.tasks-row') as HTMLElement;
    expect(row.querySelector('.tasks-freshness--current')).toBeTruthy();
  });
});
