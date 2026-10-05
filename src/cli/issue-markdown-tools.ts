#!/usr/bin/env node
import { parseCommand, commandHelp, stringOption, flagOption, repeatedOption } from "./grammar.js";
import { getDbPath, openDb } from "../db.js";
import {
  auditEscapedMarkdownBodies,
  normalizeEscapedMarkdownBodies,
  type MarkdownBodyAuditScope,
} from "../ledger/markdown-body.js";
import { localProcessDefaultAttribution } from "../identity/resolver.js";
import {
  exportIssueMarkdownFiles,
  type IssueMarkdownExportOptions,
} from "../ledger/issue-markdown-export.js";

interface ParsedArgs {
  command: string;
  dbPath: string;
  json: boolean;
  apply: boolean;
  allConfigured: boolean;
  allMatches: boolean;
  outDir: string;
  scope: MarkdownBodyAuditScope;
}

function main(argv: string[]): number {
  if (!argv.length || argv[0] === "help") {
    usage();
    return argv.length ? 0 : 2;
  }
  const args = parseArgs(argv);

  const db = openDb(args.dbPath);
  try {
    if (args.command === "audit") {
      const result = auditEscapedMarkdownBodies(db, args.scope);
      printResult(result, args.json);
      return 0;
    }
    if (args.command === "normalize") {
      const result = args.apply
        ? normalizeEscapedMarkdownBodies(db, {
            apply: true,
            scope: args.scope,
            normalize_all_matches: args.allMatches,
            // Legacy actor tuple frozen to base ('mandible_user' + "Mandible CLI").
            // Real identity in the parallel columns is the local operator only in
            // a non-managed shell; run from a managed agent session it resolves to
            // the ambient agent or stays unattributed (issue a64d2de / 92813cc).
            actor: {
              actor_type: "mandible_user",
              author_display: "Mandible CLI",
              attribution: localProcessDefaultAttribution(db),
            },
          })
        : normalizeEscapedMarkdownBodies(db, {
            apply: false,
            scope: args.scope,
            normalize_all_matches: args.allMatches,
          });
      printResult(result, args.json);
      return 0;
    }
    if (args.command === "export") {
      const options: IssueMarkdownExportOptions = {
        out_dir: args.outDir,
        all_configured: args.allConfigured,
        issue_refs: args.scope.issue_refs,
        project_refs: args.scope.project_refs,
        repo_refs: args.scope.repo_refs,
      };
      const result = exportIssueMarkdownFiles(db, options);
      printResult(result, args.json);
      return 0;
    }
  } finally {
    db.close();
  }

  throw new Error(`Unknown markdown command: ${args.command}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0] ?? "",
    dbPath: getDbPath(),
    json: false,
    apply: false,
    allConfigured: false,
    allMatches: false,
    outDir: "",
    scope: {},
  };

  const input = parseCommand(["issue", "markdown"], argv);
  parsed.dbPath = stringOption(input, "db") ?? getDbPath();
  parsed.json = flagOption(input, "json"); parsed.apply = flagOption(input, "apply");
  parsed.allConfigured = flagOption(input, "all-configured"); parsed.allMatches = flagOption(input, "all-matches");
  parsed.outDir = stringOption(input, "out-dir") ?? "";
  parsed.scope = { issue_refs: repeatedOption(input, "issue"), project_refs: repeatedOption(input, "project"),
    repo_refs: repeatedOption(input, "repo"), comment_ids: repeatedOption(input, "comment") };

  if (parsed.command === "export" && !parsed.allConfigured && !parsed.outDir.trim()) {
    throw new Error("markdown export requires --out-dir unless --all-configured is used");
  }
  return parsed;
}



function printResult(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (isAuditResult(result)) {
    process.stdout.write(`findings: ${result.findings.length}\n`);
    process.stdout.write(`issue_bodies: ${result.counts.issue_bodies}\n`);
    process.stdout.write(`comments: ${result.counts.comments}\n`);
    if (isNormalizeResult(result)) {
      process.stdout.write(`applied: ${result.applied ? "yes" : "no"}\n`);
      process.stdout.write(`normalized: ${result.normalized}\n`);
    }
    for (const finding of result.findings) {
      process.stdout.write(
        `${finding.issue_display_id}\t${finding.entity_type}\t${finding.entity_id}\t`
          + `literal_newlines=${finding.detection.literal_newline_count}\t${finding.title}\n`,
      );
    }
    return;
  }
  if (isExportResult(result)) {
    process.stdout.write(`files: ${result.files.length}\n`);
    for (const file of result.files) {
      process.stdout.write(`${file.display_id}\t${file.path}\n`);
    }
  }
}

function isAuditResult(value: unknown): value is {
  findings: Array<{
    issue_display_id: string;
    entity_type: string;
    entity_id: string;
    detection: { literal_newline_count: number };
    title: string;
  }>;
  counts: { issue_bodies: number; comments: number };
} {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { findings?: unknown }).findings));
}

function isExportResult(value: unknown): value is { files: Array<{ display_id: string; path: string }> } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { files?: unknown }).files));
}

function isNormalizeResult(value: unknown): value is {
  applied: boolean;
  normalized: number;
} {
  return Boolean(
    value
      && typeof value === "object"
      && typeof (value as { applied?: unknown }).applied === "boolean"
      && typeof (value as { normalized?: unknown }).normalized === "number",
  );
}

function usage(): void { process.stdout.write(commandHelp(["issue", "markdown"])); }

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
