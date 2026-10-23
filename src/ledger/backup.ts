import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { getMandibleHomePath, getUserHome } from "../platform-paths.js";
import { ISSUE_SEARCH_SCHEMA_SQL } from "./issue-search.js";

const LEDGER_BACKUP_TABLES = [
  "ledger_projects",
  "ledger_project_checkouts",
  "ledger_issues",
  "ledger_issue_aliases",
  "issue_branches",
  "ledger_comments",
  "ledger_issue_checkpoints",
  "ledger_body_revisions",
  "ledger_labels",
  "ledger_issue_relationships",
  "ledger_issue_relationship_sources",
  "ledger_relationship_edges",
  "ledger_events",
  "ledger_change_feed_state",
  "ledger_change_log",
  "ledger_reconciliation_reports",
  "ledger_reconciliation_mismatches",
  "ledger_work_unit_issue_links",
  "ledger_session_issue_links",
  "ledger_auth_issue_links",
  "ledger_commit_issue_links",
  "ledger_operational_link_reports",
  "ledger_operational_link_mismatches",
] as const;

export const METADATA_BACKUP_TABLES = [
  "meta",
  "settings",
  "auth_requests",
  "auth_request_actions",
  "sessions",
  "console_sessions",
  "console_session_usage",
  "console_session_telemetry",
  "conversations",
  "conversation_identity_aliases",
  // Durable source identity and restore metadata (migration 140). These rows
  // are the compact map from a conversation to provider or managed-custody
  // bytes, including stable block aliases and the exact parser epoch needed to
  // reconstitute bodies. Parent-before-child ordering is required for restore.
  "conversation_sources",
  "conversation_source_aliases",
  "conversation_source_versions",
  "conversation_normalization_checkpoints",
  "conversation_structural_blocks",
  "conversation_block_aliases",
  // Operator intent and Mandible-owned delivery custody for live
  // conversations: archive and runtime choices, the immutable control journal,
  // every message Mandible queued for a provider, spawn receipts, and usage
  // observations. None of it is in a provider transcript. Control state keeps
  // the generation counters that outbox and usage rows are keyed by.
  "conversation_archive_states",
  "conversation_runtime_settings",
  "conversation_control_state",
  "conversation_control_journal",
  "conversation_control_outbox",
  "conversation_delivery_settings",
  "conversation_provider_usage",
  "conversation_spawn_requests",
  "conversation_spawn_events",
  "chat_attachment_files",
  "workflow_runs",
  "workflow_phases",
  "workflow_workers",
  "issue_resolutions",
  "work_units",
  // Codex thread archival is attempted once per resolved unit; the archived
  // mark is what keeps a restored install from archiving threads again.
  "worker_thread_archives",
  "webhook_events",
  "auth_hooks",
  // Issue 27241e6 — durable post-merge convergence state. Not reproducible:
  // the execution rows are the only record of which hook command actually ran
  // for a merge and how many attempts it took, and the alerts are open operator
  // notices. Listed after `auth_hooks` and `auth_requests` so their logical
  // parents restore first.
  "auth_hook_executions",
  "auth_hook_alerts",
  "message_params",
  "providers",
  "artifact_blob",
  "artifact",
  "artifact_version",
  "artifact_source",
  "artifact_source_move",
  "provider_manifests",
  "artifact_aliases",
  "artifact_links",
  "artifact_drafts",
  "project_artifact_associations",
  "knowledge_backrefs",
  // Spaces P1' core four (issue b395083 / umbrella de56ffa). Parent-before-child
  // order; the metadata backup emits inline UNIQUE/composite-FK constraints as
  // part of each table's own DDL, so uniqueness survives backup/restore.
  // space_exports is NOT here yet (later serial-chain child C13a).
  "spaces",
  "space_items",
  "space_occurrences",
  "space_edges",
  // Spaces document/canvas blocks (issue d2a8e77 / umbrella de56ffa). Child of
  // spaces + space_items (composite FKs), so it MUST follow both in this list;
  // the metadata backup emits inline UNIQUE/composite-FK + CHECK constraints as
  // part of the table's own DDL, so they survive backup/restore.
  "space_blocks",
  // Spaces document-custody tracking (issue 9041bb3 / umbrella de56ffa). The
  // MUTABLE tracking record keyed to the BACKED-UP `ledger_project_checkouts.id`
  // (in LEDGER_BACKUP_TABLES below) — NOT the excluded `work_repos.id` — so its
  // tracking identity survives restore. Child of `spaces`, so it follows here; the
  // metadata backup emits the inline UNIQUE(repo_id, branch, path) as part of the
  // table's own DDL, so duplicate (repo_id, branch, path) rows stay rejected after
  // a backup round-trip. Omitting it from this list would orphan tracked documents.
  "space_exports",
  "space_document_history",
  "space_publications",
  ...LEDGER_BACKUP_TABLES,
  // Reversible local cleanup custody. Project/checkout parents are emitted by
  // LEDGER_BACKUP_TABLES first; refs remain in Git while this preserves the
  // authoritative lifecycle and retention record.
  "trash_entries",
  // User registry core (issue e89c2b0 / umbrella 8e2e8b2). Canonical identity,
  // immutable credentials, claimed bindings, verified attribution evidence, and
  // delegated-signing leases — durable metadata, not reproducible runtime, so it
  // is backed up. Parent-before-child order: `users` first, then its credentials
  // and bindings, then leases (FK credential + user), then evidence (FK
  // credential + lease). The metadata backup emits each table's inline
  // UNIQUE/FK/CHECK as part of its own DDL, so slug uniqueness and the credential
  // status/kind CHECK constraints survive a backup round-trip.
  "users",
  // Durable per-user presentation intent (migrations 145-146). Rail ordering
  // and typography choices are canonical user-scoped settings, not a runtime
  // cache, and cannot be reconstructed after loss. Keep them immediately after
  // `users` so the referenced owner exists before these rows are restored; the
  // composite primary key preserves independent values for every user/key.
  "user_settings",
  "user_credentials",
  "user_bindings",
  "delegated_signing_leases",
  "attribution_evidence",
  // Scoped merge clearances are durable audit metadata. Runtime signer handles
  // are deliberately absent and therefore every restored grant fails closed.
  "auth_clearances",
  "auth_clearance_uses",
  // Reviewed-record audit chain for protected merges: the hashed lifecycle
  // revisions of every auth request, the protected-base audit and candidate
  // acceptance each approval was judged against, and the immutable work-unit
  // custody receipts that authorize request mutation.
  "auth_request_lifecycle_events",
  "auth_base_audits",
  "auth_candidate_acceptances",
  "work_unit_custody_events",
  // User groups, group membership, and permission grants (issue a0379a3 /
  // umbrella 8e2e8b2, migration 111). Canonical registry data describing who
  // belongs to which group and what each subject may do — deliberately enrolled,
  // not reproducible runtime state — so it is backed up, matching the `users`
  // block above. Parent-before-child order: `user_groups` first, then
  // `user_group_members` (FK to both `user_groups` and the `users` above), then
  // `permission_grants` (FK to `ledger_projects`, already emitted via
  // LEDGER_BACKUP_TABLES). The metadata backup emits each table's inline
  // UNIQUE/FK/CHECK as part of its own DDL, so slug uniqueness, the group-member
  // primary key, and the grant subject/resource/permission CHECK constraints
  // survive a backup round-trip.
  "user_groups",
  "user_group_members",
  "permission_grants",
  // One Briefing model (migrations 142-143). Logical identity precedes immutable
  // rounds, definitions precede round-specific instances, then run provenance,
  // append-only drafts, frozen actor submissions, and sealed migration audit.
  "briefings",
  "briefing_members",
  "briefing_rounds",
  "briefing_directive_definitions",
  "briefing_directive_instances",
  "briefing_runs",
  "briefing_run_occurrences",
  "briefing_response_events",
  "briefing_annotation_events",
  "briefing_submissions",
  "briefing_submission_answers",
  "briefing_submission_annotations",
  "briefing_legacy_audit",
  "briefing_legacy_custody",
  "briefing_creation_overrides",
  // Loose named collections of otherwise independent Briefings. Bundle rows
  // precede their manually ordered membership rows for FK-safe restoration.
  "briefing_bundles",
  "briefing_bundle_members",
  "briefing_groups",
  "briefing_group_updates",
  "briefing_group_dispositions",
  // Destination ownership is a ledger fact; route declarations remain
  // code-owned but are retained with their immutable templates and run
  // provenance so review receipts restore with every referenced parent.
  "briefing_destination_owners",
  "briefing_destination_routes",
  "briefing_destination_policies",
  "briefing_destination_templates",
  "briefing_destination_mutations",
  "briefing_composition_runs",
  "briefing_composition_inputs",
  "briefing_composition_contributions",
  "briefing_composition_targets",
  "briefing_composition_report_publications",
  "briefing_group_review_dispositions",
  "briefing_group_review_disposition_items",
  "briefing_group_review_destination_items",
  "briefing_collection_sharing_receipts",
  // Human-triggered issue/incident dispatch audit.
  "agent_dispatch_events",
  // Executor task inventory receipts (issue 0bc2279, migration 124). Each row
  // is an immutable observation an executor made at a moment that has passed;
  // nothing in Mandible can re-derive it, and the Tasks view is a projection of
  // the newest one, so losing the receipts loses the view. References `users`
  // (the posting principal), already emitted above.
  "task_inventory_generations",
  // Disable command protocol (issue 548bd73, migration 128). Operator requests
  // and executor receipts are immutable authority/audit facts, not
  // reproducible runtime state. Keep requests before their event children.
  "task_command_requests",
  "task_command_events",
  // Task activation (executor observations, the conditions raised from them,
  // and their immutable resolution events) is executor testimony about moments
  // that have passed, like the inventory receipts above.
  "task_activation_observations",
  "task_activation_conditions",
  "task_activation_condition_events",
  // Durable successful-merge facts (migration 129). These are retained
  // predicate evidence and cannot be reconstructed after auth-request pruning.
  // The ledger_projects parent is emitted above; keep these facts before the
  // managed reminders whose predicates may depend on them.
  "auth_request_merge_succeeded_facts",
  // Managed reminders (issue e257e5c, migration 130). Stable tasks own one
  // immutable revision; idempotency receipts, bounded inbox occurrences, and
  // audit events are all durable and non-reproducible. Keep parents first.
  "managed_tasks",
  "managed_task_revisions",
  "managed_task_create_requests",
  "managed_task_occurrences",
  "managed_task_events",
  // Operational incidents (issue 5308097, migration 136). The episode carries
  // operator intent — acknowledgement, closure, remediation state — which
  // exists nowhere else and cannot be re-derived: a later executor generation
  // reports observation, never whether a person had already seen it. The
  // observation events are immutable executor testimony about moments that
  // have passed, and the workflow events are the audit chain behind
  // Prepare-fix. Keep the episode before its event children.
  "operational_incidents",
  "operational_incident_observation_events",
  "operational_incident_workflow_events",
] as const;

