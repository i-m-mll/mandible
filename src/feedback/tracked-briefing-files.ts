import { spawnSync } from "node:child_process";
import { authGitEnv } from "../auth-context.js";
import type { TrackedBriefingDocument, TrackedBriefingPath, TrackedBriefingPin } from "../contracts.js";
import type { Db } from "../db.js";
import { isGitObjectId } from "../git-change-review.js";

type ProtectedTree = TrackedBriefingPin & { root: string | null };

function git(root: string, args: string[]): Buffer | null {
  const result = spawnSync("git", args, { cwd: root, env: authGitEnv(), timeout: 5_000, maxBuffer: 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

export function isTrackedBriefingPath(path: unknown): path is string {
  return typeof path === "string" && !path.includes("\0")
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function protectedTree(db: Db, projectId: string): ProtectedTree {
  const project = db.prepare("SELECT project_key FROM ledger_projects WHERE id = ?").get(projectId) as { project_key: string };
  const checkouts = db.prepare(`SELECT root, default_branch FROM ledger_project_checkouts
    WHERE project_id = ? AND default_branch != ''
    ORDER BY work_repo_id IS NOT ? , root`)
    .all(projectId, project.project_key) as Array<{ root: string; default_branch: string }>;
  const checkout = checkouts[0];
  const root = checkout?.root ?? null;
  const oid = checkout && git(checkout.root, ["rev-parse", "--verify",
    `refs/heads/${checkout.default_branch}^{commit}`])?.toString().trim();
  return { project_id: projectId, project_key: project.project_key, root,
    commit_sha: oid && isGitObjectId(oid) ? oid : null };
}

export function trackedTreeBlob(tree: ProtectedTree, path: string): string | null {
  if (!tree.root || !tree.commit_sha) return null;
  const entry = git(tree.root, ["--literal-pathspecs", "ls-tree", "-z", tree.commit_sha, "--", path])
    ?.toString().match(/^100(?:644|755) blob ([a-f0-9]+)\t/);
  return entry && isGitObjectId(entry[1]) ? entry[1] : null;
}

export function trackedBriefingReader(db: Db) {
  const trees = new Map<string, ProtectedTree>();
  const documents = new Map<string, TrackedBriefingDocument>();
  const tree = (projectId: string) => {
    let pinned = trees.get(projectId);
    if (!pinned) {
      pinned = protectedTree(db, projectId);
      trees.set(projectId, pinned);
    }
    return pinned;
  };
  function read(member: TrackedBriefingPath): TrackedBriefingDocument {
    const key = JSON.stringify([member.project_id, member.path]);
    const existing = documents.get(key);
    if (existing) return existing;
    const { root, ...pin } = tree(member.project_id);
    const oid = trackedTreeBlob({ ...pin, root }, member.path);
    const bytes = root && oid ? git(root, ["cat-file", "blob", oid]) : null;
    let content: string | null = null;
    if (bytes && !bytes.includes(0)) {
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
    }
    const document = { ...member, ...pin, content };
    documents.set(key, document);
    return document;
  }
  return { tree, read };
}

export type TrackedBriefingReader = ReturnType<typeof trackedBriefingReader>;

type RecordedRename =
  | { kind: "renamed"; path: string }
  | { kind: "unresolved"; reason: "source_revision_unavailable" | "no_recorded_rename" | "ambiguous_recorded_rename" | "rename_destination_absent" };

export function recordedTrackedBriefingRename(tree: ProtectedTree, commit: string, oldPath: string): RecordedRename {
  const unresolved = (reason: Extract<RecordedRename, { kind: "unresolved" }>["reason"]): RecordedRename =>
    ({ kind: "unresolved", reason });
  if (!tree.root || !tree.commit_sha || !isGitObjectId(commit)) return unresolved("source_revision_unavailable");
  const fork = git(tree.root, ["merge-base", commit, tree.commit_sha])?.toString().trim();
  if (!fork || !isGitObjectId(fork) || !trackedTreeBlob({ ...tree, commit_sha: fork }, oldPath)) {
    return unresolved("source_revision_unavailable");
  }
  const history = git(tree.root, ["log", "--first-parent", "--reverse", "--format=%x00%H", "--name-status", "-z",
    "--diff-merges=first-parent", "--find-renames", `${fork}..${tree.commit_sha}`]);
  if (!history) return unresolved("source_revision_unavailable");
  let path = oldPath;
  let renamed = false;
  let deleted = false;
  for (const commit of history.toString().slice(1).split("\0\0")) {
    if (!commit) continue;
    const [sha, ...tokens] = commit.split("\0");
    if (!isGitObjectId(sha)) return unresolved("source_revision_unavailable");
    const additions: string[] = [];
    let destination: string | null = null;
    for (let index = 0; index < tokens.length;) {
      const status = tokens[index++].trimStart();
      if (!status) continue;
      const from = tokens[index++];
      const to = status.startsWith("R") ? tokens[index++] : null;
      if (status === "A") additions.push(from);
      if (from !== path) continue;
      if (status === "D") deleted = true;
      if (status === "A" && deleted) return unresolved("ambiguous_recorded_rename");
      if (to !== null) destination = to;
    }
    if (destination === null) continue;
    if (deleted || !isTrackedBriefingPath(destination)) return unresolved("ambiguous_recorded_rename");
    const revision = { ...tree, commit_sha: sha };
    const blob = trackedTreeBlob(revision, destination);
    if (!blob || additions.some(candidate => trackedTreeBlob(revision, candidate) === blob)) {
      return unresolved("ambiguous_recorded_rename");
    }
    path = destination;
    renamed = true;
  }
  if (!renamed) return unresolved("no_recorded_rename");
  if (deleted || !trackedTreeBlob(tree, path)) return unresolved("rename_destination_absent");
  return { kind: "renamed", path };
}
