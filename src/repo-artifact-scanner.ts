import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { mediaTypeForPath } from "./artifact-media-type.js";
import {
  resolveCanonicalArtifactRepoForRoot,
  resolveCanonicalArtifactRepoRef,
} from "./artifact-repo-resolution.js";
import { recordArtifactVersion, registerArtifactLink, getArtifact } from "./provider-artifacts.js";
import type { ArtifactRecord } from "./types.js";


export interface RepoArtifactRoot {
  root: string;
  repo_id?: string;
  name?: string;
  default_branch?: string | null;
}

export interface RepoArtifactScannerOptions {
  roots?: Array<string | RepoArtifactRoot>;
  repoIds?: string[];
  maxDepth?: number;
  maxFileBytes?: number;
  register?: boolean;
  discoveryOnly?: boolean;
  dryRun?: boolean;
  now?: number;
}

export interface DiscoveredRepoArtifact {
  repo_id: string;
  repo_root: string;
  repo_name: string;
  default_branch: string | null;
  absolute_path: string;
  relative_path: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  media_type: string;
  role: string;
  repo_locator: Record<string, unknown>;
  issue_id?: string;
  issue_ref?: string;
}

export interface RepoArtifactScanResult {
  scanned_repos: Array<{ repo_id: string; root: string; exists: boolean }>;
  discovered: number;
  ingested: number;
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; error: string }>;
  discovered_artifacts?: DiscoveredRepoArtifact[];
  artifacts: ArtifactRecord[];
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

const EXCLUDED_DIRS = new Set([
  ".cache",
  ".eggs",
  ".git",
  ".hg",
  ".mypy_cache",
  ".next",
  ".npm",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "cache",
  "coverage",
  "data",
  "datasets",
  "dist",
  "env",
  "logs",
  "node_modules",
  "out",
  "site-packages",
  "target",
  "tmp",
  "vendor",
  "venv",
]);

const DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".htm",
  ".html",
  ".ipynb",
  ".json",
  ".jsonl",
  ".md",
  ".pdf",
  ".toml",
  ".tsv",
  ".txt",
  ".yaml",
  ".yml",
]);

const ARTIFACT_DIR_SEGMENTS = new Set([
  "analysis",
  "analyses",
  "artifact",
  "artifacts",
  "config",
  "configs",
  "doc",
  "docs",
  "eval",
  "evals",
  "evaluation",
  "evaluations",
  "experiment",
  "experiments",
  "manifest",
  "manifests",
  "report",
  "reports",
  "result",
  "results",
  "run",
  "runs",
]);

const ARTIFACT_FILENAME_RE =
  /(?:^|[-_.])(analysis|artifact|config|eval|evaluation|experiment|manifest|metric|report|result|run|summary)(?:[-_.]|$)/i;
const ISSUE_ID_RE = /^[0-9a-f]{7,64}$/i;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRoot(input: string | RepoArtifactRoot): RepoArtifactRoot {
  if (typeof input === "string") {
    const root = path.resolve(input);
    return { root, default_branch: null };
  }
  const root = path.resolve(input.root);
  return {
    root,
    repo_id: asString(input.repo_id),
    name: asString(input.name),
    default_branch: asString(input.default_branch) ?? null,
  };
}

function configuredRoots(db: Db, options: RepoArtifactScannerOptions): RepoArtifactRoot[] {
  const roots: RepoArtifactRoot[] = [];
  const allowedIds = new Set(options.repoIds ?? []);
  const canonicalize = (root: RepoArtifactRoot): RepoArtifactRoot | null => {
    const resolution = root.repo_id
      ? resolveCanonicalArtifactRepoRef(db, root.repo_id)
      : resolveCanonicalArtifactRepoForRoot(db, root.root);
    if (!resolution.ok) return null;
    return {
      root: root.root,
      repo_id: resolution.project_key,
      name: root.name ?? resolution.checkout_name ?? resolution.project_key,
      default_branch: root.default_branch ?? resolution.default_branch ?? null,
    };
  };
  const addRoot = (root: RepoArtifactRoot): void => {
    const normalized = canonicalize(normalizeRoot(root));
    if (!normalized?.repo_id) return;
    if (allowedIds.size > 0 && !allowedIds.has(normalized.repo_id) && !allowedIds.has(normalized.name ?? "")) {
      return;
    }
    if (!roots.some((existing) => path.resolve(existing.root) === normalized.root)) {
      roots.push(normalized);
    }
  };
  if (options.roots) {
    for (const root of options.roots) addRoot(normalizeRoot(root));
    return roots;
  }

  if (tableExists(db, "ledger_project_checkouts")) {
    const rows = db.prepare(
      `SELECT root, name, default_branch
         FROM ledger_project_checkouts
        ORDER BY name, root`
    ).all() as Array<{
      root: string;
      name: string;
      default_branch: string | null;
    }>;
    for (const row of rows) {
      addRoot({
        root: row.root,
        name: row.name,
        default_branch: row.default_branch,
      });
    }
  }

  return roots;
}

