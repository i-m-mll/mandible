import { parseCommand, stringOption, flagOption } from "./grammar.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDbPath, openDb, type Db } from "../db.js";
import { localProcessDefaultAttribution } from "../identity/resolver.js";
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
    return runIssueReferenceBackfill(db, options, {
      dryRun: false,
      actor: {
        // Preserve the historical stable-ID tuple; the parallel attribution
        // records the operator only in a non-managed shell, else the ambient
        // agent or unattributed (issue a64d2de).
        actor_type: "system",
        attribution: localProcessDefaultAttribution(db),
      },
    });
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
    return runIssueReferenceBackfill(db, options, {
      dryRun: true,
      actor: {
        actor_type: "system",
        attribution: localProcessDefaultAttribution(db),
      },
    });
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

  const parsed = parseCommand(["issue", "refs", "backfill"], argv);
  options.apply = flagOption(parsed, "apply"); options.json = flagOption(parsed, "json");
  options.dbPath = stringOption(parsed, "db") ?? getDbPath();
  options.project = stringOption(parsed, "repo", "project"); options.issue = stringOption(parsed, "issue");
  const since = stringOption(parsed, "since"), until = stringOption(parsed, "until");
  options.since = since === undefined ? undefined : parseTime(since, "--since");
  options.until = until === undefined ? undefined : parseTime(until, "--until");

  if (options.since !== undefined && options.until !== undefined && options.since > options.until) {
    throw new Error("--since must be earlier than or equal to --until.");
  }

  return options;
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


main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
