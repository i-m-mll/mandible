import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AUTH_CHANGE_REPORT_FILE_ROLE_PRECEDENCE,
  type AuthChangeFile,
  type AuthChangeFileRole,
  type AuthChangeFileType,
  type AuthChangeKind,
  type AuthChangeReport,
} from "./contracts.js";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_FILES = 10_000;
const RENAME_SIMILARITY_PERCENT = 50 as const;
const RENAME_LIMIT = 10_000;
const ZERO_OID = /^0+$/;

type RawChange = {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: string;
  oldPath: string | null;
  newPath: string | null;
};

type Numstat = {
  additions: number | null;
  deletions: number | null;
  oldPath: string | null;
  newPath: string | null;
};

type Attributes = Map<string, Map<string, string>>;
type IsolatedGit = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  gitDir: string;
};

export class AuthChangeReportCollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthChangeReportCollectionError";
  }
}

export function collectAuthChangeReport(
  repoRoot: string,
  comparison: AuthChangeReport["comparison"],
): AuthChangeReport {
  const git = createIsolatedGit(repoRoot);
  try {
    return collectFromGit(git, comparison);
  } finally {
    fs.rmSync(git.gitDir, { recursive: true, force: true });
  }
}

function collectFromGit(
  git: IsolatedGit,
  comparison: AuthChangeReport["comparison"],
): AuthChangeReport {
  const diffArgs = [
    "--no-ext-diff",
    "--no-textconv",
    "--diff-algorithm=myers",
    "-M50%",
    "-C50%",
    `-l${RENAME_LIMIT}`,
    "--ignore-submodules=none",
    comparison.merge_base_sha,
    comparison.head_sha,
    "--",
  ];
  const gitPrefix = [`--attr-source=${comparison.head_sha}`];
  const raw = parseRawChanges(runGit(git, [...gitPrefix, "diff", "--raw", "--no-abbrev", "-z", ...diffArgs]));
  if (raw.length > MAX_REPORT_FILES) {
    throw new AuthChangeReportCollectionError(
      `Auth change report has ${raw.length} files; the v1 limit is ${MAX_REPORT_FILES}. Split the candidate before submission.`,
    );
  }
  const numstats = parseNumstats(runGit(git, [...gitPrefix, "diff", "--numstat", "-z", ...diffArgs]));
  const statsByPath = new Map(numstats.map((stat) => [pathPairKey(stat.oldPath, stat.newPath), stat]));
  if (statsByPath.size !== numstats.length || numstats.length !== raw.length) {
    throw new AuthChangeReportCollectionError(
      "Git raw and line-stat inventories did not reconcile; no auth change report was captured.",
    );
  }

  const headPaths: string[] = [];
  const basePaths: string[] = [];
  for (const change of raw) {
    if (change.newPath !== null && !ZERO_OID.test(change.newOid)) headPaths.push(change.newPath);
    else if (change.oldPath !== null) basePaths.push(change.oldPath);
  }
  const attributes = mergeAttributes(
    readCommittedAttributes(git, comparison.head_sha, headPaths),
    readCommittedAttributes(git, comparison.merge_base_sha, basePaths),
  );
  const objectSizes = readBlobSizes(git, raw);

  const files = raw.map((change): AuthChangeFile => {
    const stat = statsByPath.get(rawPathPairKey(change));
    if (!stat) {
      throw new AuthChangeReportCollectionError(
        `Git omitted line statistics for ${JSON.stringify(change.newPath ?? change.oldPath)}.`,
      );
    }
    const fileTypeBefore = fileType(change.oldMode);
    const fileTypeAfter = fileType(change.newMode);
    const classificationPath = change.newPath ?? change.oldPath;
    if (classificationPath === null) {
      throw new AuthChangeReportCollectionError("Git reported a changed file without a path.");
    }
    const attrs = attributes.get(classificationPath) ?? new Map<string, string>();
    const gitlink = fileTypeBefore === "gitlink" || fileTypeAfter === "gitlink";
    return {
      old_path: change.oldPath,
      new_path: change.newPath,
      change_kind: changeKind(change.status),
      file_type_before: fileTypeBefore,
      file_type_after: fileTypeAfter,
      additions: gitlink ? null : stat.additions,
      deletions: gitlink ? null : stat.deletions,
      bytes_before: blobSize(change.oldOid, fileTypeBefore, objectSizes),
      bytes_after: blobSize(change.newOid, fileTypeAfter, objectSizes),
      language: classifyLanguage(classificationPath, attrs.get("linguist-language")),
      file_role: classifyFileRole(classificationPath),
      generated: classifyFlag(
        attrs.get("linguist-generated"),
        pathSegments(classificationPath).some((part) => GENERATED_SEGMENTS.has(part)),
      ),
      vendor: classifyFlag(
        attrs.get("linguist-vendored"),
        pathSegments(classificationPath).some((part) => VENDOR_SEGMENTS.has(part)),
      ),
    };
  }).sort(compareFiles);

  const totals = files.reduce<AuthChangeReport["totals"]>((sum, file) => {
    sum.files += 1;
    if (file.additions === null || file.deletions === null) {
      if (file.file_type_before !== "gitlink" && file.file_type_after !== "gitlink") {
        sum.binary_files += 1;
      }
    } else {
      sum.text_files += 1;
      sum.additions += file.additions;
      sum.deletions += file.deletions;
    }
    return sum;
  }, { files: 0, additions: 0, deletions: 0, text_files: 0, binary_files: 0 });

  return {
    schema: "mandible-auth-change-report@1",
    classifier_version: "mandible-auth-change-classifier@1",
    rules_version: "mandible-auth-change-rules@1",
    comparison,
    rename_similarity_percent: RENAME_SIMILARITY_PERCENT,
    totals,
    files,
  };
}

