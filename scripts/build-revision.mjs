#!/usr/bin/env bun

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE_PATHS = ["package.json", ".bun-version", "bun.lock", "bunfig.toml", "tsconfig.json", "src", "channel-server", "ui", "scripts", "bin", "cli", "config", "src-tauri"];

function git(root, ...args) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
  });
  return result;
}

function trackedSourceDigest(root) {
  const listed = git(root, "ls-files", "-z", "--", ...SOURCE_PATHS);
  if (listed.status !== 0) throw new Error(`Cannot inventory the built daemon sources: ${listed.stderr.trim()}`);
  const files = listed.stdout.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Built daemon source is missing or not a regular file: ${file}`);
    }
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Freeze every executable dependency by relative name, link target and bytes. */
function executableDirectoryDigest(directory, allowLinks) {
  const hash = createHash("sha256");
  const visit = (file, relative, ancestors) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      if (!allowLinks) throw new Error(`Built daemon output is not a regular file: ${relative}`);
      hash.update(`link:${relative}\0${fs.readlinkSync(file)}\0`);
      const target = fs.realpathSync(file);
      if (ancestors.has(target)) throw new Error(`Executable dependency link forms a cycle: ${relative}`);
      visit(target, relative, ancestors);
    } else if (stat.isDirectory()) {
      const real = fs.realpathSync(file);
      if (ancestors.has(real)) throw new Error(`Executable dependency directory forms a cycle: ${relative}`);
      const next = new Set([...ancestors, real]);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), relative ? `${relative}/${name}` : name, next);
    } else if (stat.isFile()) {
      hash.update(relative); hash.update("\0"); hash.update(fs.readFileSync(file)); hash.update("\0");
    } else throw new Error(`Executable dependency is not a regular file: ${relative}`);
  };
  visit(directory, "", new Set());
  return hash.digest("hex");
}

export function compiledBuildDigest(root) { return executableDirectoryDigest(path.join(root, "dist"), false); }
export function runtimeDependenciesDigest(root) { return executableDirectoryDigest(path.join(root, "node_modules"), true); }

export function writeBuildRevision(root) {
  const head = git(root, "rev-parse", "HEAD");
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) {
    throw new Error(`Cannot identify the built daemon revision: ${head.stderr.trim()}`);
  }
  const output = path.join(root, "dist", "build-revision.json");
  if (!fs.existsSync(path.join(root, "dist", "index.js"))) throw new Error("The daemon build output is missing dist/index.js.");
  fs.writeFileSync(output, `${JSON.stringify({ commit: head.stdout.trim(), source_digest: trackedSourceDigest(root) })}\n`, { mode: 0o600 });
  return head.stdout.trim();
}

export function readBuildRevision(root) {
  const file = path.join(root, "dist", "build-revision.json");
  let marker;
  try { marker = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`The daemon build revision marker is missing or invalid: ${error.message}`); }
  if (!/^[a-f0-9]{40}$/.test(marker.commit ?? "") || !/^[a-f0-9]{64}$/.test(marker.source_digest ?? "")) {
    throw new Error("The daemon build revision marker is malformed.");
  }
  const head = git(root, "rev-parse", "HEAD");
  if (head.status !== 0) throw new Error(`Cannot inspect the production checkout: ${head.stderr.trim()}`);
  const headCommit = head.stdout.trim();
  const ancestor = git(root, "merge-base", "--is-ancestor", marker.commit, headCommit);
  if (ancestor.status !== 0) throw new Error("The daemon build revision is not an ancestor of the production checkout.");
  const trackedChanges = git(root, "diff", "--quiet", "HEAD", "--", ...SOURCE_PATHS);
  if (trackedChanges.status !== 0) throw new Error("Daemon sources changed after the production build; rebuild before starting the service.");
  const untracked = git(root, "status", "--porcelain", "--untracked-files=all", "--", ...SOURCE_PATHS);
  if (untracked.status !== 0 || untracked.stdout.trim()) throw new Error("Uncommitted daemon source files are present; refusing to start a production build.");
  const againstBuild = git(root, "diff", "--quiet", marker.commit, "HEAD", "--", ...SOURCE_PATHS);
  if (againstBuild.status !== 0) throw new Error("Daemon sources differ from the recorded build revision; rebuild before starting the service.");
  if (trackedSourceDigest(root) !== marker.source_digest) throw new Error("The daemon build revision does not match the current source bytes.");
  if (!fs.existsSync(path.join(root, "dist", "index.js"))) throw new Error("The daemon build output is missing dist/index.js.");
  return marker.commit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const command = process.argv[2];
  if (command !== "write") throw new Error("Usage: build-revision.mjs write");
  process.stdout.write(`${writeBuildRevision(root)}\n`);
}
