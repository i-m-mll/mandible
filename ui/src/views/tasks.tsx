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
//  3. DISABLE IS A REQUEST, NOT A LOCAL TOGGLE. The lifecycle shown here is
//     backed by immutable operator intent and executor receipts. "requested"
//     never renders as though the task has already stopped.
//
// The one judgment the page adds is FRESHNESS, and it is the server's: how old
// the executor's snapshot is. It is shown next to the executor, not next to the
// task, because it describes the age of the picture rather than the task.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import {
  ApiError,
  canPerformOperation,
  invalidateApiGetCache,
  getTaskCommand,
  getTaskInventory,
  getTaskCommands,
  requestTaskDryRun,
  requestTaskEnable,
  requestTaskDisable,
  cancelTaskDisable,
  TASK_INVENTORY_UNKNOWN,
  type TaskActivationFacts,
  type TaskActivationHealthFacts,
  type TaskBundleFacts,
  type TaskConfigFacts,
  type TaskExecutorFreshness,
  type TaskExecutorSummary,
  type TaskGuardFacts,
  type TaskCommandList,
  type TaskInventory,
  type TaskInventoryItem,
  type ExecutorTaskInventoryItem,
  type MandibleTaskInventoryItem,
  type TaskCommand,
  type ManagedReminderPredicate,
  type TaskRunFacts,
  type TaskRunSlot,
  type InstanceInfo,
} from '../api';
import { ViewSidebar } from '../components/ViewSidebar';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { SidebarItemBadge, SidebarItemRow } from '../components/shared/SidebarItemRow';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { VIEW_SIDEBAR_GEOMETRY } from '../view-sidebar-geometry';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format';
import { readPersistedViewState, usePersistedViewState } from '../hooks/usePersistedViewState';
import { useLiveLoad } from '../app-shell';
import { refreshAbandoned } from '../lib/coalesced-refresh';
import { parseRouteFromHash, replaceRouteHash, routeHashWithParams } from '../routing';

const TASKS_SELECTION_STATE_KEY = 'mandible.tasks.selection:v1';

function normalizeTasksSelectionState(value: unknown): { selectedKey: string | null } {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    selectedKey: typeof record.selectedKey === 'string' && record.selectedKey.trim()
      ? record.selectedKey
      : null,
  };
}

/** Poll cadence while the route is visible. Generations arrive ~hourly. */
export const TASKS_POLL_INTERVAL_MS = 60_000;

const FRESHNESS_LABEL: Record<TaskExecutorFreshness, string> = {
  current: 'current',
  stale: 'stale',
  unknown: 'unknown',
};

/** How a freshness value reads in a sidebar row's title attribute. */
export function freshnessTitle(item: TaskInventoryItem): string {
  if (item.source_kind === 'mandible') {
    return `Mandible reminder in ${item.reminder.project_key}; lifecycle ${item.reminder.lifecycle}.`;
  }
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

function activationHealth(
  activation: TaskActivationFacts,
): TaskActivationHealthFacts | null {
  return 'state' in activation ? activation : null;
}

const ACTIVATION_STATE_LABEL: Record<TaskActivationHealthFacts['state'], string> = {
  never_activated: 'Never activated',
  activated: 'Activated',
  operator_disabled: 'Disabled by operator',
  deployment_invalidated: 'Invalidated by deployment',
};

const EXECUTOR_HEALTH_LABEL = {
  healthy: 'Healthy',
  no_active_bundle: 'No active bundle',
  bundle_link_mismatch: 'Active bundle link mismatch',
  execution_path_mismatch: 'Execution path does not match the active bundle',
} as const;

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
const formatActivationMs = (value: never) => value === ('none' as never)
  ? 'none'
  : formatMs(value);

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
  const health = activationHealth(activation);
  return (
    <>
      <dl className="tasks-facts">
        {/* Two facts, never merged. A single `enabled` flag would hide exactly
            the disagreement that matters: configured on, not running here. */}
        <Fact label="Enabled in config" value={activation.config_enabled} />
        <Fact label="Activated on this host" value={activation.locally_activated} />
        {health ? <Fact label="Activation state" value={ACTIVATION_STATE_LABEL[health.state]} /> : null}
        {health ? <Fact label="Changed" value={health.changed_at} format={formatActivationMs} /> : null}
        {health ? <Fact label="Previous execution hash" value={health.previous_execution_hash} mono /> : null}
        {health ? <Fact label="Required execution hash" value={health.required_execution_hash} mono /> : null}
        {health ? <Fact label="Deployment commit" value={health.deployment_commit} mono /> : null}
        {health ? <Fact label="Deployment content hash" value={health.deployment_content_hash} mono /> : null}
        {health ? <Fact label="Deployed" value={health.deployed_at} format={formatActivationMs} /> : null}
      </dl>
      {!health && activation.config_enabled === true && activation.locally_activated === false ? (
        <p className="tasks-note">
          Configured to run, but not activated on the reporting host.
        </p>
      ) : null}
      {health?.state === 'never_activated' ? (
        <p className="tasks-note">This task has never been activated on the reporting host.</p>
      ) : health?.state === 'operator_disabled' ? (
        <p className="tasks-note">An operator explicitly disabled this task on the reporting host.</p>
      ) : health?.state === 'deployment_invalidated' ? (
        <p className="tasks-note">
          Deployment changed the executable bytes. The task stays disabled until those exact bytes
          pass a dry run and an operator explicitly enables them.
        </p>
      ) : null}
    </>
  );
}