// Older installs may retain patch history after self-modification is removed.
// Include that inert table only when it exists; new databases never create it.
const HISTORICAL_METADATA_BACKUP_TABLE = "runtime_patches";

function metadataBackupTables(db: Db): readonly string[] {
  const historical = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(HISTORICAL_METADATA_BACKUP_TABLE);
  return historical
    ? [...METADATA_BACKUP_TABLES, HISTORICAL_METADATA_BACKUP_TABLE]
    : METADATA_BACKUP_TABLES;
}

export const REPRODUCIBLE_OR_RUNTIME_TABLES = [
  // Local live-capability identity and exclusive daemon claims. Restoring this
  // table would make a copied database appear able to reconnect to authority
  // from another installation, so it is deliberately never backed up.
  "delegated_signing_runtime_bindings",
  // High-volume bounded operational telemetry is regenerated by normal daemon
  // activity. Keep it out of durable metadata backups so a dump never scans or
  // materializes a potentially multi-gigabyte log table.
  "daemon_log",
  "branches",
  "work_repos",
  "push_history",
  "conversation_blocks",
  "conversation_ingest_state",
  "workflow_ingest_state",
  "graph_entities",
  "graph_edges",
  // Full-text index over ledger issues and comments. The dump ends with
  // ISSUE_SEARCH_SCHEMA_SQL, which recreates it and rebuilds it from the
  // restored rows; its triggers keep it current from then on.
  "issue_search",
  "issue_search_config",
  "issue_search_content",
  "issue_search_data",
  "issue_search_docsize",
  "issue_search_idx",
] as const;

