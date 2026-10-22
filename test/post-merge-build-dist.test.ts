// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { copyRuntimeFixture } from "./helpers/runtime-fixture.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

// The hook decides from the merged paths what to rebuild. Dependency install,
// build and desktop install are stubbed to trace lines; instruction install runs
// for real, because its output lands in the operator's agent instructions.

const root = path.join(testRuntimeRoot, "post-merge");
const template = path.join(root, "template");
let runtimeInputs: Record<string, string> = {};
let caseCount = 0;

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function commitFile(repo: string, branch: string, file: string): void {
  git(repo, "checkout", "-q", "-b", branch);
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (file === "package.json") fs.writeFileSync(target, '{"name":"post-merge-test","private":true}\n');
  else fs.appendFileSync(target, "\n");
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", `change ${file}`);
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", branch, "-m", `merge ${branch}`);
}

beforeAll(() => {
  fs.mkdirSync(path.join(template, "cli"), { recursive: true });
  fs.mkdirSync(path.join(template, "dist"));
  // The instructions helper loads the SQLite boundary from source; one bundled
  // file stands in for the source tree it imports.
  const sqliteBuild = spawnSync(process.execPath, ["build", path.join(process.cwd(), "src/sqlite.ts"), "--target", "bun", "--outfile", path.join(template, "src/sqlite.ts")], { encoding: "utf8" });
  expect(sqliteBuild.status, sqliteBuild.stderr).toBe(0);
  runtimeInputs = copyRuntimeFixture(template);
  for (const name of [
    "post-merge-build-dist.sh", "instructions.sh", "instructions-contract.md",
    "command-syntax.sh", "command-syntax.cjs", "command-syntax.json",
    "production-db-guard.cjs", "mandible-paths.cjs",
  ]) {
    fs.copyFileSync(path.join(process.cwd(), "cli", name), path.join(template, "cli", name));
  }
  fs.copyFileSync(path.join(process.cwd(), "scripts", "local-session-production-runner.mjs"), path.join(template, "scripts", "local-session-production-runner.mjs"));
  fs.writeFileSync(path.join(template, "scripts", "local-front-door.mjs"), 'import fs from "node:fs";\nfs.appendFileSync(process.env.MANDIBLE_TEST_TRACE, "gateway\\n");\n');
  fs.writeFileSync(path.join(template, "scripts", "local-runtime.mjs"), 'import fs from "node:fs";\nfs.appendFileSync(process.env.MANDIBLE_TEST_RUNTIME_TRACE, "runtime\\n");\n');
  git(template, "init", "-q", "-b", "main");
  git(template, "config", "user.name", "Mandible Test");
  git(template, "config", "user.email", "mandible-test@example.invalid");
  git(template, "add", ".");
  git(template, "commit", "-q", "-m", "baseline");
});

interface HookCase {
  changed: string;
  /** Merge an unrelated branch afterwards and pass the original range explicitly. */
  replay?: boolean;
  /** Leave a historical local-session cutover record in the operator's home. */
  cutover?: boolean;
  failGitDiff?: boolean;
}

