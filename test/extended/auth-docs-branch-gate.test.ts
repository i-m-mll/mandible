import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../../src/auth-queue.js";
import { AuthAutoApproveManager } from "../../src/auth-auto-approve.js";
import { setDb, type Db } from "../../src/db.js";
import { registerAuthRoutes } from "../../src/routes/auth.js";
import { Router } from "../../src/server.js";
import { createLedgerIssue, createMigratedDb as createSharedMigratedDb } from "../helpers/ledger-fixtures.js";
import { authenticatedTestRouter } from "../helpers/authenticated-router.js";
import { resolveProjectForCheckout } from "../../src/ledger/projects.js";
import { addCredential } from "../../src/users/store.js";

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
  return createSharedMigratedDb({
    operator: { slug: "docs-auth-test", display_name: "Docs Auth Test" },
    // Issue a64d2de: a provider-session binding now mints session_claim attribution
    // only for an agent principal, so a forgeable ambient signal can never resolve
    // to the human operator. The docs-branch requester is an agent session, so bind
    // the session env to an agent user rather than the operator.
    agent: {
      slug: "docs-auth-agent",
      display_name: "Docs Auth Agent",
      sessionEnv: "docs-auth-session",
    },
  });
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
  return fs.realpathSync(repo);
}

function registerWorkRepo(db: Db, repoRoot: string): string {
  const project = resolveProjectForCheckout(db, {
    root: fs.realpathSync(repoRoot),
    name: path.basename(repoRoot),
    workRepoId: path.basename(repoRoot),
    defaultBranch: "main",
  });
  db.prepare(
    `INSERT OR REPLACE INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
     VALUES (?, ?, ?, ?, 1, 0)`,
  ).run(path.basename(repoRoot), repoRoot, path.basename(repoRoot), "main");
  return project.project.id;
}

async function submitDocsMerge(
  db: Db,
  repo: string,
  docsBranch: string,
): Promise<{ status: number; body: unknown }> {
  const agent = db.prepare("SELECT id, slug FROM users WHERE slug = 'docs-auth-agent'").get() as { id: string; slug: string };
  const credential = addCredential(db, agent.id, {
    type: "api_token",
    fingerprint: `docs-auth-${docsBranch}`,
  });
  const projectId = registerWorkRepo(db, repo);
  const issue = createLedgerIssue(db, {
    project_id: projectId,
    title: "Docs delivery",
    aliases: [{ alias_kind: "git_bug_short", alias: "d0c5123" }],
  });
  db.prepare(
    `INSERT INTO work_units
      (id, issue_id, repo_id, branch, kind, state, created_at, activated_at, last_commit_at,
       ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
     VALUES (?, ?, ?, ?, 'solo', 'committed', 1, 1, 1, ?, ?, ?, 1)`,
  ).run(`wu-${docsBranch}`, "d0c5123", projectId, docsBranch, issue.id, agent.id, credential.id);
  const router = authenticatedTestRouter(agent, { credentialId: credential.id });
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
        issue_references: ["d0c5123"],
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
      "doc export\n\nMandible-Issue: d0c5123",
    );
    const db = createMigratedDb();
    setDb(db);
    try {
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
