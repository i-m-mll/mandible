import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDbPath, openDb, type Db } from "../db.js";
import {
  runIssueReferenceBackfill,
  type IssueReferenceBackfillOptions,
  type IssueReferenceBackfillResult,
} from "../ledger/issue-reference-backfill.js";

interface CliOptions extends IssueReferenceBackfillOptions {
  apply: boolean;
  json: boolean;
  dbPath: string;
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const result = options.apply
    ? runApply(options)
    : await runDryRun(options);
  printResult(result, options.json);
}

function runApply(options: CliOptions): IssueReferenceBackfillResult {
  const db = openDb(options.dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    return runIssueReferenceBackfill(db, options, { dryRun: false });
  } finally {
    db.close();
  }
}

async function runDryRun(options: CliOptions): Promise<IssueReferenceBackfillResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-xref-backfill-"));
  const tempDbPath = path.join(tempDir, "mandible.db");
  let sourceDb: Db | null = openDb(options.dbPath);
  try {
    await sourceDb.backup(tempDbPath);
  } finally {
    sourceDb.close();
    sourceDb = null;
  }

  const db = openDb(tempDbPath);
  try {
    return runIssueReferenceBackfill(db, options, { dryRun: true });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    json: false,
    dbPath: getDbPath(),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--repo":
      case "--project":
        options.project = readValue(argv, ++index, arg);
        break;
      case "--issue":
        options.issue = readValue(argv, ++index, arg);
        break;
      case "--since":
        options.since = parseTime(readValue(argv, ++index, arg), arg);
        break;
      case "--until":
        options.until = parseTime(readValue(argv, ++index, arg), arg);
        break;
      case "--db":
        options.dbPath = readValue(argv, ++index, arg);
        break;
      case "-h":
      case "--help":
        usage(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.since !== undefined && options.until !== undefined && options.since > options.until) {
    throw new Error("--since must be earlier than or equal to --until.");
  }

  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parseTime(value: string, flag: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${flag} value '${value}'. Use an ISO date/time or epoch milliseconds.`);
  }
  return parsed;
}

function printResult(result: IssueReferenceBackfillResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write([
    `Issue reference backfill ${result.dry_run ? "dry run" : "applied"}`,
    `scope: project=${result.scope.project_id ?? "all"} issue=${result.scope.issue_id ?? "all"} since=${result.scope.since ?? "-"} until=${result.scope.until ?? "-"}`,
    `processed: issue_bodies=${result.processed.issue_bodies} comments=${result.processed.comments}`,
    `relationship_sources: ${result.before.relationship_sources} -> ${result.after.relationship_sources} (${formatDelta(result.delta.relationship_sources)})`,
    `active_sources: ${result.before.active_sources} -> ${result.after.active_sources} (${formatDelta(result.delta.active_sources)})`,
    `derived_refs: ${result.before.derived_refs} -> ${result.after.derived_refs} (${formatDelta(result.delta.derived_refs)})`,
    `events: ${result.before.events} -> ${result.after.events} (${formatDelta(result.delta.events)})`,
    `validation: bad_self_refs=${result.validation.bad_self_refs} dangling_targets=${result.validation.dangling_targets}`,
    "",
  ].join("\n"));
}

function formatDelta(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function usage(exitCode: number): never {
  process.stdout.write(`Usage:
  mandible issue refs backfill [--dry-run] [--apply] [--repo <repo>] [--issue <ref>] [--since <date>] [--until <date>] [--json]

Options:
  --dry-run          Run against a temporary SQLite backup (default)
  --apply            Write the backfill to the configured Mandible DB
  --repo <repo>      Scope to a project id, project display name, checkout name, or checkout root
  --issue <ref>      Scope to one issue, resolved with optional --repo context
  --since <date>     Only reanalyze issue/comment text updated at or after this ISO date or epoch ms
  --until <date>     Only reanalyze issue/comment text updated at or before this ISO date or epoch ms
  --json             Print machine-readable JSON
`);
  process.exit(exitCode);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
