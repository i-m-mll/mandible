import { spawnSync } from "node:child_process";
import type { AuthQueue } from "../../src/auth-queue.js";
import type { Db } from "../../src/db.js";
import { getAttributionEvidence } from "../../src/users/store.js";
import type { AuthRequest } from "../../src/types.js";
import { approveAsFixtureOperator } from "./operator-signing-fixtures.js";

function git(repo: string, args: string[], input?: string): string {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as NodeJS.ProcessEnv;
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_CONFIG_") || ["GIT_CONFIG", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].includes(name)) delete env[name];
  }
  const result = spawnSync("git", args, { cwd: repo, env, input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Fixture Git failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Requires configureSigningCredential(db, repo) from auth-queue-fixtures. */
export async function approveWithTestOperator(queue: AuthQueue, request: AuthRequest, operatorId: string): Promise<AuthRequest> {
  return approveAsFixtureOperator(queue, request.id, operatorId);
}

/** Publish the merge commit the request's approval signed, as the executor does. */
export function publishTestCandidate(db: Db, repo: string, request: AuthRequest): { mergeSha: string; output: string } {
  const base = request.merge_preflight_base_sha;
  const head = request.merge_effective_head_sha ?? request.merge_head_sha;
  const tree = request.merge_candidate_tree_sha;
  if (!base || !head || !tree || !request.base_branch) throw new Error("Fixture requires a reviewed candidate.");
  const signed = request.execution_evidence_id ? getAttributionEvidence(db, request.execution_evidence_id)?.details.signed_commit_sha : null;
  if (typeof signed !== "string") throw new Error("Fixture requires an approval that signed the merge commit.");
  const mergeSha = signed;
  if (git(repo, ["rev-list", "--parents", "-n", "1", mergeSha]) !== `${mergeSha} ${base} ${head}` || git(repo, ["rev-parse", `${mergeSha}^{tree}`]) !== tree) {
    throw new Error("The approval-signed commit is not the reviewed merge.");
  }
  const prepared = `MANDIBLE_MERGE_PREPARED ${JSON.stringify({ merge_sha: mergeSha, base_sha: base, head_sha: head, tree_sha: tree })}`;
  git(repo, ["update-ref", `refs/heads/${request.base_branch}`, mergeSha, base]);
  git(repo, ["update-ref", "ORIG_HEAD", base]);
  git(repo, ["read-tree", "-m", "-u", base, mergeSha]);
  const applied = `MANDIBLE_MERGE_APPLIED ${JSON.stringify({ merge_sha: mergeSha, base_sha: base })}`;
  const result = `MANDIBLE_MERGE_RESULT ${JSON.stringify({ merge_sha: mergeSha, repo_id: request.repo, declared_issues: request.issue_closures ?? [] })}`;
  return { mergeSha, output: `${prepared}\n${applied}\n${result}\n` };
}

/**
 * Issue 4720024 — the canonical change message every merge request must carry,
 * as route payload fields and as the equivalent `mandible auth request` flags.
 */
export const MERGE_CHANGE_MESSAGE = {
  canonical_message: true,
  commit_message: "Fixture outcome\n\nWhy:\nFixture.\n\nVerification:\nFixture checks pass.\n",
  verification: "Fixture checks pass.",
} as const;
export const MERGE_CHANGE_MESSAGE_FLAGS: readonly string[] = [
  "--message", "Fixture outcome\n\nWhy:\nFixture.", "--verification", "Fixture checks pass.",
];
