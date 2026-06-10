import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function copyCliFile(name: string, destDir: string): void {
  fs.copyFileSync(path.join(process.cwd(), "cli", name), path.join(destDir, name));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("post-merge build hook", () => {
  it("installs managed instructions after a local build", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-post-merge-hook-"));
    tempRoots.push(tempDir);

    const repo = path.join(tempDir, "repo");
    const home = path.join(tempDir, "home");
    const cliDir = path.join(repo, "cli");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "# Codex\n\nLocal policy.\n", "utf8");

    copyCliFile("post-merge-build-dist.sh", cliDir);
    copyCliFile("instructions.sh", cliDir);
    copyCliFile("instructions-contract.json", cliDir);

    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(0);

    const result = spawnSync("bash", ["cli/post-merge-build-dist.sh"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        MANDIBLE_POST_MERGE_BUILD_COMMAND: "true",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[post-merge-build] generated local build artifacts");
    expect(result.stderr).toContain("[post-merge-build] installed managed instruction fragments");

    const claudeTarget = path.join(home, ".claude", "CLAUDE.md");
    const codexTarget = path.join(home, ".codex", "AGENTS.md");
    expect(fs.readFileSync(claudeTarget, "utf8")).toContain("Mandible Interface Contract");
    expect(fs.readFileSync(codexTarget, "utf8")).toContain("Mandible Interface Contract");
    expect(fs.readFileSync(codexTarget, "utf8")).toContain("Local policy.");
  });
});
