import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { addBinding, setupOperator } from "../src/users/store.js";

// Child issue 8921e84 (regression-only half): the `Mandible-Issue:` trailer
// gate in src/routes/auth.ts ALREADY rejects bare-commit branches. Docs-branch
// promotion relies on every docs-branch commit being an agent-key linked commit
// carrying the trailer; if a docs branch ever accumulated a bare commit, the
// auth gate must reject the promotion. This test asserts that existing gate
// behavior. It does NOT change auth.ts — it pins the gate so a future change
// cannot silently weaken it.

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createMigratedDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  const operator = setupOperator(db, { slug: "docs-auth-test", display_name: "Docs Auth Test" });
  addBinding(db, operator.id, {
    binding_type: "provider_session_env",
    value: "docs-auth-session",
  });
  return db;
}

// A repo with `main` checked out at the root and a docs branch ahead of it.
// The docs-branch head commit message is controlled by the caller so we can
// model both a properly-trailered docs commit and a bare docs commit.
function createDocsRepo(docsBranch: string, docsCommitMessage: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-docs-gate-"));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mandible Test"]);
  git(repo, ["config", "user.email", "mandible-test@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);

  // Provision the docs branch ahead of main with the caller's commit message.
  git(repo, ["checkout", "-b", docsBranch, "main"]);
  fs.writeFileSync(path.join(repo, "doc.md"), "# doc\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", docsCommitMessage]);
  git(repo, ["checkout", "main"]);
  return repo;
}

function registerWorkRepo(db: Db, repoRoot: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES (?, ?, ?, ?, 1, 0)`,
  ).run(path.basename(repoRoot), fs.realpathSync(repoRoot), path.basename(repoRoot), "main");
}

async function submitDocsMerge(
  db: Db,
  repo: string,
  docsBranch: string,
): Promise<{ status: number; body: unknown }> {
  const router = new Router();
  const queue = new AuthQueue({ db });
  try {
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
    return await router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: {
        type: "merge",
        command: `mandible auth merge ${docsBranch} --into main`,
        title: `Promote ${docsBranch}`,
        session_id: "docs-auth-session",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: docsBranch,
        cwd: repo,
      },
    });
  } finally {
    queue.dispose();
  }
}

describe("auth.ts Mandible-Issue gate (docs-branch promotion regression)", () => {
  it("rejects a docs branch whose head commit is bare (no Mandible-Issue trailer)", async () => {
    const docsBranch = "docs/spaces";
    const repo = createDocsRepo(docsBranch, "bare docs export with no trailer");
    const db = createMigratedDb();
    setDb(db);
    try {
      registerWorkRepo(db, repo);
      const result = await submitDocsMerge(db, repo, docsBranch);

      expect(result.status).toBe(400);
      const error = (result.body as { error?: string }).error ?? "";
      expect(error).toContain("missing Mandible-Issue references");
      expect(error).toContain("Mandible-Issue: <issue-ref>");
    } finally {
      db.close();
    }
  });

  it("admits a docs branch whose commits all carry Mandible-Issue trailers", async () => {
    const docsBranch = "docs/spaces";
    const repo = createDocsRepo(
      docsBranch,
      "doc export\n\nMandible-Issue: docs123",
    );
    const db = createMigratedDb();
    setDb(db);
    try {
      registerWorkRepo(db, repo);
      const result = await submitDocsMerge(db, repo, docsBranch);

      // The gate passes (201 created). This confirms the regression test is
      // exercising the real gate, not failing for an unrelated reason.
      expect(result.status).toBe(201);
      expect((result.body as { request_id?: string }).request_id).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