function createIsolatedGit(repoRoot: string): IsolatedGit {
  const probe = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "objects"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    },
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  const objectDirectory = probe.status === 0 ? probe.stdout.trim() : "";
  if (!objectDirectory || probe.error) {
    throw new AuthChangeReportCollectionError(
      `Unable to locate the repository object store: ${probe.error?.message ?? (probe.stderr.trim() || "git returned no path")}`,
    );
  }
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-report-git-"));
  try {
    if (objectDirectory.includes("\n")) {
      throw new AuthChangeReportCollectionError("Repository object-store path contains a newline.");
    }
    fs.mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${objectDirectory}\n`, "utf8");
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/unborn\n", "utf8");
    fs.writeFileSync(
      path.join(gitDir, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
      "utf8",
    );
    return {
      cwd: repoRoot,
      gitDir,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
      },
    };
  } catch (error) {
    fs.rmSync(gitDir, { recursive: true, force: true });
    throw error;
  }
}

function runGit(git: IsolatedGit, args: string[], input?: Buffer): Buffer {
  const result = spawnSync("git", args, {
    cwd: git.cwd,
    env: git.env,
    input,
    encoding: null,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
  });
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
  if (result.error || result.status !== 0 || stderr) {
    const detail = result.error?.message ?? (stderr || `exit status ${result.status ?? "unknown"}`);
    throw new AuthChangeReportCollectionError(
      `Unable to capture auth change report (${args.slice(0, 2).join(" ")}): ${detail}`,
    );
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
}

function nulFields(value: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    fields.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) {
    throw new AuthChangeReportCollectionError("Git emitted a non-NUL-terminated path inventory.");
  }
  if (fields.at(-1)?.length === 0) fields.pop();
  return fields;
}

function gitPath(value: Buffer): string {
  const decoded = value.toString("utf8");
  if (Buffer.from(decoded, "utf8").compare(value) !== 0) {
    throw new AuthChangeReportCollectionError(
      "A changed path is not valid UTF-8 and cannot be represented losslessly in the JSON report.",
    );
  }
  return decoded;
}

function parseRawChanges(output: Buffer): RawChange[] {
  const fields = nulFields(output);
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++].toString("ascii");
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header);
    if (!match) throw new AuthChangeReportCollectionError(`Invalid git raw record: ${JSON.stringify(header)}.`);
    const status = match[5];
    const firstPath = fields[index++];
    if (!firstPath) throw new AuthChangeReportCollectionError("Git raw record omitted its first path.");
    const first = gitPath(firstPath);
    const paired = status === "R" || status === "C";
    const secondPath = paired ? fields[index++] : null;
    if (paired && !secondPath) throw new AuthChangeReportCollectionError("Git rename/copy record omitted its destination path.");
    const second = secondPath ? gitPath(secondPath) : null;
    changes.push({
      oldMode: match[1],
      newMode: match[2],
      oldOid: match[3],
      newOid: match[4],
      status,
      oldPath: status === "A" ? null : first,
      newPath: status === "D" ? null : paired ? second : first,
    });
  }
  return changes;
}

function parseNumstats(output: Buffer): Numstat[] {
  const fields = nulFields(output);
  const stats: Numstat[] = [];
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    const firstTab = record.indexOf(9);
    const secondTab = firstTab < 0 ? -1 : record.indexOf(9, firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new AuthChangeReportCollectionError("Invalid git numstat record.");
    }
    const additions = parseLineCount(record.subarray(0, firstTab));
    const deletions = parseLineCount(record.subarray(firstTab + 1, secondTab));
    const inlinePath = record.subarray(secondTab + 1);
    if (inlinePath.length > 0) {
      const pathValue = gitPath(inlinePath);
      stats.push({ additions, deletions, oldPath: pathValue, newPath: pathValue });
      continue;
    }
    const oldPath = fields[index++];
    const newPath = fields[index++];
    if (!oldPath || !newPath) {
      throw new AuthChangeReportCollectionError("Git rename/copy numstat omitted a path.");
    }
    stats.push({ additions, deletions, oldPath: gitPath(oldPath), newPath: gitPath(newPath) });
  }
  return stats;
}

function parseLineCount(value: Buffer): number | null {
  const text = value.toString("ascii");
  if (text === "-") return null;
  if (!/^\d+$/.test(text)) throw new AuthChangeReportCollectionError(`Invalid git line count ${JSON.stringify(text)}.`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new AuthChangeReportCollectionError("Git line count exceeds JavaScript's safe integer range.");
  return parsed;
}

function pathPairKey(oldPath: string | null, newPath: string | null): string {
  return `${oldPath ?? ""}\0${newPath ?? ""}`;
}

function rawPathPairKey(change: RawChange): string {
  if (change.status === "R" || change.status === "C") {
    return pathPairKey(change.oldPath, change.newPath);
  }
  const file = change.newPath ?? change.oldPath;
  return pathPairKey(file, file);
}

function fileType(mode: string): AuthChangeFileType {
  if (mode === "000000") return "absent";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  if (mode.startsWith("100")) return "blob";
  throw new AuthChangeReportCollectionError(`Unsupported git file mode ${mode}.`);
}

function changeKind(status: string): AuthChangeKind {
  switch (status) {
    case "A": return "added";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type_changed";
    default: throw new AuthChangeReportCollectionError(`Unsupported git change status ${status}.`);
  }
}

function readBlobSizes(git: IsolatedGit, changes: RawChange[]): Map<string, number> {
  const oids = [...new Set(changes.flatMap((change) => [
    fileType(change.oldMode) === "gitlink" || ZERO_OID.test(change.oldOid) ? null : change.oldOid,
    fileType(change.newMode) === "gitlink" || ZERO_OID.test(change.newOid) ? null : change.newOid,
  ]).filter((oid): oid is string => oid !== null))].sort();
  if (oids.length === 0) return new Map();
  const output = runGit(git, ["cat-file", "--batch-check"], Buffer.from(`${oids.join("\n")}\n`, "ascii"));
  const lines = output.toString("utf8").trimEnd().split("\n");
  if (lines.length !== oids.length) throw new AuthChangeReportCollectionError("Git object-size inventory was incomplete.");
  const sizes = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(lines[index]);
    if (!match || match[1] !== oids[index]) {
      throw new AuthChangeReportCollectionError(`Unexpected git object-size record: ${JSON.stringify(lines[index])}.`);
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size)) throw new AuthChangeReportCollectionError("Git object size exceeds JavaScript's safe integer range.");
    sizes.set(match[1], size);
  }
  return sizes;
}

function blobSize(oid: string, type: AuthChangeFileType, sizes: Map<string, number>): number | null {
  if (type === "absent" || type === "gitlink") return null;
  const size = sizes.get(oid);
  if (size === undefined) throw new AuthChangeReportCollectionError(`Git omitted object size for ${oid}.`);
  return size;
}

function readCommittedAttributes(git: IsolatedGit, source: string, paths: string[]): Attributes {
  if (paths.length === 0) return new Map();
  const uniquePaths = [...new Set(paths)].sort(compareUtf8);
  const output = runGit(
    git,
    ["check-attr", `--source=${source}`, "-z", "--stdin", "linguist-language", "linguist-generated", "linguist-vendored"],
    Buffer.concat(uniquePaths.flatMap((file) => [Buffer.from(file, "utf8"), Buffer.from([0])])),
  );
  const fields = nulFields(output);
  if (fields.length % 3 !== 0) throw new AuthChangeReportCollectionError("Git attribute inventory was incomplete.");
  const attributes: Attributes = new Map();
  for (let index = 0; index < fields.length; index += 3) {
    const file = gitPath(fields[index]);
    const name = fields[index + 1].toString("utf8");
    const value = fields[index + 2].toString("utf8");
    const record = attributes.get(file) ?? new Map<string, string>();
    record.set(name, value);
    attributes.set(file, record);
  }
  return attributes;
}

function mergeAttributes(...sets: Attributes[]): Attributes {
  const merged: Attributes = new Map();
  for (const set of sets) for (const [file, values] of set) merged.set(file, values);
  return merged;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".bash": "Shell", ".c": "C", ".cc": "C++", ".cfg": "Configuration", ".conf": "Configuration",
  ".cpp": "C++", ".cs": "C#", ".css": "CSS", ".csv": "CSV", ".fish": "Shell", ".go": "Go",
  ".h": "C", ".hpp": "C++", ".html": "HTML", ".ini": "Configuration", ".java": "Java",
  ".js": "JavaScript", ".json": "JSON", ".jsonc": "JSON with Comments", ".jsx": "JavaScript JSX",
  ".kt": "Kotlin", ".kts": "Kotlin", ".less": "Less", ".md": "Markdown", ".mdx": "MDX",
  ".php": "PHP", ".ps1": "PowerShell", ".py": "Python", ".rb": "Ruby", ".rs": "Rust",
  ".rst": "reStructuredText", ".sass": "Sass", ".scala": "Scala", ".scss": "SCSS", ".sh": "Shell",
  ".sql": "SQL", ".svelte": "Svelte", ".swift": "Swift", ".toml": "TOML", ".ts": "TypeScript",
  ".tsx": "TypeScript JSX", ".tsv": "TSV", ".txt": "Text", ".vue": "Vue", ".xml": "XML",
  ".yaml": "YAML", ".yml": "YAML", ".zsh": "Shell",
});
const LANGUAGE_BY_BASENAME: Readonly<Record<string, string>> = Object.freeze({
  dockerfile: "Dockerfile", makefile: "Makefile", rakefile: "Ruby", gemfile: "Ruby",
});
const IMPLEMENTATION_EXTENSIONS = new Set([
  ".bash", ".c", ".cc", ".cpp", ".cs", ".css", ".fish", ".go", ".h", ".hpp", ".html", ".java",
  ".js", ".jsx", ".kt", ".kts", ".less", ".php", ".ps1", ".py", ".rb", ".rs", ".sass", ".scala",
  ".scss", ".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue", ".zsh",
]);
const DOCUMENTATION_EXTENSIONS = new Set([".md", ".mdx", ".rst"]);
const CONFIGURATION_EXTENSIONS = new Set([".cfg", ".conf", ".ini", ".json", ".jsonc", ".toml", ".xml", ".yaml", ".yml"]);
const DATA_EXTENSIONS = new Set([".csv", ".tsv"]);
const GENERATED_SEGMENTS = new Set(["generated", "gen"]);
const VENDOR_SEGMENTS = new Set(["vendor", "vendors", "third_party", "node_modules"]);

function classifyLanguage(file: string, attribute: string | undefined): string {
  if (attribute && !["unspecified", "unset", "set"].includes(attribute)) return attribute;
  const basename = path.posix.basename(file).toLowerCase();
  return LANGUAGE_BY_BASENAME[basename] ?? LANGUAGE_BY_EXTENSION[path.posix.extname(basename)] ?? "Unknown";
}

function classifyFileRole(file: string): AuthChangeFileRole {
  const segments = pathSegments(file);
  const basename = segments.at(-1) ?? "";
  const extension = path.posix.extname(basename);
  const rules: Record<AuthChangeFileRole, boolean> = {
    fixtures_data: segments.some((part) => ["fixture", "fixtures", "__fixtures__", "testdata", "test-data", "data"].includes(part)) || DATA_EXTENSIONS.has(extension),
    tests: segments.some((part) => ["test", "tests", "__tests__", "spec", "specs"].includes(part)) || /(?:^|\.)(?:test|spec)\.[^.]+$/.test(basename),
    documentation: segments.some((part) => ["doc", "docs", "documentation"].includes(part)) || /^readme(?:\.|$)/.test(basename) || DOCUMENTATION_EXTENSIONS.has(extension),
    configuration: segments.some((part) => ["config", "configs", ".github"].includes(part)) || basename.startsWith(".") || CONFIGURATION_EXTENSIONS.has(extension),
    implementation: segments.some((part) => ["src", "lib", "app", "packages"].includes(part)) || IMPLEMENTATION_EXTENSIONS.has(extension),
    other: true,
  };
  return AUTH_CHANGE_REPORT_FILE_ROLE_PRECEDENCE.find((role) => rules[role]) ?? "other";
}

function pathSegments(file: string): string[] {
  return file.toLowerCase().split("/").filter(Boolean);
}

function classifyFlag(attribute: string | undefined, inferred: boolean): boolean {
  if (["unset", "false", "0", "no"].includes(attribute ?? "")) return false;
  if (["set", "true", "1", "yes"].includes(attribute ?? "")) return true;
  if (attribute !== undefined && attribute !== "unspecified") return true;
  return inferred;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareFiles(left: AuthChangeFile, right: AuthChangeFile): number {
  return compareUtf8(left.new_path ?? left.old_path ?? "", right.new_path ?? right.old_path ?? "")
    || compareUtf8(left.old_path ?? "", right.old_path ?? "");
}
