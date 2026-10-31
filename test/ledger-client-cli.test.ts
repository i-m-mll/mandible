import { runCli } from "./helpers/cli-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

let tempRoots: string[] = [];

function runBash(
  script: string,
  cwd = process.cwd(),
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // Pin a dead loopback endpoint. Clearing MANDIBLE_BASE alone falls back to
  // the production canonical origin, even when MANDIBLE_PORT is a test port.
  const { MANDIBLE_BASE: _leakedBase, ...baseEnv } = process.env;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
      env: {
        ...baseEnv,
        MANDIBLE_BASE: `http://127.0.0.1:${extraEnv.MANDIBLE_PORT || "9"}`,
        ZELLIJ: "",
        TMUX: "",
        CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "", CLAUDE_SESSION_ID: "", GEMINI_SESSION_ID: "",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function makeGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-client-git-"));
  tempRoots.push(root);
  git(["init", "-b", "main"], root);
  git(["config", "user.name", "Mandible Test"], root);
  git(["config", "user.email", "mandible-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n", "utf8");
  git(["add", "tracked.txt"], root);
  git(["commit", "-m", "base"], root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe("ledger mechanism CLI client", () => {
  it("supports sourceable issue-file helpers", async () => {
    const repo = makeGitRepo();
    const result = await runCli(["issue-file", "write", "abc123", "def456"], { cwd: repo });
    expect(result.status).toBe(0);

    fs.appendFileSync(path.join(repo, ".issue"), "\n# comment\n\n", "utf8");
    expect((await runCli(["issue-file", "read"], { cwd: repo })).stdout).toBe("abc123\ndef456\n");
    const sourced = await runBash(
      [
        `source ${JSON.stringify(path.join(process.cwd(), "cli", "ledger-client.sh"))}`,
        "mandible_issue_file_read",
      ].join("\n"),
      repo,
    );
    expect(sourced.status).toBe(0);
    expect(sourced.stdout).toBe("abc123\ndef456\n");
  });

  it("makes daemon-unreachable operations non-fatal when graceful is requested", async () => {
    const result = await runBash(
      [
        `source ${JSON.stringify(path.join(process.cwd(), "cli", "ledger-client.sh"))}`,
        "mandible_work_unit_claim --issue abc123 --repo mandible --branch feature/abc123 --graceful",
        "printf done",
      ].join("\n"),
      process.cwd(),
      { MANDIBLE_PORT: "9", MANDIBLE_BASE: "http://127.0.0.1:9" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("done");
    expect(result.stderr).toContain("Mandible ledger request skipped");
  });
});
