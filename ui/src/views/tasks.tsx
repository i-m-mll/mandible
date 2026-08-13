// Tasks view — issue 0bc2279, first slice of tasks-in-Mandible.
//
// This page is TELEMETRY, and its whole credibility rests on not overstating
// what it knows. Three rules:
//
//  1. EVERYTHING HERE IS REPORTED BY AN EXECUTOR. Mandible verified who posted
//     the generation and that it had the declared shape — not that any run
//     happened, that a hash is real, or that a circuit is truly open. The page
//     says so in the header, once, plainly.
//  2. `unknown` IS RENDERED AS "unknown". Never as a blank cell, never as a
//     zero, never as a plausible-looking default. The contract makes a
//     publisher state its ignorance explicitly (docs/executor-inventory-
//     contract.md §3) precisely so this view can show it.
//  3. NOTHING IS ACTIONABLE. No commands, no editing, no '+' button. Mandible
//     does not manage these tasks yet, so offering a control would be a lie
//     about where authority lives.
//
// The one judgment the page adds is FRESHNESS, and it is the server's: how old
// the executor's snapshot is. It is shown next to the executor, not next to the
// task, because it describes the age of the picture rather than the task.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import {
  getTaskInventory,
  TASK_INVENTORY_UNKNOWN,
  type TaskActivationFacts,
  type TaskBundleFacts,
  type TaskExecutorFreshness,
  type TaskExecutorSummary,
  type TaskGuardFacts,
  type TaskInventory,
  type TaskInventoryItem,
  type TaskRunFacts,
  type TaskRunSlot,
} from '../api';
import { ViewSidebar } from '../components/ViewSidebar';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format';

/** Poll cadence while the route is visible. Generations arrive ~hourly. */
export const TASKS_POLL_INTERVAL_MS = 60_000;

const FRESHNESS_LABEL: Record<TaskExecutorFreshness, string> = {
  current: 'current',
  stale: 'stale',
  unknown: 'unknown',
};

/** How a freshness value reads in a sidebar row's title attribute. */
export function freshnessTitle(item: TaskInventoryItem): string {
  if (item.freshness === 'stale') {
    return `Executor '${item.executor}' last reported ${formatRelativeTime(item.observed_at, { style: 'recent' })} — this picture is stale.`;
  }
  if (item.freshness === 'unknown') {
    return `Executor '${item.executor}' reported an observation time Mandible cannot place.`;
  }
  return `Executor '${item.executor}' reported ${formatRelativeTime(item.observed_at, { style: 'recent' })}.`;
}

function isUnknown(value: unknown): boolean {
  return value === TASK_INVENTORY_UNKNOWN;
}

/**
 * The single formatting rule for a reported scalar. Returns the text AND
 * whether it is an explicit unknown, so the caller can style it as absent
 * without inventing a different word for it.
 */
export function taskFact(
  value: unknown,
  format?: (known: never) => string,
): { text: string; unknown: boolean } {
  if (isUnknown(value) || value === undefined || value === null) {
    return { text: 'unknown', unknown: true };
  }
  if (format) return { text: format(value as never), unknown: false };
  if (typeof value === 'boolean') return { text: value ? 'yes' : 'no', unknown: false };
  return { text: String(value), unknown: false };
}

function Fact({
  label,
  value,
  format,
  mono,
}: {
  label: string;
  value: unknown;
  format?: (known: never) => string;
  mono?: boolean;
}): JSX.Element {
  const fact = taskFact(value, format);
  const valueClass = [
    'tasks-fact__value',
    fact.unknown ? 'tasks-fact__value--unknown' : '',
    mono && !fact.unknown ? 'tasks-fact__value--mono' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className="tasks-fact">
      <dt className="tasks-fact__label">{label}</dt>
      <dd className={valueClass}>{fact.text}</dd>
    </div>
  );
}

const formatMs = (value: never) => formatAbsoluteTime(value as unknown as number);

function BundleSection({ bundle }: { bundle: TaskBundleFacts | typeof TASK_INVENTORY_UNKNOWN }): JSX.Element {
  if (isUnknown(bundle)) {
    return (
      <dl className="tasks-facts">
        <Fact label="Active bundle" value={TASK_INVENTORY_UNKNOWN} />
      </dl>
    );
  }
  const facts = bundle as TaskBundleFacts;
  return (
    <dl className="tasks-facts">
      <Fact label="Commit" value={facts.commit} mono />
      <Fact label="Content hash" value={facts.content_hash} mono />
      <Fact label="Execution hash" value={facts.execution_hash} mono />
      <Fact label="Deployed" value={facts.deployed_at} format={formatMs} />
    </dl>
  );
}

