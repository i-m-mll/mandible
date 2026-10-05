import { spawnSync } from "node:child_process";
import type { AuthQueue } from "../../src/auth-queue.js";
import type { AuthRequest } from "../../src/types.js";

function git(repo: string, args: string[], input?: string): string {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as NodeJS.ProcessEnv;
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_CONFIG_") || ["GIT_CONFIG", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].includes(name)) delete env[name];
  }
  const result = spawnSync("git", args, { cwd: repo, env, input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Fixture Git failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Requires configureSigningCredential(db, repo, "ssh_key") from auth-queue-fixtures. */
export async function approveWithTestOperator(queue: AuthQueue, request: AuthRequest, operatorId: string): Promise<AuthRequest> {
  return queue.approveWithOperatorProof(request.id, operatorId);
}

/** Publish the exact candidate in a temporary test repository with its registered operator key. */
export function publishTestCandidate(repo: string, request: AuthRequest): { mergeSha: string; output: string } {
  const base = request.merge_preflight_base_sha;
  const head = request.merge_head_sha;
  const tree = request.merge_candidate_tree_sha;
  if (!base || !head || !tree || !request.base_branch) throw new Error("Fixture requires a reviewed candidate.");
  const mergeSha = git(repo, ["commit-tree", tree, "-p", base, "-p", head, "-S", "-F", "-"], request.commit_message ?? "Reviewed test merge\n");
  const prepared = `MANDIBLE_MERGE_PREPARED ${JSON.stringify({ merge_sha: mergeSha, base_sha: base, head_sha: head, tree_sha: tree })}`;
  git(repo, ["update-ref", `refs/heads/${request.base_branch}`, mergeSha, base]);
  git(repo, ["read-tree", "-m", "-u", base, mergeSha]);
  const applied = `MANDIBLE_MERGE_APPLIED ${JSON.stringify({ merge_sha: mergeSha, base_sha: base })}`;
  const result = `MANDIBLE_MERGE_RESULT ${JSON.stringify({ merge_sha: mergeSha, repo_id: request.repo, declared_issues: request.issue_closures ?? [] })}`;
  return { mergeSha, output: `${prepared}\n${applied}\n${result}\n` };
}
