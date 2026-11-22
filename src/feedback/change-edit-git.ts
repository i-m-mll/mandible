import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authGitEnv } from "../auth-context.js";
import { childOutput, observeChild } from "../child-observation.js";
import { buildCommit, writeCommitObject } from "../commit-object.js";
import type { GitFileObject } from "../contracts.js";
import { isGitObjectId } from "../git-change-review.js";
import type { ReviewChangeEdit } from "./request-draft-types.js";

const gitEnv = () => ({ ...authGitEnv(), GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1" });

type FileEdit = { path: string; object: GitFileObject; text: string };

async function inScratch<T>(f: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "mandible-review-"));
  try { return await f(directory); }
  finally { await rm(directory, { force: true, recursive: true }); }
}

export async function buildChangeEdit(
  root: string, requestId: string, head: string, createdAt: number, files: readonly FileEdit[],
): Promise<ReviewChangeEdit> {
  return inScratch(async directory => {
    if (!isGitObjectId(head)) throw new Error("Invalid review head.");
    const env = { ...gitEnv(), GIT_INDEX_FILE: join(directory, "index") };
    const git = (args: string[], input?: string) => childOutput("git", args, {
      cwd: root, env, encoding: "utf8", input,
    });
    await git(["read-tree", head]);
    const entries: string[] = [];
    for (const { path, object, text } of files) {
      const entry = await git(["ls-tree", "-z", head, "--", path]);
      if (entry !== `${object.mode} blob ${object.oid}\t${path}\0`) {
        throw new Error(`Reviewed file differs at the pinned head: ${path}`);
      }
      const blob = (await git(["hash-object", "--no-filters", "-w", "--stdin"], text)).trim();
      entries.push(`${object.mode} ${blob}\t${path}\0`);
    }
    await git(["update-index", "-z", "--index-info"], entries.join(""));
    const tree = (await git(["write-tree"])).trim();
    const commit_sha = await writeCommitObject(root, buildCommit({
      tree, parents: [head], identity: { name: "Mandible Review", email: "review@mandible.local" },
      message: "Apply review edits\n", time: { seconds: Math.floor(createdAt / 1000), offset_minutes: 0 },
    }));
    return { request_id: requestId, parent_sha: head, commit_sha, ref: `refs/mandible/change-edits/${requestId}/${commit_sha}` };
  });
}

export async function retainChangeEdit(root: string, edit: ReviewChangeEdit): Promise<void> {
  const options = { cwd: root, env: gitEnv() };
  try {
    await childOutput("git", ["update-ref", "--no-deref", edit.ref, edit.commit_sha, "0".repeat(edit.commit_sha.length)], options);
  } catch (error) {
    const existing = await observeChild("git", ["show-ref", "--verify", "--hash", edit.ref], options);
    if (existing.status !== 0 || existing.stdout.trim() !== edit.commit_sha) throw error;
    const symbolic = await observeChild("git", ["symbolic-ref", "-q", edit.ref], options);
    if (symbolic.status !== 1) throw error;
  }
}

export async function readChangeEditPatch(root: string, edit: ReviewChangeEdit): Promise<string> {
  return childOutput("git", ["diff", "--text", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
    edit.parent_sha, edit.commit_sha, "--"], { cwd: root, env: gitEnv(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

export type CarriedFileText = { text: string; conflict: "overlap" | null };

export async function carryFileText(base: string, edited: string, successor: string): Promise<CarriedFileText> {
  if (edited === base || edited === successor) return { text: successor, conflict: null };
  if (successor === base) return { text: edited, conflict: null };
  return inScratch(async directory => {
    const paths = ["successor", "base", "operator"].map(file => join(directory, file));
    await Promise.all([successor, base, edited].map((text, i) => writeFile(paths[i]!, text)));
    const result = await observeChild("git", ["merge-file", "--stdout", "--diff3",
      "-L", "Requester", "-L", "Previous request", "-L", "Review draft", ...paths], {
      cwd: directory, env: gitEnv(), maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status === null || result.status > 127) {
      throw new Error("Unable to merge the review draft onto the successor.", { cause: result.error ?? result.stderr });
    }
    return { text: result.stdout, conflict: result.status === 0 ? null : "overlap" };
  });
}
