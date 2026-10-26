import { spawn, spawnSync } from "node:child_process";
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
const MAX_DIFF_PREVIEW_BYTES = 102_400;
const MAX_DIFF_PREVIEW_READ_BYTES = MAX_DIFF_PREVIEW_BYTES + 1;
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

export type AuthMergeReviewCollection = {
  report?: AuthChangeReport;
  diffSummary?: string;
};

export type AuthMergeReviewCollectionResult =
  | { ok: true; value: AuthMergeReviewCollection }
  | { ok: false; error: AuthMergeReviewCollectionError };

export type AuthMergeReviewCollectionError =
  | { kind: "git_failed"; operation: string; message: string }
  | { kind: "invalid_git_output"; message: string }
  | { kind: "limit_exceeded"; files: number; limit: number; message: string }
  | { kind: "environment_failed"; message: string };

export type AuthMergeReviewCollectionOptions = {
  report?: boolean;
  diffSummary?: boolean;
};

class AuthChangeReportCollectionError extends Error {
  readonly result: AuthMergeReviewCollectionError;

  constructor(result: AuthMergeReviewCollectionError | string) {
    const normalized = typeof result === "string"
      ? { kind: "invalid_git_output" as const, message: result }
      : result;
    super(normalized.message);
    this.name = "AuthChangeReportCollectionError";
    this.result = normalized;
  }
}