function ConfigSection({
  config,
  configHash,
  promptHash,
}: {
  config: TaskConfigFacts | undefined;
  configHash: unknown;
  promptHash: unknown;
}): JSX.Element {
  if (config === undefined) {
    return (
      <p className="tasks-note tasks-note--unknown">
        Not reported by this executor-inventory@1 publisher.
      </p>
    );
  }
  return (
    <>
      <p className="tasks-note">
        Executor-reported configuration. Mandible verifies the payload shape, not these values.
      </p>
      <p className="tasks-section__caption">Timing</p>
      <dl className="tasks-facts">
        <Fact label="Schedule" value={config.schedule_text} mono />
        <Fact label="Not before" value={config.not_before} />
        <Fact label="Maximum lateness (minutes)" value={config.max_lateness_minutes} />
        <Fact label="Missed-run policy" value={config.missed_run_policy} />
      </dl>
      <p className="tasks-section__caption">Runner and model</p>
      <dl className="tasks-facts">
        <Fact label="Runner" value={config.runner} />
        <Fact label="Runner profile" value={config.runner_profile} />
        <Fact label="Model" value={config.model} />
      </dl>
      <p className="tasks-section__caption">Limits and publication</p>
      <dl className="tasks-facts">
        <Fact label="Timeout (seconds)" value={config.timeout_seconds} />
        <Fact label="Maximum total tokens" value={config.max_total_tokens} />
        <Fact label="Maximum turns" value={config.max_turns} />
        <Fact label="Publish" value={config.publish} />
        <Fact label="Output as source" value={config.output_as_source} />
      </dl>
      <p className="tasks-section__caption">Reported identities</p>
      <dl className="tasks-facts">
        <Fact label="Config hash" value={configHash} mono />
        <Fact label="Prompt hash" value={promptHash} mono />
      </dl>
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
        <Fact
          label="Runtime health"
          value={executor.health ? EXECUTOR_HEALTH_LABEL[executor.health.condition] : 'not reported'}
        />
        <Fact label="Observed" value={executor.observed_at} format={formatMs} />
        <Fact label="Received" value={executor.received_at} format={formatMs} />
        <Fact label="Posted by" value={executor.posted_by_slug ?? executor.posted_by_user_id} />
        <Fact label="Generation digest" value={executor.digest.slice(0, 16)} mono />
      </dl>
    </section>
  );
}

function commandStatusText(command: TaskCommand): string {
  if (command.state === 'requested') return 'Requested, not yet seen by executor.';
  if (command.state === 'accepted') {
    return 'Accepted by executor and durably journaled; application is still pending.';
  }
  if (command.state === 'applied') {
    return command.no_op
      ? 'Applied. The executor reported the task was already disabled (no-op).'
      : 'Applied. The executor reported the local task disabled.';
  }
  if (command.state === 'rejected') {
    return `Rejected permanently by executor: ${command.rejection_reason ?? 'unknown'}.`;
  }
  return 'Cancelled before executor acceptance.';
}

function CommandSection({
  commands,
  activation,
  available,
  busy,
  error,
  onCancel,
}: {
  commands: TaskCommand[];
  activation: TaskActivationFacts;
  available: boolean;
  busy: boolean;
  error: string | null;
  onCancel: (commandId: string) => void;
}): JSX.Element {
  const disableCommands = commands.filter((command) => command.verb === 'disable');
  const latest = disableCommands[0] ?? null;
  // Never hide an unresolved safety request merely because a newer historical
  // command is terminal. The selected-target query is complete by contract.
  const active = disableCommands.find((command) =>
    command.state === 'requested' || command.state === 'accepted') ?? null;
  const displayed = active ?? latest;
  // This prediction mirrors the executor's no-op predicate exactly. Config is
  // a separate reading and must not turn an activated host into a predicted
  // no-op. The report may be stale, so this changes emphasis, never safety
  // availability.
  const disableExpectedNoOp = activation.locally_activated === false;
  const configHostDisagreement = activation.config_enabled === false
    && activation.locally_activated === true;
  return (
    <section className="tasks-section tasks-command">
      <h3 className="tasks-section__title">Disable command</h3>
      <p className="tasks-note">
        Commands are fetched at executor tick boundaries. A request may take up to one scheduler
        tick to be seen; requested and applied are deliberately different states.
      </p>
      {displayed ? (
        <div className={`tasks-command__receipt tasks-command__receipt--${displayed.state}`}>
          <span className="tasks-command__state">{displayed.state}</span>
          <span>{commandStatusText(displayed)}</span>
          <span className="tasks-command__time">Requested {formatRelativeTime(displayed.requested_at, { style: 'recent' })}</span>
        </div>
      ) : (
        <p className="tasks-note">No disable request has been recorded for this task.</p>
      )}
      {disableExpectedNoOp ? (
        <p className="tasks-note">
          Already disabled per last executor report — request would be a no-op.
        </p>
      ) : configHostDisagreement ? (
        <p className="tasks-note">
          Configuration says disabled, but the reporting host still says locally activated.
          Requesting disable is not expected to be a no-op.
        </p>
      ) : null}
      {error ? <DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice> : null}
      {displayed?.state === 'requested' ? (
        <div className="tasks-command__actions">
          <button
            type="button"
            className="btn"
            disabled={busy || !available}
            onClick={() => onCancel(displayed.id)}
          >
            Cancel unseen request
          </button>
        </div>
      ) : null}
    </section>
  );
}

