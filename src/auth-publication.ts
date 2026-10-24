import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Db } from "./db.js";
import type { AuthRequest } from "./types.js";
import { authGitEnv } from "./auth-context.js";
import { resolveOperationalIssueRef } from "./ledger/operational-links.js";
import { resolveArtifactIdentity } from "./provider-artifacts.js";
import { artifactMaterializationTarget } from "./artifact-identity.js";
import { authPublicationSnapshot, type PublicationRow } from "./auth-request-snapshot.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function git(root: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root, env: authGitEnv(), timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
}
function pathState(root: string, revision: string, relative: string): { mode: string; sha256: string } | null {
  const entries = git(root, ["ls-tree", "-z", revision, "--", relative]).toString().split("\0").filter(Boolean);
  if (!entries.length) return null;
  if (entries.length !== 1) throw new Error("Publication destination is ambiguous");
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entries[0]!);
  if (!match || match[3] !== relative) throw new Error("Publication destination must remain a regular Git file");
  return { mode: match[1]!, sha256: hash(git(root, ["cat-file", "blob", match[2]!])) };
}

/** This stricter publication contract is independent of Git merge conflict detection. */
export function assertAuthPublication(db: Db, request: AuthRequest, publicationId?: string, baseSha?: string): void {
  const bound = authPublicationSnapshot(db, request.id);
  publicationId ??= request.space_publication_id ?? undefined;
  if (!publicationId && !bound) return;
  const row = db.prepare("SELECT * FROM space_publications WHERE id = ?").get(publicationId ?? bound!.id) as PublicationRow | undefined;
  const stale = (reason: string): never => { throw new Error(`Publication is stale; prepare a new publication. ${reason}`); };
  if (!row || request.type !== "merge" || !request.cwd || !request.base_branch || !request.merge_head_sha ||
      row.auth_request_id && row.auth_request_id !== request.id && row.auth_request_id !== request.supersedes_request_id || !["committed", "submitted"].includes(row.state) ||
      row.branch !== request.head_branch || row.commit_sha !== request.merge_head_sha || !row.version_ref || !row.worktree) stale("Frozen source or request binding differs.");
  const publication = row!;
  const checkout = db.prepare("SELECT root,project_id FROM ledger_project_checkouts WHERE id=?").get(publication.repo_id) as { root: string; project_id: string } | undefined;
  if (!checkout) stale("Destination project is unavailable.");
  const common = (root: string) => realpathSync(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim());
  if (common(checkout!.root) !== common(request.cwd!) || common(publication.worktree) !== common(request.cwd!)) stale("Destination repository differs.");
  const issues = request.issue_references ?? request.issue_ids ?? request.issues ?? [];
  if (!issues.some(ref => { const issue = resolveOperationalIssueRef(db, ref, checkout!.project_id); return issue.ok && issue.issue_id === publication.issue_id; })) stale("Publication issue context differs.");
  if (hash(publication.content) !== publication.source_revision) stale("Frozen source hash differs.");
  const frozen = artifactMaterializationTarget(resolveArtifactIdentity(db, publication.snapshot_ref, "strict-read"));
  if (!frozen.ok || frozen.value.custody.hash !== publication.source_revision) stale("Frozen source artifact differs.");
  const artifact = artifactMaterializationTarget(resolveArtifactIdentity(db, publication.version_ref, "strict-read"));
  if (!artifact.ok || artifact.value.custody.kind !== "git" || artifact.value.custody.commit !== publication.commit_sha || artifact.value.custody.path !== publication.path || artifact.value.custody.project_id !== checkout!.project_id || artifact.value.custody.hash !== publication.source_revision) stale("Committed source custody differs.");
  const source = pathState(request.cwd!, publication.commit_sha, publication.path);
  if (!source || source.sha256 !== publication.source_revision) stale("Signed proposal differs from the frozen source.");
  const target = pathState(request.cwd!, baseSha ?? git(request.cwd!, ["rev-parse", `refs/heads/${request.base_branch}`]).toString().trim(), publication.path);
  if (publication.expected_destination_sha256 === null ? target !== null : !target ||
      target.sha256 !== publication.expected_destination_sha256 || target.mode !== publication.expected_destination_mode) stale("Destination changed since preparation.");
  if (request.merge_candidate_tree_sha) {
    const candidate = pathState(request.cwd!, request.merge_candidate_tree_sha, publication.path);
    if (!candidate || candidate.sha256 !== publication.source_revision || candidate.mode !== source!.mode) stale("Merge candidate combines changed destination bytes or mode.");
  }
}

export function bindAuthPublication(db: Db, request: AuthRequest, id: string): void {
  assertAuthPublication(db, request, id);
  const row = db.prepare("SELECT auth_request_id,state FROM space_publications WHERE id=?").get(id) as { auth_request_id: string | null; state: string };
  if (row.auth_request_id && row.auth_request_id !== request.supersedes_request_id) throw new Error("Publication already has an auth request; inspect it before preparing another publication.");
  const result = db.prepare("UPDATE space_publications SET auth_request_id=?,state='submitted' WHERE id=? AND auth_request_id IS ? AND state=?").run(request.id,id,row.auth_request_id,row.state);
  if (result.changes !== 1) throw new Error("Publication binding changed; inspect it before preparing another publication.");
}
