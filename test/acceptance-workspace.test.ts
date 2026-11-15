// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { waitUntil } from "./helpers/wait-until.js";
import { acceptanceCheckoutPath, runCandidateAcceptance } from "../src/candidate-acceptance.js";

const roots: string[] = [];
const previousHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = previousHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(mode: "pass" | "install-fail" | "build-fail" | "detached" | "cancel" = "pass") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(testRuntimeRoot), "acceptance-workspace-"));
  roots.push(root);
  const repoRoot = path.join(root, "source");
  const home = path.join(root, "home");
  const scripts = path.join(repoRoot, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(home);
  process.env.HOME = home;
  const checkout = acceptanceCheckoutPath();
  const ready = path.join(root, "ready");
  const stopped = path.join(root, "stopped");
  const runtime = path.join(root, "runtime");
  const scratch = path.join(path.dirname(checkout), "candidate-fixture-run");
  const scratchFixture = path.join(root, "scratch.mjs");
  const env = { ...process.env, FIXTURE_RUNTIME: runtime, FIXTURE_MODE: mode, FIXTURE_READY: ready, FIXTURE_STOPPED: stopped,
    MANDIBLE_ACCEPTANCE_ID: "fixture-run", FIXTURE_SCRATCH: scratch, FIXTURE_REAL_BUN: process.execPath, FIXTURE_SCRATCH_SCRIPT: scratchFixture };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, env, encoding: "utf8", timeout: 10_000 }).trim();
  const write = (file: string, text: string) => fs.writeFileSync(file, text, { mode: 0o755 });
  write(path.join(repoRoot, ".gitignore"), "node_modules/\n.cache/\ndist/\ntarget/\n/src-tauri/gen/\n/src-tauri/resources/\n/src-tauri/binaries/\n");
  write(path.join(scripts, "bun-runtime.sh"), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_RUNTIME"\n');
  write(scratchFixture, `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createOwnedRun, saveOwnedMetadata } from ${JSON.stringify(new URL("../scripts/owned-run.mjs", import.meta.url).href)};
import { generatedProcessLog, recordScratchProcessGroup } from ${JSON.stringify(new URL("../scripts/generated-scratch.mjs", import.meta.url).href)};
const root = process.env.FIXTURE_SCRATCH;
fs.mkdirSync(root);
const ownership = createOwnedRun({ root, instanceId: 'fixture', project: 'fixture', workUnit: 'fixture',
  runId: process.env.MANDIBLE_ACCEPTANCE_ID, disposable: true,
  outputs: ['build.log', generatedProcessLog].map(path => ({ path, kind: 'generated' })) });
saveOwnedMetadata(path.join(root, 'metadata.json'), { ownership });
fs.writeFileSync(path.join(root, 'build.log'), 'partial output');
if (process.env.FIXTURE_MODE === 'detached') {
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(process.env.FIXTURE_READY, String(child.pid));
  const log = path.join(root, generatedProcessLog);
  fs.writeFileSync(log, '');
  recordScratchProcessGroup(log, child);
  child.unref();
}
process.exitCode = 1;
`);
  write(runtime, `#!/bin/sh
set -eu
case "$1" in
  */runtime-environment-path.mjs) printf "%s\\n" "$PATH";;
  install)
    mkdir -p node_modules .cache/typescript src-tauri/target/release/deps src-tauri/service-helper/target/release
    touch node_modules/dependency .cache/typescript/check src-tauri/target/release/deps/compiled src-tauri/service-helper/target/release/helper
    if [ "$FIXTURE_MODE" = install-fail ]; then mkdir -p dist; touch dist/partial; exit 1; fi;;
  *) exec /bin/sh "$@";;
esac
`);
  write(path.join(scripts, "candidate-acceptance.mjs"), `#!/bin/sh
set -eu
mkdir -p dist ui/dist src-tauri/dist src-tauri/gen src-tauri/resources/app-payload/Contents src-tauri/resources/bun-runtime src-tauri/binaries \\
  src-tauri/target/release/bundle/macos src-tauri/target/aarch64-apple-darwin/debug/bundle/dmg
touch dist/daemon ui/dist/assets src-tauri/dist/bootstrap src-tauri/gen/schema src-tauri/resources/app-payload/Contents/staged \\
  src-tauri/resources/bun-runtime/bun.zip src-tauri/resources/libsqlite3.dylib src-tauri/resources/local-ca-trust-helper \\
  src-tauri/binaries/mandible-bun src-tauri/target/release/bundle/macos/Mandible.app \\
  src-tauri/target/aarch64-apple-darwin/debug/bundle/dmg/Mandible.dmg
if [ "$FIXTURE_MODE" = cancel ]; then
  trap 'touch src-tauri/dist/last-write; touch "$FIXTURE_STOPPED"; exit 1' TERM
  touch "$FIXTURE_READY"
  while :; do sleep 1; done
fi
if [ "$FIXTURE_MODE" = build-fail ] || [ "$FIXTURE_MODE" = detached ]; then
  exec "$FIXTURE_REAL_BUN" "$FIXTURE_SCRATCH_SCRIPT"
fi
printf '{"status":"passed","candidate":"%s"}\\n' "$(git rev-parse HEAD)"
`);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const pinSha = git("rev-parse", "HEAD");
  const run = (signal = new AbortController().signal) => runCandidateAcceptance({ repoRoot, pinSha, projectId: "fixture", workUnitId: "fixture", env, signal });
  const add = (directory: string) => git("worktree", "add", "--detach", directory, pinSha);
  const remaining = () => execFileSync("git", ["status", "--porcelain", "--ignored", "--untracked-files=all"], {
    cwd: checkout, encoding: "utf8", timeout: 10_000,
  }).trim().split("\n").sort();
  const retained = ["!! .cache/typescript/check", "!! node_modules/dependency", "!! src-tauri/service-helper/target/release/helper", "!! src-tauri/target/release/deps/compiled"].sort();
  return { root, checkout, ready, stopped, scratch, git, run, add, remaining, retained };
}

