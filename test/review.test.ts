import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { getCommitLog, getDiff, getSpec } from "../src/review.js";

const execFileAsync = promisify(execFile);

const runGit = async (repoPath: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout;
};

const createRepo = async (): Promise<string> => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "review-surface-"));
  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.name", "Review Bot"]);
  await runGit(repoPath, ["config", "user.email", "review@example.com"]);
  await runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  return repoPath;
};

const commitFile = async (
  repoPath: string,
  fileName: string,
  content: string,
  subject: string,
  body?: string,
): Promise<void> => {
  const filePath = path.join(repoPath, fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await runGit(repoPath, ["add", fileName]);
  const args = body ? ["commit", "-m", subject, "-m", body] : ["commit", "-m", subject];
  await runGit(repoPath, args);
};

describe("review surface", () => {
  it("diff generation returns raw/stat/html", async () => {
    const repoPath = await createRepo();
    await commitFile(repoPath, "README.md", "hello\n", "init");
    await commitFile(repoPath, "README.md", "hello\nworld\n", "add line");

    const diff = await getDiff(repoPath, "HEAD~1", "HEAD");

    expect(diff.raw).toContain("diff --git");
    expect(diff.stat.length).toBeGreaterThan(0);
    expect(diff.files.length).toBeGreaterThan(0);
    expect(diff.html).toContain("d2h-");
  });

  it("spec discovery prefers git notes", async () => {
    const repoPath = await createRepo();
    await commitFile(repoPath, "README.md", "hello\n", "init");
    await runGit(repoPath, ["notes", "add", "-m", "## Notes\n- Added", "HEAD"]);
    await fs.writeFile(path.join(repoPath, "COMMIT_MSG.txt"), "Fallback", "utf8");

    const spec = await getSpec(repoPath, "HEAD");

    expect(spec.source).toBe("git-notes");
    expect(spec.raw).toContain("Notes");
    expect(spec.html).toContain("<h2");
  });

  it("spec discovery prefers COMMIT_MSG.txt over README_COMMIT.md", async () => {
    const repoPath = await createRepo();
    await fs.writeFile(path.join(repoPath, "README_COMMIT.md"), "## Summary\n- Added", "utf8");
    await fs.writeFile(path.join(repoPath, "COMMIT_MSG.txt"), "Fallback", "utf8");

    const spec = await getSpec(repoPath, "HEAD");

    expect(spec.source).toBe("COMMIT_MSG.txt");
    expect(spec.raw).toContain("Fallback");
  });

  it("spec discovery falls back to COMMIT_MSG.txt", async () => {
    const repoPath = await createRepo();
    await fs.writeFile(path.join(repoPath, "COMMIT_MSG.txt"), "Fallback message", "utf8");

    const spec = await getSpec(repoPath, "HEAD");

    expect(spec.source).toBe("COMMIT_MSG.txt");
    expect(spec.raw).toContain("Fallback");
  });

  it("spec discovery falls back to README_COMMIT.md for old commits", async () => {
    const repoPath = await createRepo();
    await commitFile(repoPath, "README_COMMIT.md", "## Summary\n- Legacy", "add notes");
    await fs.unlink(path.join(repoPath, "README_COMMIT.md"));

    const spec = await getSpec(repoPath, "HEAD");

    expect(spec.source).toBe("README_COMMIT.md");
    expect(spec.raw).toContain("Legacy");
    expect(spec.html).toContain("<h2");
  });

  it("spec discovery returns empty when missing", async () => {
    const repoPath = await createRepo();

    const spec = await getSpec(repoPath, "HEAD");

    expect(spec.source).toBe("");
    expect(spec.raw).toBe("");
    expect(spec.html).toBe("");
  });

  it("commit log parses co-authors", async () => {
    const repoPath = await createRepo();
    await commitFile(repoPath, "README.md", "hello\n", "init");
    await commitFile(
      repoPath,
      "README.md",
      "hello\nworld\n",
      "add line",
      "Co-Authored-By: Codex <codex@openai.com>",
    );

    const log = await getCommitLog(repoPath, "HEAD~1", "HEAD");

    expect(log.total).toBe(1);
    expect(log.commits[0].co_authors).toContain("Codex");
  });
});
