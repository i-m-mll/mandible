#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import {
  auditEscapedMarkdownBodies,
  normalizeEscapedMarkdownBodies,
  type MarkdownBodyAuditScope,
} from "../ledger/markdown-body.js";
import { systemAction } from "../identity/resolver.js";
import {
  exportIssueMarkdownFiles,
  type IssueMarkdownExportOptions,
} from "../ledger/issue-markdown-export.js";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".cache", "mandible", "mandible.db");

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
  const args = parseArgs(argv);
  if (!args.command || args.command === "help" || args.command === "-h" || args.command === "--help") {
    usage();
    return args.command ? 0 : 2;
  }

  const db = openDb(args.dbPath);
  try {
    if (args.command === "audit") {
      const result = auditEscapedMarkdownBodies(db, args.scope);
      printResult(result, args.json);
      return 0;
    }
    if (args.command === "normalize") {
      const result = normalizeEscapedMarkdownBodies(db, {
        apply: args.apply,
        scope: args.scope,
        normalize_all_matches: args.allMatches,
        actor: {
          actor_type: "system",
          author_display: "Mandible CLI",
          attribution: systemAction("markdown_normalize_cli"),
        },
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
    dbPath: process.env.MANDIBLE_DB || DEFAULT_DB_PATH,
    json: false,
    apply: false,
    allConfigured: false,
    allMatches: false,
    outDir: "",
    scope: {},
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--db":
        parsed.dbPath = requireValue(argv, ++index, "--db");
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--apply":
        parsed.apply = true;
        break;
      case "--all-configured":
        parsed.allConfigured = true;
        break;
      case "--all-matches":
        parsed.allMatches = true;
        break;
      case "--out-dir":
        parsed.outDir = requireValue(argv, ++index, "--out-dir");
        break;
      case "--issue":
        parsed.scope.issue_refs = [...(parsed.scope.issue_refs ?? []), requireValue(argv, ++index, "--issue")];
        break;
      case "--project":
        parsed.scope.project_refs = [...(parsed.scope.project_refs ?? []), requireValue(argv, ++index, "--project")];
        break;
      case "--repo":
        parsed.scope.repo_refs = [...(parsed.scope.repo_refs ?? []), requireValue(argv, ++index, "--repo")];
        break;
      case "--comment":
        parsed.scope.comment_ids = [...(parsed.scope.comment_ids ?? []), requireValue(argv, ++index, "--comment")];
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (parsed.command === "export" && !parsed.allConfigured && !parsed.outDir.trim()) {
    throw new Error("markdown export requires --out-dir unless --all-configured is used");
  }
  return parsed;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
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

function usage(): void {
  process.stdout.write(`Usage:
  mandible issue markdown audit [--issue <ref>] [--repo <ref>] [--project <ref>] [--comment <id>] [--json]
  mandible issue markdown normalize [--apply] [--issue <ref>|--repo <ref>|--project <ref>|--comment <id>|--all-matches] [--json]
  mandible issue markdown export --out-dir <dir> [--issue <ref>|--repo <ref>|--project <ref>] [--json]
  mandible issue markdown export --all-configured [--json]

Normalization defaults to dry-run. Applying normalization requires --apply and
explicit targets, or --all-matches for every current audit finding.
`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