export async function collectAuthMergeReview(
  repoRoot: string,
  comparison: AuthChangeReport["comparison"],
  options: AuthMergeReviewCollectionOptions = { report: true, diffSummary: true },
): Promise<AuthMergeReviewCollectionResult> {
  let gitDir: string | null = null;
  let value: AuthMergeReviewCollection | null = null;
  let failure: unknown = null;
  try {
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-report-git-"));
    const git = createIsolatedGit(repoRoot, gitDir);
    const diffArgs = pinnedDiffArgs(comparison);
    value = {};
    if (options.report !== false) value.report = await collectReportFromGit(git, comparison, diffArgs);
    if (options.diffSummary !== false) {
      value.diffSummary = await readBoundedDiffPreview(git, comparison.head_sha, diffArgs);
    }
  } catch (error) {
    failure = error;
  }
  if (gitDir) {
    try {
      fs.rmSync(gitDir, { recursive: true, force: true });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    return {
      ok: false,
      error: failure instanceof AuthChangeReportCollectionError
        ? failure.result
        : {
          kind: "environment_failed",
          message: `Unable to capture auth merge review: ${failure instanceof Error ? failure.message : String(failure)}`,
        },
    };
  }
  return { ok: true, value: value ?? {} };
}

function pinnedDiffArgs(comparison: AuthChangeReport["comparison"]): string[] {
  return [
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
}

async function collectReportFromGit(
  git: IsolatedGit,
  comparison: AuthChangeReport["comparison"],
  diffArgs: string[],
): Promise<AuthChangeReport> {
  const gitPrefix = [`--attr-source=${comparison.head_sha}`];
  const raw = parseRawChanges(runGit(git, [...gitPrefix, "diff", "--raw", "--no-abbrev", "-z", ...diffArgs]));
  if (raw.length > MAX_REPORT_FILES) {
    throw new AuthChangeReportCollectionError({
      kind: "limit_exceeded",
      files: raw.length,
      limit: MAX_REPORT_FILES,
      message: `Auth change report has ${raw.length} files; the v1 limit is ${MAX_REPORT_FILES}. Split the candidate before submission.`,
    });
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
  const scriptLanguages = await readScriptLanguages(git, raw, objectSizes);

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
    const scriptLanguage = scriptLanguages.get(change.newPath === null ? change.oldOid : change.newOid);
    const format = filenameFormat(classificationPath)
      ?? (scriptLanguage ? { language: scriptLanguage, role: "implementation" as const } : undefined);
    const language = classifyLanguage(format, attrs.get("linguist-language"));
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
      language,
      file_role: classifyFileRole(classificationPath, format, language),
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
    classifier_version: "mandible-auth-change-classifier@2",
    rules_version: "mandible-auth-change-rules@2",
    comparison,
    rename_similarity_percent: RENAME_SIMILARITY_PERCENT,
    totals,
    files,
  };
}

function createIsolatedGit(repoRoot: string, gitDir: string): IsolatedGit {
  const environmentRoot = path.join(gitDir, "environment");
  const probeEnv = isolatedGitEnvironment(environmentRoot);
  const probe = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "objects"], {
    cwd: repoRoot,
    env: probeEnv,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  const objectDirectory = probe.status === 0 ? probe.stdout.trim() : "";
  if (!objectDirectory || probe.error) {
    throw new AuthChangeReportCollectionError({
      kind: "git_failed",
      operation: "rev-parse object store",
      message: `Unable to locate the repository object store: ${probe.error?.message ?? (probe.stderr.trim() || "git returned no path")}`,
    });
  }
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
    env: { ...probeEnv, GIT_DIR: gitDir },
  };
}

function isolatedGitEnvironment(environmentRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const home = path.join(environmentRoot, "home");
  const xdg = path.join(environmentRoot, "xdg");
  const emptyConfig = path.join(environmentRoot, "empty.gitconfig");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  fs.writeFileSync(emptyConfig, "", "utf8");
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
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
    throw new AuthChangeReportCollectionError({
      kind: "git_failed",
      operation: args.slice(0, 2).join(" "),
      message: `Unable to capture auth change report (${args.slice(0, 2).join(" ")}): ${detail}`,
    });
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
}

function readBoundedDiffPreview(git: IsolatedGit, attributeSource: string, diffArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytesRead = 0;
    let truncated = false;
    let timedOut = false;
    const child = spawn(
      "git",
      [`--attr-source=${attributeSource}`, "diff", "--patch", ...diffArgs],
      { cwd: git.cwd, env: git.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_DIFF_PREVIEW_READ_BYTES - bytesRead;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, Math.max(remaining, 0)));
        bytesRead += remaining;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
      bytesRead += chunk.length;
      if (bytesRead >= MAX_DIFF_PREVIEW_READ_BYTES) {
        truncated = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderrChunks).length < 4096) stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new AuthChangeReportCollectionError({
          kind: "git_failed",
          operation: "diff preview",
          message: "Timed out while collecting auth merge diff preview.",
        }));
        return;
      }
      if (code !== 0 && !truncated) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new AuthChangeReportCollectionError({
          kind: "git_failed",
          operation: "diff preview",
          message: stderr ? `Unable to collect auth merge diff preview: ${stderr}` : "Unable to collect auth merge diff preview.",
        }));
        return;
      }
      const preview = Buffer.concat(chunks).subarray(0, MAX_DIFF_PREVIEW_BYTES).toString("utf8");
      resolve(truncated
        ? `${preview}\n... [truncated: diff preview exceeded ${MAX_DIFF_PREVIEW_BYTES} bytes]`
        : preview);
    });
  });
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

