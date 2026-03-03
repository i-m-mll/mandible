import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { WorkScanner } from "./work-scanner.js";
import type {
  GitBugIssue,
  GitBugIssueDetail,
  GitBugComment,
  IssueRepoSummary,
} from "./types.js";

const CACHE_TTL_MS = 60_000;

interface RepoCache {
  summary: IssueRepoSummary;
  scannedAt: number;
}

function runGitBug(
  args: string[],
  cwd: string,
): string | null {
  const result = spawnSync("git-bug", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trimEnd();
}

function runCommandAsync(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
    }

    let finished = false;
    const finish = (status: number | null) => {
      if (finished) return;
      finished = true;
      resolve({ status, stdout: stdout.trimEnd() });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

async function runGitBugAsync(
  args: string[],
  cwd: string,
): Promise<string | null> {
  const result = await runCommandAsync("git-bug", args, cwd, 15_000);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
}

function hasGitBugRefs(repoRoot: string): boolean {
  const result = spawnSync("git", ["for-each-ref", "--count=1", "refs/bugs/"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) {
    return false;
  }
  return result.stdout.trim().length > 0;
}

async function hasGitBugRefsAsync(repoRoot: string): Promise<boolean> {
  const result = await runCommandAsync("git", ["for-each-ref", "--count=1", "refs/bugs/"], repoRoot, 5_000);
  if (result.status !== 0) {
    return false;
  }
  return result.stdout.trim().length > 0;
}

/**
 * Parse the JSON output of `git-bug bug show <id> --format=json`.
 *
 * JSON schema (git-bug v0.10.1):
 *   { id, human_id, title, status, labels, author: { name },
 *     create_time: { time }, comments: [{ id, human_id, author: { name }, message }] }
 *
 * The first comment is the issue description; remaining are actual comments.
 */
function parseIssueDetailJson(
  jsonStr: string,
  repoId: string,
  repoName: string,
): GitBugIssueDetail | null {
  try {
    const data = JSON.parse(jsonStr) as {
      id?: string;
      human_id?: string;
      title?: string;
      status?: string;
      labels?: string[] | null;
      author?: { name?: string };
      create_time?: { time?: string };
      comments?: Array<{
        id?: string;
        human_id?: string;
        author?: { name?: string };
        message?: string;
      }>;
    };

    if (!data || !data.title) {
      return null;
    }

    const allComments = Array.isArray(data.comments) ? data.comments : [];
    // git-bug stores the description as the first comment
    const description = allComments.length > 0
      ? (allComments[0].message ?? "")
      : "";
    const restComments: GitBugComment[] = allComments.slice(1).map((c) => ({
      id: c.human_id ?? c.id ?? "",
      author: c.author?.name ?? "",
      date: "",
      body: c.message ?? "",
    }));

    return {
      id: data.human_id ?? data.id ?? "",
      repo_id: repoId,
      repo_name: repoName,
      title: data.title,
      status: data.status === "closed" ? "closed" : "open",
      labels: data.labels ?? [],
      author: data.author?.name ?? "",
      created_at: data.create_time?.time ?? "",
      description,
      comments: restComments,
    };
  } catch {
    return null;
  }
}

export class IssueScanner {
  private cache = new Map<string, RepoCache>();
  private workScanner: WorkScanner;
  private scanPromise: Promise<IssueRepoSummary[]> | null = null;

  constructor(workScanner: WorkScanner) {
    this.workScanner = workScanner;
  }

  getRepoSummaries(): IssueRepoSummary[] {
    this.ensureScan();
    const summaries: IssueRepoSummary[] = [];
    for (const entry of this.cache.values()) {
      summaries.push(entry.summary);
    }
    // Sort by repo name
    summaries.sort((a, b) => a.repo_name.localeCompare(b.repo_name));
    return summaries;
  }

  getIssueDetail(repoId: string, issueId: string): GitBugIssueDetail | null {
    const repo = this.workScanner.getRepoById(repoId);
    if (!repo || !repo.exists) {
      return null;
    }
    const output = runGitBug(["bug", "show", issueId, "--format=json"], repo.root);
    if (!output) {
      return null;
    }
    return parseIssueDetailJson(output, repo.id, repo.name);
  }

  /** Look up an issue's status from the cache. Returns null if unknown. */
  getIssueStatus(repoId: string, issueId: string): "open" | "closed" | null {
    this.ensureScan();
    const cached = this.cache.get(repoId);
    if (!cached) {
      return null;
    }
    const issue = cached.summary.issues.find((i) => i.id === issueId);
    return issue ? issue.status : null;
  }

  scanAll(): IssueRepoSummary[] {
    // Ensure WorkScanner has refreshed its repo list before we iterate it
    const repos = this.workScanner.getRepos();
    for (const repo of repos) {
      if (!repo.exists) {
        continue;
      }
      this.scanRepo(repo.id, repo.name, repo.root);
    }
    return this.getRepoSummaries();
  }

  scanAllAsync(): Promise<IssueRepoSummary[]> {
    if (!this.scanPromise) {
      this.scanPromise = this.scanAllInternalAsync().finally(() => {
        this.scanPromise = null;
      });
    }
    return this.scanPromise;
  }

  /**
   * Force-scan a single repo by its repo ID.
   * Returns true if the repo was found and scanned, false otherwise.
   * Used by the /api/issues/:repoId/scan endpoint to unblock deep-link 404s.
   */
  scanRepoById(repoId: string): boolean {
    const repo = this.workScanner.getRepoById(repoId);
    if (!repo || !repo.exists) {
      return false;
    }
    // Invalidate cache so scanRepo runs unconditionally
    this.invalidateRepo(repoId);
    this.scanRepo(repo.id, repo.name, repo.root);
    return true;
  }

  async scanRepoByIdAsync(repoId: string): Promise<boolean> {
    const repo = this.workScanner.getRepoById(repoId);
    if (!repo || !repo.exists) {
      return false;
    }
    this.invalidateRepo(repoId);
    await this.scanRepoAsync(repo.id, repo.name, repo.root);
    return true;
  }

  closeIssue(repoId: string, issueId: string): boolean {
    const repo = this.workScanner.getRepoById(repoId);
    if (!repo || !repo.exists) {
      return false;
    }
    const result = spawnSync("git-bug", ["bug", "status", "close", issueId], {
      cwd: repo.root,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status === 0) {
      this.invalidateRepo(repoId);
    }
    return result.status === 0;
  }

  reopenIssue(repoId: string, issueId: string): boolean {
    const repo = this.workScanner.getRepoById(repoId);
    if (!repo || !repo.exists) {
      return false;
    }
    const result = spawnSync("git-bug", ["bug", "status", "open", issueId], {
      cwd: repo.root,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status === 0) {
      this.invalidateRepo(repoId);
    }
    return result.status === 0;
  }

  addComment(repoId: string, issueId: string, message: string): boolean {
    const repo = this.workScanner.getRepoById(repoId);
    if (!repo || !repo.exists) {
      return false;
    }
    const result = spawnSync(
      "git-bug",
      ["bug", "comment", "new", issueId, "-m", message, "--non-interactive"],
      {
        cwd: repo.root,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    return result.status === 0;
  }

  addLabel(repoId: string, issueId: string, label: string): boolean {
    const repo = this.workScanner.getRepoById(repoId);
    if (!repo || !repo.exists) {
      return false;
    }
    const result = spawnSync("git-bug", ["bug", "label", "new", issueId, label], {
      cwd: repo.root,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status === 0) {
      this.invalidateRepo(repoId);
    }
    return result.status === 0;
  }

  removeLabel(repoId: string, issueId: string, label: string): boolean {
    const repo = this.workScanner.getRepoById(repoId);
    if (!repo || !repo.exists) {
      return false;
    }
    const result = spawnSync("git-bug", ["bug", "label", "rm", issueId, label], {
      cwd: repo.root,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status === 0) {
      this.invalidateRepo(repoId);
    }
    return result.status === 0;
  }

  private ensureScan(): void {
    if (this.scanPromise) {
      return;
    }
    const repos = this.workScanner.getRepos();
    const now = Date.now();
    let hasStale = false;
    for (const repo of repos) {
      if (!repo.exists) {
        continue;
      }
      const cached = this.cache.get(repo.id);
      if (cached && now - cached.scannedAt < CACHE_TTL_MS) {
        continue;
      }
      hasStale = true;
      break;
    }
    if (hasStale) {
      void this.scanAllAsync();
    }
  }

  private async scanAllInternalAsync(): Promise<IssueRepoSummary[]> {
    const repos = this.workScanner.getRepos();
    for (const repo of repos) {
      if (!repo.exists) {
        continue;
      }
      await this.scanRepoAsync(repo.id, repo.name, repo.root);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return this.getRepoSummaries();
  }

  private scanRepo(repoId: string, repoName: string, repoRoot: string): void {
    if (!hasGitBugRefs(repoRoot)) {
      // No git-bug issues in this repo — skip it, remove stale cache
      this.cache.delete(repoId);
      return;
    }

    const output = runGitBug(["bug", "--format=json"], repoRoot);
    if (output === null) {
      // git-bug not available or command failed
      this.cache.delete(repoId);
      return;
    }

    const issues: GitBugIssue[] = [];
    let openCount = 0;
    let mergedCount = 0;
    let closedCount = 0;

    let parsed: Array<{
      id: string;
      human_id: string;
      status: string;
      labels: string[] | null;
      title: string;
      actors: Array<{ name: string }>;
      create_time?: { time?: string };
    }>;
    try {
      parsed = JSON.parse(output || "[]");
    } catch {
      // JSON parse failure — clear cache so next scan retries
      this.cache.delete(repoId);
      return;
    }

    for (const entry of parsed) {
      const status: "open" | "closed" = entry.status === "closed" ? "closed" : "open";
      const labels = entry.labels ?? [];
      const issue: GitBugIssue = {
        id: entry.human_id,
        repo_id: repoId,
        repo_name: repoName,
        title: entry.title,
        status,
        labels,
        author: entry.actors?.[0]?.name ?? "",
        created_at: entry.create_time?.time ?? "",
        description: "",
      };
      issues.push(issue);
      if (status === "open") {
        openCount++;
      } else if (labels.includes("merged")) {
        // Bug: e32ee8b — three-state lifecycle: closed + "merged" label = merged
        mergedCount++;
      } else {
        closedCount++;
      }
    }

    this.cache.set(repoId, {
      summary: {
        repo_id: repoId,
        repo_name: repoName,
        repo_root: repoRoot,
        open_count: openCount,
        merged_count: mergedCount,
        closed_count: closedCount,
        issues,
      },
      scannedAt: Date.now(),
    });
  }

  private async scanRepoAsync(repoId: string, repoName: string, repoRoot: string): Promise<void> {
    if (!await hasGitBugRefsAsync(repoRoot)) {
      this.cache.delete(repoId);
      return;
    }

    const output = await runGitBugAsync(["bug", "--format=json"], repoRoot);
    if (output === null) {
      this.cache.delete(repoId);
      return;
    }

    const issues: GitBugIssue[] = [];
    let openCount = 0;
    let mergedCount = 0;
    let closedCount = 0;

    let parsed: Array<{
      id: string;
      human_id: string;
      status: string;
      labels: string[] | null;
      title: string;
      actors: Array<{ name: string }>;
      create_time?: { time?: string };
    }>;
    try {
      parsed = JSON.parse(output || "[]");
    } catch {
      this.cache.delete(repoId);
      return;
    }

    for (const entry of parsed) {
      const status: "open" | "closed" = entry.status === "closed" ? "closed" : "open";
      const labels = entry.labels ?? [];
      const issue: GitBugIssue = {
        id: entry.human_id,
        repo_id: repoId,
        repo_name: repoName,
        title: entry.title,
        status,
        labels,
        author: entry.actors?.[0]?.name ?? "",
        created_at: entry.create_time?.time ?? "",
        description: "",
      };
      issues.push(issue);
      if (status === "open") {
        openCount++;
      } else if (labels.includes("merged")) {
        mergedCount++;
      } else {
        closedCount++;
      }
    }

    this.cache.set(repoId, {
      summary: {
        repo_id: repoId,
        repo_name: repoName,
        repo_root: repoRoot,
        open_count: openCount,
        merged_count: mergedCount,
        closed_count: closedCount,
        issues,
      },
      scannedAt: Date.now(),
    });
  }

  private invalidateRepo(repoId: string): void {
    this.cache.delete(repoId);
  }
}
