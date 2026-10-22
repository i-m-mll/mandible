import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { addOrUpdateCheckout, addProject, resolveProjectRef, resolveProjectRefAsync } from "../src/ledger/project-registry.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-ref-")));
  db = openDb(path.join(dir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function register(key: string, root: string, extra: { display?: string; remote?: string; upstream?: string } = {}) {
  addProject(db, {
    project_key: key,
    display_name: extra.display ?? key,
    remote_identity: extra.remote ?? null,
    upstream_identity: extra.upstream ?? null,
  });
  return addOrUpdateCheckout(db, key, { root, work_repo_id: `20-${key}`, name: `${key}-checkout` });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repoWithCommit(root: string, ...initArgs: string[]): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main", ...initArgs);
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(root, "file.md"), "x");
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
}

describe.each([{ name: "sync", resolve: resolveProjectRef }, { name: "async", resolve: resolveProjectRefAsync }])("resolveProjectRef ($name)", ({ resolve }) => {
async function resolvedKey(ref: string, observedPath?: string) {
  const resolved = await resolve(db, ref, { observedPath });
  return resolved.ok ? [resolved.project.project_key, resolved.matched_by] : resolved;
}


  it("resolves every kind of non-path ref to its one project", async () => {
    const root = path.join(dir, "alpha");
    const { project, checkout } = register("alpha", root, { display: "Alpha Project", remote: "git@github.com:mll/alpha.git" });
    register("beta", path.join(dir, "beta"));
    expect(await resolvedKey(project.id)).toEqual(["alpha", "id"]);
    expect(await resolvedKey(checkout.id)).toEqual(["alpha", "checkout_id"]);
    expect(await resolvedKey("Alpha")).toEqual(["alpha", "project_key"]);
    expect(await resolvedKey("20-alpha")).toEqual(["alpha", "work_repo_id"]);
    expect(await resolvedKey("ALPHA-checkout")).toEqual(["alpha", "checkout_name"]);
    expect(await resolvedKey("https://github.com/mll/alpha.git")).toEqual(["alpha", "remote_identity"]);
    expect(await resolvedKey("alpha project")).toEqual(["alpha", "display_name"]);
    expect(await resolvedKey(root)).toEqual(["alpha", "checkout_root"]);
    expect(await resolvedKey("gamma")).toEqual({ ok: false, reason: "unknown" });
    expect(await resolvedKey("alpha/subdir")).toEqual({ ok: false, reason: "unknown" });
  });

  it("refuses a ref that names more than one project", async () => {
    register("alpha", path.join(dir, "alpha"), { display: "Shared", upstream: "github.com/up/repo" });
    register("beta", path.join(dir, "beta"), { display: "Shared", upstream: "github.com/up/repo" });
    expect(await resolvedKey("Shared")).toEqual({ ok: false, reason: "ambiguous", candidates: ["alpha", "beta"] });
    expect(await resolvedKey("git@github.com:up/repo.git")).toEqual({ ok: false, reason: "ambiguous", candidates: ["alpha", "beta"] });
  });

  it("refuses a remote that is one project's identity and another project's checkout remote", async () => {
    register("alpha", path.join(dir, "alpha"), { remote: "github.com/mll/shared" });
    register("beta", path.join(dir, "beta"));
    addOrUpdateCheckout(db, "beta", { root: path.join(dir, "beta"), remote_url: "git@github.com:mll/shared.git" });
    expect(await resolvedKey("https://github.com/mll/shared.git")).toEqual({ ok: false, reason: "ambiguous", candidates: ["alpha", "beta"] });
  });

  it("resolves every worktree of a registered repository to the repository's project", async () => {
    const main = path.join(dir, "repo");
    repoWithCommit(main);
    register("repo", main);
    const nested = path.join(main, "worktrees", "feature__x");
    const external = path.join(dir, "elsewhere", "feature-y");
    git(main, "worktree", "add", "-b", "feature/x", nested);
    git(main, "worktree", "add", "-b", "feature/y", external);
    fs.mkdirSync(path.join(nested, "src"));
    expect(await resolvedKey(nested)).toEqual(["repo", "git_common_dir"]);
    expect(await resolvedKey(path.join(nested, "src"))).toEqual(["repo", "git_common_dir"]);
    expect(await resolvedKey(external)).toEqual(["repo", "git_common_dir"]);

    // An exact registration of the worktree is stronger than shared-repository evidence.
    register("pinned", external);
    expect(await resolvedKey(external)).toEqual(["pinned", "checkout_root"]);
  });

  it("resolves a worktree whose repository keeps its Git directory elsewhere", async () => {
    const main = path.join(dir, "main");
    repoWithCommit(main, "--separate-git-dir", path.join(dir, "git-data"));
    git(main, "config", "core.worktree", main);
    const linked = path.join(dir, "linked");
    git(main, "worktree", "add", "-b", "feature", linked);
    register("project", main);
    expect(await resolvedKey(linked)).toEqual(["project", "git_common_dir"]);
    // The object store is not a checkout, so registering it adds no evidence.
    register("object-store", path.join(dir, "git-data"));
    expect(await resolvedKey(linked)).toEqual(["project", "git_common_dir"]);
  });

  it("resolves a clone of a registered remote, refusing a remote shared by two projects", async () => {
    const clone = path.join(dir, "clone");
    fs.mkdirSync(clone);
    git(clone, "init", "-b", "main");
    git(clone, "remote", "add", "origin", "https://example.invalid/group/repo.git");
    register("a", path.join(dir, "a"), { remote: "example.invalid/group/repo" });
    expect(await resolvedKey(clone)).toEqual(["a", "git_remote"]);
    register("b", path.join(dir, "b"), { upstream: "example.invalid/group/repo" });
    expect(await resolvedKey(clone)).toEqual({ ok: false, reason: "ambiguous", candidates: ["a", "b"] });
  });

  it("resolves a non-repository path to the deepest registered checkout containing it", async () => {
    const outer = path.join(dir, "outer");
    const inner = path.join(outer, "inner");
    fs.mkdirSync(path.join(inner, "sub"), { recursive: true });
    register("outer", outer);
    register("inner", inner);
    expect(await resolvedKey(path.join(inner, "sub"))).toEqual(["inner", "checkout_ancestry"]);
    expect(await resolvedKey(path.join(outer, "missing"))).toEqual(["outer", "checkout_ancestry"]);
    expect(await resolvedKey(outer, inner)).toEqual(["outer", "checkout_root"]);
  });

  it("resolves a path through requested symlinks, refusing two projects registered at one place", async () => {
    const target = path.join(dir, "target");
    fs.mkdirSync(target);
    const alias = path.join(dir, "alias");
    fs.symlinkSync(target, alias);
    register("target", target);
    expect(await resolvedKey(alias)).toEqual(["target", "checkout_root"]);
    register("alias", alias);
    expect(await resolvedKey(alias)).toEqual({ ok: false, reason: "ambiguous", candidates: ["alias", "target"] });
  });
});
