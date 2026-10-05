#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import SqliteDatabase from "../src/sqlite.ts";

const require = createRequire(import.meta.url);
const {
  PRODUCTION_DB_PATHS,
  canonicalizePath: canonicalFuturePath,
  resolvesToAnyProductionDbPath,
} = require("../cli/production-db-guard.cjs");

export const REPORT_VERSION = 2;
export const TOOL_VERSION = `conversation-cutover-proof/${REPORT_VERSION}`;
export const COVERAGE_CLASSES = Object.freeze([
  "verified-live-source",
  "verified-managed-custody",
  "legacy-body-only",
]);

const DEFAULT_DISPOSABLE_TABLE_PATTERNS = Object.freeze([
  /^conversation_(?:body_)?cache(?:_|$)/,
  /^conversation_search(?:_|$)/,
  /^conversation_fts(?:_|$)/,
  /^conversation_trigram(?:_|$)/,
  /^conversation_parser_checkpoint_cache(?:_|$)/,
]);

const DENSE_CONVERSATION_INDEX_TABLES = Object.freeze([
  "conversation_blocks",
  "conversation_structural_blocks",
  "conversation_block_aliases",
  "conversation_normalization_checkpoints",
]);
const SPARSE_BLOCK_TYPES = Object.freeze([
  "user_message", "assistant_message", "thinking", "plan", "tool_use",
  "tool_result", "system", "event",
]);
const SPARSE_ROLES = Object.freeze(["user", "assistant", "system", "tool"]);
const SPARSE_STRUCTURE_CACHE_VERSION = 3;

function sparseToolKey(toolId) {
  return createHash("sha256").update(toolId).digest().subarray(0, 16);
}

function sparseToolId(providerKey) {
  return String(providerKey).match(/^tool:(.*):tool_use:\d+:record:/)?.[1] ?? null;
}

class SimulatedInterruption extends Error {
  constructor(message = "simulated rebuild interruption") {
    super(message);
    this.name = "SimulatedInterruption";
  }
}

function canonicalPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function sameFile(left, right) {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlReferencesIdentifier(sql, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:[\"\`]${escaped}[\"\`]|\\b${escaped}\\b)`, "i").test(sql);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  if (Buffer.isBuffer(value)) return JSON.stringify({ $blob: value.toString("base64") });
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(target) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fd = fs.openSync(target, "r");
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
    }
    return digest.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function dbFileSnapshot(dbPath) {
  const snapshot = {};
  // The database and WAL contain durable SQLite bytes. The shared-memory file
  // is only a transient lock/index cache: attaching the source read-only can
  // legitimately create or rewrite it even when no database content changed.
  for (const suffix of ["", "-wal"]) {
    const target = `${dbPath}${suffix}`;
    if (!fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    // SQLite may create an empty WAL as a connection artifact. It contains no
    // durable database bytes, so absent and zero-length are equivalent here.
    if (suffix === "-wal" && stat.size === 0) continue;
    snapshot[suffix || "db"] = { size_bytes: stat.size, sha256: hashFile(target) };
  }
  return snapshot;
}

function fsyncFile(target) {
  const fd = fs.openSync(target, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeDbFamily(target) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${target}${suffix}`, { force: true });
}

function visibleColumns(db, schema, table) {
  return db.pragma(`${schema}.table_xinfo(${quoteIdentifier(table)})`)
    .filter((column) => Number(column.hidden ?? 0) === 0);
}

function orderClause(columns) {
  const primary = columns.filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk));
  if (primary.length === 0) return " ORDER BY rowid";
  return ` ORDER BY ${primary.map((column) => quoteIdentifier(column.name)).join(", ")}`;
}

function userSchema(db, schema = "main") {
  const rows = db.prepare(
    `SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`,
  ).all();
  return {
    tables: rows.filter((row) => row.type === "table"),
    indexes: rows.filter((row) => row.type === "index"),
    views: rows.filter((row) => row.type === "view"),
    triggers: rows.filter((row) => row.type === "trigger"),
  };
}

function normalizedRowIterator(db, schema, table) {
  const columns = visibleColumns(db, schema, table);
  const selected = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  return db.prepare(
    `SELECT ${selected} FROM ${schema}.${quoteIdentifier(table)}${orderClause(columns)}`,
  ).iterate();
}

function tableDigest(db, schema, table) {
  const digest = createHash("sha256");
  let rows = 0;
  digest.update("[");
  for (const row of normalizedRowIterator(db, schema, table)) {
    if (rows > 0) digest.update(",");
    digest.update(stableJson(row));
    rows += 1;
  }
  digest.update("]");
  return { rows, sha256: digest.digest("hex") };
}

function sourceDatabaseBinding(db, sourcePath, schema = "main") {
  const sourceSchema = userSchema(db, schema);
  const schemaObjects = [...sourceSchema.tables, ...sourceSchema.indexes, ...sourceSchema.views, ...sourceSchema.triggers]
    .map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql }));
  const tables = Object.fromEntries(sourceSchema.tables.map((table) => [table.name, tableDigest(db, schema, table.name)]));
  const stat = fs.statSync(sourcePath);
  return {
    tool_version: TOOL_VERSION,
    schema_head: {
      user_version: Number(db.pragma(`${schema}.user_version`, { simple: true }) ?? 0),
      sha256: sha256(stableJson(schemaObjects)),
    },
    source_database: {
      path: canonicalPath(sourcePath),
      identity: { device: Number(stat.dev), inode: Number(stat.ino) },
      digest: sha256(stableJson(tables)),
    },
  };
}

function bindingMatches(actual, expected) {
  return Boolean(actual) && stableJson(actual) === stableJson(expected);
}

export function inspectSourceBinding(source) {
  const sourcePath = path.resolve(source);
  const db = new SqliteDatabase(sourcePath, { readonly: true, fileMustExist: true });
  try {
    return sourceDatabaseBinding(db, sourcePath);
  } finally {
    db.close();
  }
}

function normalizedForeignKeys(db, schema) {
  return db.pragma(`${schema}.foreign_key_check`).map((row) => ({
    table: String(row.table),
    rowid: row.rowid === null ? null : Number(row.rowid),
    parent: String(row.parent),
    fkid: Number(row.fkid),
  })).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

function foreignKeyViolationCount(rows) {
  return rows.length;
}

function projectedTableDigest(db, schema, table, options = {}) {
  const columns = visibleColumns(db, schema, table);
  const selected = columns.map((column) => {
    const expression = options.columns?.[column.name];
    return expression === undefined
      ? quoteIdentifier(column.name)
      : `${expression} AS ${quoteIdentifier(column.name)}`;
  }).join(", ");
  const rows = db.prepare(
    `SELECT ${selected} FROM ${schema}.${quoteIdentifier(table)}`
      + `${options.where ? ` WHERE ${options.where}` : ""}${orderClause(columns)}`,
  ).iterate();
  const digest = createHash("sha256");
  let count = 0;
  digest.update("[");
  for (const row of rows) {
    if (count > 0) digest.update(",");
    digest.update(stableJson(row));
    count += 1;
  }
  digest.update("]");
  return { rows: count, sha256: digest.digest("hex") };
}

function isDisposableTable(name, explicit) {
  return explicit.has(name) || DEFAULT_DISPOSABLE_TABLE_PATTERNS.some((pattern) => pattern.test(name));
}

function usableRowidAlias(table, columns) {
  if (/\bWITHOUT\s+ROWID\b/i.test(table.sql)) return null;
  const names = new Set(columns.map((column) => column.name.toLowerCase()));
  return ["rowid", "_rowid_", "oid"].find((alias) => !names.has(alias)) ?? null;
}

function assertSafeDestination(sourcePath, destinationPath) {
  if (canonicalPath(sourcePath) === canonicalFuturePath(destinationPath) || sameFile(sourcePath, destinationPath)) {
    throw new Error("Rebuild destination must be distinct from the source database");
  }
  const futureDestination = canonicalFuturePath(destinationPath);
  const productionMatch = resolvesToAnyProductionDbPath(destinationPath, PRODUCTION_DB_PATHS)
    ?? PRODUCTION_DB_PATHS.find((candidate) => canonicalFuturePath(candidate) === futureDestination);
  if (productionMatch) {
    throw new Error(`Refusing production database alias as rebuild destination: ${canonicalPath(productionMatch)}`);
  }
}

/**
 * Build a fresh, compact SQLite destination without mutating the source. The
 * in-progress marker deliberately survives process interruption; the next run
 * removes only the named partial file and starts from the source again.
 */
export function buildCompactDestination(options) {
  const sourcePath = path.resolve(options.source);
  const destinationPath = path.resolve(options.destination);
  const partialPath = `${destinationPath}.partial`;
  const markerPath = `${destinationPath}.rebuild-in-progress.json`;
  const explicitExcluded = new Set(options.excludeTables ?? []);
  assertSafeDestination(sourcePath, destinationPath);
  if (!fs.existsSync(sourcePath)) throw new Error(`Source database does not exist: ${sourcePath}`);
  if (fs.existsSync(destinationPath)) throw new Error(`Destination already exists: ${destinationPath}`);

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  let recoveredPartial = false;
  if (fs.existsSync(markerPath)) {
    recoveredPartial = true;
    removeDbFamily(partialPath);
    fs.rmSync(markerPath, { force: true });
  } else if (fs.existsSync(partialPath)) {
    throw new Error(`Unowned partial destination exists without recovery marker: ${partialPath}`);
  }

  const sourceBefore = dbFileSnapshot(sourcePath);
  const marker = {
    version: REPORT_VERSION,
    source: sourcePath,
    destination: destinationPath,
    partial: partialPath,
  };
  fs.writeFileSync(markerPath, `${stableJson(marker)}\n`, { encoding: "utf8", flag: "wx" });
  fsyncFile(markerPath);

  let db;
  let committed = false;
  try {
    db = new SqliteDatabase(partialPath);
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = OFF");
    db.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
    const binding = sourceDatabaseBinding(db, sourcePath, "source");
    const sourceForeignKeys = normalizedForeignKeys(db, "source");
    db.exec("BEGIN DEFERRED");
    const schema = userSchema(db, "source");
    const copied = {};
    const emptied = new Set(options.emptyConversationIndex ? DENSE_CONVERSATION_INDEX_TABLES : []);
    const excluded = schema.tables.map((table) => table.name)
      .filter((name) => isDisposableTable(name, explicitExcluded));
    const retainedTables = schema.tables.filter((table) => !excluded.includes(table.name));

    for (const table of retainedTables) db.exec(table.sql);
    let copiedTables = 0;
    for (const table of retainedTables) {
      const columns = visibleColumns(db, "source", table.name);
      const rowidAlias = usableRowidAlias(table, columns);
      const names = [
        ...(rowidAlias ? [quoteIdentifier(rowidAlias)] : []),
        ...columns.map((column) => quoteIdentifier(column.name)),
      ].join(", ");
      const reclaimCheckpoints = options.reclaimConversationCheckpoints
        && table.name === "conversation_normalization_checkpoints";
      const reclaimStructuralReferences = options.reclaimConversationCheckpoints
        && table.name === "conversation_structural_blocks";
      const sourceProjection = [
        ...(rowidAlias ? [quoteIdentifier(rowidAlias)] : []),
        ...columns.map((column) => {
          if (reclaimStructuralReferences && column.name === "normalization_checkpoint_id") {
            return `CASE WHEN normalization_checkpoint_id IN (
              SELECT id FROM source.conversation_normalization_checkpoints
               WHERE state_json = '{"kind":"codex-model-metadata","version":1}'
            ) THEN normalization_checkpoint_id ELSE NULL END AS ${quoteIdentifier(column.name)}`;
          }
          return quoteIdentifier(column.name);
        }),
      ].join(", ");
      const checkpointWhere = reclaimCheckpoints
        ? ` WHERE state_json = '{"kind":"codex-model-metadata","version":1}'
              AND id IN (SELECT normalization_checkpoint_id
                           FROM source.conversation_structural_blocks
                          WHERE normalization_checkpoint_id IS NOT NULL)`
        : "";
      const sql = `INSERT INTO ${quoteIdentifier(table.name)} (${names}) SELECT ${sourceProjection} FROM source.${quoteIdentifier(table.name)}${checkpointWhere}${orderClause(columns)}`;
      copied[table.name] = emptied.has(table.name) ? 0 : db.prepare(sql).run().changes;
      copiedTables += 1;
      if (options.interruptAfterTables === copiedTables) throw new SimulatedInterruption();
    }

    const retainedNames = new Set(retainedTables.map((table) => table.name));
    for (const object of [...schema.indexes, ...schema.views, ...schema.triggers]) {
      if (object.type !== "view" && object.tbl_name && !retainedNames.has(object.tbl_name)) continue;
      if (object.type === "view" && excluded.some((name) => sqlReferencesIdentifier(object.sql, name))) continue;
      db.exec(object.sql);
    }
    db.exec("COMMIT");
    committed = true;

    const integrity = db.pragma("integrity_check", { simple: true });
    const foreignKeys = normalizedForeignKeys(db, "main");
    if (integrity !== "ok") throw new Error(`Compact destination integrity_check failed: ${integrity}`);
    if (stableJson(foreignKeys) !== stableJson(sourceForeignKeys)) {
      throw new Error("Compact destination foreign-key violations differ from source");
    }
    const parity = {};
    for (const table of retainedTables) {
      const transformedCheckpointTable = options.reclaimConversationCheckpoints
        && table.name === "conversation_normalization_checkpoints";
      const transformedStructuralTable = options.reclaimConversationCheckpoints
        && table.name === "conversation_structural_blocks";
      parity[table.name] = {
        source: emptied.has(table.name)
          ? projectedTableDigest(db, "source", table.name, { where: "0" })
          : transformedCheckpointTable
          ? projectedTableDigest(db, "source", table.name, {
            where: "state_json = '{\"kind\":\"codex-model-metadata\",\"version\":1}' AND id IN (SELECT normalization_checkpoint_id FROM source.conversation_structural_blocks WHERE normalization_checkpoint_id IS NOT NULL)",
          })
          : transformedStructuralTable
            ? projectedTableDigest(db, "source", table.name, {
              columns: {
                normalization_checkpoint_id: "CASE WHEN normalization_checkpoint_id IN (SELECT id FROM source.conversation_normalization_checkpoints WHERE state_json = '{\"kind\":\"codex-model-metadata\",\"version\":1}') THEN normalization_checkpoint_id ELSE NULL END",
              },
            })
          : tableDigest(db, "source", table.name),
        destination: tableDigest(db, "main", table.name),
      };
      parity[table.name].match = stableJson(parity[table.name].source) === stableJson(parity[table.name].destination);
      if (!parity[table.name].match) throw new Error(`Row parity failed for ${table.name}`);
    }
    const checkpointReclaim = options.reclaimConversationCheckpoints && !options.emptyConversationIndex ? {
      structural_source_rows: Number(db.prepare(
        "SELECT COUNT(*) AS count FROM source.conversation_structural_blocks",
      ).get().count),
      structural_destination_rows: Number(db.prepare(
        "SELECT COUNT(*) AS count FROM main.conversation_structural_blocks",
      ).get().count),
      destination_checkpoint_rows: Number(db.prepare(
        "SELECT COUNT(*) AS count FROM main.conversation_normalization_checkpoints",
      ).get().count),
      referenced_checkpoint_rows: Number(db.prepare(
        "SELECT COUNT(DISTINCT normalization_checkpoint_id) AS count FROM main.conversation_structural_blocks WHERE normalization_checkpoint_id IS NOT NULL",
      ).get().count),
    } : null;
    if (checkpointReclaim && (checkpointReclaim.structural_source_rows !== checkpointReclaim.structural_destination_rows
        || checkpointReclaim.destination_checkpoint_rows !== checkpointReclaim.referenced_checkpoint_rows)) {
      throw new Error("Conversation checkpoint reclaim validation failed");
    }
    db.prepare("DETACH DATABASE source").run();
    const sourceAfter = dbFileSnapshot(sourcePath);
    if (stableJson(sourceAfter) !== stableJson(sourceBefore)) {
      throw new Error("Source database or sidecars changed during compact rebuild");
    }
    db.close();
    db = undefined;
    fsyncFile(partialPath);
    fs.renameSync(partialPath, destinationPath);
    fs.rmSync(markerPath, { force: true });
    return {
      version: REPORT_VERSION,
      report_kind: "compact-rebuild-evidence",
      binding,
      source: { path: sourcePath, files: sourceBefore },
      destination: { path: destinationPath, size_bytes: fs.statSync(destinationPath).size },
      recovered_partial: recoveredPartial,
      integrity_check: "ok",
      foreign_key_violations: foreignKeys,
      foreign_key_parity: {
        source: foreignKeyViolationCount(sourceForeignKeys),
        destination: foreignKeyViolationCount(foreignKeys),
        match: true,
      },
      copied_rows: copied,
      excluded_tables: excluded.sort(),
      emptied_tables: [...emptied].sort(),
      reclaimed_dense_conversation_index: options.emptyConversationIndex === true,
      reclaimed_conversation_checkpoints: options.reclaimConversationCheckpoints === true,
      checkpoint_reclaim: checkpointReclaim,
      cache_exclusion: { pass: excluded.every((name) => !retainedNames.has(name)), excluded_tables: excluded.sort() },
      table_parity: parity,
      row_count_report: Object.fromEntries(Object.entries(parity).map(([name, value]) => [name, {
        source: value.source.rows,
        destination: value.destination.rows,
        match: value.source.rows === value.destination.rows,
      }])),
      annotation_relationship_report: Object.fromEntries(Object.entries(parity)
        .filter(([name]) => /annotation|relationship|(?:^|_)links?(?:_|$)|graph_edges/.test(name))
        .map(([name, value]) => [name, value])),
      pass: true,
    };
  } catch (error) {
    if (db) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch {}
      try { db.close(); } catch {}
    }
    if (!(error instanceof SimulatedInterruption)) {
      removeDbFamily(partialPath);
      fs.rmSync(markerPath, { force: true });
    }
    if (committed && error instanceof SimulatedInterruption) {
      throw new Error("invalid simulated interruption after commit");
    }
    throw error;
  }
}

/**
 * Build the complete disposable navigation cache directly from the old dense
 * projection. The source database stays read-only and the finished cache is
 * published by atomic rename only after count and integrity checks pass.
 */
export function buildSparseConversationStructureCache(options) {
  const sourcePath = path.resolve(options.source);
  const destinationPath = path.resolve(options.destination);
  const partialPath = `${destinationPath}.partial`;
  const markerPath = `${destinationPath}.rebuild-in-progress.json`;
  assertSafeDestination(sourcePath, destinationPath);
  if (!fs.existsSync(sourcePath)) throw new Error(`Source database does not exist: ${sourcePath}`);
  if (fs.existsSync(destinationPath)) throw new Error(`Structure cache already exists: ${destinationPath}`);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (fs.existsSync(markerPath)) {
    removeDbFamily(partialPath);
    fs.rmSync(markerPath, { force: true });
  } else if (fs.existsSync(partialPath)) {
    throw new Error(`Unowned structure-cache partial exists: ${partialPath}`);
  }

  const sourceBefore = dbFileSnapshot(sourcePath);
  fs.writeFileSync(markerPath, `${stableJson({
    version: REPORT_VERSION,
    source: sourcePath,
    destination: destinationPath,
    partial: partialPath,
  })}\n`, { encoding: "utf8", flag: "wx" });
  fsyncFile(markerPath);
  let db;
  try {
    db = new SqliteDatabase(partialPath);
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
    const now = Date.now();
    db.exec(`
      CREATE TABLE cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE cache_conversations (
        cache_id INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE,
        source_version_id TEXT NOT NULL,
        parser_format TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        redaction_epoch INTEGER NOT NULL,
        block_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );
      CREATE TABLE cache_blocks (
        cache_conversation_id INTEGER NOT NULL
          REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        type_code INTEGER NOT NULL,
        role_code INTEGER NOT NULL,
        parent_position INTEGER,
        record_offset INTEGER NOT NULL,
        record_length INTEGER NOT NULL,
        record_ordinal INTEGER NOT NULL,
        sub_block_ordinal INTEGER NOT NULL,
        PRIMARY KEY (cache_conversation_id, position)
      ) WITHOUT ROWID;
      CREATE TABLE cache_tool_links (
        cache_conversation_id INTEGER NOT NULL
          REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        tool_key BLOB NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (cache_conversation_id, tool_key)
      ) WITHOUT ROWID;
    `);
    db.prepare("INSERT INTO cache_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SPARSE_STRUCTURE_CACHE_VERSION));
    db.prepare(`
      INSERT INTO cache_conversations (
        conversation_id, source_version_id, parser_format, parser_version,
        normalization_version, redaction_epoch, block_count, updated_at, accessed_at
      )
      SELECT c.id, source.current_version_id, source.parser_format,
             source.parser_version, source.normalization_version,
             source.redaction_epoch, c.block_count, ?, ?
        FROM source.conversations c
        JOIN source.conversation_sources source
          ON source.conversation_id = c.id AND source.provider = c.source
        JOIN source.conversation_source_versions version
          ON version.id = source.current_version_id
       WHERE source.current_version_id IS NOT NULL
         AND version.content_sha256 = c.source_hash
         AND (
           SELECT COUNT(*) FROM source.conversation_structural_blocks block
            WHERE block.conversation_id = c.id
              AND block.source_version_id = source.current_version_id
              AND block.status = 'current'
              AND block.position < c.block_count
              AND block.record_offset IS NOT NULL
              AND block.record_length IS NOT NULL
              AND block.record_ordinal IS NOT NULL
         ) = c.block_count
    `).run(now, now);
    const typeCase = SPARSE_BLOCK_TYPES
      .map((value, index) => `WHEN '${value}' THEN ${index}`)
      .join(" ");
    const roleCase = SPARSE_ROLES
      .map((value, index) => `WHEN '${value}' THEN ${index}`)
      .join(" ");
    db.exec(`
      INSERT INTO cache_blocks (
        cache_conversation_id, position, type_code, role_code, parent_position,
        record_offset, record_length, record_ordinal, sub_block_ordinal
      )
      SELECT cached.cache_id, block.position,
             CASE block.type ${typeCase} ELSE -1 END,
             CASE block.role ${roleCase} ELSE -1 END,
             parent.position, block.record_offset, block.record_length,
             block.record_ordinal, block.sub_block_ordinal
        FROM source.conversation_structural_blocks block
        JOIN cache_conversations cached
          ON cached.conversation_id = block.conversation_id
         AND cached.source_version_id = block.source_version_id
        LEFT JOIN source.conversation_structural_blocks parent
          ON parent.id = block.parent_block_id
       WHERE block.status = 'current'
         AND block.position < (
           SELECT block_count FROM source.conversations
            WHERE id = block.conversation_id
         )
         AND block.record_offset IS NOT NULL
         AND block.record_length IS NOT NULL
         AND block.record_ordinal IS NOT NULL
       ORDER BY cached.cache_id, block.position;
    `);
    const insertTool = db.prepare(`
      INSERT INTO cache_tool_links (cache_conversation_id, tool_key, position)
      VALUES (?, ?, ?)
      ON CONFLICT(cache_conversation_id, tool_key) DO UPDATE SET position = excluded.position
    `);
    const cacheIds = new Map(db.prepare(
      "SELECT conversation_id, cache_id FROM cache_conversations",
    ).all().map((row) => [row.conversation_id, row.cache_id]));
    const sourceReader = new SqliteDatabase(sourcePath, { readonly: true, fileMustExist: true });
    const insertToolLinks = db.transaction(() => {
      for (const row of sourceReader.prepare(`
        SELECT block.conversation_id, block.provider_key, block.position
          FROM conversation_structural_blocks block
          JOIN conversations conversation ON conversation.id = block.conversation_id
         WHERE block.status = 'current' AND block.type = 'tool_use'
           AND block.position < conversation.block_count
      `).iterate()) {
        const cacheId = cacheIds.get(row.conversation_id);
        if (cacheId === undefined) continue;
        const toolId = sparseToolId(row.provider_key);
        if (toolId) insertTool.run(cacheId, sparseToolKey(toolId), row.position);
      }
    });
    try {
      insertToolLinks();
    } finally {
      sourceReader.close();
    }
    const counts = db.prepare(`
      SELECT COUNT(*) AS conversations,
             COALESCE(SUM(block_count), 0) AS expected_blocks,
             (SELECT COUNT(*) FROM cache_blocks) AS cached_blocks,
             (SELECT COUNT(*) FROM cache_blocks WHERE type_code < 0 OR role_code < 0) AS invalid_codes,
             (SELECT COUNT(*) FROM cache_tool_links) AS tool_links,
             (SELECT COUNT(*) FROM source.conversations) AS source_conversations,
             (SELECT COALESCE(SUM(block_count), 0) FROM source.conversations) AS source_blocks
        FROM cache_conversations
    `).get();
    if (Number(counts.expected_blocks) !== Number(counts.cached_blocks)) {
      throw new Error(`Sparse cache coverage mismatch: expected ${counts.expected_blocks}, cached ${counts.cached_blocks}`);
    }
    if (Number(counts.invalid_codes) !== 0) {
      throw new Error(`${counts.invalid_codes} sparse cache rows use unsupported type or role values`);
    }
    const integrity = db.pragma("integrity_check", { simple: true });
    const foreignKeys = db.pragma("foreign_key_check");
    if (integrity !== "ok" || foreignKeys.length > 0) {
      throw new Error(`Sparse cache verification failed (integrity=${integrity}, foreign_keys=${foreignKeys.length})`);
    }
    db.prepare("DETACH DATABASE source").run();
    if (stableJson(dbFileSnapshot(sourcePath)) !== stableJson(sourceBefore)) {
      throw new Error("Source database or sidecars changed during sparse-cache build");
    }
    db.close();
    db = undefined;
    fsyncFile(partialPath);
    fs.renameSync(partialPath, destinationPath);
    fs.rmSync(markerPath, { force: true });
    return {
      version: REPORT_VERSION,
      report_kind: "sparse-conversation-structure-cache",
      source: { path: sourcePath, files: sourceBefore },
      destination: { path: destinationPath, size_bytes: fs.statSync(destinationPath).size },
      conversations: Number(counts.conversations),
      blocks: Number(counts.cached_blocks),
      tool_links: Number(counts.tool_links),
      rebuild_conversations: Number(counts.source_conversations) - Number(counts.conversations),
      rebuild_blocks: Number(counts.source_blocks) - Number(counts.cached_blocks),
      integrity_check: "ok",
      foreign_key_violations: [],
      pass: true,
    };
  } catch (error) {
    try { db?.close(); } catch {}
    removeDbFamily(partialPath);
    fs.rmSync(markerPath, { force: true });
    throw error;
  }
}

function defaultOperationalLogPath(sourcePath) {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, parsed.base === "mandible.db" ? "operational-logs.db" : `${parsed.name}.operational-logs.db`);
}

export function inspectLegacyReclaimReadiness(options) {
  const sourcePath = path.resolve(options.source);
  const logDbPath = path.resolve(options.logDb ?? defaultOperationalLogPath(sourcePath));
  const db = new SqliteDatabase(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const blockColumns = visibleColumns(db, "main", "conversation_blocks").map((column) => column.name);
    if (!blockColumns.includes("payload_state")) {
      return { pass: false, errors: ["source-backed payload migration has not run"], source: sourcePath, operational_log: logDbPath };
    }
    const payload = db.prepare(`
      SELECT payload_state, COUNT(*) AS blocks,
             COALESCE(SUM(length(content) + length(metadata_json)), 0) AS payload_bytes
        FROM conversation_blocks GROUP BY payload_state ORDER BY payload_state
    `).all();
    const malformedSourcePayloads = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_blocks
       WHERE payload_state = 'source'
         AND (length(content) != 0 OR metadata_json != '{}' OR compressed != 0)
    `).get().count);
    const legacyPayloads = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_blocks WHERE payload_state = 'legacy'
    `).get().count);
    const locatorGaps = Number(db.prepare(`
      SELECT COUNT(*) AS count
        FROM conversation_blocks b
        JOIN conversations c ON c.id = b.conversation_id
        JOIN conversation_sources s ON s.conversation_id = c.id
          AND s.provider = c.source AND s.availability = 'available'
       WHERE b.payload_state = 'source'
         AND NOT EXISTS (
           SELECT 1 FROM conversation_structural_blocks sb
           JOIN conversation_source_versions v ON v.id = sb.source_version_id
            WHERE sb.conversation_id = b.conversation_id
              AND sb.position = b.position AND sb.status = 'current'
              AND sb.source_version_id IS NOT NULL
              AND sb.record_offset IS NOT NULL AND sb.record_length IS NOT NULL
              AND sb.record_length <= 67108864 AND sb.record_hash IS NOT NULL
              AND sb.record_ordinal IS NOT NULL AND sb.record_ordinal >= 0
              AND (c.source <> 'gemini'
                OR (sb.record_offset = 0
                  AND sb.record_length = v.byte_length
                  AND sb.record_hash = v.content_sha256
                  AND sb.record_ordinal = 0))
         )
    `).get().count);
    const legacyRows = Number(db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get().count);
    const legacyGeneration = Number(db.prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM daemon_log").get().value);
    const highWater = db.prepare(`
      SELECT ts, id FROM daemon_log ORDER BY ts DESC, id DESC LIMIT 1
    `).get() ?? { ts: null, id: null };

    let logState = null;
    if (fs.existsSync(logDbPath)) {
      const logDb = new SqliteDatabase(logDbPath, { readonly: true, fileMustExist: true });
      try {
        logState = logDb.prepare(`
          SELECT * FROM operational_log_copy_state
           WHERE source_path = ?
        `).get(canonicalPath(sourcePath)) ?? null;
      } finally {
        logDb.close();
      }
    }
    const logVerified = Boolean(logState?.completed_at && logState?.verified_at
      && Number(logState.verified_legacy_rows) === legacyRows
      && Number(logState.legacy_high_water_rows) === legacyRows
      && Number(logState.legacy_generation_rowid) === legacyGeneration
      && (logState.legacy_high_water_ts ?? null) === (highWater.ts ?? null)
      && (logState.legacy_high_water_id ?? null) === (highWater.id ?? null));
    const errors = [];
    if (!logVerified) errors.push("legacy daemon-log copy has no current recorded verifier snapshot");
    if (legacyPayloads > 0) errors.push(`${legacyPayloads} legacy conversation block payloads remain`);
    if (malformedSourcePayloads > 0) errors.push(`${malformedSourcePayloads} source-backed block payloads were not stripped`);
    if (locatorGaps > 0) errors.push(`${locatorGaps} source-backed blocks lack bounded exact locators`);
    return {
      pass: errors.length === 0,
      errors,
      source: sourcePath,
      operational_log: logDbPath,
      payload,
      legacy_payloads: legacyPayloads,
      malformed_source_payloads: malformedSourcePayloads,
      source_locator_gaps: locatorGaps,
      legacy_daemon_log: {
        rows: legacyRows,
        generation_rowid: legacyGeneration,
        high_water: highWater,
        recorded_state: logState,
        verified: logVerified,
      },
    };
  } finally {
    db.close();
  }
}

export function buildLegacyReclaimedDestination(options) {
  const readiness = inspectLegacyReclaimReadiness(options);
  if (!readiness.pass) {
    return { version: REPORT_VERSION, report_kind: "legacy-storage-reclaim", readiness, pass: false };
  }
  const structureCachePath = path.resolve(options.structureCache
    ?? `${path.resolve(options.destination)}.conversation-structure.db`);
  const structure_cache = buildSparseConversationStructureCache({
    source: options.source,
    destination: structureCachePath,
  });
  let rebuild;
  try {
    rebuild = buildCompactDestination({
      source: options.source,
      destination: options.destination,
      excludeTables: ["daemon_log"],
      emptyConversationIndex: true,
    });
  } catch (error) {
    removeDbFamily(structureCachePath);
    throw error;
  }
  return {
    version: REPORT_VERSION,
    report_kind: "legacy-storage-reclaim",
    readiness,
    structure_cache,
    rebuild,
    pass: rebuild.pass === true,
  };
}

function normalizeMetadata(value) {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function blockProjection(block) {
  const content = block.content_sha256
    ? null
    : (Number(block.compressed) === 1 && Buffer.isBuffer(block.content)
      ? gunzipSync(block.content).toString("utf8")
      : Buffer.isBuffer(block.content) ? block.content.toString("utf8") : String(block.content ?? ""));
  return {
    id: String(block.id),
    type: String(block.type),
    role: String(block.role),
    content_sha256: block.content_sha256 ?? sha256(content),
    metadata: normalizeMetadata(block.metadata ?? block.metadata_json ?? null),
    position: Number(block.position),
    parent_id: block.parent_id ?? null,
    dag_uuid: block.dag_uuid ?? null,
    dag_parent_uuid: block.dag_parent_uuid ?? null,
  };
}

function legacyConversationProjection(db, conversation) {
  const blocks = db.prepare(
    `SELECT id, type, role, content, compressed, position, parent_id, metadata_json, dag_uuid, dag_parent_uuid
       FROM conversation_blocks WHERE conversation_id = ? ORDER BY position, id`,
  ).all(conversation.id).map(blockProjection);
  return {
    identity: {
      id: conversation.id,
      source: conversation.source,
      session_id: conversation.session_id,
      parent_conversation_id: conversation.parent_conversation_id ?? null,
      is_sidechain: Number(conversation.is_sidechain ?? 0),
      agent_id: conversation.agent_id ?? null,
    },
    blocks,
  };
}

function compareProjection(expected, actual) {
  const fields = ["identity", "blocks", "annotations", "relationships"];
  const mismatches = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(actual, field)
      || stableJson(expected[field] ?? []) !== stableJson(actual[field] ?? [])) mismatches.push(field);
  }
  return { pass: mismatches.length === 0, mismatches };
}

function evidenceByConversation(packet) {
  const map = new Map();
  for (const item of packet?.conversation_evidence ?? []) {
    if (!item || typeof item.conversation_id !== "string") continue;
    map.set(item.conversation_id, item);
  }
  return map;
}

function relationshipProjection(db, conversationId) {
  const result = [];
  const conversations = db.prepare(
    "SELECT id, parent_conversation_id FROM conversations WHERE id = ? OR parent_conversation_id = ? ORDER BY id",
  ).all(conversationId, conversationId);
  for (const row of conversations) {
    if (row.parent_conversation_id) result.push({ type: "parent_child", source: row.parent_conversation_id, target: row.id });
  }
  if (userSchema(db).tables.some((table) => table.name === "workflow_workers")) {
    for (const row of db.prepare(
      "SELECT id, workflow_id FROM workflow_workers WHERE conversation_id = ? ORDER BY id",
    ).all(conversationId)) result.push({ type: "workflow_worker", source: row.workflow_id, target: row.id });
  }
  return result;
}

function annotationProjection(db, conversationId) {
  const output = [];
  for (const table of userSchema(db).tables) {
    if (!/annotation/i.test(table.name)) continue;
    const columns = visibleColumns(db, "main", table.name).map((column) => column.name);
    if (!columns.includes("conversation_id")) continue;
    const rows = db.prepare(
      `SELECT * FROM ${quoteIdentifier(table.name)} WHERE conversation_id = ? ORDER BY rowid`,
    ).all(conversationId);
    output.push({ table: table.name, rows });
  }
  return output;
}

function assessSearch(packet, evidenceBound) {
  const comparisons = (packet?.search?.comparisons ?? []).map((item) => {
    const legacy = [...(item.legacy_results ?? [])].map(String);
    const source = [...(item.source_results ?? [])].map(String);
    return {
      query: String(item.query ?? ""),
      pass: stableJson(legacy) === stableJson(source),
      legacy_results: legacy,
      source_results: source,
    };
  });
  const declared = evidenceBound && packet?.search?.adapter_verified === true;
  return {
    pass: declared && comparisons.length > 0 && comparisons.every((item) => item.pass),
    adapter_verified: declared,
    comparisons,
  };
}

function assessPerformance(packet, evidenceBound) {
  const modes = ["cold_detail", "hot_detail", "cold_search", "hot_search"];
  const report = {};
  let pass = true;
  for (const mode of modes) {
    const value = packet?.performance?.[mode];
    const valid = evidenceBound && value && Number.isFinite(value.p95_ms) && Number.isFinite(value.budget_ms)
      && Number.isFinite(value.peak_rss_bytes) && Number.isFinite(value.rss_budget_bytes);
    const modePass = Boolean(valid && value.p95_ms <= value.budget_ms && value.peak_rss_bytes <= value.rss_budget_bytes);
    report[mode] = { ...(value ?? {}), pass: modePass };
    pass &&= modePass;
  }
  return { pass, modes: report };
}

function namedExternalGate(packet, key, evidenceBound) {
  const value = packet?.gates?.[key];
  return {
    pass: evidenceBound && value?.pass === true,
    adapter: value?.adapter ?? null,
    evidence: value?.evidence ?? null,
    errors: !evidenceBound
      ? ["unbound_evidence_packet"]
      : Array.isArray(value?.errors) ? value.errors : value ? [] : ["missing_adapter_evidence"],
  };
}

function assessRollbackGate(packet, evidenceBound) {
  const gate = namedExternalGate(packet, "rollback_kill_switch", evidenceBound);
  const evidence = gate.evidence ?? {};
  const contractPass = Number(evidence.retention_days) >= 31
    && evidence.legacy_database_verified === true
    && evidence.kill_switch_tested === true
    && evidence.default_reader_unchanged === true;
  return {
    ...gate,
    pass: gate.pass && contractPass,
    contract: {
      minimum_retention_days: 31,
      retention_days: Number.isFinite(Number(evidence.retention_days)) ? Number(evidence.retention_days) : null,
      legacy_database_verified: evidence.legacy_database_verified === true,
      kill_switch_tested: evidence.kill_switch_tested === true,
      default_reader_unchanged: evidence.default_reader_unchanged === true,
    },
  };
}

export function auditCutover(options) {
  const sourcePath = path.resolve(options.source);
  const packet = options.evidence ?? {};
  const db = new SqliteDatabase(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const binding = sourceDatabaseBinding(db, sourcePath);
    const evidenceBound = bindingMatches(packet.binding, binding);
    const conversations = db.prepare(
      `SELECT id, source, session_id, parent_conversation_id, is_sidechain, agent_id
         FROM conversations ORDER BY id`,
    ).all();
    const evidence = evidenceByConversation(packet);
    const coverage = [];
    const shadow = [];
    for (const conversation of conversations) {
      const legacy = legacyConversationProjection(db, conversation);
      const item = evidence.get(conversation.id);
      const verifiedClass = evidenceBound && COVERAGE_CLASSES.includes(item?.classification) && item?.verified === true
        ? item.classification : null;
      const hasLegacyBodies = legacy.blocks.length > 0;
      let classification = verifiedClass;
      if (!classification && hasLegacyBodies) classification = "legacy-body-only";
      const retained = classification !== "legacy-body-only" || hasLegacyBodies;
      coverage.push({
        conversation_id: conversation.id,
        classification,
        legacy_body_count: legacy.blocks.length,
        retained,
        evidence_error: item?.error ?? null,
      });
      if (classification === "verified-live-source" || classification === "verified-managed-custody") {
        const actual = item?.projection ?? {};
        shadow.push({
          conversation_id: conversation.id,
          classification,
          ...compareProjection({
            ...legacy,
            annotations: annotationProjection(db, conversation.id),
            relationships: relationshipProjection(db, conversation.id),
          }, actual),
        });
      }
    }

    const coverageReport = {
      pass: coverage.every((row) => row.classification && row.retained),
      counts: Object.fromEntries(COVERAGE_CLASSES.map((name) => [name, coverage.filter((row) => row.classification === name).length])),
      unclassified: coverage.filter((row) => !row.classification).map((row) => row.conversation_id),
      conversations: coverage,
    };
    const shadowReport = {
      pass: shadow.length > 0 && shadow.every((row) => row.pass),
      compared: shadow.length,
      mismatches: shadow.filter((row) => !row.pass),
    };
    const search = assessSearch(packet, evidenceBound);
    const performance = assessPerformance(packet, evidenceBound);
    const rebuildInput = options.rebuildReport;
    const rebuildBound = bindingMatches(rebuildInput?.binding, binding);
    const rebuild = rebuildInput ? {
      ...rebuildInput,
      pass: rebuildInput.pass === true && rebuildBound,
      binding_valid: rebuildBound,
      errors: rebuildBound ? (rebuildInput.errors ?? []) : ["source_binding_mismatch"],
    } : { pass: false, binding_valid: false, error: "compact_rebuild_not_run" };
    const restoreDrills = options.restoreDrillReports ?? [];
    const validRestoreDrill = (report) => report?.pass === true
      && bindingMatches(report?.binding, binding)
      && typeof report?.run_id === "string" && report.run_id.length > 0
      && typeof report?.destination_root === "string" && report.destination_root.length > 0
      && report?.original_provider_roots_used === false
      && report?.metadata?.integrity_check === "ok"
      && Array.isArray(report?.metadata?.foreign_key_violations)
      && report.metadata.foreign_key_violations.length === 0
      && report?.custody?.pass === true
      && report?.custody?.manifest_present === true
      && report?.collision_policy === "destination-must-not-exist";
    const validRestoreDrills = restoreDrills.filter(validRestoreDrill);
    const distinctRunIds = new Set(validRestoreDrills.map((report) => report.run_id));
    const distinctDestinations = new Set(validRestoreDrills.map((report) => canonicalPath(report.destination_root)));
    const recovery = {
      pass: validRestoreDrills.length >= 2
        && validRestoreDrills.length === restoreDrills.length
        && distinctRunIds.size === validRestoreDrills.length
        && distinctDestinations.size === validRestoreDrills.length,
      required: 2,
      completed: validRestoreDrills.length,
      distinct_run_ids: distinctRunIds.size,
      distinct_destinations: distinctDestinations.size,
      drills: restoreDrills,
    };
    const gates = {
      evidence_binding: {
        pass: evidenceBound,
        expected: binding,
        supplied: packet.binding ?? null,
        errors: evidenceBound ? [] : ["unbound_or_mismatched_evidence_packet"],
      },
      coverage: coverageReport,
      dual_read_shadow: shadowReport,
      exact_search_parity: search,
      parser_performance: performance,
      locator_refresh: namedExternalGate(packet, "locator_refresh", evidenceBound),
      security_redaction: namedExternalGate(packet, "security_redaction", evidenceBound),
      compact_rebuild: rebuild,
      fresh_machine_recovery: recovery,
      rollback_kill_switch: assessRollbackGate(packet, evidenceBound),
    };
    const failedGates = Object.entries(gates).filter(([, gate]) => gate.pass !== true).map(([name]) => name);
    failedGates.push("automated_go_authority");
    return {
      version: REPORT_VERSION,
      report_kind: "source-bound-evidence-checklist",
      binding,
      decision: "NO-GO",
      pass: false,
      go_authority: false,
      failed_gates: failedGates,
      gates,
    };
  } finally {
    db.close();
  }
}

function parseChecksums(root) {
  const checksumPath = path.join(root, "SHA256SUMS");
  if (!fs.existsSync(checksumPath)) throw new Error(`Missing custody checksum file: ${checksumPath}`);
  const entries = [];
  for (const raw of fs.readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(raw);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${raw}`);
    const relative = match[2];
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe custody checksum path: ${relative}`);
    }
    entries.push({ sha256: match[1], path: relative });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function verifyCustodyTree(root) {
  const entries = parseChecksums(root);
  const listed = new Set(entries.map((entry) => entry.path));
  const mismatches = [];
  const unlisted = [];
  const unsafe = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        unsafe.push(relative);
      } else if (stat.isDirectory()) {
        visit(target);
      } else if (!stat.isFile()) {
        unsafe.push(relative);
      } else if (relative !== "SHA256SUMS" && !listed.has(relative)) {
        unlisted.push(relative);
      }
    }
  };
  visit(root);
  for (const entry of entries) {
    const target = path.join(root, entry.path);
    let valid = false;
    try {
      const stat = fs.lstatSync(target);
      valid = stat.isFile()
        && !stat.isSymbolicLink()
        && canonicalPath(target).startsWith(`${canonicalPath(root)}${path.sep}`)
        && hashFile(target) === entry.sha256;
    } catch {
      valid = false;
    }
    if (!valid) mismatches.push(entry.path);
  }
  return {
    pass: entries.length > 0 && mismatches.length === 0 && unlisted.length === 0 && unsafe.length === 0,
    files: entries.length,
    mismatches,
    unlisted,
    unsafe,
  };
}

export function runRestoreDrill(options) {
  const sourcePath = path.resolve(options.source);
  const metadataSql = path.resolve(options.metadataSql);
  const custodyRoot = path.resolve(options.custodyRoot);
  const destinationRoot = path.resolve(options.destinationRoot);
  if (fs.existsSync(destinationRoot)) throw new Error(`Restore destination already exists: ${destinationRoot}`);
  if (!fs.existsSync(sourcePath)) throw new Error(`Source database does not exist: ${sourcePath}`);
  const futureDestinationRoot = canonicalFuturePath(destinationRoot);
  for (const production of PRODUCTION_DB_PATHS) {
    const productionRoot = canonicalPath(path.dirname(production));
    if (futureDestinationRoot === productionRoot || futureDestinationRoot.startsWith(`${productionRoot}${path.sep}`)) {
      throw new Error(`Refusing restore destination under production database root: ${destinationRoot}`);
    }
  }
  if (!fs.existsSync(metadataSql)) throw new Error(`Metadata SQL does not exist: ${metadataSql}`);
  if (!fs.existsSync(custodyRoot)) throw new Error(`Custody root does not exist: ${custodyRoot}`);
  const sourceCustody = verifyCustodyTree(custodyRoot);
  if (!sourceCustody.pass) throw new Error(`Custody input verification failed: ${sourceCustody.mismatches.join(", ")}`);
  const binding = inspectSourceBinding(sourcePath);
  const runId = randomUUID();

  fs.mkdirSync(destinationRoot, { recursive: false });
  const metadataPath = path.join(destinationRoot, "metadata.sqlite");
  const restoredCustody = path.join(destinationRoot, "custody");
  try {
    const db = new SqliteDatabase(metadataPath);
    try {
      db.exec(fs.readFileSync(metadataSql, "utf8"));
      const integrity = db.pragma("integrity_check", { simple: true });
      const foreignKeys = normalizedForeignKeys(db, "main");
      if (integrity !== "ok" || foreignKeys.length > 0) {
        throw new Error(`Restored metadata failed SQLite verification (integrity=${integrity}, foreign_keys=${foreignKeys.length})`);
      }
    } finally {
      db.close();
    }
    fs.cpSync(custodyRoot, restoredCustody, { recursive: true, dereference: false, errorOnExist: true });
    const restored = verifyCustodyTree(restoredCustody);
    const manifestPresent = fs.existsSync(path.join(restoredCustody, "manifest.json"));
    return {
      version: REPORT_VERSION,
      report_kind: "fresh-machine-restore-evidence",
      binding,
      run_id: runId,
      destination_root: canonicalPath(destinationRoot),
      inputs: {
        metadata_sql_sha256: hashFile(metadataSql),
        custody_manifest_sha256: hashFile(path.join(custodyRoot, "SHA256SUMS")),
      },
      pass: restored.pass && manifestPresent,
      metadata: { path: metadataPath, integrity_check: "ok", foreign_key_violations: [] },
      custody: { ...restored, manifest_present: manifestPresent },
      original_provider_roots_used: false,
      collision_policy: "destination-must-not-exist",
    };
  } catch (error) {
    fs.rmSync(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(path.resolve(target), "utf8"));
}

function parseArgs(argv) {
  const parsed = require("../cli/command-syntax.cjs").parse(["conversation-cutover", ...argv]);
  const repeated = key => Array.isArray(parsed.options[key]) ? parsed.options[key] : parsed.options[key] ? [parsed.options[key]] : [];
  const options = { command: parsed.command.split(".").at(-1), excludeTables: repeated("exclude-table"), restoreReports: repeated("restore-report"), json: parsed.options.json === true };
  for (const [key, target] of Object.entries({source:"source", destination:"destination", evidence:"evidence", "log-db":"logDb", "structure-cache":"structureCache", "rebuild-report":"rebuildReport", "metadata-sql":"metadataSql", "custody-root":"custodyRoot", "destination-root":"destinationRoot"})) options[target] = parsed.options[key];
  return options;
}
function usage() {
  console.log(require("../cli/command-syntax.cjs").help(["conversation-cutover"]));
}

async function main(argv) {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    usage();
    return 0;
  }
  if (argv.some(arg => arg === "--help" || arg === "-h")) { usage(); return 0; }
  const options = parseArgs(argv);
  if (options.help || !options.command) { usage(); return options.command ? 0 : 2; }
  let report;
  if (options.command === "binding") {
    if (!options.source) throw new Error("binding requires --source");
    report = inspectSourceBinding(options.source);
  } else if (options.command === "rebuild") {
    if (!options.source || !options.destination) throw new Error("rebuild requires --source and --destination");
    report = buildCompactDestination({ source: options.source, destination: options.destination, excludeTables: options.excludeTables });
  } else if (options.command === "reclaim") {
    if (!options.source || !options.destination) throw new Error("reclaim requires --source and --destination");
    report = buildLegacyReclaimedDestination(options);
  } else if (options.command === "restore-drill") {
    if (!options.source || !options.metadataSql || !options.custodyRoot || !options.destinationRoot) {
      throw new Error("restore-drill requires --source, --metadata-sql, --custody-root, and --destination-root");
    }
    report = runRestoreDrill(options);
  } else if (options.command === "audit") {
    if (!options.source || !options.evidence) throw new Error("audit requires --source and --evidence");
    report = auditCutover({
      source: options.source,
      evidence: readJson(options.evidence),
      rebuildReport: options.rebuildReport ? readJson(options.rebuildReport) : undefined,
      restoreDrillReports: options.restoreReports.map(readJson),
    });
  } else {
    throw new Error(`Unknown command: ${options.command}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, options.json ? 2 : 0)}\n`);
  return options.command === "binding" ? 0 : report.pass ? 0 : 1;
}

const invoked = process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}

export { SimulatedInterruption, stableJson };
