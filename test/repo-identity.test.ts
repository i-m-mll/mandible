import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import {
  canonicalRepoKeyForPath,
  canonicalRepoKeysForRef,
  clearRepoIdentityCache,
} from "../src/repo-identity.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

function initRepo(prefix = "mandible-repo-id-"): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mandible Test"]);
  git(repo, ["config", "user.email", "mandible-test@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

afterEach(() => {
  clearRepoIdentityCache();
});

describe("canonicalRepoKeyForPath", () => {
  it("maps repo root, a linked worktree, and a symlink alias to one key", () => {
    const repo = initRepo();
    const worktree = path.join(os.tmpdir(), `mandible-repo-id-wt-${Date.now()}`);
    git(repo, ["worktree", "add", "-b", "wt-branch", worktree]);
    const alias = path.join(os.tmpdir(), `mandible-repo-id-alias-${Date.now()}`);
    fs.symlinkSync(repo, alias);

    const rootKey = canonicalRepoKeyForPath(repo);
    expect(rootKey).not.toBeNull();
    // One physical repo under three names → one canonical chain key.
    expect(canonicalRepoKeyForPath(worktree)).toBe(rootKey);
    expect(canonicalRepoKeyForPath(alias)).toBe(rootKey);
  });

  it("distinguishes unrelated repos and returns null for non-git / missing paths", () => {
    const a = initRepo();
    const b = initRepo();
    expect(canonicalRepoKeyForPath(a)).not.toBeNull();
    expect(canonicalRepoKeyForPath(a)).not.toBe(canonicalRepoKeyForPath(b));

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-repo-id-plain-"));
    expect(canonicalRepoKeyForPath(plain)).toBeNull();
    expect(canonicalRepoKeyForPath(path.join(plain, "missing"))).toBeNull();
    expect(canonicalRepoKeyForPath(null)).toBeNull();
    expect(canonicalRepoKeyForPath(undefined)).toBeNull();
  });

  it("caches successful lookups so a deleted repo still resolves until cleared", () => {
    const repo = initRepo();
    const key = canonicalRepoKeyForPath(repo);
    expect(key).not.toBeNull();

    // Delete the checkout: a cache hit must return the memoized key without
    // respawning git (which would now fail).
    fs.rmSync(repo, { recursive: true, force: true });
    expect(canonicalRepoKeyForPath(repo)).toBe(key);

    // After clearing the cache the missing path resolves to null.
    clearRepoIdentityCache();
    expect(canonicalRepoKeyForPath(repo)).toBeNull();
  });
});

describe("canonicalRepoKeysForRef", () => {
  it("resolves a repo ref through work_repos id, name, and root", () => {
    const db = new Database(":memory:");
    migrate(db);
    const repo = initRepo();
    const realRoot = fs.realpathSync(repo);
    db.prepare(
      `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
       VALUES (?, ?, ?, 'main', 1, 0)`
    ).run("dotfiles", realRoot, "dotfiles");

    const key = canonicalRepoKeyForPath(realRoot);
    expect(key).not.toBeNull();
    for (const ref of ["dotfiles", realRoot]) {
      expect([...canonicalRepoKeysForRef(db, ref)]).toContain(key);
    }
    db.close();
  });

  it("resolves a repo ref through ledger project_key and display_name", () => {
    const db = new Database(":memory:");
    migrate(db);
    const repo = initRepo();
    const { project } = resolveProjectForCheckout(db, {
      root: repo,
      name: path.basename(repo),
      defaultBranch: "main",
      remoteUrl: "",
    });

    const key = canonicalRepoKeyForPath(repo);
    expect(key).not.toBeNull();
    if (project.project_key) {
      expect([...canonicalRepoKeysForRef(db, project.project_key)]).toContain(key);
    }
    expect([...canonicalRepoKeysForRef(db, project.display_name)]).toContain(key);
    db.close();
  });

  it("returns an empty set when registry tables are missing", () => {
    const db = new Database(":memory:"); // no migrate → no work_repos / ledger tables
    expect(canonicalRepoKeysForRef(db, "dotfiles").size).toBe(0);
    db.close();
  });
});