function knownExecutionHash(item: ExecutorTaskInventoryItem): string | null {
  const hash = item.activation_condition?.required_execution_hash
    ?? (item.task.bundle !== TASK_INVENTORY_UNKNOWN
    ? item.task.bundle.execution_hash
    : TASK_INVENTORY_UNKNOWN);
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function ExecutorTaskHeaderActions({
  item,
  executor,
  commands,
  commandAvailable,
  disableBusy,
  v2Busy,
  onRequestDisable,
  onDryRun,
  onEnable,
}: {
  item: ExecutorTaskInventoryItem;
  executor: TaskExecutorSummary | null;
  commands: TaskCommand[];
  commandAvailable: boolean;
  disableBusy: boolean;
  v2Busy: boolean;
  onRequestDisable: () => void;
  onDryRun: () => void;
  onEnable: () => void;
}): JSX.Element {
  const activeDisable = commands.find((command) => command.verb === 'disable'
    && (command.state === 'requested' || command.state === 'accepted')) ?? null;
  const disableExpectedNoOp = item.task.activation.locally_activated === false;
  const executionHash = knownExecutionHash(item);
  const supportsV2 = executor?.capabilities.includes('task-command@2') === true && executionHash !== null;
  return (
    <>
      <button
        type="button"
        className={disableExpectedNoOp ? 'btn btn--ghost' : 'btn btn--danger'}
        disabled={disableBusy || activeDisable !== null || !commandAvailable}
        onClick={onRequestDisable}
      >
        {disableBusy ? 'Recording…' : 'Request disable'}
      </button>
      {supportsV2 && !item.activation_condition ? (
        <>
          <button type="button" className="btn" disabled={v2Busy} onClick={onDryRun}>
            Dry run
          </button>
          <button type="button" className="btn" disabled={v2Busy} onClick={onEnable}>
            Enable task
          </button>
        </>
      ) : null}
    </>
  );
}

function V2CommandSection({
  capable,
  executionHash,
}: {
  capable: boolean;
  executionHash: string | null;
}): JSX.Element | null {
  if (!capable || !executionHash) return null;
  return (
    <section className="tasks-section tasks-command tasks-command--v2">
      <h3 className="tasks-section__title">Behavioral activation</h3>
      <p className="tasks-note">
        Dry run records behavioral evidence for these exact execution bytes. Enabling is always a
        separate operator request.
      </p>
      <p className="tasks-command__hash">Execution hash <code>{executionHash}</code></p>
    </section>
  );
}

function ExecutorTaskDetail({
  item,
  executor,
  commands,
  commandAvailable,
  disableBusy,
  commandError,
  onCancelDisable,
}: {
  item: ExecutorTaskInventoryItem;
  executor: TaskExecutorSummary | null;
  commands: TaskCommand[];
  commandAvailable: boolean;
  disableBusy: boolean;
  commandError: string | null;
  onCancelDisable: (commandId: string) => void;
}): JSX.Element {
  const { task } = item;
  return (
    <article className="tasks-detail__content">
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

      <CommandSection
        commands={commands}
        activation={task.activation}
        available={commandAvailable}
        busy={disableBusy}
        error={commandError}
        onCancel={onCancelDisable}
      />

      <V2CommandSection
        capable={executor?.capabilities.includes('task-command@2') === true}
        executionHash={knownExecutionHash(item)}
      />

      <section className="tasks-section">
        <h3 className="tasks-section__title">Active bundle</h3>
        <BundleSection bundle={task.bundle} />
      </section>

      <section className="tasks-section">
        <h3 className="tasks-section__title">Configuration</h3>
        <ConfigSection
          config={task.config}
          configHash={task.config_hash}
          promptHash={task.prompt_hash}
        />
      </section>

      <section className="tasks-section">
        <h3 className="tasks-section__title">Activation</h3>
        <ActivationSection activation={task.activation} />
      </section>

      {item.activation_history.length > 0 ? (
        <section className="tasks-section">
          <h3 className="tasks-section__title">Activation history</h3>
          <ol className="tasks-activation-history">
            {item.activation_history.map((entry) => (
              <li key={entry.id}>
                <strong>{ACTIVATION_STATE_LABEL[entry.state]}</strong>
                <span>{formatAbsoluteTime(entry.observed_at)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

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

function PredicateFacts({ predicate }: { predicate: ManagedReminderPredicate }): JSX.Element {
  if (predicate.kind === 'at') {
    return <dl className="tasks-facts"><Fact label="At" value={predicate.at} /></dl>;
  }
  if (predicate.kind === 'issue_closed') {
    return <dl className="tasks-facts"><Fact label="Issue id" value={predicate.issue_id} mono /></dl>;
  }
  return (
    <dl className="tasks-facts">
      <Fact label="Project id" value={predicate.project_id} mono />
      <Fact label="Base branch" value={predicate.base_branch ?? 'any'} mono />
      <Fact
        label="Canonical message"
        value={predicate.canonical_message === undefined ? 'either' : predicate.canonical_message}
      />
      <Fact label="Threshold" value={predicate.threshold} />
    </dl>
  );
}

function ReminderOccurrenceEvidence({ item }: { item: MandibleTaskInventoryItem }): JSX.Element | null {
  const occurrence = item.reminder.occurrence;
  if (!occurrence) return null;
  const evidence = occurrence.triggering_evidence;
  return (
    <section className="tasks-section">
      <h3 className="tasks-section__title">Occurrence</h3>
      <dl className="tasks-facts">
        <Fact label="Occurrence id" value={occurrence.id} mono />
        <Fact label="Fired" value={occurrence.created_at} format={formatMs} />
        <Fact label="Fired by" value={occurrence.fired_by_user_id} mono />
        <Fact label="Evidence kind" value={evidence.kind} />
        {typeof evidence.at === 'string' ? <Fact label="Scheduled at" value={evidence.at} /> : null}
        {typeof evidence.evaluated_at === 'number'
          ? <Fact label="Evaluated" value={evidence.evaluated_at} format={formatMs} /> : null}
        {typeof evidence.issue_id === 'string' ? <Fact label="Issue id" value={evidence.issue_id} mono /> : null}
        {typeof evidence.closed_at === 'number'
          ? <Fact label="Issue closed" value={evidence.closed_at} format={formatMs} /> : null}
        {typeof evidence.observed_count === 'number'
          ? <Fact label="Observed merge count" value={evidence.observed_count} /> : null}
        {typeof evidence.latest_completed_at === 'number'
          ? <Fact label="Latest merge" value={evidence.latest_completed_at} format={formatMs} /> : null}
      </dl>
    </section>
  );
}

function MandibleReminderDetail({ item }: { item: MandibleTaskInventoryItem }): JSX.Element {
  const { reminder } = item;
  return (
    <article className="tasks-detail__content">
      <section className="tasks-section">
        <h3 className="tasks-section__title">Immutable predicate</h3>
        <PredicateFacts predicate={reminder.revision.payload.predicate} />
        <p className="tasks-note">Read-only first-party reminder. Mandible records one bounded inbox occurrence and does not execute external effects.</p>
      </section>
      <section className="tasks-section">
        <h3 className="tasks-section__title">Lifecycle</h3>
        <dl className="tasks-facts">
          <Fact label="State" value={reminder.lifecycle} />
          <Fact label="Created" value={reminder.created_at} format={formatMs} />
          <Fact label="Completed" value={reminder.completed_at ?? 'not completed'} format={reminder.completed_at === null ? undefined : formatMs} />
          <Fact label="Cancelled" value={reminder.cancelled_at ?? 'not cancelled'} format={reminder.cancelled_at === null ? undefined : formatMs} />
        </dl>
      </section>
      <section className="tasks-section">
        <h3 className="tasks-section__title">Revision provenance</h3>
        <dl className="tasks-facts">
          <Fact label="Revision" value={reminder.revision.revision_no} />
          <Fact label="Revision id" value={reminder.revision.id} mono />
          <Fact label="Schema" value={reminder.revision.schema} />
          <Fact label="Payload digest" value={reminder.revision.payload_digest} mono />
          <Fact label="Created by" value={reminder.created_by_user_id} mono />
          <Fact label="Revision created" value={reminder.revision.created_at} format={formatMs} />
        </dl>
      </section>
      <ReminderOccurrenceEvidence item={item} />
    </article>
  );
}

type CommandIntent = {
  executor: string;
  taskId: string;
  executionHash: string;
  verb: 'dry_run' | 'enable';
  command: TaskCommand | null;
};

const PROGRESS_TEXT: Record<string, string> = {
  preflight_passed: 'Preflight passed',
  collector_started: 'Collector started',
  snapshot_validated: 'Snapshot validated',
  runner_started: 'Runner started',
  runner_completed: 'Runner completed',
  output_validated: 'Output validated',
};

// Which gate refused, in the operator's language. The map is the display-side
// copy of the closed enumeration: a value outside it renders nothing at all,
// so a payload that reached storage by some route other than the wire parser
// still cannot put an executor-authored string on screen.
const POLICY_GATE_TEXT: Record<string, string> = {
  kill_switch: 'the kill switch is set on the executor host',
  no_bundle: 'no active bundle is deployed',
  unprotected: 'the active bundle was deployed with --allow-unprotected',
  tampered: 'the active bundle no longer matches its deploy manifest',
  misbound: 'the active bundle is not the one bound for execution',
  unreadable_config: "the active bundle's task configuration could not be read",
};

function TaskCommandModal({
  intent,
  busy,
  error,
  onClose,
  onCancel,
  onDryRun,
  onEnable,
}: {
  intent: CommandIntent;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCancel: (commandId: string) => void;
  onDryRun: () => void;
  onEnable: () => void;
}): JSX.Element {
  const { command } = intent;
  const failure = command?.events.find((event) => event.event === 'rejected')?.payload;
  const policyGateText = command?.rejection_reason === 'policy_refused'
    && typeof failure?.policy_gate === 'string'
    ? POLICY_GATE_TEXT[failure.policy_gate]
    : undefined;
  const receiptFailure = command?.state === 'rejected'
    && (command.rejection_reason === 'missing_receipt'
      || command.rejection_reason === 'stale_receipt');
  const dryRunPassed = command?.verb === 'dry_run' && command.state === 'applied';
  const status = !command
    ? 'Recording operator intent…'
    : command.state === 'requested'
      ? 'Waiting for executor'
      : command.state === 'accepted'
        ? 'Accepted; cancellation is closed.'
        : command.state === 'started'
          ? 'Executor-owned dry run started.'
          : command.state === 'cancelled'
            ? 'Cancelled before executor acceptance.'
            : command.state === 'rejected'
              ? `Rejected: ${command.rejection_reason ?? 'unknown'}.`
              : command.verb === 'dry_run'
                ? `Dry run passed. Receipt recorded for ${intent.executionHash.slice(0, 12)}. Task remains disabled.`
                : 'Enable request applied.';
  return (
    <div className="tasks-command-modal" role="dialog" aria-modal="true" aria-label={`${intent.verb === 'dry_run' ? 'Dry run' : 'Enable task'} command`}>
      <div className="tasks-command-modal__panel">
        <header className="tasks-command-modal__header">
          <div>
            <h2>{intent.verb === 'dry_run' ? 'Dry run' : 'Enable task'}</h2>
            <code>{intent.executionHash}</code>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
        </header>
        <div className="tasks-command-modal__terminal" aria-live="polite">
          <div className="tasks-command-modal__line">{status}</div>
          {command?.events.filter((event) => event.event === 'started').map((event) => (
            <div className="tasks-command-modal__line" key={event.id}>Run started</div>
          ))}
          {command?.events.filter((event) => event.event === 'progress').map((event) => {
            const step = typeof event.payload.step === 'string' ? event.payload.step : '';
            const sequence = typeof event.payload.sequence === 'number' ? event.payload.sequence : '?';
            return (
              <div className="tasks-command-modal__line" key={event.id}>
                {sequence}/6 {PROGRESS_TEXT[step] ?? 'Unknown progress step'}
              </div>
            );
          })}
          {command?.rejection_reason === 'dry_run_failed'
            && typeof failure?.failure_class === 'string' ? (
              <div className="tasks-command-modal__line">Failure class: {failure.failure_class}</div>
            ) : null}
          {/* Absent means the executor predates the field, and the plain reason
              stands on its own. Only a recognized member is ever rendered. */}
          {policyGateText ? (
            <div className="tasks-command-modal__line">Refused because {policyGateText}.</div>
          ) : null}
        </div>
        {error ? <DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice> : null}
        <div className="tasks-command__actions">
          {command?.state === 'requested' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => onCancel(command.id)}>
              Cancel unseen request
            </button>
          ) : null}
          {receiptFailure ? (
            <button type="button" className="btn" disabled={busy} onClick={onDryRun}>
              Run dry run
            </button>
          ) : null}
          {dryRunPassed ? (
            <button type="button" className="btn" disabled={busy} onClick={onEnable}>
              Enable task
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export type TasksViewProps = {
  sidebarHidden?: boolean;
  initialTaskKey?: string | null;
};

type TaskSourceFilter = 'all' | TaskInventoryItem['source_kind'];
type TaskFreshnessFilter = 'all' | TaskExecutorFreshness;

function taskSearchText(item: TaskInventoryItem): string {
  if (item.source_kind === 'executor') {
    return [
      item.task.display_name,
      item.task.task_id,
      item.executor,
      item.task.management_mode,
    ].join(' ').toLocaleLowerCase();
  }
  return [
    item.reminder.revision.payload.message,
    item.reminder.project_key,
    item.reminder.lifecycle,
    item.reminder.revision.payload.predicate.kind,
  ].join(' ').toLocaleLowerCase();
}

export async function warmInitialData(
  params: Record<string, string>,
  context: { instanceInfo: InstanceInfo | null },
): Promise<void> {
  if (!canPerformOperation(context.instanceInfo, 'GET', '/api/tasks')) return;
  const inventory = await getTaskInventory();
  const persisted = readPersistedViewState(
    TASKS_SELECTION_STATE_KEY,
    normalizeTasksSelectionState,
    { selectedKey: null },
  );
  const selectedKey = params.task?.trim() || persisted.selectedKey;
  const selected = inventory.tasks.find((item) => item.key === selectedKey)
    ?? (params.task?.trim() ? null : inventory.tasks[0])
    ?? null;
  if (selected?.source_kind !== 'executor'
      || !canPerformOperation(context.instanceInfo, 'GET', '/api/tasks/commands')) return;
  await getTaskCommands({
    executor: selected.executor,
    taskId: selected.task.task_id,
  });
}

export function TasksView({ sidebarHidden, initialTaskKey }: TasksViewProps): JSX.Element {
  const [selectionState, setSelectionState] = usePersistedViewState(
    TASKS_SELECTION_STATE_KEY,
    normalizeTasksSelectionState,
    { selectedKey: null },
  );
  const [inventory, setInventory] = useState<TaskInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [commands, setCommands] = useState<TaskCommand[]>([]);
  const [commandAvailable, setCommandAvailable] = useState(false);
  const [disableBusy, setDisableBusy] = useState(false);
  const [v2Busy, setV2Busy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [activeIntent, setActiveIntent] = useState<CommandIntent | null>(null);
  const routeKey = initialTaskKey?.trim() || null;
  const [selection, setSelection] = useState({ routeKey, key: routeKey ?? selectionState.selectedKey });
  const selectedKey = selection.routeKey === routeKey ? selection.key : routeKey ?? selectionState.selectedKey;
  const explicitSelection = selection.routeKey === routeKey ? Boolean(routeKey && selection.key === routeKey) : Boolean(routeKey);
  useEffect(() => {
    setSelection((current) => current.routeKey === routeKey ? current : { routeKey, key: routeKey ?? selectionState.selectedKey });
  }, [routeKey, selectionState.selectedKey]);
  const setSelectedKey = (key: string | null) => setSelection({ routeKey, key });
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<TaskSourceFilter>('all');
  const [freshnessFilter, setFreshnessFilter] = useState<TaskFreshnessFilter>('all');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const mounted = useRef(true);
  const inventorySequence = useRef(0);
  // Preserve one client idempotency key across ambiguous transport failures.
  // A retry of the same UI intent must replay rather than create a second
  // disable request merely because the first response was lost.
  const pendingRequestKeys = useRef(new Map<string, string>());

  const load = useCallback(async (signal?: AbortSignal, initial = false): Promise<TaskInventory | null> => {
    const sequence = ++inventorySequence.current;
    const showCached = (cached: TaskInventory) => {
      setInventory(cached);
      setLoading(false);
    };
    try {
      const next = await getTaskInventory({ signal, onCached: initial ? showCached : undefined });
      if (!mounted.current || signal?.aborted || sequence !== inventorySequence.current) return null;
      setInventory(next);
      setError(null);
      return next;
    } catch (loadError) {
      if (!mounted.current || refreshAbandoned(signal) || sequence !== inventorySequence.current) return null;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      return null;
    } finally {
      if (mounted.current && !refreshAbandoned(signal) && sequence === inventorySequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const inventoryLoadedRef = useRef(false);
  const refreshInventory = useLiveLoad((signal) => {
    const initial = !inventoryLoadedRef.current;
    if (!initial) invalidateApiGetCache('/api/tasks');
    inventoryLoadedRef.current = true;
    return load(signal, initial);
  }, [], TASKS_POLL_INTERVAL_MS);
  useEffect(() => {
    window.addEventListener('managed-reminder:sse', refreshInventory);
    return () => window.removeEventListener('managed-reminder:sse', refreshInventory);
  }, [refreshInventory]);

  const tasks = inventory?.tasks ?? [];
  const executors = inventory?.executors ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredTasks = useMemo(() => tasks.filter((item) => {
    if (sourceFilter !== 'all' && item.source_kind !== sourceFilter) return false;
    if (freshnessFilter !== 'all'
      && (item.source_kind !== 'executor' || item.freshness !== freshnessFilter)) return false;
    return normalizedSearch === '' || taskSearchText(item).includes(normalizedSearch);
  }), [freshnessFilter, normalizedSearch, sourceFilter, tasks]);
  const activeFilterCount = Number(sourceFilter !== 'all') + Number(freshnessFilter !== 'all');

  const selected = useMemo(
    () => tasks.find((item) => item.key === selectedKey) ?? (explicitSelection ? null : tasks[0]) ?? null,
    [tasks, selectedKey, explicitSelection],
  );
  useEffect(() => {
    if (loading && !inventory) return;
    if (error && !inventory) return;
    if (explicitSelection && !selected) return;
    const nextKey = selected?.key ?? null;
    if (nextKey !== selectedKey) setSelectedKey(nextKey);
    setSelectionState((current) => current.selectedKey === nextKey
      ? current
      : { selectedKey: nextKey });
  }, [error, inventory, loading, selected, selectedKey, explicitSelection, setSelectionState]);
  const selectedExecutorTask = selected?.source_kind === 'executor' ? selected : null;
  const selectedExecutor = useMemo(
    () => executors.find((entry) => entry.name === selectedExecutorTask?.executor) ?? null,
    [executors, selectedExecutorTask],
  );
  const selectedTargetKey = selectedExecutorTask?.key ?? null;
  const selectedTargetExecutor = selectedExecutorTask?.executor ?? null;
  const selectedTargetTaskId = selectedExecutorTask?.task.task_id ?? null;

  const commandsTargetRef = useRef<string | null>(null);
  useLiveLoad(async (signal) => {
    if (!selectedTargetKey || !selectedTargetExecutor || !selectedTargetTaskId) {
      if (commandsTargetRef.current === null) return;
      commandsTargetRef.current = null;
      setCommands([]);
      setCommandAvailable(false);
      setCommandError(null);
      return;
    }
    const targetKey = selectedTargetKey;
    const initial = commandsTargetRef.current !== targetKey;
    if (initial) {
      commandsTargetRef.current = targetKey;
      setCommands([]);
      setCommandAvailable(false);
      setCommandError(null);
    } else {
      invalidateApiGetCache('/api/tasks/commands');
    }
    const showCached = (cached: TaskCommandList) => {
      setCommands(cached.commands);
      setCommandAvailable(true);
    };
    try {
      const commandList = await getTaskCommands({
        executor: selectedTargetExecutor,
        taskId: selectedTargetTaskId,
      }, { signal, onCached: initial ? showCached : undefined });
      if (!mounted.current || signal.aborted) return;
      setCommands(commandList.commands);
      const pendingKey = pendingRequestKeys.current.get(targetKey);
      if (pendingKey && commandList.commands.some((command) => command.request_key === pendingKey)) {
        pendingRequestKeys.current.delete(targetKey);
      }
      setCommandAvailable(true);
      setCommandError(null);
    } catch (commandLoadError) {
      if (!mounted.current || refreshAbandoned(signal)) return;
      setCommandAvailable(false);
      setCommandError(
        commandLoadError instanceof Error ? commandLoadError.message : String(commandLoadError),
      );
    }
  }, [selectedTargetExecutor, selectedTargetKey, selectedTargetTaskId], TASKS_POLL_INTERVAL_MS);

  const selectedCommands = useMemo(
    () => commands.filter((command) =>
      command.executor === selectedExecutorTask?.executor
      && command.task_id === selectedExecutorTask?.task.task_id),
    [commands, selectedExecutorTask],
  );

  const requestDisable = useCallback(async () => {
    if (!selectedExecutorTask) return;
    const targetKey = selectedExecutorTask.key;
    const requestKey = pendingRequestKeys.current.get(targetKey) ?? crypto.randomUUID();
    pendingRequestKeys.current.set(targetKey, requestKey);
    setDisableBusy(true);
    setCommandError(null);
    try {
      const result = await requestTaskDisable(
        selectedExecutorTask.executor,
        selectedExecutorTask.task.task_id,
        requestKey,
      );
      if (!mounted.current) return;
      pendingRequestKeys.current.delete(targetKey);
      setCommands((current) => [result.command, ...current.filter((row) => row.id !== result.command.id)]);
    } catch (mutationError) {
      if (mounted.current) {
        // A 4xx response is a definitive refusal: the server received this
        // attempt and did not store it, so a later operator click is new
        // intent. Network failures, 429, and 5xx remain ambiguous and retain
        // the key for an idempotent replay.
        if (mutationError instanceof ApiError
          && mutationError.status < 500
          && mutationError.status !== 429) {
          pendingRequestKeys.current.delete(targetKey);
        }
        setCommandError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    } finally {
      if (mounted.current) setDisableBusy(false);
    }
  }, [selectedExecutorTask]);

  const cancelDisable = useCallback(async (commandId: string) => {
    setDisableBusy(true);
    setCommandError(null);
    try {
      const result = await cancelTaskDisable(commandId);
      if (!mounted.current) return;
      setCommands((current) => current.map((row) => row.id === result.command.id ? result.command : row));
    } catch (mutationError) {
      if (mounted.current) {
        setCommandError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    } finally {
      if (mounted.current) setDisableBusy(false);
    }
  }, []);

  const requestV2 = useCallback(async (
    verb: 'dry_run' | 'enable',
    frozen?: Pick<CommandIntent, 'executor' | 'taskId' | 'executionHash'>,
  ) => {
    const target = frozen ?? (selectedExecutorTask ? {
      executor: selectedExecutorTask.executor,
      taskId: selectedExecutorTask.task.task_id,
      executionHash: knownExecutionHash(selectedExecutorTask),
    } : null);
    if (!target) return;
    const { executor, taskId, executionHash } = target;
    if (!executionHash) return;
    const intentKey = `${executor}/${taskId}:${verb}:${executionHash}`;
    const requestKey = pendingRequestKeys.current.get(intentKey) ?? crypto.randomUUID();
    pendingRequestKeys.current.set(intentKey, requestKey);
    setActiveIntent({ executor, taskId, executionHash, verb, command: null });
    setV2Busy(true);
    setCommandError(null);
    try {
      const result = verb === 'dry_run'
        ? await requestTaskDryRun(executor, taskId, executionHash, requestKey)
        : await requestTaskEnable(executor, taskId, executionHash, requestKey);
      if (!mounted.current) return;
      pendingRequestKeys.current.delete(intentKey);
      setCommands((current) => [
        result.command,
        ...current.filter((row) => row.id !== result.command.id),
      ]);
      setActiveIntent({ executor, taskId, executionHash, verb, command: result.command });
    } catch (mutationError) {
      if (mounted.current) {
        if (mutationError instanceof ApiError
          && mutationError.status < 500
          && mutationError.status !== 429) {
          pendingRequestKeys.current.delete(intentKey);
        }
        setCommandError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    } finally {
      if (mounted.current) setV2Busy(false);
    }
  }, [selectedExecutorTask]);

  const cancelIntent = useCallback(async (commandId: string) => {
    setV2Busy(true);
    setCommandError(null);
    try {
      const result = await cancelTaskDisable(commandId);
      if (!mounted.current) return;
      setCommands((current) => current.map((row) =>
        row.id === result.command.id ? result.command : row));
      setActiveIntent((current) => current?.command?.id === result.command.id
        ? { ...current, command: result.command }
        : current);
    } catch (mutationError) {
      if (mounted.current) {
        setCommandError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    } finally {
      if (mounted.current) setV2Busy(false);
    }
  }, []);

  const commandId = activeIntent?.command?.id;
  const commandState = activeIntent?.command?.state;
  const intentPending = Boolean(commandId)
    && commandState !== 'applied' && commandState !== 'rejected' && commandState !== 'cancelled';
  const refreshIntent = useLiveLoad(async (signal) => {
    if (!commandId || !intentPending) return;
    try {
      const command = await getTaskCommand(commandId, signal);
      if (!mounted.current || signal.aborted) return;
      setCommands((current) => [command, ...current.filter((row) => row.id !== command.id)]);
      setActiveIntent((current) => current?.command?.id === command.id
        ? { ...current, command }
        : current);
      if (command.state === 'rejected' && command.rejection_reason === 'stale_target') refreshInventory();
    } catch (reconcileError) {
      if (mounted.current && !refreshAbandoned(signal)) {
        setCommandError(reconcileError instanceof Error ? reconcileError.message : String(reconcileError));
      }
    }
  }, [commandId, intentPending], intentPending ? 2_000 : undefined);
  useEffect(() => {
    if (!commandId || !intentPending) return undefined;
    const onSse = (event: Event) => {
      const detail = (event as CustomEvent<{
        data?: { command_id?: string };
      }>).detail;
      if (detail?.data?.command_id === commandId) refreshIntent();
    };
    window.addEventListener('task-command:sse', onSse);
    return () => window.removeEventListener('task-command:sse', onSse);
  }, [commandId, intentPending, refreshIntent]);

  // "No executor has ever posted" and "an executor posted an empty inventory"
  // are different facts and must not share a message.
  const neverRegistered = !loading && !error && executors.length === 0 && tasks.length === 0;
  const registeredButEmpty = !loading && !error && executors.length > 0 && tasks.length === 0;
  const activationCondition = selectedExecutorTask?.activation_condition ?? null;
  const executorHealth = selectedExecutor?.health;
  const detailNotice = activationCondition && selectedExecutorTask ? (
    <DetailPaneNotice
      severity="warning"
      density="compact"
      title="Important: activation invalidated"
      actions={(
        <button
          type="button"
          className="btn"
          disabled={v2Busy || !commandAvailable}
          onClick={() => { void requestV2(activationCondition.next_action, {
            executor: selectedExecutorTask.executor,
            taskId: selectedExecutorTask.task.task_id,
            executionHash: activationCondition.required_execution_hash,
          }); }}
        >
          {activationCondition.next_action === 'dry_run' ? 'Dry run' : 'Enable task'}
        </button>
      )}
    >
      Deployment changed the execution hash to{' '}
      <code>{activationCondition.required_execution_hash.slice(0, 12)}</code>. Run the dry run for
      these exact bytes, then enable them explicitly. This alert is deduplicated by task and hash.
    </DetailPaneNotice>
  ) : executorHealth?.status === 'operational_failure' ? (
    <DetailPaneNotice severity="warning" density="compact" title="Executor operational failure">
      {EXECUTOR_HEALTH_LABEL[executorHealth.condition]}. This is an executor-path problem, not a
      task activation transition.
    </DetailPaneNotice>
  ) : (
    <DetailPaneNotice severity="info" density="compact" title="Execution testimony">
      Reported by executor: those rows remain executor testimony. Mandible reminder rows are first-party
      ledger records; neither row type implies external execution.
    </DetailPaneNotice>
  );

  return (
    <div className={`tasks-layout${sidebarHidden ? ' tasks-layout--sidebar-hidden' : ''}`}>
      <ViewSidebar
        {...VIEW_SIDEBAR_GEOMETRY.tasks}
        className="tasks-sidebar"
        ariaLabel="Tasks"
        hidden={sidebarHidden}
        header={
          <SidebarSearchFilterHeader
            value={search}
            onValueChange={setSearch}
            placeholder="Search tasks..."
            searchAriaLabel="Search tasks"
            clearAriaLabel="Clear task search"
            filterTrigger={{
              ariaLabel: 'Task filters',
              title: 'Task filters',
              open: filterMenuOpen,
              active: activeFilterCount > 0,
              count: activeFilterCount,
              onToggle: () => setFilterMenuOpen((open) => !open),
            }}
            panel={filterMenuOpen ? {
              id: 'tasks-filter-panel',
              ariaLabel: 'Task filter controls',
              onDismiss: () => setFilterMenuOpen(false),
              children: (
                <>
                  <div className="sidebar-search-filter__section sidebar-search-filter__section--header">
                    <span>Filters</span>
                    <button
                      type="button"
                      className="sidebar-search-filter__clear-action"
                      onClick={() => {
                        setSourceFilter('all');
                        setFreshnessFilter('all');
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="sidebar-search-filter__section">
                    <span className="sidebar-search-filter__label">Source</span>
                    <div
                      className="sidebar-search-filter__options sidebar-search-filter__options--segmented"
                      role="group"
                      aria-label="Task source"
                    >
                      {(['all', 'executor', 'mandible'] as const).map((source) => (
                        <button
                          key={source}
                          type="button"
                          aria-pressed={sourceFilter === source}
                          className={`sidebar-search-filter__option${sourceFilter === source ? ' sidebar-search-filter__option--active' : ''}`}
                          onClick={() => setSourceFilter(source)}
                        >
                          {source === 'mandible' ? 'Reminders' : source}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="sidebar-search-filter__section">
                    <span className="sidebar-search-filter__label">Executor freshness</span>
                    <div
                      className="sidebar-search-filter__options sidebar-search-filter__options--segmented"
                      role="group"
                      aria-label="Executor freshness"
                    >
                      {(['all', 'current', 'stale', 'unknown'] as const).map((freshness) => (
                        <button
                          key={freshness}
                          type="button"
                          aria-pressed={freshnessFilter === freshness}
                          className={`sidebar-search-filter__option${freshnessFilter === freshness ? ' sidebar-search-filter__option--active' : ''}`}
                          onClick={() => setFreshnessFilter(freshness)}
                        >
                          {freshness}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ),
            } : undefined}
          />
        }
        bodyClassName="tasks-sidebar__list"
      >
        {loading && !inventory ? (
          <div className="tasks-sidebar__empty">Loading…</div>
        ) : error && !inventory ? (
          <div className="tasks-sidebar__empty">Could not load the inventory.</div>
        ) : neverRegistered ? (
          <div className="tasks-sidebar__empty">No executor has registered an inventory.</div>
        ) : registeredButEmpty ? (
          <div className="tasks-sidebar__empty">The executor reported no tasks.</div>
        ) : filteredTasks.length === 0 ? (
          <div className="tasks-sidebar__empty">No tasks match your search and filters.</div>
        ) : (
          filteredTasks.map((item) => (
            <SidebarItemRow
              key={item.key}
              className="tasks-row"
              label={item.source_kind === 'executor'
                ? item.task.display_name
                : item.reminder.revision.payload.message}
              selectionLabel={`Select ${item.source_kind === 'executor'
                ? item.task.display_name
                : item.reminder.revision.payload.message}`}
              selectionDescription={freshnessTitle(item)}
              selected={selected?.key === item.key}
              ariaCurrent={selected?.key === item.key ? 'true' : undefined}
              onSelect={() => {
                setSelectedKey(item.key);
                if (parseRouteFromHash(window.location.hash).tab === 'tasks') {
                  replaceRouteHash(routeHashWithParams(window.location.hash, 'tasks', { task: item.key }));
                }
              }}
              badges={item.source_kind === 'mandible' ? (
                <>
                  <SidebarItemBadge title={item.reminder.project_key}>
                    {item.reminder.project_key}
                  </SidebarItemBadge>
                  <SidebarItemBadge>{item.reminder.lifecycle}</SidebarItemBadge>
                </>
              ) : item.activation_condition ? (
                <SidebarItemBadge title="Important activation recovery required">
                  important
                </SidebarItemBadge>
              ) : activationHealth(item.task.activation) ? (
                <SidebarItemBadge>
                  {ACTIVATION_STATE_LABEL[activationHealth(item.task.activation)!.state]}
                </SidebarItemBadge>
              ) : undefined}
            />
          ))
        )}
      </ViewSidebar>

      <DetailPaneShell
        className="tasks-detail"
        bodyClassName="tasks-detail__scroll"
        header={selected ? (
          selected.source_kind === 'executor' ? (
            <DetailPaneHeader
              variant="standard"
              identity={{
                entityLabel: selected.executor,
                displayRef: selected.task.task_id,
                canonicalRef: selected.key,
                copyLabel: 'Copy task reference',
              }}
              title={selected.task.display_name}
              status={(
                <span className={`tasks-freshness tasks-freshness--${selected.freshness}`}>
                  {FRESHNESS_LABEL[selected.freshness]}
                </span>
              )}
              secondaryMetadata={`Executor ${selected.executor} · ${freshnessTitle(selected)}`}
              actionsLabel="Task actions"
              actions={(
                <ExecutorTaskHeaderActions
                  item={selected}
                  executor={selectedExecutor}
                  commands={selectedCommands}
                  commandAvailable={commandAvailable}
                  disableBusy={disableBusy}
                  v2Busy={v2Busy}
                  onRequestDisable={() => { void requestDisable(); }}
                  onDryRun={() => { void requestV2('dry_run'); }}
                  onEnable={() => { void requestV2('enable'); }}
                />
              )}
            />
          ) : (
            <DetailPaneHeader
              variant="standard"
              identity={{
                entityLabel: selected.reminder.project_key,
                displayRef: selected.reminder.id.slice(0, 7),
                canonicalRef: selected.reminder.id,
                copyLabel: 'Copy reminder reference',
              }}
              title={selected.reminder.revision.payload.message}
              status={<span>{selected.reminder.lifecycle}</span>}
              secondaryMetadata={`Mandible reminder · ${selected.reminder.project_key}`}
            />
          )
        ) : (
          <DetailPaneHeader variant="compact" title="Tasks" />
        )}
        notice={<>
          {error && <DetailPaneNotice severity="error" density="compact" title="Could not load task inventory">{error}</DetailPaneNotice>}
          {detailNotice}
        </>}
        overlays={activeIntent ? (
          <TaskCommandModal
            intent={activeIntent}
            busy={v2Busy}
            error={commandError}
            onClose={() => setActiveIntent(null)}
            onCancel={(commandId) => { void cancelIntent(commandId); }}
            onDryRun={() => { void requestV2('dry_run', activeIntent); }}
            onEnable={() => { void requestV2('enable', activeIntent); }}
          />
        ) : null}
      >
        {error && !inventory ? (
          <div className="tasks-detail__empty">
            <span className="text-muted">Task inventory unavailable.</span>
          </div>
        ) : loading && !inventory ? (
          <div className="tasks-detail__empty">
            <span className="text-muted">Loading tasks…</span>
          </div>
        ) : explicitSelection && !selected ? (
          <div className="tasks-detail__empty" role="status">Task not found: {selectedKey}</div>
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
          selected.source_kind === 'executor' ? (
            <ExecutorTaskDetail
              item={selected}
              executor={selectedExecutor}
              commands={selectedCommands}
              commandAvailable={commandAvailable}
              disableBusy={disableBusy}
              commandError={commandError}
              onCancelDisable={(commandId) => { void cancelDisable(commandId); }}
            />
          ) : (
            <MandibleReminderDetail item={selected} />
          )
        )}
      </DetailPaneShell>
    </div>
  );
}
