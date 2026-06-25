import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import type {
  GitBugClient,
  GitBugCreateIssueInput,
  GitBugIssueDetail,
  GitBugIssueSummary,
  GitBugResult,
} from "../src/ledger/git-bug-client.js";
import {
  resolveProjectForCheckout,
  resolveProjectForCheckoutReadOnly,
} from "../src/ledger/projects.js";
import { runGitBugSyncForRepos } from "../src/ledger/sync-runner.js";
import { isEphemeralMountPath, type RepoInfo } from "../src/work-scanner.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-sync-discovery-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeRepo(overrides: Partial<RepoInfo> & { root: string }): RepoInfo {
  return {
    id: overrides.id ?? "repo-id",
    name: overrides.name ?? path.basename(overrides.root),
    root: overrides.root,
    exists: overrides.exists ?? true,
    default_branch: overrides.default_branch ?? "main",
    excluded: overrides.excluded ?? false,
    user_modified: overrides.user_modified ?? false,
    last_scanned_at: overrides.last_scanned_at ?? null,
  };
}

function countProjects(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ledger_projects").get() as { n: number }).n;
}

function countCheckouts(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ledger_project_checkouts").get() as { n: number })
    .n;
}

// ---------------------------------------------------------------------------
// isEphemeralMountPath — defense in depth
// ---------------------------------------------------------------------------

