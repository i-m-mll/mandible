import { establishTestClientAccess } from '../helpers/local-client-access';
import { MAIN_CLI_INSTANCE_RESPONSE } from '../helpers/cli-instance-response';
import { bindTestInstanceCatalog } from '../helpers/instance-operation-fixtures';
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
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { render } from './notice-test-render';
import SqliteDatabase from "../../src/sqlite.ts";
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TASK_INVENTORY_SCHEMA_V2, type TaskInventoryResponse } from '../../src/contracts.js';
import { migrate, setDb, type Db } from '../../src/db.js';
import {
  getTaskInventoryView,
  parseTaskInventoryGeneration,
  recordTaskInventoryGeneration,
  TASK_INVENTORY_STALE_AFTER_MS,
} from '../../src/task-inventory.js';
import { createUser } from '../../src/users/store.js';
import { createManagedReminder } from '../../src/managed-reminders.js';
import { parseManagedReminderCreateRequest } from '../../src/managed-reminder-parser.js';
import { resolveProjectForCheckout } from '../../src/ledger/projects.js';
import { invalidateApiGetCache, normalizeTaskInventory } from '../../ui/src/api';
import { parseRouteFromHash } from '../../ui/src/routing';
import { taskFact, TasksView } from '../../ui/src/views/tasks';

const HOUR = 60 * 60 * 1000;
const EXECUTION_HASH = 'a'.repeat(64);
const PRODUCER_INVENTORY = (JSON.parse(readFileSync(
  'test/fixtures/dotfiles-cba4353-activation-health.json',
  'utf8',
)) as { inventory: Record<string, unknown> }).inventory;

let db: Db;
let publisherId: string;
let projectId: string;