function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase();
  return EXCLUDED_DIRS.has(lower) || (lower.startsWith(".") && lower !== ".github");
}

function slashPath(value: string): string {
  return value.split(path.sep).join("/");
}

function pathSegments(relativePath: string): string[] {
  return slashPath(relativePath).split("/").filter(Boolean);
}

function hasArtifactSegment(relativePath: string): boolean {
  return pathSegments(relativePath).some((segment) => ARTIFACT_DIR_SEGMENTS.has(segment.toLowerCase()));
}

function isArtifactLikePath(relativePath: string): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(extension)) return false;
  const base = path.basename(relativePath).toLowerCase();
  if (base === "readme.md" || base === "readme.txt") return hasArtifactSegment(relativePath);
  return hasArtifactSegment(relativePath) || ARTIFACT_FILENAME_RE.test(base);
}

function inferRole(relativePath: string): string {
  const lower = slashPath(relativePath).toLowerCase();
  if (lower.includes("manifest")) return "manifest";
  if (lower.includes("config")) return "config";
  if (lower.includes("report")) return "report";
  if (lower.includes("result") || lower.includes("metric") || lower.includes("eval")) return "result";
  return "document";
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function candidateIssueRef(relativePath: string): string | null {
  const segments = pathSegments(relativePath);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const lower = segment.toLowerCase();
    if ((lower === "issue" || lower === "issues") && segments[i + 1]) {
      const match = /^([0-9a-f]{7,64})(?:[-_.].*)?$/i.exec(segments[i + 1]);
      if (match) return match[1];
    }
    const prefixed = /^issue[-_]([0-9a-f]{7,64})(?:[-_.].*)?$/i.exec(segment);
    if (prefixed) return prefixed[1];
  }
  const filename = path.basename(relativePath);
  const fileMatch = /^issue[-_]([0-9a-f]{7,64})(?:[-_.].*)?$/i.exec(filename);
  return fileMatch?.[1] ?? null;
}

function projectIdForRepo(db: Db, repoId: string, root: string): string | null {
  if (!tableExists(db, "ledger_projects")) return null;
  const hasProjectKey = (db.prepare("PRAGMA table_info(ledger_projects)").all() as Array<{ name: string }>)
    .some((column) => column.name === "project_key");
  const projectKeyClause = hasProjectKey ? " OR project_key = @repoId" : "";
  const checkoutClause = tableExists(db, "ledger_project_checkouts")
    ? `UNION
       SELECT project_id AS id FROM ledger_project_checkouts
        WHERE work_repo_id = @repoId OR name = @repoId OR root = @root`
    : "";
  const rows = db.prepare(
    `SELECT id FROM ledger_projects
      WHERE id = @repoId OR display_name = @repoId OR remote_identity = @repoId${projectKeyClause}
     ${checkoutClause}`
  ).all({ repoId, root }) as Array<{ id: string }>;
  const ids = Array.from(new Set(rows.map((row) => row.id)));
  return ids.length === 1 ? ids[0] : null;
}

function resolveIssueId(db: Db, repoId: string, root: string, issueRef: string): string | null {
  if (!ISSUE_ID_RE.test(issueRef) || !tableExists(db, "ledger_issues")) return issueRef;
  const projectId = projectIdForRepo(db, repoId, root);
  const projectFilter = projectId ? "AND project_id = @projectId" : "";
  const rows = db.prepare(
    `SELECT id FROM ledger_issues
      WHERE (id = @issueRef OR short_id = @issueRef OR id LIKE @prefix OR short_id LIKE @prefix)
      ${projectFilter}`
  ).all({ issueRef, prefix: `${issueRef}%`, projectId }) as Array<{ id: string }>;
  const aliasRows = tableExists(db, "ledger_issue_aliases")
    ? db.prepare(
        `SELECT issue_id AS id FROM ledger_issue_aliases
          WHERE (alias = @issueRef OR alias LIKE @prefix)
          ${projectId ? "AND project_id = @projectId" : ""}`
      ).all({ issueRef, prefix: `${issueRef}%`, projectId }) as Array<{ id: string }>
    : [];
  const ids = Array.from(new Set([...rows, ...aliasRows].map((row) => row.id)));
  return ids.length === 1 ? ids[0] : null;
}

