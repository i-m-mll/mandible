import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import {
  canonicalRepoKeyForPath,
  canonicalRepoKeysForRef,
  clearRepoIdentityCache,
} from "../src/repo-identity.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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

describe("canonicalRepoKeyForPath", async () => {
  it("maps repo root, a linked worktree, and a symlink alias to one key", async () => {
    const repo = initRepo();
    const worktree = path.join(os.tmpdir(), `mandible-repo-id-wt-${Date.now()}`);
    git(repo, ["worktree", "add", "-b", "wt-branch", worktree]);
    const alias = path.join(os.tmpdir(), `mandible-repo-id-alias-${Date.now()}`);
    fs.symlinkSync(repo, alias);

    const rootKey = (await canonicalRepoKeyForPath(repo));
    expect(rootKey).not.toBeNull();
    // One physical repo under three names → one canonical chain key.
    expect((await canonicalRepoKeyForPath(worktree))).toBe(rootKey);
    expect((await canonicalRepoKeyForPath(alias))).toBe(rootKey);
  });

  it("distinguishes unrelated repos and returns null for non-git / missing paths", async () => {
    const a = initRepo();
    const b = initRepo();
    expect((await canonicalRepoKeyForPath(a))).not.toBeNull();
    expect((await canonicalRepoKeyForPath(a))).not.toBe((await canonicalRepoKeyForPath(b)));

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-repo-id-plain-"));
    expect((await canonicalRepoKeyForPath(plain))).toBeNull();
    expect((await canonicalRepoKeyForPath(path.join(plain, "missing")))).toBeNull();
    expect((await canonicalRepoKeyForPath(null))).toBeNull();
    expect((await canonicalRepoKeyForPath(undefined))).toBeNull();
  });

  // Issue ded17e6 hardening — a transient resolution failure for a path that
  // previously resolved must reuse the last-known-good key (stale-but-stable
  // beats unresolved), so two same-repo merges never split onto the canonical
  // and the unresolved execution chains and run concurrently.
  it("reuses the last-known-good key when a later resolution transiently fails", async () => {
    const repo = initRepo();

    // First resolution succeeds and memoizes the canonical key.
    const key = (await canonicalRepoKeyForPath(repo));
    expect(key).not.toBeNull();

    // Delete the checkout so a real git recompute now FAILS, and advance the
    // clock past the success TTL so the memoized success entry is stale — this
    // forces a recompute (a genuine transient failure) rather than a cache hit.
    fs.rmSync(repo, { recursive: true, force: true });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      // Recompute fails, but the last-known-good key is returned rather than null.
      expect((await canonicalRepoKeyForPath(repo))).toBe(key);
    } finally {
      nowSpy.mockRestore();
    }

    // A path that NEVER resolved has no last-known-good and still returns null.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-repo-id-never-"));
    expect((await canonicalRepoKeyForPath(plain))).toBeNull();

    // Clearing the cache drops the last-known-good fallback too.
    clearRepoIdentityCache();
    expect((await canonicalRepoKeyForPath(repo))).toBeNull();
  });
});

describe("canonicalRepoKeysForRef", async () => {

  it("resolves a repo ref through ledger project_key and display_name", async () => {
    const db = migratedMemoryDb();
    const repo = initRepo();
    const { project } = resolveProjectForCheckout(db, {
      root: repo,
      name: path.basename(repo),
      defaultBranch: "main",
      remoteUrl: "",
    });

    const key = (await canonicalRepoKeyForPath(repo));
    expect(key).not.toBeNull();
    if (project.project_key) {
      expect([...(await canonicalRepoKeysForRef(db, project.project_key))]).toContain(key);
    }
    expect([...(await canonicalRepoKeysForRef(db, project.display_name))]).toContain(key);
    db.close();
  });

});
