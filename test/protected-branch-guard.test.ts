/**
 * @vitest-environment node
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import {
  ALLOWED_SIGNERS_FILE,
  PROTECTED_REFS_FILE,
  buildProtectedBranchGuardProjection,
  startProtectedBranchGuardProjection,
  writeProtectedBranchGuardProjection,
} from "../src/protected-branch-guard.js";
import { addCredential, createUser, revokeCredential, setupOperator } from "../src/users/store.js";

// Issue 5886596 — the Git reference-transaction guard and the projection the
// daemon writes for it. The guard runs against real repositories here, with
// throwaway keys standing in for the operator, Mandible's delegated signer,
// and an agent.
const GUARD_HOOKS = fileURLToPath(new URL("../hooks/git", import.meta.url));

interface Key {
  path: string;
  publicMaterial: string;
  fingerprint: string;
}

let tempDir = "";
let mandibleHome = "";
let guardDir = "";
let db: Db;
let origin = "";
let work = "";
let worktree = "";
let operatorKey: Key;
let delegatedKey: Key;
let agentKey: Key;
let operatorCredentialIds: string[] = [];
let delegatedCredentialId = "";
let agentCredentialId = "";

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    MANDIBLE_HOME: mandibleHome,
    GIT_AUTHOR_NAME: "Guard Test",
    GIT_AUTHOR_EMAIL: "guard-test@example.invalid",
    GIT_COMMITTER_NAME: "Guard Test",
    GIT_COMMITTER_EMAIL: "guard-test@example.invalid",
  };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key) || key === "GIT_DIR") delete env[key];
  }
  return env;
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function signedBy(key: Key, args: string[]): string[] {
  return ["-c", "gpg.format=ssh", "-c", `user.signingkey=${key.path}`, "-c", "commit.gpgsign=true", ...args];
}

function makeKey(name: string): Key {
  const keyPath = path.join(tempDir, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", keyPath]);
  return {
    path: keyPath,
    publicMaterial: fs.readFileSync(`${keyPath}.pub`, "utf8").trim(),
    fingerprint: execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"], { encoding: "utf8" })
      .trim()
      .split(/\s+/)[1]!,
  };
}

function commonDirOf(repo: string): string {
  return fs.realpathSync.native(path.join(repo, ".git"));
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-protected-guard-"));
  mandibleHome = path.join(tempDir, "mandible-home");
  guardDir = path.join(mandibleHome, "git-guard");
  operatorKey = makeKey("operator");
  delegatedKey = makeKey("delegated");
  agentKey = makeKey("agent");

  db = openDb(path.join(tempDir, "mandible.db"));
  const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
  const operatorCredential = addCredential(db, operator.id, {
    type: "ssh_key",
    fingerprint: operatorKey.fingerprint,
    public_material: operatorKey.publicMaterial,
  });
  const delegated = addCredential(db, operator.id, {
    type: "delegated_ssh_key",
    fingerprint: delegatedKey.fingerprint,
    public_material: delegatedKey.publicMaterial,
  });
  operatorCredentialIds = [operatorCredential.id, delegated.id];
  delegatedCredentialId = delegated.id;
  const agent = createUser(db, { slug: "agent-worker", kind: "agent", display_name: "Agent" });
  agentCredentialId = addCredential(db, agent.id, {
    type: "ssh_key",
    fingerprint: agentKey.fingerprint,
    public_material: agentKey.publicMaterial,
  }).id;

  origin = path.join(tempDir, "origin.git");
  work = path.join(tempDir, "work");
  worktree = path.join(tempDir, "work-feature");
  gitOk(tempDir, ["init", "-q", "--bare", "-b", "main", origin]);
  gitOk(tempDir, ["clone", "-q", origin, work]);
  gitOk(work, ["commit", "-q", "--allow-empty", "-m", "base"]);
  gitOk(work, ["push", "-q", "origin", "main"]);
  gitOk(work, ["worktree", "add", "-q", "-b", "feature", worktree]);

  addProject(db, { project_key: "guarded" });
  addOrUpdateCheckout(db, "guarded", { root: work, default_branch: "trunk" });
  addOrUpdateCheckout(db, "guarded", { root: worktree, default_branch: "" });
  addOrUpdateCheckout(db, "guarded", { root: path.join(tempDir, "missing-checkout"), default_branch: "main" });
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('protected_branches', 'main', 0)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("protected-branch guard projection", () => {
  it("keys protected refs by repository and lists only the operator's signing keys", () => {
    const projection = buildProtectedBranchGuardProjection(db);
    const commonDir = commonDirOf(work);
    expect(projection.protectedRefs).toEqual([
      [commonDir, "refs/heads/main"],
      [commonDir, "refs/heads/trunk"],
    ]);
    const principals = projection.allowedSigners.map((line) => line.split(" ")[0]);
    expect(principals.sort()).toEqual([...operatorCredentialIds].sort());
    expect(principals).not.toContain(agentCredentialId);

    writeProtectedBranchGuardProjection(guardDir, projection);
    const refsLines = fs.readFileSync(path.join(guardDir, PROTECTED_REFS_FILE), "utf8").trimEnd().split("\n");
    expect(refsLines[1]).toBe("names\trefs/heads/main\trefs/heads/trunk");
    expect(refsLines.slice(2)).toEqual([`${commonDir}\trefs/heads/main`, `${commonDir}\trefs/heads/trunk`]);
  });

  it("rewrites the projection when protection inputs change, without polling", async () => {
    const projector = startProtectedBranchGuardProjection({ db, logger: () => undefined, dir: guardDir });
    try {
      revokeCredential(db, delegatedCredentialId);
      addOrUpdateCheckout(db, "guarded", { root: work, default_branch: "release" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(fs.readFileSync(path.join(guardDir, ALLOWED_SIGNERS_FILE), "utf8")).not.toContain(delegatedCredentialId);
      expect(fs.readFileSync(path.join(guardDir, PROTECTED_REFS_FILE), "utf8")).toContain(
        `${commonDirOf(work)}\trefs/heads/release`,
      );
    } finally {
      projector.stop();
    }
  });
});

describe("protected-branch guard hook", () => {
  beforeEach(() => {
    writeProtectedBranchGuardProjection(guardDir, buildProtectedBranchGuardProjection(db));
    gitOk(work, ["config", "core.hooksPath", GUARD_HOOKS]);
  });

  it("moves a protected branch only to operator-signed commits or upstream fast-forwards", () => {
    expect(git(worktree, signedBy(agentKey, ["commit", "-q", "--allow-empty", "-m", "agent work"])).status).toBe(0);
    expect(git(work, signedBy(operatorKey, ["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"])).status).toBe(0);
    expect(git(work, signedBy(delegatedKey, ["commit", "-q", "--allow-empty", "-m", "delegated merge"])).status).toBe(0);

    const agentCommit = git(work, signedBy(agentKey, ["commit", "-q", "--allow-empty", "-m", "direct"]));
    expect(agentCommit.status).not.toBe(0);
    expect(agentCommit.stderr).toContain("refusing to move protected branch 'main'");
    expect(agentCommit.stderr).toContain("mandible auth request");
    expect(git(work, ["commit", "-q", "--allow-empty", "-m", "unsigned"]).status).not.toBe(0);
    expect(git(work, ["update-ref", "refs/heads/main", "feature"]).status).not.toBe(0);
    expect(git(worktree, ["update-ref", "refs/heads/main", "feature"]).status).not.toBe(0);

    expect(git(work, ["branch", "trunk", "main"]).status).toBe(0);
    const deletion = git(work, ["branch", "-D", "trunk"]);
    expect(deletion.status).not.toBe(0);
    expect(deletion.stderr).toContain("refusing to delete protected branch 'trunk'");
    expect(git(work, ["pack-refs", "--all"]).status).toBe(0);

    // A collaborator's unsigned commits reach main only by fast-forwarding to
    // what the upstream already contains.
    gitOk(work, ["push", "-q", "origin", "main"]);
    const collaborator = path.join(tempDir, "collaborator");
    gitOk(tempDir, ["clone", "-q", origin, collaborator]);
    gitOk(collaborator, ["commit", "-q", "--allow-empty", "-m", "collaborator"]);
    gitOk(collaborator, ["push", "-q", "origin", "main"]);
    expect(git(work, ["pull", "-q", "--ff-only"]).status).toBe(0);
    expect(gitOk(work, ["rev-parse", "main"])).toBe(gitOk(work, ["rev-parse", "origin/main"]));
  });

  it("leaves unregistered repositories alone and warns once when the projection is missing", () => {
    const other = path.join(tempDir, "other");
    gitOk(tempDir, ["init", "-q", "-b", "main", other]);
    gitOk(other, ["config", "core.hooksPath", GUARD_HOOKS]);
    const unregistered = git(other, signedBy(agentKey, ["commit", "-q", "--allow-empty", "-m", "elsewhere"]));
    expect(unregistered).toMatchObject({ status: 0, stderr: "" });

    fs.rmSync(guardDir, { recursive: true });
    const unguarded = git(work, ["commit", "-q", "--allow-empty", "-m", "before setup"]);
    expect(unguarded.status).toBe(0);
    expect(unguarded.stderr.split("\n").filter((line) => line.includes("no data at"))).toHaveLength(1);
  });
});
