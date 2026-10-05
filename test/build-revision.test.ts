// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBuildRevision, writeBuildRevision } from "../scripts/build-revision.mjs";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function makeCheckout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-build-revision-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "dist", "index.js"), "// built\n");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Mandible Test");
  git(root, "config", "user.email", "mandible-test@example.invalid");
  git(root, "add", "package.json", "src/index.ts");
  git(root, "commit", "-m", "baseline");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("daemon build revision", () => {
  it("binds built bytes to a source commit and rejects later source drift", () => {
    const root = makeCheckout();
    const commit = git(root, "rev-parse", "HEAD");
    expect(writeBuildRevision(root)).toBe(commit);
    expect(readBuildRevision(root)).toBe(commit);

    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "runtime.mjs"), "export {};\n");
    git(root, "add", "scripts/runtime.mjs");
    git(root, "commit", "-m", "runtime support");
    writeBuildRevision(root);
    fs.appendFileSync(path.join(root, "scripts", "runtime.mjs"), "// drift\n");
    expect(() => readBuildRevision(root)).toThrow("Daemon sources changed after the production build");
    fs.writeFileSync(path.join(root, "scripts", "runtime.mjs"), "export {};\n");

    fs.appendFileSync(path.join(root, "src", "index.ts"), "// changed after build\n");
    expect(() => readBuildRevision(root)).toThrow("Daemon sources changed after the production build");
  });
});