function runHook({ changed, replay = false, cutover = false, failGitDiff = false }: HookCase) {
  const dir = path.join(root, `case-${caseCount += 1}`);
  const repo = path.join(dir, "repo");
  const home = path.join(dir, "home");
  fs.cpSync(template, repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "# Codex\n\nLocal policy.\n");
  if (cutover) {
    fs.mkdirSync(path.join(home, ".mandible", "config", "local-sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, ".mandible", "config", "local-sessions", "cutover.json"), "{}\n");
  }
  const base = git(repo, "rev-parse", "HEAD");
  commitFile(repo, "topic", changed);
  const head = git(repo, "rev-parse", "HEAD^2");
  if (replay) commitFile(repo, "later", "docs/later.md");

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (failGitDiff) {
    const shimDir = path.join(dir, "bin");
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, "git"), `#!/usr/bin/env bash
if [[ "$1" == "diff" ]]; then
  printf '%s\\n' 'injected git diff failure' >&2
  exit 42
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
    env.REAL_GIT = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    env.PATH = `${shimDir}${path.delimiter}${env.PATH}`;
  }
  const trace = path.join(dir, "trace");
  const desktopTrace = path.join(dir, "desktop-trace");
  const runtimeTrace = path.join(dir, "runtime-trace");
  const result = spawnSync("bash", ["cli/post-merge-build-dist.sh"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...env,
      ...runtimeInputs,
      HOME: home,
      MANDIBLE_DB: path.join(dir, "fixture.db"),
      MANDIBLE_RUNTIME: process.execPath,
      MANDIBLE_POST_MERGE_DEPENDENCY_COMMAND: 'printf "dependencies\\n" >> "$MANDIBLE_TEST_TRACE"',
      MANDIBLE_POST_MERGE_BUILD_COMMAND: 'test "$PATH" = "$MANDIBLE_TEST_RUNTIME_PATH" && printf "build\\n" >> "$MANDIBLE_TEST_TRACE"',
      MANDIBLE_TEST_RUNTIME_PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH}`,
      MANDIBLE_POST_MERGE_DESKTOP_COMMAND: 'printf "desktop\\n" >> "$MANDIBLE_TEST_DESKTOP_TRACE"',
      MANDIBLE_TEST_TRACE: trace,
      MANDIBLE_TEST_DESKTOP_TRACE: desktopTrace,
      MANDIBLE_TEST_RUNTIME_TRACE: runtimeTrace,
      MANDIBLE_AUTH_MERGE_BASE_SHA: replay ? base : "",
      MANDIBLE_AUTH_MERGE_HEAD_SHA: replay ? head : "",
    },
  });
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  const claude = read(path.join(home, ".claude", "CLAUDE.md"));
  return {
    status: result.status,
    stderr: result.stderr,
    built: read(trace),
    desktop: read(desktopTrace),
    runtime: read(runtimeTrace),
    instructionsInstalled: claude?.includes("Mandible Interface Contract") ?? false,
    codexPolicy: read(path.join(home, ".codex", "AGENTS.md")),
  };
}

describe("post-merge build hook", () => {
  it("rebuilds after a Mandible merge, deploys the desktop for native or shared paths, and installs instructions for contract or source paths", () => {
    const cases = [
      { changed: "src/index.ts", desktop: false, instructions: true },
      { changed: "cli/instructions-contract.md", desktop: false, instructions: true },
      { changed: "src-tauri/src/lib.rs", desktop: true, instructions: false },
      { changed: "package.json", desktop: true, instructions: true },
    ];
    for (const expected of cases) {
      const result = runHook({ changed: expected.changed });
      expect(result.status, `${expected.changed}: ${result.stderr}`).toBe(0);
      expect({ changed: expected.changed, built: result.built, desktop: result.desktop, instructions: result.instructionsInstalled }).toEqual({
        changed: expected.changed,
        built: "dependencies\nbuild\n",
        desktop: expected.desktop ? "desktop\n" : null,
        instructions: expected.instructions,
      });
      if (expected.instructions) {
        expect(result.codexPolicy).toContain("Mandible Interface Contract");
        expect(result.codexPolicy).toContain("Local policy.");
      }
    }
  });

  it("does nothing after an unrelated merge", () => {
    const result = runHook({ changed: "docs/note.md" });
    expect(result.status, result.stderr).toBe(0);
    expect(result).toMatchObject({ built: null, desktop: null, instructionsInstalled: false });
  });

  it("replays the original merge range after HEAD advances and leaves the runtime restart to launchd", () => {
    const result = runHook({ changed: "scripts/local-runtime.mjs", replay: true, cutover: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result).toMatchObject({ built: "dependencies\nbuild\n", desktop: "desktop\n", runtime: null });
    expect(result.stderr).toContain("runtime restart remains with the production LaunchAgent");
  });

  it("fails without building when it cannot read the merged paths", () => {
    const result = runHook({ changed: "src/index.ts", failGitDiff: true });
    expect(result.status).toBe(42);
    expect(result.stderr).toContain("injected git diff failure");
    expect(result).toMatchObject({ built: null, desktop: null, instructionsInstalled: false });
  });
});
