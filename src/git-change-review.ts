import type { AuthChangeReport, DiffFilePair, GitChangeFile, GitFileObject } from "./contracts.js";
import { authGitEnv, isUnbornBase } from "./auth-context.js";
import { childOutput } from "./child-observation.js";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
type Comparison = AuthChangeReport["comparison"];
type PairResult = { ok: true; file: DiffFilePair } | { ok: false; status: 404 | 413; error: string };

export function isGitObjectId(value: string): boolean {
  return OID.test(value);
}

function runGit(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return childOutput("git", args, {
    cwd, input, timeout: 5_000, maxBuffer: MAX_TEXT_BYTES, env: { ...authGitEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

export async function readGitFilePair(cwd: string, comparison: Pick<Comparison, "merge_base_sha" | "head_sha">, file: Pick<GitChangeFile, "old_path" | "new_path" | "old_object" | "new_object">): Promise<PairResult> {
  async function read(commit: string, path: string | null, object: GitFileObject | null | undefined, otherPath: string | null) {
    const name = path ?? otherPath ?? "File";
    if (path === null || object === null) return { name, contents: "" };
    if (object ? !isGitObjectId(object.oid) : !isGitObjectId(commit)) throw new Error("Invalid stored revision.");
    const ref = object?.oid ?? `${commit}:${path}`;
    const bytes = await runGit(cwd, ["cat-file", "blob", ref]);
    try {
      return { name, contents: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      return null;
    }
  }

  try {
    const [before, after] = await Promise.all([
      read(comparison.merge_base_sha, file.old_path, file.old_object, file.new_path),
      read(comparison.head_sha, file.new_path, file.new_object, file.old_path),
    ]);
    return { ok: true, file: before && after && !before.contents.includes("\0") && !after.contents.includes("\0")
      ? { kind: "text", before, after }
      : { kind: "binary" } };
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { ok: false, status: 413, error: "File is too large for text review." };
    }
    return { ok: false, status: 404, error: "The reviewed Git file is unavailable." };
  }
}

function reviewRefs(requestId: string, comparison: Comparison) {
  const root = `refs/mandible/auth-revisions/${requestId}/${comparison.base_sha}/${comparison.head_sha}`;
  return [
    [`${root}/head`, comparison.head_sha],
    ...(!isUnbornBase(comparison.base_sha) ? [[`${root}/base`, comparison.base_sha]] : []),
  ];
}

export async function retainReviewRevision(cwd: string, requestId: string, comparison: Comparison): Promise<void> {
  const commands = reviewRefs(requestId, comparison).map(([ref, sha]) => `create ${ref} ${sha}\n`).join("");
  await runGit(cwd, ["update-ref", "--stdin"], commands);
}

export async function releaseUnpublishedReviewRevision(cwd: string, requestId: string, comparison: Comparison): Promise<void> {
  const commands = reviewRefs(requestId, comparison).map(([ref, sha]) => `delete ${ref} ${sha}\n`).join("");
  await runGit(cwd, ["update-ref", "--stdin"], commands);
}
