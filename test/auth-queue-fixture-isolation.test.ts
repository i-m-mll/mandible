/**
 * @vitest-environment node
 *
 * The fixture contract the nine auth-queue files depend on (issue 9e40a31).
 *
 * Those files stopped building a Git repository per test and started copying an
 * immutable template. That is only sound while three things hold: a copy is a
 * complete private repository, mutating one copy reaches neither the other
 * copies nor the template, and nothing a test creates outlives it. None of the
 * 139 cases would fail loudly if any of that broke — they would fail
 * intermittently, in whichever file happened to run second. So the properties
 * are asserted directly, here.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  commitOnBranch,
  createAuthCheckRepo,
  createMigratedDb,
  git,
  trackedTempPaths,
  uniqueMissingPath,
  verifyTemplateIntegrity,
} from "./helpers/auth-queue-fixtures.js";

// Recorded by the first test and asserted absent by a later one: `afterEach`
// runs between them, so this is a direct observation that teardown happened
// rather than a restatement of the code that is supposed to do it.
const leakedFromEarlierTest: string[] = [];

describe("auth-queue fixture", () => {
  it("hands out complete, independent repositories", () => {
    const a = createAuthCheckRepo();
    const b = createAuthCheckRepo();

    expect(a).not.toBe(b);
    for (const repo of [a, b]) {
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      expect(git(repo, ["status", "--porcelain"])).toBe("");
      expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("base\n");
      // A copy is a real repository, not a reference to one.
      expect(fs.existsSync(path.join(repo, ".git", "objects", "info", "alternates"))).toBe(false);
      expect(git(repo, ["cat-file", "-t", "HEAD"])).toBe("commit");
    }
    expect(git(a, ["rev-parse", "HEAD"])).toBe(git(b, ["rev-parse", "HEAD"]));
  });

  it("confines every clone-local mutation to its own copy", () => {
    const a = createAuthCheckRepo();
    const b = createAuthCheckRepo();
    const bHeadBefore = git(b, ["rev-parse", "HEAD"]);

    // Each of these is a mutation some auth-queue test really performs, and
    // each is a way one repository could reach another: a rewritten ref, a
    // dirty index, an installed hook, an absolute signing path, and a linked
    // worktree whose administrative record points back at its source.
    commitOnBranch(a, "feature/isolation", { "isolation.txt": "a\n" });
    git(a, ["checkout", "main"]);
    git(a, ["merge", "--no-ff", "--no-edit", "feature/isolation"]);
    fs.writeFileSync(path.join(a, "staged.txt"), "staged\n");
    git(a, ["add", "staged.txt"]);
    const hook = path.join(a, ".git", "hooks", "pre-merge-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(hook, 0o755);
    git(a, ["config", "user.signingkey", path.join(a, ".some-key")]);
    const linked = uniqueMissingPath("mandible-isolation-worktree");
    git(a, ["worktree", "add", "-b", "feature/isolation-linked", linked]);

    expect(git(a, ["rev-parse", "HEAD"])).not.toBe(bHeadBefore);

    // B is untouched by all of it.
    expect(git(b, ["rev-parse", "HEAD"])).toBe(bHeadBefore);
    expect(git(b, ["status", "--porcelain"])).toBe("");
    expect(git(b, ["branch", "--list", "feature/isolation"])).toBe("");
    expect(fs.existsSync(path.join(b, ".git", "hooks", "pre-merge-commit"))).toBe(false);
    expect(fs.existsSync(path.join(b, ".git", "worktrees"))).toBe(false);
    expect(fs.readFileSync(path.join(b, ".git", "config"), "utf8")).not.toMatch(/signingkey/);
    expect(fs.readFileSync(path.join(b, "shared.txt"), "utf8")).toBe("base\n");

    // And so is the template every later copy in this file comes from.
    verifyTemplateIntegrity();

    leakedFromEarlierTest.push(a, b, linked);
    expect(trackedTempPaths().perTest).toEqual(expect.arrayContaining([a, b]));
  });

  it("removes every repository, hook and linked worktree the previous test made", () => {
    expect(leakedFromEarlierTest.length).toBeGreaterThan(0);
    for (const leaked of leakedFromEarlierTest) {
      expect(fs.existsSync(leaked)).toBe(false);
    }
    // The tracking set is emptied too, so paths do not accumulate across a file.
    expect(trackedTempPaths().perTest).toEqual([]);
  });

  it("gives each case an independent migrated database", () => {
    const first = createMigratedDb();
    const second = createMigratedDb();
    try {
      const operators = () =>
        (first.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
      const before = operators();

      first.prepare("INSERT INTO auth_requests (id, type, command, title, status, created_at, updated_at, expires_at, output, execution_mode, files_changed, additions, deletions) VALUES ('iso', 'merge', 'x', 'x', 'pending', 1, 1, 2, '', 'daemon', 0, 0, 0)").run();

      expect(
        (first.prepare("SELECT COUNT(*) AS n FROM auth_requests").get() as { n: number }).n,
      ).toBe(1);
      expect(
        (second.prepare("SELECT COUNT(*) AS n FROM auth_requests").get() as { n: number }).n,
      ).toBe(0);
      // The seeded operator survives deserialisation; the template is a
      // migrated *and* seeded database, not an empty one.
      expect(before).toBeGreaterThan(0);
      expect(
        (second.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n,
      ).toBe(before);
    } finally {
      first.close();
      second.close();
    }
  });

  it("isolates the fixture from ambient Git configuration", () => {
    const repo = createAuthCheckRepo();
    // `git()` sets GIT_CONFIG_NOSYSTEM and points GIT_CONFIG_GLOBAL at the null
    // device, so the only configuration in scope is the repository's own. A
    // developer with `core.hooksPath`, `init.templateDir` or signing defaults
    // set globally must not change what these tests exercise.
    expect(git(repo, ["config", "--show-origin", "--get", "user.email"]))
      .toContain("file:.git/config");
    expect(git(repo, ["config", "--list", "--show-scope"])).not.toMatch(/^system/m);
    expect(git(repo, ["config", "--list", "--show-scope"])).not.toMatch(/^global/m);
    // No sample hooks, so an ambient hooks template cannot arrive unnoticed.
    expect(fs.readdirSync(path.join(repo, ".git", "hooks"))).toEqual([]);
  });
});
