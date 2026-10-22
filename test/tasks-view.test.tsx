import { establishTestClientAccess } from './helpers/local-client-access';
import { MAIN_CLI_INSTANCE_RESPONSE } from './helpers/cli-instance-response';
import { bindTestInstanceCatalog } from './helpers/instance-operation-fixtures';
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
import { cleanup, fireEvent, screen, waitFor, within } from './helpers/dom.js';
import { render } from './helpers/notice-test-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TASK_INVENTORY_SCHEMA_V2, type TaskInventoryResponse } from '../src/contracts.js';
import { setDb, type Db } from '../src/db.js';
import { migratedMemoryDb } from './helpers/ledger-fixtures.js';
import { getTaskInventoryView, parseTaskInventoryGeneration, recordTaskInventoryGeneration } from '../src/task-inventory.js';
import { createUser } from '../src/users/store.js';
import { createManagedReminder } from '../src/managed-reminders.js';
import { parseManagedReminderCreateRequest } from '../src/managed-reminder-parser.js';
import { resolveProjectForCheckout } from '../src/ledger/projects.js';
import { invalidateApiGetCache, normalizeTaskInventory } from '../ui/src/api';
import { TasksView } from '../ui/src/views/tasks';

const HOUR = 60 * 60 * 1000;
const EXECUTION_HASH = 'a'.repeat(64);

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
  db = migratedMemoryDb();
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

describe('TasksView', () => {

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
    fireEvent.input(search, { target: { value: 'daily-digest' } });
    expect(within(sidebar).getByRole('button', { name: 'Select Daily digest' })).toBeTruthy();
    expect(within(sidebar).queryByRole('button', { name: 'Select Review reminder filters' })).toBeNull();
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Select Daily digest' }));

    fireEvent.click(screen.getByRole('button', { name: 'Task filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reminders' }));
    expect(screen.getByRole('button', { name: 'Reminders' }).getAttribute('aria-pressed')).toBe('true');

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
    await screen.findByRole('alert');
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
    await screen.findByRole('alert');
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
});

describe('TasksView task-command v2', () => {

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
