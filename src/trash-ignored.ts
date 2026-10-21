import fs from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

/**
 * Policy-free classification of a worktree's ignored files before trash
 * removes it. Symlinks hold no unique bytes, and rebuildable directories are
 * named by an explicit default list a repository may extend or replace in
 * `mandible.toml` / `.mandible.toml` under `[trash.ignored]`. Everything else
 * that is ignored is unique and must be preserved or must block removal.
 */

export const DEFAULT_REBUILDABLE_DIRS: readonly string[] = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  "build",
  ".next",
  ".turbo",
  "target",
  ".cache",
];

export const DEFAULT_MAX_PRESERVED_BYTES = 50 * 1024 * 1024;

/** Mandible's own root-level issue helper file; the work-unit ledger holds its facts. */
const ISSUE_HELPER_FILE = ".issue";

const REPO_CONFIG_FILES = ["mandible.toml", ".mandible.toml"];

export interface IgnoredPolicy {
  rebuildableDirs: ReadonlySet<string>;
  maxPreservedBytes: number;
}

export interface IgnoredFile {
  path: string;
  bytes: number;
  executable: boolean;
}

export interface UnpreservableEntry {
  path: string;
  reason: "nested_repository" | "newline_in_path";
}

export interface IgnoredClassification {
  kept: IgnoredFile[];
  keptBytes: number;
  skipped: number;
  unpreservable: UnpreservableEntry[];
}

export type PolicyResult =
  | { ok: true; policy: IgnoredPolicy; source: string | null }
  | { ok: false; source: string; error: string };

function dirNameList(value: unknown, key: string): string[] | string {
  if (!Array.isArray(value)) return `${key} must be an array of directory names`;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || item.includes("/") || item.includes("\\")) {
      return `${key} entries must be non-empty directory names without path separators`;
    }
    names.push(item.trim());
  }
  return names;
}

export function readIgnoredPolicy(repoRoot: string): PolicyResult {
  const source = REPO_CONFIG_FILES
    .map((name) => path.join(repoRoot, name))
    .find((candidate) => fs.existsSync(candidate)) ?? null;
  const defaults: IgnoredPolicy = {
    rebuildableDirs: new Set(DEFAULT_REBUILDABLE_DIRS),
    maxPreservedBytes: DEFAULT_MAX_PRESERVED_BYTES,
  };
  if (!source) return { ok: true, policy: defaults, source: null };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(fs.readFileSync(source, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, source, error: error instanceof Error ? error.message : String(error) };
  }
  const trash = parsed.trash;
  const section = trash && typeof trash === "object"
    ? (trash as Record<string, unknown>).ignored
    : undefined;
  if (section === undefined) return { ok: true, policy: defaults, source };
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { ok: false, source, error: "[trash.ignored] must be a table" };
  }
  const table = section as Record<string, unknown>;

  let dirs = [...DEFAULT_REBUILDABLE_DIRS];
  if (table.rebuildable_dirs !== undefined) {
    const replaced = dirNameList(table.rebuildable_dirs, "rebuildable_dirs");
    if (typeof replaced === "string") return { ok: false, source, error: replaced };
    dirs = replaced;
  }
  if (table.extra_rebuildable_dirs !== undefined) {
    const extra = dirNameList(table.extra_rebuildable_dirs, "extra_rebuildable_dirs");
    if (typeof extra === "string") return { ok: false, source, error: extra };
    dirs.push(...extra);
  }

  let maxPreservedBytes = DEFAULT_MAX_PRESERVED_BYTES;
  if (table.max_preserved_bytes !== undefined) {
    const value = table.max_preserved_bytes;
    const numeric = typeof value === "bigint" ? Number(value) : value;
    if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0) {
      return { ok: false, source, error: "max_preserved_bytes must be a non-negative integer" };
    }
    maxPreservedBytes = numeric;
  }
  return { ok: true, policy: { rebuildableDirs: new Set(dirs), maxPreservedBytes }, source };
}

/**
 * Paths reported as `!!` by `git status --porcelain=v1 -z --ignored=matching`.
 * Matching mode lists an ignored directory once, without descending, and
 * still lists ignored files inside untracked directories.
 */
export function ignoredStatusPaths(statusZ: string): string[] {
  const fields = statusZ.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    if (status === "!!") paths.push(field.slice(3).replace(/\/$/, ""));
    if (status[0] === "R" || status[0] === "C") index += 1;
  }
  return paths;
}

export function classifyIgnored(
  worktreePath: string,
  ignoredPaths: readonly string[],
  policy: IgnoredPolicy,
): IgnoredClassification {
  const result: IgnoredClassification = { kept: [], keptBytes: 0, skipped: 0, unpreservable: [] };

  const keep = (relative: string, stat: fs.Stats) => {
    if (relative.includes("\n")) {
      result.unpreservable.push({ path: relative, reason: "newline_in_path" });
      return;
    }
    result.kept.push({ path: relative, bytes: stat.size, executable: (stat.mode & 0o111) !== 0 });
    result.keptBytes += stat.size;
  };

  const walk = (relative: string) => {
    const absolute = path.join(worktreePath, relative);
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    if (entries.some((entry) => entry.name === ".git")) {
      result.unpreservable.push({ path: relative, reason: "nested_repository" });
      return;
    }
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (policy.rebuildableDirs.has(entry.name)) result.skipped += 1;
        else walk(child);
      } else if (entry.isFile()) {
        keep(child, fs.lstatSync(path.join(worktreePath, child)));
      } else {
        result.skipped += 1;
      }
    }
  };

  for (const relative of ignoredPaths) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(worktreePath, relative));
    } catch {
      continue;
    }
    const components = relative.split("/");
    const directoryComponents = stat.isDirectory() ? components : components.slice(0, -1);
    if (
      stat.isSymbolicLink()
      || relative === ISSUE_HELPER_FILE
      || directoryComponents.some((name) => policy.rebuildableDirs.has(name))
    ) {
      result.skipped += 1;
    } else if (stat.isDirectory()) {
      walk(relative);
    } else if (stat.isFile()) {
      keep(relative, stat);
    } else {
      result.skipped += 1;
    }
  }
  result.kept.sort((left, right) => left.path.localeCompare(right.path));
  return result;
}
