import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "iab-preview.mjs");

let tempRoots: string[] = [];

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function createRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-test-"));
  tempRoots.push(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Mandible Test"], repo);
  git(["config", "user.email", "mandible-test@example.invalid"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n", "utf8");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "base"], repo);
  return repo;
}

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe("iab-preview launcher", () => {
  it("reports explicit preview instance environment in dry-run output", () => {
    const repo = createRepo();
    const sourceDb = path.join(repo, "source.db");
    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--dry-run",
      "--json",
      "--branch",
      "integration/test-preview",
      "--db",
      sourceDb,
    ], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.instanceEnv).toMatchObject({
      MANDIBLE_INSTANCE_ROLE: "preview",
      MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
      MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
      MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
    });
  });
});
