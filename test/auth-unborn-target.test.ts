/**
 * Issue c8817ff — a protected branch with no commits yet receives its first
 * history only through an auth request. The reviewed result is an
 * approval-signed commit whose only parent is the reviewed head, and its
 * publication creates the branch.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { executeAuthCommand } from "../src/auth-executor.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setDb } from "../src/db.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { getOperator } from "../src/users/store.js";
import { MERGE_CHANGE_MESSAGE } from "./helpers/auth-delivery-fixtures.js";
import {
  configureSigningCredential, createLedgerIssue, createLedgerProject, createMigratedDb, createNoopHookManager, git,
  registerWorkRepo,
} from "./helpers/auth-queue-fixtures.js";
import { approveAsFixtureOperator } from "./helpers/operator-signing-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";

const AUTH_MERGE = path.join(process.cwd(), "cli", "auth-merge.sh");

let root: string;
let repo: string;
let db: ReturnType<typeof createMigratedDb>;
let queue: AuthQueue | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-unborn-")));
  repo = path.join(root, "repo");
  git(root, ["init", "-q", "-b", "main", repo]);
  git(repo, ["config", "user.name", "Mandible Test"]);
  git(repo, ["config", "user.email", "mandible-test@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.hooksPath", ".git/hooks"]);
  db = createMigratedDb();
  setDb(db);
});

afterEach(async () => {
  await queue?.dispose();
  queue = undefined;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The feature's first commit, written without touching the unborn checkout. */
function commitFeature(branch: string, file: string, content: string): string {
  const input = (args: string[], stdin: string) => execFileSync("git", args, { cwd: repo, input: stdin, encoding: "utf8" }).trim();
  const blob = input(["hash-object", "-w", "--stdin"], content);
  const tree = input(["mktree"], `100644 blob ${blob}\t${file}\n`);
  const commit = git(repo, ["commit-tree", tree, "-m", `Add ${file}`]);
  git(repo, ["update-ref", `refs/heads/${branch}`, commit, ""]);
  return commit;
}

it("creates an unborn protected branch from the approved head", async () => {
  const { operatorId } = configureSigningCredential(db, repo);
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n.mandible-test-signing-key*\n");
  registerWorkRepo(db, repo);
  const project = createLedgerProject(db, repo);
  const issue = createLedgerIssue(db, project.project.id, "c8817ff", "Unborn target");
  db.prepare(`INSERT INTO work_units
    (id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
     ledger_issue_id, owner_user_id, responsibility_session_id, custody_generation)
    VALUES (?, 'c8817ff', ?, 'feature/first', 'solo', 'committed', 1, 1, ?, ?, NULL, 1)`)
    .run(crypto.randomUUID(), project.project.project_key, issue.id, operatorId);
  const head = commitFeature("feature/first", "first.txt", "first history\n");

  const results: Awaited<ReturnType<typeof executeAuthCommand>>[] = [];
  queue = new AuthQueue({
    db, hookManager: createNoopHookManager(), backgroundMaintenance: false, broadcast: () => {},
    executor: async (options) => {
      const snippet = [
        "export MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1",
        `source ${JSON.stringify(AUTH_MERGE)}`,
        "persist_atomic_marker() { printf '%s\\n' \"$1\" >&2; }",
        "collect_declared_issues() { :; }",
        "main feature/first --into main",
      ].join("\n");
      const result = await executeAuthCommand({ ...options, mandibleArgs: undefined, command: snippet,
        env: { ...options.env, MANDIBLE_CLI_DIR: path.dirname(AUTH_MERGE) } });
      results.push(result);
      return result;
    },
  });
  const authenticator = new ClientAuthenticator(db, { secretsDir: path.join(root, "secrets") });
  const { token } = authenticator.mintApiToken(getOperator(db)!.id);
  const router = new Router({ clientAuth: authenticator });
  registerAuthRoutes(router, queue, inlineLedgerReader(() => queue!.db));

  const submitted = await router.invoke({
    method: "POST", url: "/api/auth/v2/request", credential: token, transport: "http",
    body: {
      ...MERGE_CHANGE_MESSAGE, type: "merge", title: "First history", command: "mandible auth merge feature/first --into main",
      cwd: repo, repo: project.project.project_key, base_branch: "main", head_branch: "feature/first",
      issue_references: ["c8817ff"], execution_mode: "local",
    },
  });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  const id = (submitted.body as { request_id: string }).request_id;
  const request = (await queue.getRequest(id))!;
  expect(request.change_report?.totals.files).toBe(1);
  expect(request.merge_candidate_pin_sha).toBeTruthy();

  await approveAsFixtureOperator(queue, id, operatorId);
  await waitUntil(() => results.length > 0, "the approved merge to execute");
  expect(results[0]!.exit_code, results[0]!.output).toBe(0);

  const main = git(repo, ["rev-parse", "refs/heads/main"]);
  expect(git(repo, ["rev-list", "--parents", "-n", "1", main])).toBe(`${main} ${head}`);
  expect(git(repo, ["rev-parse", `${main}^{tree}`])).toBe(git(repo, ["rev-parse", `${head}^{tree}`]));
  expect(fs.readFileSync(path.join(repo, "first.txt"), "utf8")).toBe("first history\n");
  expect(git(repo, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
  await waitUntil(async () => !["approved", "executing"].includes((await queue!.getRequest(id))?.status ?? ""), "the merge to settle");
  const settled = (await queue.getRequest(id))!;
  expect(settled.status, `${settled.error}\n${settled.output}`).toBe("completed");
  await waitUntil(async () => (await queue!.getRequest(id))?.merge_finalized_at, "the merge to finalize");
});