export type MetadataBackupResult = {
  path: string;
  size_bytes: number;
  table_count: number;
};

type SqliteMasterTable = {
  name: string;
  sql: string | null;
};

type TableColumn = {
  name: string;
};

/**
 * Backups are durable state, so they belong under the durable root rather than
 * the disposable cache root (issue 24f0316). The write side only ever targets
 * this path (or an explicit configured destination); the read side stays aware
 * of the old location — see `findExistingMetadataBackupPaths`.
 */
export function getDefaultMetadataBackupPath(): string {
  return getMandibleHomePath("backups", "mandible-metadata.sql");
}

/**
 * Where backups were written before the durable/cache split. Existing backups
 * are deliberately left where they are: the directory holds gigabytes, and
 * silently relocating it at startup would be a large unrequested copy. This
 * exists so status output can report them instead of implying they vanished.
 */
export function getLegacyMetadataBackupPath(): string {
  return path.join(getUserHome(), ".cache", "mandible", "backups", "mandible-metadata.sql");
}

/**
 * Every location a previously written metadata backup may still be sitting at,
 * newest layout first. Report-only: nothing here moves or deletes a file.
 */
export function findExistingMetadataBackupPaths(): string[] {
  const candidates = [getDefaultMetadataBackupPath(), getLegacyMetadataBackupPath()];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return fs.existsSync(resolved);
  });
}

export function resolveMetadataBackupPath(destination?: string | null): string {
  const trimmed = destination?.trim();
  return path.resolve(trimmed || getDefaultMetadataBackupPath());
}