/** Stream pinned blobs once, retaining only bounded first-line evidence for extensionless regular files. */
async function readScriptLanguages(git: IsolatedGit, changes: RawChange[], sizes: Map<string, number>): Promise<Map<string, string>> {
  const oids = [...new Set(changes.flatMap(change => {
    const file = change.newPath ?? change.oldPath;
    const mode = change.newPath === null ? change.oldMode : change.newMode;
    if (!file || fileType(mode) !== "blob" || path.posix.extname(file) || filenameFormat(file)) return [];
    return [change.newPath === null ? change.oldOid : change.newOid];
  }))].sort();
  const languages = new Map<string, string>();
  if (oids.length === 0) return languages;
  const totalBytes = oids.reduce((sum, oid) => sum + (sizes.get(oid) ?? 0) + oid.length + 32, 0);
  if (totalBytes > GIT_MAX_OUTPUT_BYTES) {
    throw new AuthChangeReportCollectionError("Extensionless script evidence exceeds the 64 MiB capture limit. Split the candidate before submission.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd: git.cwd, env: git.env, stdio: ["pipe", "pipe", "pipe"] });
    let failure: Error | null = null;
    const fail = (error: Error) => { failure ??= error; child.kill("SIGTERM"); };
    const timer = setTimeout(() => fail(new AuthChangeReportCollectionError("Timed out reading committed script evidence.")), GIT_TIMEOUT_MS);
    let index = 0;
    let remaining: number | null = null;
    let header = "";
    let prefix = Buffer.alloc(0);
    let firstLineComplete = false;
    let separator = false;
    let bytesRead = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      bytesRead += chunk.length;
      if (bytesRead > GIT_MAX_OUTPUT_BYTES) { fail(new AuthChangeReportCollectionError("Script evidence output exceeded its capture limit.")); return; }
      let offset = 0;
      while (offset < chunk.length && !failure) {
        if (separator) {
          if (chunk[offset++] !== 10) { fail(new AuthChangeReportCollectionError("Invalid script blob terminator.")); return; }
          const language = shebangLanguage(prefix.toString("utf8"));
          if (language) languages.set(oids[index], language);
          index += 1;
          separator = false;
          remaining = null;
          prefix = Buffer.alloc(0);
          firstLineComplete = false;
        } else if (remaining === null) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          header += chunk.subarray(offset, end).toString("ascii");
          offset = end + (newline < 0 ? 0 : 1);
          if (header.length > 200) { fail(new AuthChangeReportCollectionError("Invalid script blob header.")); return; }
          if (newline < 0) continue;
          if (index >= oids.length || header !== `${oids[index]} blob ${sizes.get(oids[index])}`) {
            fail(new AuthChangeReportCollectionError("Script blob inventory did not match pinned objects.")); return;
          }
          remaining = sizes.get(oids[index])!;
          header = "";
          separator = remaining === 0;
        } else {
          const count = Math.min(remaining, chunk.length - offset);
          if (!firstLineComplete && prefix.length < 4096) {
            const content = chunk.subarray(offset, offset + Math.min(count, 4096 - prefix.length));
            const newline = content.indexOf(10);
            prefix = Buffer.concat([prefix, newline < 0 ? content : content.subarray(0, newline)]);
            firstLineComplete = newline >= 0;
          }
          remaining -= count;
          offset += count;
          separator = remaining === 0;
        }
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(0, 4096); });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || stderr || index !== oids.length || header || remaining !== null) {
        reject(new AuthChangeReportCollectionError(`Unable to read committed script evidence: ${stderr || "incomplete blob inventory"}`));
      } else resolve();
    });
    child.stdin.end(`${oids.join("\n")}\n`);
  });
  return languages;
}

