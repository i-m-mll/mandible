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
import { normalizeTaskInventory } from '../ui/src/api';
import { parseRouteFromHash } from '../ui/src/routing';
import { taskFact, TasksView } from '../ui/src/views/tasks';

const HOUR = 60 * 60 * 1000;

let db: Db;
let publisherId: string;

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
