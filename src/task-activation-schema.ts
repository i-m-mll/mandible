/**
 * Durable activation-health observations and notification episodes (v166).
 *
 * Both tables are event records. Current state is projected from their order;
 * recovery never rewrites or deletes the deployment transition that raised an
 * important notification.
 */
export const TASK_ACTIVATION_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE task_activation_observations (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL CHECK(
      length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    generation_id TEXT NOT NULL,
    executor_name TEXT NOT NULL CHECK(trim(executor_name) != ''),
    task_id TEXT NOT NULL CHECK(trim(task_id) != ''),
    state TEXT NOT NULL CHECK(state IN (
      'never_activated','activated','operator_disabled','deployment_invalidated'
    )),
    reason TEXT NOT NULL CHECK(reason IN (
      'never_activated','operator_enabled','operator_disabled','execution_hash_changed'
    )),
    observed_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL CHECK(
      json_valid(payload_json) AND json_type(payload_json) = 'object'
    ),
    recorded_at INTEGER NOT NULL,
    UNIQUE(executor_name, task_id, fingerprint)
  )`,
  `CREATE INDEX idx_task_activation_observations_task
    ON task_activation_observations(executor_name, task_id, observed_at DESC, recorded_at DESC)`,
  `CREATE TRIGGER task_activation_observations_immutable_update
    BEFORE UPDATE ON task_activation_observations BEGIN
      SELECT RAISE(ABORT, 'task activation observations are immutable');
    END`,
  `CREATE TRIGGER task_activation_observations_immutable_delete
    BEFORE DELETE ON task_activation_observations BEGIN
      SELECT RAISE(ABORT, 'task activation observations are immutable');
    END`,
  `CREATE TABLE task_activation_conditions (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL CHECK(trim(dedupe_key) != ''),
    source_observation_id TEXT NOT NULL UNIQUE
      REFERENCES task_activation_observations(id) ON DELETE RESTRICT,
    executor_name TEXT NOT NULL CHECK(trim(executor_name) != ''),
    task_id TEXT NOT NULL CHECK(trim(task_id) != ''),
    required_execution_hash TEXT NOT NULL CHECK(
      length(required_execution_hash) = 64
      AND required_execution_hash NOT GLOB '*[^0-9a-f]*'
    ),
    raised_at INTEGER NOT NULL,
    UNIQUE(dedupe_key, source_observation_id)
  )`,
  `CREATE INDEX idx_task_activation_conditions_target
    ON task_activation_conditions(executor_name, task_id, raised_at DESC)`,
  `CREATE TRIGGER task_activation_conditions_immutable_update
    BEFORE UPDATE ON task_activation_conditions BEGIN
      SELECT RAISE(ABORT, 'task activation conditions are immutable');
    END`,
  `CREATE TRIGGER task_activation_conditions_immutable_delete
    BEFORE DELETE ON task_activation_conditions BEGIN
      SELECT RAISE(ABORT, 'task activation conditions are immutable');
    END`,
  `CREATE TABLE task_activation_condition_events (
    id TEXT PRIMARY KEY,
    condition_id TEXT NOT NULL REFERENCES task_activation_conditions(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN ('raised','dry_run_ready','resolved','superseded')),
    observation_id TEXT REFERENCES task_activation_observations(id) ON DELETE RESTRICT,
    command_id TEXT REFERENCES task_command_requests(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    UNIQUE(condition_id, kind),
    CHECK(kind = 'raised' OR observation_id IS NOT NULL),
    CHECK(kind != 'resolved' OR command_id IS NOT NULL)
  )`,
  `CREATE INDEX idx_task_activation_condition_events_condition
    ON task_activation_condition_events(condition_id, created_at, id)`,
  `CREATE TRIGGER task_activation_condition_events_immutable_update
    BEFORE UPDATE ON task_activation_condition_events BEGIN
      SELECT RAISE(ABORT, 'task activation condition events are immutable');
    END`,
  `CREATE TRIGGER task_activation_condition_events_immutable_delete
    BEFORE DELETE ON task_activation_condition_events BEGIN
      SELECT RAISE(ABORT, 'task activation condition events are immutable');
    END`,
];