function ActivationSection({ activation }: { activation: TaskActivationFacts }): JSX.Element {
  return (
    <>
      <dl className="tasks-facts">
        {/* Two facts, never merged. A single `enabled` flag would hide exactly
            the disagreement that matters: configured on, not running here. */}
        <Fact label="Enabled in config" value={activation.config_enabled} />
        <Fact label="Activated on this host" value={activation.locally_activated} />
      </dl>
      {activation.config_enabled === true && activation.locally_activated === false ? (
        <p className="tasks-note">
          Configured to run, but not activated on the reporting host.
        </p>
      ) : null}
    </>
  );
}

function GuardsSection({ guards }: { guards: TaskGuardFacts }): JSX.Element {
  return (
    <dl className="tasks-facts">
      <Fact label="Circuit" value={guards.circuit} />
      <Fact label="Retry attempts" value={guards.retry_attempt} />
      <Fact
        label="Next retry"
        value={guards.retry_next_at}
        format={(value) => (value === ('none' as never) ? 'none queued' : formatAbsoluteTime(value as unknown as number))}
      />
      <Fact label="Kill switch" value={guards.kill_switch} />
      <Fact label="Executor staleness claim" value={guards.staleness} />
    </dl>
  );
}

function RunSection({ title, slot }: { title: string; slot: TaskRunSlot }): JSX.Element {
  if (slot === 'never') {
    return (
      <section className="tasks-section">
        <h3 className="tasks-section__title">{title}</h3>
        <p className="tasks-note">Reported as never having happened.</p>
      </section>
    );
  }
  if (isUnknown(slot)) {
    return (
      <section className="tasks-section">
        <h3 className="tasks-section__title">{title}</h3>
        <p className="tasks-note tasks-note--unknown">
          unknown — the executor could not say.
        </p>
      </section>
    );
  }
  const run = slot as TaskRunFacts;
  return (
    <section className="tasks-section">
      <h3 className="tasks-section__title">{title}</h3>
      <dl className="tasks-facts">
        <Fact label="Run id" value={run.run_id} mono />
        <Fact label="Outcome" value={run.outcome} />
        <Fact label="Started" value={run.started_at} format={formatMs} />
        <Fact label="Finished" value={run.finished_at} format={formatMs} />
      </dl>
      {/* The binding identities are the reason this record exists: a run that
          cannot name what it executed reports unknown instead of borrowing the
          currently deployed bundle's identity. */}
      <p className="tasks-section__caption">Bound identities</p>
      <dl className="tasks-facts">
        <Fact label="Bundle commit" value={run.bundle_commit} mono />
        <Fact label="Content hash" value={run.content_hash} mono />
        <Fact label="Execution hash" value={run.execution_hash} mono />
        <Fact label="Config hash" value={run.config_hash} mono />
      </dl>
      <dl className="tasks-facts">
        <Fact label="Detail" value={run.detail} />
      </dl>
    </section>
  );
}

function ExecutorFooter({ executor }: { executor: TaskExecutorSummary | null }): JSX.Element | null {
  if (!executor) return null;
  return (
    <section className="tasks-section">
      <h3 className="tasks-section__title">Reporting executor</h3>
      <dl className="tasks-facts">
        <Fact label="Name" value={executor.name} />
        <Fact label="Version" value={executor.version} />
        <Fact
          label="Capabilities"
          value={executor.capabilities.length > 0 ? executor.capabilities.join(', ') : 'none declared'}
        />
        <Fact label="Observed" value={executor.observed_at} format={formatMs} />
        <Fact label="Received" value={executor.received_at} format={formatMs} />
        <Fact label="Posted by" value={executor.posted_by_slug ?? executor.posted_by_user_id} />
        <Fact label="Generation digest" value={executor.digest.slice(0, 16)} mono />
      </dl>
    </section>
  );
}

function TaskDetail({
  item,
  executor,
}: {
  item: TaskInventoryItem;
  executor: TaskExecutorSummary | null;
}): JSX.Element {
  const { task } = item;
  return (
    <article className="tasks-detail__body">
      <header className="tasks-detail__header">
        <h2 className="tasks-detail__title">{task.display_name}</h2>
        <p className="tasks-detail__subtitle">
          <span className="tasks-detail__id">{task.task_id}</span>
          <span className="tasks-detail__sep">·</span>
          <span>{item.executor}</span>
          <span className="tasks-detail__sep">·</span>
          <span className={`tasks-freshness tasks-freshness--${item.freshness}`}>
            {FRESHNESS_LABEL[item.freshness]}
          </span>
        </p>
      </header>

      <section className="tasks-section">
        <h3 className="tasks-section__title">Management</h3>
        <dl className="tasks-facts">
          <Fact label="Mode" value={task.management_mode} />
        </dl>
        {task.management_mode === 'external' ? (
          <p className="tasks-note">
            Owned by the executor. Mandible observes it and does not run, enable, or edit it.
          </p>
        ) : null}
      </section>

      <section className="tasks-section">
        <h3 className="tasks-section__title">Active bundle</h3>
        <BundleSection bundle={task.bundle} />
      </section>

      <section className="tasks-section">
        <h3 className="tasks-section__title">Activation</h3>
        <ActivationSection activation={task.activation} />
      </section>

      <section className="tasks-section">
        <h3 className="tasks-section__title">Guards</h3>
        <GuardsSection guards={task.guards} />
      </section>

      <RunSection title="Last run" slot={task.last_run} />
      <RunSection title="Last failure" slot={task.last_failure} />
      <ExecutorFooter executor={executor} />
    </article>
  );
}

