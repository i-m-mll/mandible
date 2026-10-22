import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyRuntimeFixture } from './helpers/runtime-fixture.js';

const tempRoots: string[] = [];

type HookResult = {
  status: number | null;
  stderr: string;
  home: string;
  tracePath: string;
  desktopTracePath: string;
  runtimeTracePath: string;
};

function copyCliFile(name: string, destDir: string): void {
  fs.copyFileSync(path.join(process.cwd(), "cli", name), path.join(destDir, name));
}

function runGit(repo: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  expect(result.status, result.stderr).toBe(0);
}

function runHookAfterMerge(
  changedPath: string,
  failGitDiff = false,
  replayAfterUnrelatedMerge = false,
  withCutover = false,
): HookResult {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-post-merge-hook-"));
  tempRoots.push(tempDir);

  const repo = path.join(tempDir, "repo");
  const home = path.join(tempDir, "home");
  const cliDir = path.join(repo, "cli");
  const tracePath = path.join(tempDir, "trace");
  const desktopTracePath = path.join(tempDir, "desktop-trace");
  const runtimeTracePath = path.join(tempDir, "runtime-trace");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(path.join(repo, "dist"));
  const sqliteBuild = spawnSync(process.execPath, ["build", path.join(process.cwd(), "src/sqlite.ts"), "--target", "bun", "--outfile", path.join(repo, "dist/sqlite.js")], { encoding: "utf8" });
  expect(sqliteBuild.status, sqliteBuild.stderr).toBe(0);
  const runtimeInputs = copyRuntimeFixture(repo);
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "# Codex\n\nLocal policy.\n", "utf8");

  copyCliFile("post-merge-build-dist.sh", cliDir);
  fs.copyFileSync(
    path.join(process.cwd(), "scripts", "local-session-production-runner.mjs"),
    path.join(repo, "scripts", "local-session-production-runner.mjs"),
  );
  fs.writeFileSync(path.join(repo, "scripts", "local-front-door.mjs"), `
import fs from "node:fs";
fs.appendFileSync(process.env.MANDIBLE_TEST_TRACE, "gateway\\n");
if (process.env.MANDIBLE_TEST_GATEWAY_FAIL === "1") process.exit(23);
`);
  fs.writeFileSync(path.join(repo, "scripts", "local-runtime.mjs"), `
import fs from "node:fs";
fs.appendFileSync(process.env.MANDIBLE_TEST_RUNTIME_TRACE, "runtime\\n");
`);
  if (withCutover) {
    fs.mkdirSync(path.join(home, ".mandible", "config", "local-sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, ".mandible", "config", "local-sessions", "cutover.json"), "{}\n");
  }
  copyCliFile("instructions.sh", cliDir);
  copyCliFile("instructions-contract.md", cliDir);
  for (const file of ["command-syntax.sh", "command-syntax.cjs", "command-syntax.json"]) copyCliFile(file, cliDir);
  // instructions.sh's settings helper requires two shared modules from the same
  // cli/ directory: the production-DB guard (issue 07edc0d) and the durable-root
  // path resolver (issue 24f0316). Ship both into the temp repo.
  copyCliFile("production-db-guard.cjs", cliDir);
  copyCliFile("mandible-paths.cjs", cliDir);

  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.name", "Mandible Test"]);
  runGit(repo, ["config", "user.email", "mandible-test@example.invalid"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "baseline"]);
  const mergeBaseSha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  runGit(repo, ["checkout", "-b", "topic"]);

  const changedFile = path.join(repo, changedPath);
  fs.mkdirSync(path.dirname(changedFile), { recursive: true });
  if (changedPath === "package.json") {
    fs.writeFileSync(changedFile, '{"name":"post-merge-test","private":true}\n', "utf8");
  } else {
    fs.appendFileSync(changedFile, "\n", "utf8");
  }
  runGit(repo, ["add", changedPath]);
  runGit(repo, ["commit", "-m", `change ${changedPath}`]);
  const mergeHeadSha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  runGit(repo, ["checkout", "main"]);
  runGit(repo, ["merge", "--no-ff", "topic", "-m", "merge topic"]);
  if (replayAfterUnrelatedMerge) {
    runGit(repo, ["checkout", "-b", "later"]);
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs", "later.md"), "later\n", "utf8");
    runGit(repo, ["add", "docs/later.md"]);
    runGit(repo, ["commit", "-m", "later unrelated change"]);
    runGit(repo, ["checkout", "main"]);
    runGit(repo, ["merge", "--no-ff", "later", "-m", "merge later"]);
  }

  const hookEnv = { ...process.env };
  if (failGitDiff) {
    const gitBin = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const shimDir = path.join(tempDir, "bin");
    fs.mkdirSync(shimDir);
    fs.writeFileSync(
      path.join(shimDir, "git"),
      `#!/usr/bin/env bash
if [[ "$1" == "diff" ]]; then
  printf '%s\\n' 'injected git diff failure' >&2
  exit 42
fi
exec "$REAL_GIT" "$@"
`,
      { mode: 0o755 },
    );
    hookEnv.PATH = `${shimDir}${path.delimiter}${hookEnv.PATH}`;
    hookEnv.REAL_GIT = gitBin;
  }

  const result = spawnSync("bash", ["cli/post-merge-build-dist.sh"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...hookEnv,
      ...runtimeInputs,
      HOME: home,
      MANDIBLE_DB: path.join(tempDir, "fixture.db"),
      MANDIBLE_RUNTIME: process.execPath,
      MANDIBLE_POST_MERGE_DEPENDENCY_COMMAND: 'printf "dependencies\\n" >> "$MANDIBLE_TEST_TRACE"',
      MANDIBLE_POST_MERGE_BUILD_COMMAND: 'test "$PATH" = "$MANDIBLE_TEST_RUNTIME_PATH" && printf "build\\n" >> "$MANDIBLE_TEST_TRACE"',
      MANDIBLE_TEST_RUNTIME_PATH: `${path.dirname(process.execPath)}${path.delimiter}${hookEnv.PATH}`,
      MANDIBLE_POST_MERGE_DESKTOP_COMMAND:
        'printf "desktop\\n" >> "$MANDIBLE_TEST_DESKTOP_TRACE"',
      MANDIBLE_TEST_TRACE: tracePath,
      MANDIBLE_TEST_DESKTOP_TRACE: desktopTracePath,
      MANDIBLE_TEST_RUNTIME_TRACE: runtimeTracePath,
      MANDIBLE_AUTH_MERGE_BASE_SHA: replayAfterUnrelatedMerge ? mergeBaseSha : "",
      MANDIBLE_AUTH_MERGE_HEAD_SHA: replayAfterUnrelatedMerge ? mergeHeadSha : "",
    },
  });

  return { status: result.status, stderr: result.stderr, home, tracePath, desktopTracePath, runtimeTracePath };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("post-merge build hook", () => {
  it.each(["cli/instructions-contract.md", "cli/command-syntax.json", "cli/command-syntax.cjs"])(
    "refreshes build provenance and installs instructions after changing %s",
    (changedPath) => {
      const result = runHookAfterMerge(changedPath);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("[post-merge-build] generated local build artifacts");
      expect(result.stderr).toContain("no native desktop changes detected");
      expect(result.stderr).toContain("[post-merge-build] installed managed instruction fragments");
      expect(fs.readFileSync(result.tracePath, "utf8")).toBe("dependencies\nbuild\n");
      expect(fs.existsSync(result.desktopTracePath)).toBe(false);

      const claudeTarget = path.join(result.home, ".claude", "CLAUDE.md");
      const codexTarget = path.join(result.home, ".codex", "AGENTS.md");
      expect(fs.readFileSync(claudeTarget, "utf8")).toContain("Mandible Interface Contract");
      expect(fs.readFileSync(codexTarget, "utf8")).toContain("Mandible Interface Contract");
      expect(fs.readFileSync(codexTarget, "utf8")).toContain("Local policy.");
    },
    15_000,
  );

  it(
    "builds local artifacts and installs instructions after a source-changing merge",
    () => {
      const result = runHookAfterMerge("src/index.ts");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("[post-merge-build] generated local build artifacts");
      expect(result.stderr).toContain("no native desktop changes detected");
      expect(result.stderr).toContain("[post-merge-build] installed managed instruction fragments");
      expect(fs.readFileSync(result.tracePath, "utf8")).toBe("dependencies\nbuild\n");
      expect(fs.existsSync(result.desktopTracePath)).toBe(false);
      expect(fs.readFileSync(path.join(result.home, ".claude", "CLAUDE.md"), "utf8")).toContain(
        "Mandible Interface Contract",
      );
    },
    15_000,
  );

  it("deploys the desktop bundle after a native-only source merge", () => {
    const result = runHookAfterMerge("src-tauri/src/lib.rs");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("generated local build artifacts");
    expect(result.stderr).toContain("installed native desktop bundle");
    expect(fs.readFileSync(result.tracePath, "utf8")).toBe("dependencies\nbuild\n");
    expect(fs.readFileSync(result.desktopTracePath, "utf8")).toBe("desktop\n");
  });

  it("replays the original native deployment after HEAD advances", () => {
    const result = runHookAfterMerge("src-tauri/src/lib.rs", false, true);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("installed native desktop bundle");
    expect(fs.readFileSync(result.desktopTracePath, "utf8")).toBe("desktop\n");
  });

  it("runs both build paths after a shared dependency merge", () => {
    const result = runHookAfterMerge("package.json");

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(result.tracePath, "utf8")).toBe("dependencies\nbuild\n");
    expect(fs.readFileSync(result.desktopTracePath, "utf8")).toBe("desktop\n");
  });

  it("does nothing after an unrelated merge", () => {
    const result = runHookAfterMerge("docs/note.md");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[post-merge-build] no Mandible source changes detected; skipping build");
    expect(result.stderr).not.toContain("[post-merge-build] generated local build artifacts");
    expect(result.stderr).toContain("no native desktop changes detected");
    expect(result.stderr).not.toContain("[post-merge-build] installed managed instruction fragments");
    expect(fs.existsSync(result.tracePath)).toBe(false);
    expect(fs.existsSync(result.desktopTracePath)).toBe(false);
    expect(fs.existsSync(path.join(result.home, ".claude", "CLAUDE.md"))).toBe(false);
  });

  it("leaves the production runtime with launchd even when a historical cutover record exists", () => {
    const replay = runHookAfterMerge("scripts/local-runtime.mjs", false, true, true);
    expect(replay.status, replay.stderr).toBe(0);
    expect(replay.stderr).toContain("runtime restart remains with the production LaunchAgent");
    expect(fs.readFileSync(replay.desktopTracePath, "utf8")).toBe("desktop\n");
    expect(fs.readFileSync(replay.tracePath, "utf8")).toBe("dependencies\nbuild\n");
    expect(fs.existsSync(replay.runtimeTracePath)).toBe(false);
    expect(replay.stderr).not.toContain("converged");
  });

  it("exits nonzero when git diff fails", () => {
    const result = runHookAfterMerge("docs/note.md", true);

    expect(result.status).toBe(42);
    expect(result.stderr).toContain("injected git diff failure");
    expect(result.stderr).not.toContain("skipping build");
    expect(result.stderr).not.toContain("installed managed instruction fragments");
    expect(fs.existsSync(result.tracePath)).toBe(false);
    expect(fs.existsSync(result.desktopTracePath)).toBe(false);
  });
});
