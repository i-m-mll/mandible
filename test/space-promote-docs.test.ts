import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Child issue 8921e84: the `mandible space promote-docs` subcommand promotes
// the long-lived Spaces docs branch by cutting a disposable promote/docs/<ts>
// proxy branch from the docs-branch head and submitting THAT proxy to the auth
// queue. These tests stub the auth-request CLI so they assert the proxy-cutting
// behavior and the submitted branch without reaching a live daemon.

const SPACE_SH = path.join(process.cwd(), "cli", "space.sh");
const API_SH = path.join(process.cwd(), "cli", "api.sh");

let tempDir = "";
let repo = "";
let cliDir = "";
let argLog = "";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function createDocsRepo(docsBranch: string): void {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mandible Test"]);
  git(repo, ["config", "user.email", "mandible-test@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  // Docs branch ahead of main with a trailered linked commit.
  git(repo, ["checkout", "-b", docsBranch, "main"]);
  fs.writeFileSync(path.join(repo, "doc.md"), "# doc\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "doc export\n\nMandible-Issue: docs123"]);
  git(repo, ["checkout", "main"]);
}

function runPromoteDocs(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(SPACE_SH, ["promote-docs", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      MANDIBLE_CLI_DIR: cliDir,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-promote-docs-"));
  repo = path.join(tempDir, "repo");
  fs.mkdirSync(repo, { recursive: true });

  // Staging cli dir with the real space.sh/api.sh and a stub auth-request.sh
  // that records its invocation args instead of contacting a daemon.
  cliDir = path.join(tempDir, "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.copyFileSync(SPACE_SH, path.join(cliDir, "space.sh"));
  fs.copyFileSync(API_SH, path.join(cliDir, "api.sh"));
  argLog = path.join(tempDir, "auth-request-args.log");
  fs.writeFileSync(
    path.join(cliDir, "auth-request.sh"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > ${JSON.stringify(argLog)}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  createDocsRepo("docs/spaces");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("mandible space promote-docs", () => {
  it("cuts a promote/docs/<ts> proxy from the docs head and submits the proxy", () => {
    const docsHead = git(repo, ["rev-parse", "refs/heads/docs/spaces"]);

    const result = runPromoteDocs(["--issue", "docs123", "--json"]);
    expect(result.status).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      status: string;
      docs_branch: string;
      proxy_branch: string;
      head_sha: string;
    };
    expect(payload.status).toBe("proxy_submitted");
    expect(payload.docs_branch).toBe("docs/spaces");
    expect(payload.proxy_branch).toMatch(/^promote\/docs\/\d{14}$/);
    expect(payload.head_sha).toBe(docsHead);

    // The proxy branch exists and points at the docs head — never the other way.
    const proxyHead = git(repo, ["rev-parse", `refs/heads/${payload.proxy_branch}`]);
    expect(proxyHead).toBe(docsHead);

    // The auth request was submitted for the PROXY branch, not the docs branch.
    const submittedArgs = fs.readFileSync(argLog, "utf8").trim().split("\n");
    expect(submittedArgs[0]).toBe(payload.proxy_branch);
    expect(submittedArgs).toContain("--issue");
    expect(submittedArgs).toContain("docs123");
    expect(submittedArgs).toContain("--no-watch");
    // The docs branch itself must never be the submitted head branch.
    expect(submittedArgs).not.toContain("docs/spaces");
  });

  it("requires an --issue reference", () => {
    const result = runPromoteDocs(["--json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--issue");
    expect(fs.existsSync(argLog)).toBe(false);
  });

  it("fails when the docs branch does not exist", () => {
    const result = runPromoteDocs(["--issue", "docs123", "--branch", "docs/missing"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not exist");
    expect(fs.existsSync(argLog)).toBe(false);
  });
});