export type TasksViewProps = {
  sidebarHidden?: boolean;
  initialTaskKey?: string | null;
};

export function TasksView({ sidebarHidden, initialTaskKey }: TasksViewProps): JSX.Element {
  const [inventory, setInventory] = useState<TaskInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialTaskKey ?? null);
  const mounted = useRef(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getTaskInventory(signal);
      if (!mounted.current) return;
      setInventory(next);
      setError(null);
    } catch (loadError) {
      if (!mounted.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => { void load(); }, TASKS_POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  const tasks = inventory?.tasks ?? [];
  const executors = inventory?.executors ?? [];

  const selected = useMemo(
    () => tasks.find((item) => item.key === selectedKey) ?? tasks[0] ?? null,
    [tasks, selectedKey],
  );
  const selectedExecutor = useMemo(
    () => executors.find((entry) => entry.name === selected?.executor) ?? null,
    [executors, selected],
  );

  // "No executor has ever posted" and "an executor posted an empty inventory"
  // are different facts and must not share a message.
  const neverRegistered = !loading && !error && executors.length === 0;
  const registeredButEmpty = !loading && !error && executors.length > 0 && tasks.length === 0;

  return (
    <div className={`tasks-layout${sidebarHidden ? ' tasks-layout--sidebar-hidden' : ''}`}>
      <ViewSidebar
        storageKey="sidebar-width:tasks"
        defaultWidth={340}
        minWidth={240}
        className="tasks-sidebar"
        ariaLabel="Tasks"
        hidden={sidebarHidden}
        header={
          <div className="tasks-sidebar__header">
            <span className="tasks-sidebar__title">Tasks</span>
            <span className="tasks-sidebar__count">
              {tasks.length > 0 ? `${tasks.length}` : ''}
            </span>
          </div>
        }
        bodyClassName="tasks-sidebar__list"
      >
        {loading && !inventory ? (
          <div className="tasks-sidebar__empty">Loading…</div>
        ) : error ? (
          <div className="tasks-sidebar__empty">Could not load the inventory.</div>
        ) : neverRegistered ? (
          <div className="tasks-sidebar__empty">No executor has registered an inventory.</div>
        ) : registeredButEmpty ? (
          <div className="tasks-sidebar__empty">The executor reported no tasks.</div>
        ) : (
          tasks.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`tasks-row${selected?.key === item.key ? ' tasks-row--selected' : ''}`}
              onClick={() => setSelectedKey(item.key)}
              title={freshnessTitle(item)}
            >
              <span className="tasks-row__name">{item.task.display_name}</span>
              <span className="tasks-row__meta">
                <span className="tasks-row__executor">{item.executor}</span>
                <span
                  className={`tasks-freshness tasks-freshness--${item.freshness}`}
                  aria-label={`Executor report ${FRESHNESS_LABEL[item.freshness]}`}
                >
                  {FRESHNESS_LABEL[item.freshness]}
                </span>
              </span>
            </button>
          ))
        )}
      </ViewSidebar>

      <div className="tasks-detail">
        <p className="tasks-provenance">
          Reported by executor. Mandible verifies the publisher's identity and the shape of what
          they post — not that any of it happened.
        </p>
        {error ? (
          <div className="tasks-detail__empty">
            <span className="text-muted">Could not load the inventory: {error}</span>
          </div>
        ) : loading && !inventory ? (
          <div className="tasks-detail__empty">
            <span className="text-muted">Loading tasks…</span>
          </div>
        ) : neverRegistered ? (
          <div className="tasks-detail__empty">
            <span className="text-muted">
              No executor has registered an inventory. Tasks appear here once an executor posts one;
              Mandible does not create or run them.
            </span>
          </div>
        ) : !selected ? (
          <div className="tasks-detail__empty">
            <span className="text-muted">
              An executor has reported, but listed no tasks.
            </span>
          </div>
        ) : (
          <TaskDetail item={selected} executor={selectedExecutor} />
        )}
      </div>
    </div>
  );
}