describe("isEphemeralMountPath", () => {
  it("matches sandbox session bind-mount roots", () => {
    expect(isEphemeralMountPath("/sessions/abc123/mnt")).toBe(true);
    expect(isEphemeralMountPath("/sessions/abc123/mnt/Main/feedbax")).toBe(true);
    expect(isEphemeralMountPath("/mnt/sessions/abc123/repo")).toBe(true);
  });

  it("does not match real home checkouts", () => {
    expect(isEphemeralMountPath(path.join(os.homedir(), "Main", "feedbax"))).toBe(false);
    expect(isEphemeralMountPath("/Users/mll/.dotfiles")).toBe(false);
    expect(isEphemeralMountPath("/sessions/abc123/notmnt")).toBe(false);
    expect(isEphemeralMountPath("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveProjectForCheckoutReadOnly — no-mint resolution unit
// ---------------------------------------------------------------------------

describe("resolveProjectForCheckoutReadOnly", () => {
  it("reports needs_registration for an unregistered root without minting", () => {
    const dir = path.join(tempDir, "unregistered");
    fs.mkdirSync(dir, { recursive: true });

    const before = countProjects();
    const result = resolveProjectForCheckoutReadOnly(db, { root: dir, remoteUrl: "" });

    expect(result.status).toBe("needs_registration");
    if (result.status === "needs_registration") {
      expect(result.matchedProjectId).toBeUndefined();
      expect(result.root).toBe(path.resolve(dir));
    }
    expect(countProjects()).toBe(before);
  });

  it("resolves a registered checkout root", () => {
    const dir = path.join(tempDir, "registered");
    fs.mkdirSync(dir, { recursive: true });
    const { project, checkout } = resolveProjectForCheckout(db, {
      root: dir,
      remoteUrl: "git@github.com:mll/registered.git",
    });

    const result = resolveProjectForCheckoutReadOnly(db, { root: dir });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.project.id).toBe(project.id);
      expect(result.checkout.id).toBe(checkout.id);
    }
  });

  it("hints matchedProjectId when a project exists by identity but root is unregistered", () => {
    const registeredDir = path.join(tempDir, "canonical");
    fs.mkdirSync(registeredDir, { recursive: true });
    const { project } = resolveProjectForCheckout(db, {
      root: registeredDir,
      remoteUrl: "git@github.com:mll/shared-remote.git",
    });

    // A different root that resolves to the same remote identity, but is not a
    // registered checkout, should be flagged for registration (not minted).
    const otherRoot = path.join(tempDir, "mount-copy");
    fs.mkdirSync(otherRoot, { recursive: true });
    const before = countCheckouts();
    const result = resolveProjectForCheckoutReadOnly(db, {
      root: otherRoot,
      remoteUrl: "git@github.com:mll/shared-remote.git",
    });

    expect(result.status).toBe("needs_registration");
    if (result.status === "needs_registration") {
      expect(result.matchedProjectId).toBe(project.id);
    }
    expect(countCheckouts()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// runGitBugSyncForRepos — discovery is no-mint and mount-prefix safe
// ---------------------------------------------------------------------------

describe("runGitBugSyncForRepos discovery", () => {
  it("(a) skips an unregistered root, reports needs_registration, mints nothing", async () => {
    const dir = path.join(tempDir, "fresh-repo");
    fs.mkdirSync(dir, { recursive: true });
    const repo = makeRepo({ id: "fresh-repo", root: dir });

    const before = countProjects();
    const result = await runGitBugSyncForRepos({
      db,
      client: new NoopGitBugClient(),
      repos: [repo],
      direction: "export",
    });

    expect(countProjects()).toBe(before);
    expect(countCheckouts()).toBe(0);
    expect(result.needs_registration).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(0);
    const row = result.results[0];
    expect(row.status).toBe("skipped");
    expect(row.needs_registration).toBe(true);
    expect(row.error).toMatch(/not a registered project\/checkout/);
  });

  it("(b) syncs an already-registered root without minting a new project", async () => {
    const dir = path.join(tempDir, "known-repo");
    fs.mkdirSync(dir, { recursive: true });
    const { project, checkout } = resolveProjectForCheckout(db, {
      root: dir,
      remoteUrl: "git@github.com:mll/known.git",
      workRepoId: "known-repo",
    });
    const repo = makeRepo({ id: "known-repo", root: dir });

    const before = countProjects();
    const result = await runGitBugSyncForRepos({
      db,
      client: new NoopGitBugClient(),
      repos: [repo],
      direction: "export",
    });

    expect(countProjects()).toBe(before);
    expect(result.needs_registration).toBe(0);
    expect(result.completed).toBe(1);
    const row = result.results[0];
    expect(row.status).toBe("completed");
    expect(row.project_id).toBe(project.id);
    expect(row.checkout_id).toBe(checkout.id);
  });

  it("(c) skips ephemeral sandbox-mount roots without minting", async () => {
    const repo = makeRepo({
      id: "mounted",
      root: "/sessions/sess-1/mnt/Main/feedbax",
    });

    const result = await runGitBugSyncForRepos({
      db,
      client: new NoopGitBugClient(),
      repos: [repo],
      direction: "export",
    });

    expect(countProjects()).toBe(0);
    expect(countCheckouts()).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.results[0].status).toBe("skipped");
    expect(result.results[0].error).toMatch(/ephemeral/);
  });
});

// ---------------------------------------------------------------------------
// Minimal GitBug client: import/export are no-ops so a registered sync completes.
// ---------------------------------------------------------------------------

function ok<T>(value: T): GitBugResult<T> {
  return { ok: true, value, stdout: "", stderr: "", exit_code: 0 };
}
function fail<T>(error: string): GitBugResult<T> {
  return { ok: false, error, retry: "fatal", stdout: "", stderr: "", exit_code: 1 };
}

class NoopGitBugClient implements GitBugClient {
  async hasGitBugRefs(): Promise<GitBugResult<boolean>> {
    return ok(false);
  }
  async listIssues(): Promise<GitBugResult<GitBugIssueSummary[]>> {
    return ok([]);
  }
  async getIssue(): Promise<GitBugResult<GitBugIssueDetail>> {
    return fail("not found");
  }
  async createIssue(_root: string, _input: GitBugCreateIssueInput): Promise<GitBugResult<{ id: string }>> {
    return ok({ id: "new-1" });
  }
  async editTitle(): Promise<GitBugResult<void>> {
    return ok(undefined);
  }
  async editComment(): Promise<GitBugResult<void>> {
    return ok(undefined);
  }
  async setStatus(): Promise<GitBugResult<void>> {
    return ok(undefined);
  }
  async addComment(): Promise<GitBugResult<{ id?: string }>> {
    return ok({ id: "c-1" });
  }
  async addLabel(): Promise<GitBugResult<void>> {
    return ok(undefined);
  }
  async removeLabel(): Promise<GitBugResult<void>> {
    return ok(undefined);
  }
}
