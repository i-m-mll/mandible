#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import SqliteDatabase from "../src/sqlite.ts";

// Issue 24f0316 — the ledger database lives under the durable root.
const { liveDbPath } = createRequire(import.meta.url)("../cli/mandible-paths.cjs");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_SOURCE = liveDbPath();
const REQUIRED_PROJECTED_TABLES = new Set(["conversations", "conversation_blocks"]);
const PROJECTED_TABLES = new Set(["daemon_log", ...REQUIRED_PROJECTED_TABLES]);
const LOG_ALL_WINDOW_MS = DAY_MS;
const LOG_SEVERE_WINDOW_MS = 7 * DAY_MS;
const CONVERSATION_WINDOW_MS = 7 * DAY_MS;
const SPACE_MARGIN_BYTES = 128 * 1024 * 1024;

export function projectDatabaseSnapshot(options) {
  const sourcePath = path.resolve(expandHome(options.source ?? DEFAULT_SOURCE));
  const outputPath = path.resolve(expandHome(options.output));
  const manifestPath = path.resolve(expandHome(options.manifest ?? `${outputPath}.manifest.json`));
  const stagingDir = options.stagingDir ? path.resolve(options.stagingDir) : path.dirname(outputPath);
  if (options.stagingDir) fs.mkdirSync(stagingDir, { recursive: true });
  const partialPath = path.join(stagingDir, `${path.basename(outputPath)}.partial-${process.pid}`);
  const partialManifestPath = path.join(stagingDir, `${path.basename(manifestPath)}.partial-${process.pid}`);
  const partialStructureCachePath = `${partialPath}.conversation-structure.db`;

  if (!fs.existsSync(sourcePath)) throw new Error(`Source database does not exist: ${sourcePath}`);
  if (!options.replace && fs.existsSync(outputPath)) {
    throw new Error(`Output already exists (pass --replace to overwrite): ${outputPath}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  removeDatabaseArtifacts(partialPath);
  removeDatabaseArtifacts(partialStructureCachePath);
  removeIfExists(partialManifestPath);

  let db = null;
  const startedAt = Date.now();
  try {
    db = new SqliteDatabase(partialPath);
    db.pragma("journal_mode = OFF");
    db.pragma("synchronous = OFF");
    db.pragma("temp_store = MEMORY");
    db.pragma("foreign_keys = OFF");
    // The source schema is only ever referenced by SELECT statements inside the
    // single read transaction below. Every convergence write happens later,
    // after DETACH, against the private partial copy.
    db.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
    db.exec("BEGIN DEFERRED");

    const schema = readSourceSchema(db);
    requireProjectedTables(schema.tables);
    const sourceTableNames = new Set(schema.tables.map((table) => table.name));
    const hasLegacyDaemonLog = sourceTableNames.has("daemon_log");
    const sourcePragmas = readSourcePragmas(db);
    const sourceForeignKeyViolations = normalizedForeignKeyViolations(db, "source");
    const cutoffMs = resolveCutoffMs(db, options.cutoffMs, hasLegacyDaemonLog);
    const windows = {
      cutoff_ms: cutoffMs,
      logs_all_after_ms: Math.max(0, cutoffMs - LOG_ALL_WINDOW_MS),
      logs_severe_after_ms: Math.max(0, cutoffMs - LOG_SEVERE_WINDOW_MS),
      conversations_after_ms: Math.max(0, cutoffMs - CONVERSATION_WINDOW_MS),
    };

    db.pragma(`page_size = ${sourcePragmas.page_size}`);
    if (sourcePragmas.application_id !== 0) db.pragma(`application_id = ${sourcePragmas.application_id}`);
    db.pragma(`user_version = ${sourcePragmas.user_version}`);

    for (const table of schema.tables) db.exec(table.sql);
    selectConversationProjection(db, windows);

    const space = estimateAndCheckSpace(db, outputPath, windows, hasLegacyDaemonLog, options);
    const copied = {};
    for (const table of schema.tables) {
      copied[table.name] = copyTable(db, table.name, windows);
    }
    copySqliteSequence(db, schema.tables);

    for (const index of schema.indexes) db.exec(index.sql);
    for (const view of schema.views) db.exec(view.sql);
    for (const trigger of schema.triggers) db.exec(trigger.sql);
    db.exec("COMMIT");
    db.prepare("DETACH DATABASE source").run();

    db.close();
    db = null;
    const titleConvergence = convergeProjectedConversationTitles(partialPath, partialStructureCachePath);
    // Title convergence may rebuild the disposable source-coordinate cache.
    // A projected database does not own that cache, so never publish it with
    // the snapshot or leave it behind when a candidate succeeds.
    removeDatabaseArtifacts(partialStructureCachePath);
    db = new SqliteDatabase(partialPath);
    db.pragma("foreign_keys = ON");

    const quickCheck = db.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") throw new Error(`Projected database quick_check failed: ${quickCheck}`);
    const foreignKeyViolations = normalizedForeignKeyViolations(db, "main");
    const inheritedViolationKeys = new Set(sourceForeignKeyViolations.map((violation) => violation.signature));
    const introducedViolations = foreignKeyViolations
      .filter((violation) => !inheritedViolationKeys.has(violation.signature));
    if (introducedViolations.length > 0) {
      throw new Error(`Projected database introduced ${introducedViolations.length} foreign-key violation(s)`);
    }

    const outputCounts = readProjectedCounts(db, hasLegacyDaemonLog);
    db.close();
    db = null;

    fsyncFile(partialPath);
    const manifest = {
      version: 1,
      kind: "mandible-projected-database",
      source: {
        path: sourcePath,
        size_bytes: fs.statSync(sourcePath).size,
        page_size: sourcePragmas.page_size,
        page_count: sourcePragmas.page_count,
        user_version: sourcePragmas.user_version,
        application_id: sourcePragmas.application_id,
      },
      projection: {
        cutoff_ms: windows.cutoff_ms,
        logs: {
          all_after_ms: windows.logs_all_after_ms,
          warn_error_after_ms: windows.logs_severe_after_ms,
        },
        conversations: {
          active_after_ms: windows.conversations_after_ms,
          preserve_starred: true,
          preserve_session_overrides: true,
          preserve_declared_foreign_keys: true,
          preserve_newest_per_source_project: true,
          preserve_parent_closure: true,
          whole_conversations: true,
          title_convergence: titleConvergence,
        },
      },
      tables: {
        copied_rows: copied,
        projected_counts: outputCounts,
        complete_table_count: schema.tables.length
          - [...PROJECTED_TABLES].filter((name) => sourceTableNames.has(name)).length,
      },
      schema: {
        tables: schema.tables.length,
        indexes: schema.indexes.length,
        views: schema.views.length,
        triggers: schema.triggers.length,
      },
      safety: {
        source_transaction: "single-read-snapshot",
        integrity: "ok",
        foreign_key_violations: foreignKeyViolations.length,
        inherited_foreign_key_violations: foreignKeyViolations.length,
        introduced_foreign_key_violations: introducedViolations.length,
        space,
      },
      output: {
        path: outputPath,
        manifest_path: manifestPath,
        size_bytes: fs.statSync(partialPath).size,
      },
      duration_ms: Date.now() - startedAt,
    };

    fs.writeFileSync(partialManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsyncFile(partialManifestPath);
    fs.renameSync(partialPath, outputPath);
    fs.renameSync(partialManifestPath, manifestPath);
    return manifest;
  } catch (error) {
    if (db) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      try {
        db.close();
      } catch {
        // Preserve the original error.
      }
    }
    removeDatabaseArtifacts(partialPath);
    removeDatabaseArtifacts(partialStructureCachePath);
    removeIfExists(partialManifestPath);
    throw error;
  }
}

function convergeProjectedConversationTitles(dbPath, structureCachePath) {
  const entrypoint = fileURLToPath(new URL(
    "../dist/cli/projected-conversation-convergence.js",
    import.meta.url,
  ));
  if (!fs.existsSync(entrypoint)) {
    throw new Error(`Projected conversation convergence entrypoint does not exist: ${entrypoint}`);
  }
  const result = spawnSync(process.execPath, [entrypoint, "--db", dbPath, "--json"], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    encoding: "utf8",
    env: {
      ...process.env,
      MANDIBLE_CONVERSATION_STRUCTURE_DB: structureCachePath,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `Projected conversation convergence failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Projected conversation convergence returned invalid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function readSourceSchema(db) {
  const rows = db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM source.sqlite_master
      WHERE sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END,
               name`,
  ).all();
  return {
    tables: rows.filter((row) => row.type === "table"),
    indexes: rows.filter((row) => row.type === "index"),
    views: rows.filter((row) => row.type === "view"),
    triggers: rows.filter((row) => row.type === "trigger"),
  };
}

function requireProjectedTables(tables) {
  const names = new Set(tables.map((table) => table.name));
  const missing = [...REQUIRED_PROJECTED_TABLES].filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Source database is missing projected table(s): ${missing.join(", ")}`);
  }
}

function readSourcePragmas(db) {
  return {
    page_size: Number(db.pragma("source.page_size", { simple: true })),
    page_count: Number(db.pragma("source.page_count", { simple: true })),
    user_version: Number(db.pragma("source.user_version", { simple: true })),
    application_id: Number(db.pragma("source.application_id", { simple: true })),
  };
}

function resolveCutoffMs(db, explicitCutoff, hasLegacyDaemonLog) {
  if (explicitCutoff !== null && explicitCutoff !== undefined) return explicitCutoff;
  if (!hasLegacyDaemonLog) {
    const row = db.prepare("SELECT COALESCE(MAX(source_mtime), 0) AS cutoff_ms FROM source.conversations").get();
    return Number(row.cutoff_ms ?? 0);
  }
  const row = db.prepare(
    `SELECT COALESCE(MAX(value), 0) AS cutoff_ms
       FROM (
         SELECT MAX(ts) AS value FROM source.daemon_log
         UNION ALL
         SELECT MAX(source_mtime) AS value FROM source.conversations
       )`,
  ).get();
  return Number(row.cutoff_ms ?? 0);
}

function selectConversationProjection(db, windows) {
  db.exec("CREATE TEMP TABLE selected_conversation_ids (id TEXT PRIMARY KEY)");
  const insert = db.prepare(
    `INSERT OR IGNORE INTO selected_conversation_ids(id)
     SELECT id FROM source.conversations WHERE source_mtime >= @conversations_after_ms OR starred = 1`,
  );
  insert.run(windows);

  db.prepare(
    `INSERT OR IGNORE INTO selected_conversation_ids(id)
     SELECT c.id
       FROM source.conversations c
       JOIN source.sessions s ON s.conversation_id = c.id
      WHERE s.status = 'active'
         OR COALESCE(s.pinned, 0) = 1
         OR COALESCE(unixepoch(s.updated_at) * 1000, 0) >= @conversations_after_ms`,
  ).run(windows);

  db.prepare(
    `INSERT OR IGNORE INTO selected_conversation_ids(id)
     SELECT id
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY source, COALESCE(project_path, '')
                  ORDER BY source_mtime DESC, id DESC
                ) AS rank
           FROM source.conversations
       )
      WHERE rank = 1`,
  ).run();

  for (const reference of conversationForeignKeyReferences(db)) {
    db.exec(
      `INSERT OR IGNORE INTO selected_conversation_ids(id)
       SELECT DISTINCT c.id
         FROM source.${quoteIdentifier(reference.table)} r
         JOIN source.conversations c ON c.id = r.${quoteIdentifier(reference.column)}
        WHERE r.${quoteIdentifier(reference.column)} IS NOT NULL`,
    );
  }

  const addParents = db.prepare(
    `INSERT OR IGNORE INTO selected_conversation_ids(id)
     SELECT parent.id
       FROM source.conversations child
       JOIN selected_conversation_ids selected ON selected.id = child.id
       JOIN source.conversations parent ON parent.id = child.parent_conversation_id`,
  );
  while (addParents.run().changes > 0) {
    // Reach the complete transitive parent closure.
  }
}

function conversationForeignKeyReferences(db) {
  const tables = db.prepare(
    `SELECT name FROM source.sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  ).all();
  const references = [];
  for (const { name } of tables) {
    const foreignKeys = db.pragma(`source.foreign_key_list(${quoteIdentifier(name)})`);
    for (const foreignKey of foreignKeys) {
      if (foreignKey.table === "conversations") {
        references.push({ table: name, column: foreignKey.from });
      }
    }
  }
  return references.filter((reference) => reference.table !== "conversation_blocks");
}

function estimateAndCheckSpace(db, outputPath, windows, hasLegacyDaemonLog, options = {}) {
  let canonicalPhysicalBytes;
  try {
    canonicalPhysicalBytes = Number(db.prepare(
      `SELECT COALESCE(SUM(pgsize), 0) AS bytes
         FROM dbstat('source') stats
         LEFT JOIN source.sqlite_master objects ON objects.name = stats.name
        WHERE stats.aggregate = TRUE
          AND stats.name NOT LIKE 'sqlite_%'
          AND COALESCE(objects.tbl_name, stats.name)
              NOT IN ('daemon_log', 'conversations', 'conversation_blocks')`,
    ).get().bytes);
  } catch {
    canonicalPhysicalBytes = fs.statSync(db.prepare("PRAGMA source.database_list").all()
      .find((row) => row.name === "source").file).size;
  }

  const logPayloadBytes = hasLegacyDaemonLog ? Number(db.prepare(
    `SELECT COALESCE(SUM(
       length(id) + length(level) + length(event) + length(subsystem) + length(fields_json) +
       COALESCE(length(issue_id), 0) + COALESCE(length(auth_request_id), 0) +
       COALESCE(length(artifact_id), 0) + COALESCE(length(session_id), 0) +
       COALESCE(length(repo_id), 0) + 8
     ), 0) AS bytes
       FROM source.daemon_log
      WHERE ts >= @logs_all_after_ms
         OR (ts >= @logs_severe_after_ms AND level IN ('warn', 'error'))`,
  ).get(windows).bytes) : 0;
  const conversationPayloadBytes = Number(db.prepare(
    `SELECT COALESCE(SUM(length(b.content) + length(b.metadata_json)), 0) AS bytes
       FROM source.conversation_blocks b
       JOIN selected_conversation_ids selected ON selected.id = b.conversation_id`,
  ).get().bytes);

  const estimatedRequiredBytes = Math.ceil(
    canonicalPhysicalBytes + (logPayloadBytes * 3) + (conversationPayloadBytes * 2) + SPACE_MARGIN_BYTES,
  );
  const statfs = fs.statfsSync(path.dirname(outputPath));
  const availableBytes = Number(statfs.bavail) * Number(statfs.bsize);
  const reserveBytes = options.reserveBytes ?? 0;
  const maxOutputBytes = options.maxOutputBytes ?? Number.MAX_SAFE_INTEGER;
  if (estimatedRequiredBytes > maxOutputBytes || availableBytes - reserveBytes < estimatedRequiredBytes) {
    throw new Error(
      `Insufficient free space for projected snapshot: available=${availableBytes}, estimated_required=${estimatedRequiredBytes}, reserve=${reserveBytes}, output_budget=${maxOutputBytes}`,
    );
  }
  return {
    available_bytes: availableBytes,
    estimated_required_bytes: estimatedRequiredBytes,
    canonical_physical_bytes: canonicalPhysicalBytes,
    selected_log_payload_bytes: logPayloadBytes,
    selected_conversation_payload_bytes: conversationPayloadBytes,
  };
}

function copyTable(db, tableName, windows) {
  const columns = visibleColumns(db, tableName);
  const columnList = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const target = quoteIdentifier(tableName);
  let sql = `INSERT INTO ${target} (${columnList}) SELECT ${columnList} FROM source.${target}`;
  let parameters = undefined;

  if (tableName === "daemon_log") {
    sql += ` WHERE ts >= @logs_all_after_ms
              OR (ts >= @logs_severe_after_ms AND level IN ('warn', 'error'))
             ORDER BY ts, id`;
    parameters = windows;
  } else if (tableName === "conversations") {
    sql += ` WHERE id IN (SELECT id FROM selected_conversation_ids)
             ORDER BY source_mtime, id`;
  } else if (tableName === "conversation_blocks") {
    sql += ` WHERE conversation_id IN (SELECT id FROM selected_conversation_ids)
             ORDER BY conversation_id, position, id`;
  } else {
    const primaryKey = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    if (primaryKey.length > 0) {
      sql += ` ORDER BY ${primaryKey.map((column) => quoteIdentifier(column.name)).join(", ")}`;
    }
  }

  const statement = db.prepare(sql);
  return parameters === undefined ? statement.run().changes : statement.run(parameters).changes;
}

function visibleColumns(db, tableName) {
  return db.pragma(`source.table_xinfo(${quoteIdentifier(tableName)})`)
    .filter((column) => Number(column.hidden ?? 0) === 0);
}

function copySqliteSequence(db, tables) {
  const hasSequence = db.prepare(
    "SELECT 1 AS present FROM source.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
  ).get();
  if (!hasSequence) return;
  const tableNames = new Set(tables.map((table) => table.name));
  const rows = db.prepare("SELECT name, seq FROM source.sqlite_sequence ORDER BY name").all();
  const insert = db.prepare("INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES (?, ?)");
  for (const row of rows) {
    if (tableNames.has(row.name)) insert.run(row.name, row.seq);
  }
}

function readProjectedCounts(db, hasLegacyDaemonLog) {
  return {
    daemon_log: hasLegacyDaemonLog
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get().count)
      : 0,
    conversations: Number(db.prepare("SELECT COUNT(*) AS count FROM conversations").get().count),
    conversation_blocks: Number(db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks").get().count),
  };
}

function normalizedForeignKeyViolations(db, schemaName) {
  const violations = db.pragma(`${schemaName}.foreign_key_check`);
  return violations.map((violation) => {
    const columns = db.pragma(`${schemaName}.table_info(${quoteIdentifier(violation.table)})`);
    const primaryKey = columns.filter((column) => Number(column.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk));
    let identity;
    if (primaryKey.length > 0) {
      const selected = primaryKey.map((column) => quoteIdentifier(column.name)).join(", ");
      identity = db.prepare(
        `SELECT ${selected} FROM ${schemaName}.${quoteIdentifier(violation.table)} WHERE rowid = ?`,
      ).get(violation.rowid) ?? { rowid: violation.rowid };
    } else {
      identity = { rowid: violation.rowid };
    }
    const normalized = {
      table: violation.table,
      parent: violation.parent,
      fkid: Number(violation.fkid),
      identity,
    };
    return { ...normalized, signature: JSON.stringify(normalized) };
  });
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function removeDatabaseArtifacts(dbPath) {
  for (const candidate of [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]) {
    removeIfExists(candidate);
  }
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv) {
  const options = {
    cutoffMs: null,
    help: false,
    json: false,
    manifest: null,
    output: null,
    replace: false,
    source: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--reserve-bytes":
      case "--max-output-bytes": {
        const field = arg === "--reserve-bytes" ? "reserveBytes" : "maxOutputBytes";
        options[field] = Number(requireValue(argv, ++index, arg));
        if (!Number.isSafeInteger(options[field]) || options[field] < 0) throw new Error(`Invalid ${arg} value`);
        break;
      }
      case "--staging-dir": options.stagingDir = requireValue(argv, ++index, arg); break;
      case "--source":
        options.source = requireValue(argv, ++index, arg);
        break;
      case "--output":
        options.output = requireValue(argv, ++index, arg);
        break;
      case "--manifest":
        options.manifest = requireValue(argv, ++index, arg);
        break;
      case "--cutoff-ms":
        options.cutoffMs = Number(requireValue(argv, ++index, arg));
        if (!Number.isSafeInteger(options.cutoffMs) || options.cutoffMs < 0) {
          throw new Error(`Invalid --cutoff-ms value: ${argv[index]}`);
        }
        break;
      case "--replace":
        options.replace = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.help && !options.output) throw new Error("--output is required");
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printUsage() {
  console.log(`Usage: bun scripts/project-db-snapshot.mjs --output PATH [options]

Create a deterministic compact Mandible database projection.

Options:
  --source PATH       Source database. Defaults to ~/.mandible/mandible.db.
  --output PATH       Final projected database path (required).
  --manifest PATH     Projection manifest path. Defaults to OUTPUT.manifest.json.
  --cutoff-ms VALUE   Explicit projection cutoff. Defaults to the source's newest log/conversation time.
  --replace           Atomically replace an existing output and manifest.
  --json              Print the manifest as JSON.
  -h, --help          Show this help.
`);
}

async function cli() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }
    const result = projectDatabaseSnapshot(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Projected database: ${result.output.path}`);
      console.log(`Manifest: ${result.output.manifest_path}`);
      console.log(`Size: ${result.output.size_bytes} bytes`);
      console.log(`Cutoff: ${result.projection.cutoff_ms}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`project-db-snapshot failed: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli();
}