export function listUserTables(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function getUnclassifiedBackupTables(db: Db): string[] {
  const classified = new Set<string>([
    ...METADATA_BACKUP_TABLES,
    HISTORICAL_METADATA_BACKUP_TABLE,
    ...REPRODUCIBLE_OR_RUNTIME_TABLES,
  ]);
  return listUserTables(db).filter((table) => !classified.has(table));
}

export function writeMetadataBackup(db: Db, destination?: string | null): MetadataBackupResult {
  const outputPath = resolveMetadataBackupPath(destination);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const result = writeMetadataBackupFile(db, temporaryPath);
    fs.renameSync(temporaryPath, outputPath);
    return { ...result, path: outputPath };
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* preserve the original failure */ }
    throw error;
  }
}

/** Write and flush one unpublished file; its owner controls final publication. */
export function writeMetadataBackupFile(db: Db, outputPath: string): MetadataBackupResult {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const file = fs.openSync(outputPath, "wx", 0o600);
  try {
    db.transaction(() => {
      let buffer = "";
      let first = true;
      for (const line of metadataBackupLines(db)) {
        buffer += `${first ? "" : "\n"}${line}`;
        first = false;
        if (buffer.length >= 256 * 1024) {
          writeAll(file, buffer);
          buffer = "";
        }
      }
      if (buffer) writeAll(file, buffer);
    }).deferred();
    fs.fsyncSync(file);
    fs.closeSync(file);
  } catch (error) {
    try { fs.closeSync(file); } catch { /* already closed */ }
    try { fs.unlinkSync(outputPath); } catch { /* preserve the original failure */ }
    throw error;
  }
  const stat = fs.statSync(outputPath);
  return {
    path: outputPath,
    size_bytes: stat.size,
    table_count: metadataBackupTables(db).length,
  };
}

function writeAll(file: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(file, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("Metadata backup write made no progress.");
    offset += written;
  }
}

export function buildMetadataBackupSql(db: Db): string {
  // Fixture and in-memory callers only. The scheduled writer streams the same
  // generator so production-sized backups never materialize one giant string.
  return Array.from(metadataBackupLines(db)).join("\n");
}

function* metadataBackupLines(db: Db): Generator<string> {
  const timestamp = new Date().toISOString();
  const tables = metadataBackupTables(db);
  yield* [
    "-- Mandible metadata backup",
    `-- Generated: ${timestamp}`,
    `-- Tables: ${tables.join(" ")}`,
    "-- Restore is intentionally deferred until the restore path has a tested round trip.",
    "",
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
    "",
  ];

  for (const table of tables) {
    const tableInfo = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as SqliteMasterTable | undefined;
    if (!tableInfo?.sql) {
      yield `-- Table missing in this database: ${table}`;
      yield "";
      continue;
    }

    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableColumn[];
    const columnNames = columns.map((column) => column.name);
    yield* [
      "-- ============================================",
      `-- Table: ${table}`,
      "-- ============================================",
      `${tableInfo.sql};`,
      `DELETE FROM ${quoteIdentifier(table)};`,
    ];

    if (columnNames.length > 0) {
      const quotedColumns = columnNames.map(quoteIdentifier).join(", ");
      for (const row of db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).iterate() as Iterable<Record<string, unknown>>) {
        const values = columnNames.map((column) => sqlLiteral(row[column])).join(", ");
        yield `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${values});`;
      }
    }

    // Secondary indexes. A table's CREATE statement only carries the implicit
    // indexes for inline PRIMARY KEY / UNIQUE constraints; explicitly named
    // CREATE INDEX statements (e.g. idx_artifact_links_kind /
    // idx_artifact_links_series from migration 89) are separate sqlite_master
    // rows that a column-driven dump would otherwise drop, so a restore into a
    // fresh DB would silently lose them (codex LOW). Emit each one here. The
    // migration DDL uses CREATE INDEX IF NOT EXISTS, so re-applying the dump over
    // an already-migrated DB stays idempotent. sql IS NULL for auto-created
    // constraint indexes, which the CREATE TABLE above already recreates.
    const indexes = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
         ORDER BY name`,
      )
      .all(table) as Array<{ sql: string | null }>;
    for (const index of indexes) {
      if (index.sql) {
        yield `${index.sql};`;
      }
    }
    yield "";
  }

  // Triggers carry the append-only and immutability guards. They are created
  // after every row so restoring the rows neither fires nor trips them.
  const backedUp = new Set(tables);
  const triggers = db
    .prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name")
    .all() as Array<{ tbl_name: string; sql: string }>;
  for (const trigger of triggers) {
    if (backedUp.has(trigger.tbl_name)) yield `${trigger.sql};`;
  }
  for (const statement of ISSUE_SEARCH_SCHEMA_SQL) yield `${statement};`;

  yield* ["", "COMMIT;", "PRAGMA foreign_keys=ON;", ""];
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return `X'${value.toString("hex")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}