function shebangLanguage(line: string): string | undefined {
  if (!line.startsWith("#!")) return undefined;
  const tokens = line.slice(2).trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map(token => token.replace(/^["']|["']$/g, "")) ?? [];
  let interpreter = tokens.shift() ?? "";
  if (path.posix.basename(interpreter) === "env") {
    while (tokens.length) {
      const token = tokens.shift()!;
      if (["-u", "--unset", "-C", "--chdir"].includes(token)) { tokens.shift(); continue; }
      if (token === "-S" || token === "--split-string") {
        tokens.unshift(...tokens.splice(0).flatMap(part => part.split(/\s+/)));
        continue;
      }
      if (token.startsWith("-") || /^[A-Za-z_][A-Za-z_0-9]*=/.test(token)) continue;
      interpreter = token;
      break;
    }
  }
  const name = path.posix.basename(interpreter);
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) return "Python";
  if (/^(?:ba|da|k|z)?sh$/.test(name) || name === "fish") return "Shell";
  if (/^(?:node(?:js)?|bun|deno)$/.test(name)) return "JavaScript";
  if (/^ruby(?:\d+(?:\.\d+)*)?$/.test(name)) return "Ruby";
  if (name === "perl") return "Perl";
  if (name === "php") return "PHP";
  if (/^lua(?:\d+(?:\.\d+)*)?$/.test(name)) return "Lua";
  if (name === "Rscript") return "R";
  if (name === "swift") return "Swift";
  return undefined;
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

type FileFormat = { language: string; role: AuthChangeFileRole };

function formats(role: AuthChangeFileRole, entries: Record<string, string>): Record<string, FileFormat> {
  return Object.fromEntries(Object.entries(entries).map(([key, language]) => [key, { language, role }]));
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, FileFormat>> = Object.freeze({
  ...formats("implementation", {
    ".bash": "Shell", ".c": "C", ".cc": "C++", ".cpp": "C++", ".cs": "C#", ".css": "CSS",
    ".fish": "Shell", ".go": "Go", ".h": "C", ".hpp": "C++", ".html": "HTML", ".java": "Java",
    ".js": "JavaScript", ".jsx": "JavaScript JSX", ".kt": "Kotlin", ".kts": "Kotlin", ".less": "Less",
    ".php": "PHP", ".ps1": "PowerShell", ".py": "Python", ".rb": "Ruby", ".rs": "Rust",
    ".sass": "Sass", ".scala": "Scala", ".scss": "SCSS", ".sh": "Shell", ".sql": "SQL",
    ".svelte": "Svelte", ".swift": "Swift", ".ts": "TypeScript", ".tsx": "TypeScript JSX",
    ".vue": "Vue", ".zsh": "Shell",
  }),
  ...formats("documentation", { ".md": "Markdown", ".mdx": "MDX", ".rst": "reStructuredText" }),
  ...formats("configuration", {
    ".cfg": "Configuration", ".conf": "Configuration", ".ini": "Configuration", ".json": "JSON",
    ".jsonc": "JSON with Comments", ".toml": "TOML", ".xml": "XML", ".yaml": "YAML", ".yml": "YAML",
  }),
  ...formats("fixtures_data", { ".csv": "CSV", ".tsv": "TSV" }),
  ...formats("other", { ".txt": "Text" }),
});
const FORMAT_BY_BASENAME: Readonly<Record<string, FileFormat>> = Object.freeze({
  ...formats("configuration", { dockerfile: "Dockerfile", makefile: "Makefile" }),
  ...formats("implementation", { rakefile: "Ruby", gemfile: "Ruby" }),
});
const IMPLEMENTATION_LANGUAGES = new Set(Object.values(FORMAT_BY_EXTENSION)
  .filter(format => format.role === "implementation").map(format => format.language.toLowerCase()));
const GENERATED_SEGMENTS = new Set(["generated", "gen"]);
const VENDOR_SEGMENTS = new Set(["vendor", "vendors", "third_party", "node_modules"]);

function filenameFormat(file: string): FileFormat | undefined {
  const basename = path.posix.basename(file).toLowerCase();
  const name = basename.endsWith(".template") ? basename.slice(0, -".template".length) : basename;
  return FORMAT_BY_BASENAME[name] ?? FORMAT_BY_EXTENSION[path.posix.extname(name)];
}

function classifyLanguage(format: FileFormat | undefined, attribute: string | undefined): string {
  if (attribute && !["unspecified", "unset", "set"].includes(attribute)) return attribute;
  return format?.language ?? "Unknown";
}

function classifyFileRole(file: string, format: FileFormat | undefined, language: string): AuthChangeFileRole {
  const segments = pathSegments(file);
  const basename = segments.at(-1) ?? "";
  const rules: Record<AuthChangeFileRole, boolean> = {
    fixtures_data: segments.some((part) => ["fixture", "fixtures", "__fixtures__", "testdata", "test-data", "data"].includes(part)) || format?.role === "fixtures_data",
    tests: segments.some((part) => ["test", "tests", "__tests__", "spec", "specs"].includes(part)) || /(?:^|\.)(?:test|spec)\.[^.]+$/.test(basename),
    documentation: segments.some((part) => ["doc", "docs", "documentation"].includes(part)) || /^readme(?:\.|$)/.test(basename) || format?.role === "documentation",
    configuration: segments.some((part) => ["config", "configs", ".github"].includes(part)) || basename.startsWith(".") || format?.role === "configuration",
    implementation: format?.role === "implementation" || IMPLEMENTATION_LANGUAGES.has(language.toLowerCase()),
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