export function discoverRepoArtifacts(
  db: Db,
  options: RepoArtifactScannerOptions = {},
): Omit<RepoArtifactScanResult, "ingested" | "artifacts"> & { artifacts: DiscoveredRepoArtifact[] } {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const repos = configuredRoots(db, options);
  const artifacts: DiscoveredRepoArtifact[] = [];
  const skipped: RepoArtifactScanResult["skipped"] = [];
  const errors: RepoArtifactScanResult["errors"] = [];
  const scannedRepos: RepoArtifactScanResult["scanned_repos"] = [];

  const visit = (repo: Required<Pick<RepoArtifactRoot, "root">> & RepoArtifactRoot, dir: string, depth: number): void => {
    if (depth > maxDepth) {
      skipped.push({ path: dir, reason: "max_depth" });
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: dir, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) {
          skipped.push({ path: absolutePath, reason: "excluded_dir" });
          continue;
        }
        visit(repo, absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = slashPath(path.relative(repo.root, absolutePath));
      if (!isArtifactLikePath(relativePath)) continue;

      try {
        const stat = fs.statSync(absolutePath);
        if (stat.size > maxFileBytes) {
          skipped.push({ path: absolutePath, reason: "file_too_large" });
          continue;
        }
        const repoId = repo.repo_id;
        if (!repoId) {
          skipped.push({ path: absolutePath, reason: "unknown_repo_identity" });
          continue;
        }
        const issueRef = candidateIssueRef(relativePath) ?? undefined;
        const issueId = issueRef ? resolveIssueId(db, repoId, repo.root, issueRef) ?? undefined : undefined;
        artifacts.push({
          repo_id: repoId,
          repo_root: repo.root,
          repo_name: repo.name ?? repoId,
          default_branch: repo.default_branch ?? null,
          absolute_path: absolutePath,
          relative_path: relativePath,
          filename: entry.name,
          size_bytes: stat.size,
          sha256: hashFile(absolutePath),
          media_type: mediaTypeForPath(absolutePath),
          role: inferRole(relativePath),
          repo_locator: {
            repo_id: repoId,
            ref: repo.default_branch ?? null,
            path: relativePath,
            root: repo.root,
          },
          issue_id: issueId,
          issue_ref: issueRef,
        });
      } catch (error) {
        errors.push({ path: absolutePath, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  for (const repo of repos) {
    const root = path.resolve(repo.root);
    const exists = fs.existsSync(root);
    if (!repo.repo_id) continue;
    scannedRepos.push({ repo_id: repo.repo_id, root, exists });
    if (!exists) continue;
    visit({ ...repo, root }, root, 0);
  }

  artifacts.sort((a, b) => a.repo_id.localeCompare(b.repo_id) || a.relative_path.localeCompare(b.relative_path));
  return {
    scanned_repos: scannedRepos,
    discovered: artifacts.length,
    skipped,
    errors,
    artifacts,
  };
}

export function scanRepoArtifacts(db: Db, options: RepoArtifactScannerOptions = {}): RepoArtifactScanResult {
  const now = options.now ?? Date.now();
  const discovered = discoverRepoArtifacts(db, options);
  const shouldRegister = options.register !== false && !options.discoveryOnly && !options.dryRun;
  if (!shouldRegister) {
    return {
      scanned_repos: discovered.scanned_repos,
      discovered: discovered.discovered,
      ingested: 0,
      skipped: discovered.skipped,
      errors: discovered.errors,
      discovered_artifacts: discovered.artifacts,
      artifacts: [],
    };
  }
  const artifacts: ArtifactRecord[] = [];
  for (const artifact of discovered.artifacts) {
    try {
      const recorded = recordArtifactVersion(db, {source_kind:'tracked_repo',path:artifact.absolute_path,
        role:artifact.role,logical_name:artifact.relative_path,media_type:artifact.media_type,
        issue:artifact.issue_id,metadata:{source:'repo_artifact_scanner'}},now);
      if (artifact.issue_id) registerArtifactLink(db,recorded.artifact_version.id,{entity_type:'issue',entity_id:artifact.issue_id,link_type:'references',role:'repo_path_inferred',repo_id:artifact.repo_id,source:'repo_artifact_scanner'},now);
      artifacts.push(getArtifact(db,recorded.artifact_version.id)!);
    } catch(error) { discovered.errors.push({path:artifact.absolute_path,error:String(error)}); }
  }
  return {
    scanned_repos: discovered.scanned_repos,
    discovered: discovered.discovered,
    ingested: artifacts.length,
    skipped: discovered.skipped,
    errors: discovered.errors,
    discovered_artifacts: discovered.artifacts,
    artifacts,
  };
}
