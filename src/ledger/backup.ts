import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db.js";

export const LEDGER_BACKUP_TABLES = [
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
  "ledger_outbox",
  "ledger_external_refs",
  "ledger_conflicts",
  "ledger_sync_jobs",
  "ledger_reconciliation_reports",
  "ledger_reconciliation_mismatches",
  "ledger_work_unit_issue_links",
  "ledger_session_issue_links",
  "ledger_auth_issue_links",
  "ledger_commit_issue_links",
  "ledger_operational_link_reports",
  "ledger_operational_link_mismatches",
] as const;

export type LedgerBackupTable = (typeof LEDGER_BACKUP_TABLES)[number];

export const METADATA_BACKUP_TABLES = [
  "meta",
  "settings",
  "auth_requests",
  "auth_request_actions",
  "sessions",
  "session_issues",
  "session_projects",
  "console_sessions",
  "console_session_usage",
  "conversations",
  "starred_chats",
  "issue_resolutions",
  "work_units",
  "webhook_events",
  "presets",
  "preset_nodes",
  "session_presets",
  "preset_diffs",
  "convention_setting_links",
  "auth_hooks",
  "runtime_patches",
  "message_params",
  "providers",
  "artifacts",
  "provider_manifests",
  "artifact_aliases",
  "artifact_links",
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
  ...LEDGER_BACKUP_TABLES,
] as const;

export type MetadataBackupTable = (typeof METADATA_BACKUP_TABLES)[number];

export const REPRODUCIBLE_OR_RUNTIME_TABLES = [
  "branches",
  "work_repos",
  "push_history",
  "conversation_blocks",
  "graph_entities",
  "graph_edges",
] as const;

export type ReproducibleOrRuntimeTable = (typeof REPRODUCIBLE_OR_RUNTIME_TABLES)[number];

export const EXCLUDED_METADATA_BACKUP_TABLES = REPRODUCIBLE_OR_RUNTIME_TABLES;

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

export function getDefaultMetadataBackupPath(): string {
  return path.join(os.homedir(), ".cache", "mandible", "backups", "mandible-metadata.sql");
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
    ...REPRODUCIBLE_OR_RUNTIME_TABLES,
  ]);
  return listUserTables(db).filter((table) => !classified.has(table));
}

export function writeMetadataBackup(db: Db, destination?: string | null): MetadataBackupResult {
  const outputPath = resolveMetadataBackupPath(destination);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const sql = buildMetadataBackupSql(db);
  fs.writeFileSync(outputPath, sql, "utf8");
  const stat = fs.statSync(outputPath);
  return {
    path: outputPath,
    size_bytes: stat.size,
    table_count: METADATA_BACKUP_TABLES.length,
  };
}

export function buildMetadataBackupSql(db: Db): string {
  const timestamp = new Date().toISOString();
  const lines = [
    "-- Mandible metadata backup",
    `-- Generated: ${timestamp}`,
    `-- Tables: ${METADATA_BACKUP_TABLES.join(" ")}`,
    "-- Restore is intentionally deferred until the restore path has a tested round trip.",
    "",
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
    "",
  ];

  for (const table of METADATA_BACKUP_TABLES) {
    const tableInfo = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as SqliteMasterTable | undefined;
    if (!tableInfo?.sql) {
      lines.push(`-- Table missing in this database: ${table}`, "");
      continue;
    }

    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableColumn[];
    const columnNames = columns.map((column) => column.name);
    const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Array<
      Record<string, unknown>
    >;

    lines.push(
      "-- ============================================",
      `-- Table: ${table}`,
      "-- ============================================",
      `${tableInfo.sql};`,
      `DELETE FROM ${quoteIdentifier(table)};`,
    );

    if (rows.length > 0 && columnNames.length > 0) {
      const quotedColumns = columnNames.map(quoteIdentifier).join(", ");
      for (const row of rows) {
        const values = columnNames.map((column) => sqlLiteral(row[column])).join(", ");
        lines.push(`INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${values});`);
      }
    }
    lines.push("");
  }

  lines.push("COMMIT;", "PRAGMA foreign_keys=ON;", "");
  return lines.join("\n");
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
