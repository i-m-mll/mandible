import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { authGitEnv } from "../src/auth-context.js";
import { gitCommitFacts, readGitCommitFacts } from "../src/git-object-facts.js";
import { verifyMergeCommitSignature } from "../src/auth-signature-verification.js";
import { commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb, git, tamperLooseGitObject, trackTempPath } from "./helpers/auth-queue-fixtures.js";

const options = () => ({ env: authGitEnv(), timeout: 5_000 });

describe("immutable Git commit facts", () => {
  it("reads exact tree, all parents and Unicode message, independent of refs and replacement objects", async () => {
    const repo = createAuthCheckRepo();
    const base = git(repo, ["rev-parse", "HEAD"]);
    commitOnBranch(repo, "feature/facts", { "facts.txt": "new bytes\n" });
    const head = git(repo, ["rev-parse", "feature/facts"]);
    const tree = git(repo, ["rev-parse", `${head}^{tree}`]);
    const merge = git(repo, ["commit-tree", tree, "-p", base, "-p", head, "-m", "Exact café 🐜\n\nsecond paragraph"]);
    git(repo, ["replace", merge, head]);
    expect(await gitCommitFacts(repo, merge, options())).toEqual({ tree, parents: [base, head], message: "Exact café 🐜\n\nsecond paragraph" });
    git(repo, ["update-ref", "refs/heads/main", head, base]);
    expect((await gitCommitFacts(repo, merge, options())).parents).toEqual([base, head]);
    await expect(gitCommitFacts(repo, "HEAD", options())).rejects.toThrow("full object id");
    await expect(gitCommitFacts(repo, tree, options())).rejects.toThrow("not an available commit");
  });

  it("retries unavailable objects and keeps repository identities separate", async () => {
    const first = createAuthCheckRepo();
    const second = createAuthCheckRepo();
    const oid = git(first, ["rev-parse", "HEAD"]);
    expect((await gitCommitFacts(first, oid, options())).parents).toEqual([]);
    const object = path.join(second, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    const bytes = fs.readFileSync(object);
    fs.unlinkSync(object);
    await expect(gitCommitFacts(second, oid, options())).rejects.toThrow("not an available commit");
    fs.writeFileSync(object, bytes);
    expect(await gitCommitFacts(second, oid, options())).toEqual(await gitCommitFacts(first, oid, options()));
  });

  it("observes corruption and deletion despite a warm immutable fact cache", async () => {
    const repo = createAuthCheckRepo();
    const oid = git(repo, ["rev-parse", "HEAD"]);
    await gitCommitFacts(repo, oid, options());
    const restore = tamperLooseGitObject(repo, oid, object => { object[object.indexOf(Buffer.from("\n\n")) + 2]! ^= 1; });
    try { await expect(readGitCommitFacts(repo, oid, options())).rejects.toThrow("does not match its object id"); }
    finally { restore(); }
    const filename = path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    fs.unlinkSync(filename);
    try { await expect(readGitCommitFacts(repo, oid, options())).rejects.toThrow("not an available commit"); }
    finally { restore(); }
  });

  it("refuses a signed replacement as evidence for an unsigned original commit", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      const original = git(repo, ["rev-parse", "HEAD"]);
      configureSigningCredential(db, repo, "ssh_key");
      const replacement = git(repo, ["commit-tree", "HEAD^{tree}", "-S", "-m", "Signed replacement"]);
      expect((await verifyMergeCommitSignature(db, repo, replacement)).verified).toBe(true);
      git(repo, ["replace", original, replacement]);
      expect((await verifyMergeCommitSignature(db, repo, original)).verified).toBe(false);
    } finally { db.close(); }
  });

  it("preserves Git's conversion of legacy commit message encodings", async () => {
    const repo = createAuthCheckRepo();
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const content = Buffer.concat([
      Buffer.from(`tree ${tree}\nauthor Facts <facts@example.invalid> 1 +0000\ncommitter Facts <facts@example.invalid> 1 +0000\nencoding ISO-8859-1\n\ncaf`),
      Buffer.from([0xe9, 0x0a]),
    ]);
    const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, env: authGitEnv(), input: content, encoding: "utf8", timeout: 5_000 }).trim();
    expect((await gitCommitFacts(repo, oid, options())).message).toBe("café");
  });

  it("accepts full SHA-256 commit and tree ids", async () => {
    const repo = trackTempPath(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-object-sha256-")));
    git(repo, ["init", "--object-format=sha256", "-b", "main"]);
    git(repo, ["config", "user.name", "Object Facts"]);
    git(repo, ["config", "user.email", "facts@example.invalid"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "SHA-256 facts"]);
    const oid = git(repo, ["rev-parse", "HEAD"]);
    expect(oid).toHaveLength(64);
    expect(await gitCommitFacts(repo, oid, options())).toEqual({ tree: git(repo, ["rev-parse", "HEAD^{tree}"]), parents: [], message: "SHA-256 facts" });
  });
});