it("recreates only the missing acceptance checkout and clears all package outputs on a pass", async () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.checkout), { recursive: true });
  const unrelated = path.join(f.root, "missing unrelated");
  for (const directory of [f.checkout, unrelated]) {
    f.add(directory);
    fs.rmSync(directory, { recursive: true });
  }
  await expect(f.run()).resolves.toMatchObject({ status: "passed" });
  expect(f.remaining()).toEqual(f.retained);
  expect(f.git("worktree", "list", "--porcelain")).toContain(`worktree ${unrelated}`);
  expect(f.git("worktree", "list", "--porcelain")).toContain(`worktree ${f.checkout}\nHEAD`);
});

it("clears partial generated outputs when dependency preparation fails", async () => {
  const f = fixture("install-fail");
  await expect(f.run()).resolves.toMatchObject({ status: "failed", result: { phases: { checkout: { status: "failed" } } } });
  expect(f.remaining()).toEqual(f.retained);
});

it("clears owned scratch and checkout outputs after an interrupted package producer exits", async () => {
  const f = fixture("build-fail");
  await expect(f.run()).resolves.toMatchObject({ status: "failed" });
  expect(fs.existsSync(f.scratch)).toBe(false);
  expect(f.remaining()).toEqual(f.retained);
});

it("postpones cleanup and prevents checkout reuse while a separately supervised build group remains active", async () => {
  const f = fixture("detached");
  try {
    await expect(f.run()).resolves.toMatchObject({ status: "failed", result: { cleanup_error: expect.stringContaining("process lifetime") } });
    expect(fs.existsSync(f.scratch)).toBe(true);
    expect(fs.existsSync(path.join(f.checkout, "dist", "daemon"))).toBe(true);
    await expect(f.run()).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("previous candidate acceptance") });
  } finally {
    if (fs.existsSync(f.ready)) process.kill(-Number(fs.readFileSync(f.ready, "utf8")), "SIGKILL");
  }
});

it("joins the producer before clearing checkout outputs on cancellation", async () => {
  const f = fixture("cancel");
  const controller = new AbortController();
  const result = f.run(controller.signal);
  await waitUntil(() => fs.existsSync(f.ready), "candidate producer ready");
  controller.abort();
  await expect(result).resolves.toMatchObject({ status: "failed" });
  expect(fs.existsSync(f.stopped)).toBe(true);
  expect(f.remaining()).toEqual(f.retained);
});

it("leaves the exact checkout registration in place when Git marks it locked", async () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.checkout), { recursive: true });
  f.add(f.checkout);
  f.git("worktree", "lock", f.checkout);
  fs.rmSync(f.checkout, { recursive: true });
  await expect(f.run()).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("unlocked detached worktree") });
  expect(f.git("worktree", "list", "--porcelain")).toContain(`worktree ${f.checkout}`);
});
