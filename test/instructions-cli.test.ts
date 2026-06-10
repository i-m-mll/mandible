import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");
const tempRoots: string[] = [];

function run(args: string[], env: Record<string, string> = {}): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("instructions CLI", () => {
  it("diffs and installs the managed instructions block", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-cli-"));
    tempRoots.push(tempDir);
    const target = path.join(tempDir, "AGENTS.md");
    fs.writeFileSync(target, "# Existing\n\nUser policy stays here.\n", "utf8");

    const diff = await run(["instructions", "diff", "--target", target]);
    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain("Mandible Interface Contract");
    expect(diff.stdout).toContain("User policy stays here.");

    const install = await run(["instructions", "install", "--target", target]);
    expect(install.status).toBe(0);
    const installed = fs.readFileSync(target, "utf8");
    expect(installed).toContain("<!-- BEGIN MANDIBLE MANAGED INSTRUCTIONS -->");
    expect(installed).toContain("mandible auth request <branch>");
    expect(installed).toContain("User policy stays here.");

    const cleanDiff = await run(["instructions", "diff", "--target", target]);
    expect(cleanDiff.status).toBe(0);
    expect(cleanDiff.stdout).toContain("already current");
  });

  it("uses ~/.claude/CLAUDE.md as the default install target", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-instructions-home-"));
    tempRoots.push(home);

    const install = await run(["instructions", "install"], { HOME: home });
    expect(install.status).toBe(0);
    const target = path.join(home, ".claude", "CLAUDE.md");
    expect(fs.readFileSync(target, "utf8")).toContain("Mandible Interface Contract");
  });
});