function knownTask(): Record<string, unknown> {
  return {
    task_id: 'daily-digest',
    display_name: 'Daily digest',
    management_mode: 'external',
    config_hash: 'sha256:config',
    prompt_hash: 'sha256:prompt',
    config: {
      schedule_text: '0 6 * * *',
      not_before: '2026-08-15T00:00:00Z',
      max_lateness_minutes: 30,
      missed_run_policy: 'skip',
      timeout_seconds: 90,
      runner: 'codex',
      runner_profile: 'default',
      model: 'gpt-5',
      max_total_tokens: 20_000,
      max_turns: 12,
      publish: true,
      output_as_source: false,
    },
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

function v2Task(): Record<string, unknown> {
  const task = knownTask();
  task.bundle = {
    ...(task.bundle as Record<string, unknown>),
    execution_hash: EXECUTION_HASH,
  };
  return task;
}

function unknownTask(): Record<string, unknown> {
  return {
    task_id: 'unknown-task',
    display_name: 'Unknown task',
    management_mode: 'external',
    config_hash: 'unknown',
    prompt_hash: 'unknown',
    config: {
      schedule_text: 'unknown',
      not_before: 'unknown',
      max_lateness_minutes: 'unknown',
      missed_run_policy: 'unknown',
      timeout_seconds: 'unknown',
      runner: 'unknown',
      runner_profile: 'unknown',
      model: 'unknown',
      max_total_tokens: 'unknown',
      max_turns: 'unknown',
      publish: 'unknown',
      output_as_source: 'unknown',
    },
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

function post(
  tasks: Array<Record<string, unknown>>,
  observedAt = Date.now(),
  capabilities: string[] = ['cron'],
): void {
  const generation = parseTaskInventoryGeneration({
    schema: TASK_INVENTORY_SCHEMA_V2,
    executor: { name: 'agent-schedule', version: '0.4.2', capabilities },
    observed_at: observedAt,
    tasks,
  });
  recordTaskInventoryGeneration(db, generation, { postedByUserId: publisherId });
}

function postV3(body: Record<string, unknown> = PRODUCER_INVENTORY): void {
  const generation = parseTaskInventoryGeneration(body);
  recordTaskInventoryGeneration(db, generation, { postedByUserId: publisherId });
}

function commandFixture(
  verb: 'dry_run' | 'enable',
  state: 'requested' | 'accepted' | 'started' | 'applied' | 'rejected',
  options: {
    events?: Array<Record<string, unknown>>;
    rejectionReason?: string | null;
    id?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: options.id ?? `command-${verb}`,
    schema: 'task-command@2',
    request_key: `request-${verb}`,
    request_digest: 'b'.repeat(64),
    executor: 'agent-schedule',
    task_id: 'daily-digest',
    verb,
    payload: { execution_hash: EXECUTION_HASH },
    requested_by_user_id: 'operator',
    requested_by_slug: 'operator',
    requested_at: Date.now(),
    state,
    no_op: verb === 'enable' && state === 'applied' ? false : null,
    rejection_reason: options.rejectionReason ?? null,
    events: options.events ?? [],
  };
}

function stubV2Fetch(options: {
  postCommand?: (body: Record<string, unknown>) => Record<string, unknown>;
  pointCommand?: () => Record<string, unknown>;
  listedCommands?: Record<string, unknown>[];
} = {}) {
  post([v2Task()], Date.now(), ['cron', 'task-command@2']);
  const inventory = normalizeTaskInventory(getTaskInventoryView(db));
  const postedBodies: Array<Record<string, unknown>> = [];
  let inventoryReads = 0;
  let pointReads = 0;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/tasks') {
      inventoryReads += 1;
      return Promise.resolve(new Response(JSON.stringify(inventory), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (url.startsWith('/api/tasks/commands?') && !init?.method) {
      return Promise.resolve(new Response(JSON.stringify({
        commands: options.listedCommands ?? [], polling: 'tick_aligned',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (/^\/api\/tasks\/commands\/[^/]+$/.test(url) && !init?.method) {
      pointReads += 1;
      const command = options.pointCommand?.();
      if (!command) return Promise.reject(new Error('unexpected point read'));
      return Promise.resolve(new Response(JSON.stringify({ command }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (url === '/api/tasks/commands' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      postedBodies.push(body);
      const command = options.postCommand?.(body)
        ?? commandFixture(body.verb as 'dry_run' | 'enable', 'requested');
      return Promise.resolve(new Response(JSON.stringify({ stored: true, command }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }));
  return {
    postedBodies,
    inventoryReads: () => inventoryReads,
    pointReads: () => pointReads,
  };
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

beforeEach(async () => {
  invalidateApiGetCache();
  await establishTestClientAccess();
  bindTestInstanceCatalog(MAIN_CLI_INSTANCE_RESPONSE.instance);
  db = new SqliteDatabase(':memory:');
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
  vi.useRealTimers();
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
  it('keeps mounted explicit targets authoritative and records deliberate row selection', async () => {
    post([knownTask(), { ...knownTask(), task_id: 'second', display_name: 'Second task' }]);
    const inventory = normalizeTaskInventory(getTaskInventoryView(db));
    stubInventory(inventory);
    const first = inventory.tasks[0].key;
    const second = inventory.tasks[1].key;
    window.history.replaceState(null, '', '#/tasks?sidebar=hidden&agent_session=bound&sentinel=a%26b%2Bc');
    window.localStorage.setItem('mandible.tasks.selection:v1', JSON.stringify({ selectedKey: first }));
    const view = render(<TasksView initialTaskKey={first} />);
    await screen.findByRole('button', { name: 'Select Second task' });
    view.rerender(<TasksView initialTaskKey={second} />);
    await waitFor(() => expect(document.querySelector('.tasks-detail .detail-pane-header')?.textContent).toContain('Second task'));
    view.rerender(<TasksView initialTaskKey="missing-target" />);
    await screen.findByText('Task not found: missing-target');
    expect(document.querySelector('.tasks-detail .detail-pane-header')?.textContent).not.toContain('Daily digest');
    window.dispatchEvent(new Event('managed-reminder:sse'));
    await waitFor(() => expect(screen.getByText('Task not found: missing-target')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Select Daily digest' }));
    await waitFor(() => expect(document.querySelector('.tasks-detail .detail-pane-header')?.textContent).toContain('Daily digest'));
    const params = new URLSearchParams(window.location.hash.split('?')[1]);
    expect(params.get('task')).toBe(first);
    expect(params.get('sidebar')).toBe('hidden');
    expect(params.get('agent_session')).toBe('bound');
    expect(params.get('sentinel')).toBe('a&b+c');
  });

  it('renders a Mandible reminder as a read-only first-party row with exact provenance', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
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
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} initialTaskKey={`mandible-reminder:${created.reminder.id}`} />);

    await waitFor(() => expect(screen.getAllByText('Review the twentieth canonical merge')).toHaveLength(2));
    const detail = document.querySelector('.tasks-detail') as HTMLElement;
    expect(within(detail).getByText('Immutable predicate')).toBeTruthy();
    expect(within(detail).getByText('20')).toBeTruthy();
    expect(within(detail).getByText('develop')).toBeTruthy();
    expect(within(detail).getByText(created.reminder.revision.payload_digest)).toBeTruthy();
    expect(within(detail).getByText(created.reminder.created_by_user_id)).toBeTruthy();
    expect(detail.querySelector('[data-detail-pane-header-variant="standard"]')).toBeTruthy();
    expect(within(detail).getByText('Mandible reminder · tasks-view-reminder-project')).toBeTruthy();
    const copyReminderReference = within(detail).getByRole('button', {
      name: 'Copy reminder reference',
    });
    fireEvent.click(copyReminderReference);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(created.reminder.id));
    const reminderRow = within(document.querySelector('.tasks-sidebar') as HTMLElement)
      .getByText('Review the twentieth canonical merge').closest('.tasks-row') as HTMLElement;
    expect(within(reminderRow).getByText('tasks-view-reminder-project')).toBeTruthy();
    expect(within(reminderRow).getByText('armed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /request disable|new|create|edit|\+/i })).toBeNull();
  });

  it('uses shared search and filters without resetting search, selection, or filters on reconciliation', async () => {
    const created = createManagedReminder(
      db,
      parseManagedReminderCreateRequest({
        schema: 'mandible-reminder@1',
        idempotency_key: 'tasks-sidebar-filter-reminder',
        project: 'tasks-view-reminder-project',
        message: 'Review reminder filters',
        predicate: {
          kind: 'auth_merge_count_gte',
          project: 'tasks-view-reminder-project',
          base_branch: 'develop',
          canonical_message: true,
          threshold: 3,
        },
      }),
      { userId: publisherId, evidenceMethod: 'api_token' },
      { projectId },
    );
    post([knownTask()]);
    const inventory = normalizeTaskInventory(getTaskInventoryView(db));
    inventory.tasks.push({
      source_kind: 'mandible',
      key: `mandible-reminder:${created.reminder.id}`,
      reminder: created.reminder,
    });
    stubInventory(inventory);
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} initialTaskKey={`mandible-reminder:${created.reminder.id}`} />);

    const search = await screen.findByRole('searchbox', { name: 'Search tasks' });
    const sidebar = document.querySelector('.tasks-sidebar') as HTMLElement;
    await within(sidebar).findByRole('button', { name: 'Select Daily digest' });
    const executorRow = within(sidebar).getByText('Daily digest').closest('.tasks-row') as HTMLElement;
    const reminderRow = within(sidebar).getByText('Review reminder filters').closest('.tasks-row') as HTMLElement;
    expect(executorRow.querySelector('.sidebar-item-row__badges')).toBeNull();
    expect(within(executorRow).queryByText('agent-schedule')).toBeNull();
    expect(executorRow.querySelector('.tasks-freshness')).toBeNull();
    expect(within(reminderRow).getByText('tasks-view-reminder-project')).toBeTruthy();
    expect(within(reminderRow).getByText('armed')).toBeTruthy();
    fireEvent.input(search, { target: { value: 'daily-digest' } });
    expect(within(sidebar).getByRole('button', { name: 'Select Daily digest' })).toBeTruthy();
    expect(within(sidebar).queryByRole('button', { name: 'Select Review reminder filters' })).toBeNull();
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Select Daily digest' }));

    fireEvent.click(screen.getByRole('button', { name: 'Task filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reminders' }));
    expect(screen.getByRole('button', { name: 'Reminders' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sidebar).getByText(/No tasks match your search and filters/i)).toBeTruthy();

    const inventoryReadsBeforeSse = vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input) === '/api/tasks').length;
    invalidateApiGetCache('/api/tasks');
    window.dispatchEvent(new CustomEvent('managed-reminder:sse'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input) === '/api/tasks').length).toBeGreaterThan(inventoryReadsBeforeSse));
    expect((search as HTMLInputElement).value).toBe('daily-digest');
    expect(screen.getByRole('button', { name: 'Reminders' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.input(search, { target: { value: '' } });
    expect(within(sidebar).getByRole('button', { name: 'Select Review reminder filters' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Task source' }))
      .getByRole('button', { name: 'all' }));
    expect(within(sidebar).getByRole('button', { name: 'Select Daily digest' }).getAttribute('aria-current'))
      .toBe('true');
  });

  it('says plainly that no executor has registered an inventory', async () => {
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

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
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

    await waitFor(() => {
      expect(screen.getAllByText(/executor reported no tasks|executor has reported, but listed no tasks/i))
        .toHaveLength(2);
    });
    expect(screen.queryByText(/No executor has registered an inventory/i)).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toBeTruthy();
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button', { name: /new|create|run|enable|edit|delete|\+/i })).toBeNull();
  });

  it('renders reported facts, keeps activation as two readings, and shows unknown as unknown', async () => {
    post([knownTask()]);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

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

    expect(factValue('Schedule').textContent).toBe('0 6 * * *');
    expect(factValue('Runner').textContent).toBe('codex');
    expect(factValue('Model').textContent).toBe('gpt-5');
    expect(factValue('Maximum total tokens').textContent).toBe('20000');
    expect(factValue('Config hash').textContent).toBe('sha256:config');
    expect(factValue('Prompt hash').textContent).toBe('sha256:prompt');
    expect(within(detail).getByText(/Executor-reported configuration/i)).toBeTruthy();

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
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

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
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

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

    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
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

    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
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

    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
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

    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
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

    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    await waitFor(() => expect(screen.getByText(/Accepted by executor and durably journaled/i)).toBeTruthy());
    expect(screen.queryByText(/executor reported the local task disabled/i)).toBeNull();
    expect((screen.getByRole('button', { name: 'Request disable' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('removes provider and freshness badges from rows while retaining them in typed detail', async () => {
    post([knownTask()], Date.now() - TASK_INVENTORY_STALE_AFTER_MS - HOUR);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

    await waitFor(() => expect(screen.getAllByText('Daily digest').length).toBe(2));
    const sidebar = document.querySelector('.tasks-sidebar') as HTMLElement;
    const row = within(sidebar).getByText('Daily digest').closest('.tasks-row') as HTMLElement;
    expect(row.classList.contains('sidebar-item-row')).toBe(true);
    expect(row.querySelector('.sidebar-item-row__badges')).toBeNull();
    expect(within(row).queryByText('agent-schedule')).toBeNull();
    expect(row.querySelector('.tasks-freshness')).toBeNull();

    const detail = document.querySelector('.tasks-detail') as HTMLElement;
    expect(detail.querySelector('[data-detail-pane-header-variant="standard"]')).toBeTruthy();
    expect(within(detail).getAllByText('agent-schedule').length).toBeGreaterThan(0);
    expect(detail.querySelector('.detail-pane-header .tasks-freshness--stale')?.textContent).toBe('stale');
    expect(within(detail).getByRole('button', {
      name: 'Copy task reference',
    })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Request disable' })
      .closest('.detail-pane-header__actions')).toBeTruthy();
  });

  it('keeps every explicit unknown visible, including unknown freshness', async () => {
    post([unknownTask()], Date.now() + HOUR);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

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
      'Schedule',
      'Not before',
      'Maximum lateness (minutes)',
      'Missed-run policy',
      'Runner',
      'Runner profile',
      'Model',
      'Timeout (seconds)',
      'Maximum total tokens',
      'Maximum turns',
      'Publish',
      'Output as source',
      'Config hash',
      'Prompt hash',
      'Circuit',
      'Retry attempts',
      'Next retry',
      'Kill switch',
      'Executor staleness claim',
    ]) {
      expect(factValue(label).textContent, label).toBe('unknown');
      expect(factValue(label).className, label).toContain('tasks-fact__value--unknown');
    }
    expect(within(detail).getAllByText(/unknown — the executor could not say/i)).toHaveLength(2);
    const row = within(document.querySelector('.tasks-sidebar') as HTMLElement)
      .getByText('Unknown task').closest('.tasks-row') as HTMLElement;
    expect(row.querySelector('.tasks-freshness--unknown')).toBeNull();
    expect(detail.querySelector('.detail-pane-header .tasks-freshness--unknown')?.textContent).toBe('unknown');
  });

  it('labels a report exactly at the staleness horizon as current', async () => {
    const observedAt = Date.now();
    post([knownTask()], observedAt);
    const view = getTaskInventoryView(db, {
      now: observedAt + TASK_INVENTORY_STALE_AFTER_MS,
    });
    stubInventory(normalizeTaskInventory(view));
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

    await waitFor(() => expect(screen.getAllByText('Daily digest').length).toBe(2));
    const row = within(document.querySelector('.tasks-sidebar') as HTMLElement)
      .getByText('Daily digest').closest('.tasks-row') as HTMLElement;
    expect(row.querySelector('.tasks-freshness--current')).toBeNull();
    expect(document.querySelector('.detail-pane-header .tasks-freshness--current')?.textContent).toBe('current');
  });

  it('uses Chat-equal native row geometry and one typed detail scroll owner', async () => {
    post([knownTask()]);
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);

    await screen.findByRole('button', { name: 'Select Daily digest' });

    const probe = document.createElement('div');
    probe.innerHTML = '<div class="tasks-list"><button class="select"></button></div><div class="chat-list"><button class="select"></button></div>';
    const style = document.createElement('style');
    style.textContent = '.tasks-list{padding:4px 6px}.chat-list{padding:8px 6px 14px}.select{padding:5px 7px 5px 7px}';
    document.head.append(style);
    document.body.append(probe);
    const nativeInset = (list: Element) => Number.parseFloat(getComputedStyle(list).paddingLeft)
      + Number.parseFloat(getComputedStyle(list.querySelector('.select')!).paddingLeft);
    expect(nativeInset(probe.querySelector('.tasks-list')!)).toBe(13);
    expect(nativeInset(probe.querySelector('.chat-list')!)).toBe(13);
    probe.remove();
    style.remove();

    const detail = document.querySelector('.tasks-detail') as HTMLElement;
    expect(detail.classList.contains('detail-pane-shell')).toBe(true);
    expect(detail.querySelectorAll('[data-detail-pane-slot="header"]')).toHaveLength(1);
    expect(detail.querySelectorAll('[data-detail-pane-slot="notice"]')).toHaveLength(1);
    expect(detail.querySelector('[data-detail-pane-slot="notice"] .detail-pane-notice')).toBeTruthy();
    expect(detail.querySelectorAll('[data-detail-pane-slot="body"]')).toHaveLength(1);
    expect(detail.querySelector('.tasks-detail__content header')).toBeNull();
    expect(readFileSync('ui/src/styles/detail-pane-shell.css', 'utf8'))
      .toMatch(/\.detail-pane-shell__body\s*\{[^}]*overflow-y:\s*auto;/s);
  });

  it('surfaces the cba4353 invalidation as one important sequential recovery notice', async () => {
    postV3();
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} initialTaskKey="agent-schedule/task-health" />);

    expect(await screen.findByText('Important: activation invalidated')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable task' })).toBeNull();
    expect(screen.getAllByText('Invalidated by deployment')).toHaveLength(2);
    expect(screen.getByText('important')).toBeTruthy();
    expect(screen.getByText('Activation history')).toBeTruthy();
  });

  it('keeps operator disablement separate from executor-path operational failure', async () => {
    const tasks = PRODUCER_INVENTORY.tasks as Array<Record<string, unknown>>;
    const activation = tasks[0].activation as Record<string, unknown>;
    postV3({
      ...PRODUCER_INVENTORY,
      executor: {
        ...(PRODUCER_INVENTORY.executor as object),
        health: {
          status: 'operational_failure',
          condition: 'execution_path_mismatch',
          attention: 'important',
        },
      },
      tasks: [{
        ...tasks[0],
        activation: {
          ...activation,
          locally_activated: false,
          state: 'operator_disabled',
          reason: 'operator_disabled',
          required_execution_hash: 'none',
          required_action: 'none',
          attention: 'none',
        },
      }],
    });
    stubInventory(normalizeTaskInventory(getTaskInventoryView(db)));
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} initialTaskKey="agent-schedule/task-health" />);

    expect(await screen.findByText('Executor operational failure')).toBeTruthy();
    expect(screen.getAllByText('Disabled by operator').length).toBeGreaterThan(0);
    expect(screen.getByText(/executor-path problem, not a task activation transition/i)).toBeTruthy();
  });
});

describe('TasksView task-command v2', () => {
  it('shows_v2_actions_only_for_capable_executor_with_known_hash', async () => {
    stubV2Fetch();
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    expect(await screen.findByRole('button', { name: 'Dry run' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable task' })).toBeTruthy();
    expect(screen.getAllByText(EXECUTION_HASH).length).toBeGreaterThan(0);
  });

  it('keeps_disable_available_during_non_disable_command', async () => {
    stubV2Fetch({ listedCommands: [commandFixture('dry_run', 'accepted')] });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    const disable = await screen.findByRole('button', { name: 'Request disable' });
    await waitFor(() => expect((disable as HTMLButtonElement).disabled).toBe(false));
  });

  it('dry_run_modal_streams_structured_progress', async () => {
    const command = commandFixture('dry_run', 'started', { events: [
      { id: 'accepted', event: 'accepted', payload: {} },
      { id: 'started', event: 'started', payload: { execution_hash: EXECUTION_HASH, run_id: 'run-1' } },
      { id: 'progress-1', event: 'progress', payload: { sequence: 1, step: 'preflight_passed' } },
      { id: 'progress-2', event: 'progress', payload: { sequence: 2, step: 'collector_started' } },
    ] });
    stubV2Fetch({ postCommand: () => command, pointCommand: () => command });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Dry run' })).click();
    const dialog = await screen.findByRole('dialog', { name: 'Dry run command' });
    expect(await within(dialog).findByText('Run started')).toBeTruthy();
    expect(within(dialog).getByText('1/6 Preflight passed')).toBeTruthy();
    expect(within(dialog).getByText('2/6 Collector started')).toBeTruthy();
    expect(dialog.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it('dry_run_success_keeps_task_disabled', async () => {
    stubV2Fetch({ postCommand: () => commandFixture('dry_run', 'applied') });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Dry run' })).click();
    expect(await screen.findByText(/Dry run passed\. Receipt recorded for aaaaaaaaaaaa\. Task remains disabled\./))
      .toBeTruthy();
    expect(screen.getByText(/not activated on the reporting host/i)).toBeTruthy();
  });

  it('enable_after_dry_run_requires_a_second_click', async () => {
    const stub = stubV2Fetch({
      postCommand: (body) => commandFixture(
        body.verb as 'dry_run' | 'enable',
        'applied',
        { id: `command-${String(body.verb)}` },
      ),
    });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Dry run' })).click();
    const dialog = await screen.findByRole('dialog', { name: 'Dry run command' });
    const enable = await within(dialog).findByRole('button', { name: 'Enable task' });
    expect(stub.postedBodies.map((body) => body.verb)).toEqual(['dry_run']);
    enable.click();
    await waitFor(() => expect(stub.postedBodies.map((body) => body.verb))
      .toEqual(['dry_run', 'enable']));
  });

  it('matching_receipt_enables_directly', async () => {
    const stub = stubV2Fetch({ postCommand: () => commandFixture('enable', 'applied') });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Enable task' })).click();
    expect(await screen.findByText('Enable request applied.')).toBeTruthy();
    expect(stub.postedBodies.map((body) => body.verb)).toEqual(['enable']);
  });

  it('missing_or_stale_receipt_offers_dry_run_without_starting_it', async () => {
    const stub = stubV2Fetch({
      postCommand: () => commandFixture('enable', 'rejected', {
        rejectionReason: 'missing_receipt',
      }),
    });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Enable task' })).click();
    const dialog = await screen.findByRole('dialog', { name: 'Enable task command' });
    expect(await within(dialog).findByRole('button', { name: 'Run dry run' })).toBeTruthy();
    expect(stub.postedBodies.map((body) => body.verb)).toEqual(['enable']);
  });

  it('cancel_disappears_at_acceptance', async () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const accepted = commandFixture('dry_run', 'accepted');
    stubV2Fetch({
      postCommand: () => commandFixture('dry_run', 'requested'),
      pointCommand: () => accepted,
    });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Dry run' })).click();
    expect(await screen.findByRole('button', { name: 'Cancel unseen request' })).toBeTruthy();
    await waitFor(() => expect(intervalSpy.mock.calls
      .some((call) => call[1] === 2_000)).toBe(true));
    invalidateApiGetCache('/api/tasks');
    window.dispatchEvent(new CustomEvent('task-command:sse', {
      detail: { type: 'tasks.commands.changed', data: { command_id: 'command-dry_run' } },
    }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel unseen request' }))
      .toBeNull());
    expect(screen.getByText('Accepted; cancellation is closed.')).toBeTruthy();
  });

  it('stale_target_refetches_inventory', async () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const stub = stubV2Fetch({
      postCommand: () => commandFixture('enable', 'requested'),
      pointCommand: () => commandFixture('enable', 'rejected', {
        rejectionReason: 'stale_target',
      }),
    });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    const search = await screen.findByRole('searchbox', { name: 'Search tasks' });
    fireEvent.input(search, { target: { value: 'daily' } });
    fireEvent.click(screen.getByRole('button', { name: 'Task filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'current' }));
    (await screen.findByRole('button', { name: 'Enable task' })).click();
    const before = stub.inventoryReads();
    await waitFor(() => expect(intervalSpy.mock.calls
      .some((call) => call[1] === 2_000)).toBe(true));
    const poll = intervalSpy.mock.calls.find((call) => call[1] === 2_000)![0];
    expect(typeof poll).toBe('function');
    (poll as () => void)();
    await waitFor(() => expect(stub.inventoryReads()).toBeGreaterThan(before));
    expect(screen.getByText('Rejected: stale_target.')).toBeTruthy();
    expect((search as HTMLInputElement).value).toBe('daily');
    expect(screen.getByRole('button', { name: 'current' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Select Daily digest' }).getAttribute('aria-current'))
      .toBe('true');
  });

  it('sse_reconciles_with_polling_fallback', async () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const accepted = commandFixture('dry_run', 'accepted');
    const stub = stubV2Fetch({
      postCommand: () => commandFixture('dry_run', 'requested'),
      pointCommand: () => accepted,
    });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Dry run' })).click();
    await screen.findByRole('button', { name: 'Cancel unseen request' });
    await waitFor(() => expect(intervalSpy.mock.calls.some((call) => call[1] === 2_000)).toBe(true));
    invalidateApiGetCache('/api/tasks');
    window.dispatchEvent(new CustomEvent('task-command:sse', {
      detail: { type: 'tasks.commands.changed', data: { command_id: 'command-dry_run' } },
    }));
    await waitFor(() => expect(stub.pointReads()).toBe(1));

    const pollingCall = intervalSpy.mock.calls.find((call) => call[1] === 2_000);
    expect(pollingCall).toBeTruthy();
    (pollingCall?.[0] as TimerHandler as () => void)();
    await waitFor(() => expect(stub.pointReads()).toBe(2));
  });

  it('never_renders_raw_output_notes_or_environment', async () => {
    const command = commandFixture('dry_run', 'rejected', {
      rejectionReason: 'dry_run_failed',
      events: [
        {
          id: 'progress',
          event: 'progress',
          payload: {
            sequence: 1,
            step: 'preflight_passed',
            output: 'SECRET RAW OUTPUT',
            environment: 'TOKEN=secret',
          },
        },
        {
          id: 'rejected',
          event: 'rejected',
          payload: {
            reason: 'dry_run_failed',
            failure_class: 'runner',
            note: 'private run note',
          },
        },
      ],
    });
    stubV2Fetch({ postCommand: () => command });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Dry run' })).click();
    expect(await screen.findByText('Failure class: runner')).toBeTruthy();
    expect(screen.queryByText('SECRET RAW OUTPUT')).toBeNull();
    expect(screen.queryByText('TOKEN=secret')).toBeNull();
    expect(screen.queryByText('private run note')).toBeNull();
  });

  it('names_the_policy_gate_that_refused', async () => {
    // The whole point of the field: an operator sees which gate fired without
    // walking to the machine.
    const gates: Array<[string, string]> = [
      ['kill_switch', 'Refused because the kill switch is set on the executor host.'],
      ['no_bundle', 'Refused because no active bundle is deployed.'],
      ['unprotected',
        'Refused because the active bundle was deployed with --allow-unprotected.'],
      ['tampered',
        'Refused because the active bundle no longer matches its deploy manifest.'],
      ['misbound',
        'Refused because the active bundle is not the one bound for execution.'],
      ['unreadable_config',
        "Refused because the active bundle's task configuration could not be read."],
    ];
    for (const [policy_gate, line] of gates) {
      const command = commandFixture('enable', 'rejected', {
        rejectionReason: 'policy_refused',
        events: [{
          id: 'rejected',
          event: 'rejected',
          payload: { reason: 'policy_refused', policy_gate },
        }],
      });
      stubV2Fetch({ postCommand: () => command });
      const view = render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
      (await screen.findByRole('button', { name: 'Enable task' })).click();
      expect(await screen.findByText(line)).toBeTruthy();
      view.unmount();
    }
  });

  it('policy_refusal_without_a_gate_shows_only_the_reason', async () => {
    // The pre-amendment executor. Absence is legal and must not render a
    // placeholder that reads like a gate.
    const command = commandFixture('enable', 'rejected', {
      rejectionReason: 'policy_refused',
      events: [{
        id: 'rejected',
        event: 'rejected',
        payload: { reason: 'policy_refused' },
      }],
    });
    stubV2Fetch({ postCommand: () => command });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Enable task' })).click();
    expect(await screen.findByText('Rejected: policy_refused.')).toBeTruthy();
    expect(screen.queryByText(/^Refused because/)).toBeNull();
  });

  it('never_renders_an_unrecognized_policy_gate', async () => {
    // A payload that reached storage by some route other than the wire parser
    // — a hand-edited database, a restored backup — degrades to the plain
    // reason. The raw value never reaches the DOM.
    const command = commandFixture('enable', 'rejected', {
      rejectionReason: 'policy_refused',
      events: [{
        id: 'rejected',
        event: 'rejected',
        payload: {
          reason: 'policy_refused',
          policy_gate: '/Users/mll/Library/Application Support/agent-schedule',
        },
      }],
    });
    stubV2Fetch({ postCommand: () => command });
    render(<TasksView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} />);
    (await screen.findByRole('button', { name: 'Enable task' })).click();
    expect(await screen.findByText('Rejected: policy_refused.')).toBeTruthy();
    expect(screen.queryByText(/^Refused because/)).toBeNull();
    expect(screen.queryByText(/Library\/Application Support/)).toBeNull();
  });
});
