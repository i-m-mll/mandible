import { authGitEnv } from "./auth-context.js";
import { childOutput } from "./child-observation.js";
import type { Signed } from "./operator-signing/authority.js";

/**
 * Protected merge commits are built here, byte for byte, and signed before the
 * executor runs. The executor publishes the signed object and never invokes a
 * signer (issue e523950).
 */

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface MergeCommitInput {
  tree: string;
  /** First parent is the protected base, second the reviewed head. */
  parents: readonly [string, string];
  /** The exact message, ending in one newline. */
  message: string;
  identity: CommitIdentity;
  /** Author and committer time, fixed when the commit is built. */
  time: { seconds: number; offset_minutes: number };
}

export interface CommitSignature {
  credential_id: string;
  /** Armored SSHSIG (`-----BEGIN SSH SIGNATURE-----`) over the unsigned commit in namespace `git`. */
  signature: string;
}

/**
 * Anything that signs a commit for Mandible: the operator's approval key. The
 * returned signature must already be verified against the credential it names.
 */
export interface MergeCommitSigner {
  sign(message: Buffer, namespace: "git", signal?: AbortSignal): Promise<Signed<CommitSignature>>;
}

export interface SignedMergeCommit {
  sha: string;
  credential_id: string;
  signature: string;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function timezone(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}${String(absolute % 60).padStart(2, "0")}`;
}

function personLine(role: "author" | "committer", input: MergeCommitInput): string {
  const { name, email } = input.identity;
  if (/[<>\n]/.test(name) || /[<>\n]/.test(email)) throw new Error("Commit identity contains characters git does not allow.");
  return `${role} ${name} <${email}> ${input.time.seconds} ${timezone(input.time.offset_minutes)}\n`;
}

/** The unsigned commit object: exactly the bytes a commit signature covers. */
export function buildMergeCommit(input: MergeCommitInput): Buffer {
  for (const sha of [input.tree, ...input.parents]) if (!SHA.test(sha)) throw new Error(`Not an object id: ${sha}`);
  if (!input.message.endsWith("\n") || input.message.endsWith("\n\n")) throw new Error("Merge message must end in exactly one newline.");
  return Buffer.from(
    `tree ${input.tree}\n` +
    input.parents.map((parent) => `parent ${parent}\n`).join("") +
    personLine("author", input) +
    personLine("committer", input) +
    `\n${input.message}`,
  );
}

/**
 * Insert `signature` as the commit's signature header, as `git commit -S`
 * stores it: `gpgsig` in a SHA-1 repository, `gpgsig-sha256` in a SHA-256 one.
 */
export function signedCommitObject(unsigned: Buffer, signature: string): Buffer {
  const text = unsigned.toString("utf8");
  const headerEnd = text.indexOf("\n\n");
  if (headerEnd < 0 || !signature.endsWith("\n")) throw new Error("Malformed commit or signature.");
  const tree = /^tree ([0-9a-f]+)\n/.exec(text)?.[1];
  if (!tree) throw new Error("Malformed commit.");
  const field = tree.length === 64 ? "gpgsig-sha256" : "gpgsig";
  const header = `${field} ${signature.slice(0, -1).split("\n").join("\n ")}\n`;
  return Buffer.from(`${text.slice(0, headerEnd + 1)}${header}${text.slice(headerEnd + 1)}`);
}

/** `localtime` for commit headers, as git computes it from the process time zone. */
export function commitTime(at: number): MergeCommitInput["time"] {
  return { seconds: Math.floor(at / 1000), offset_minutes: -new Date(at).getTimezoneOffset() };
}

/** The message `git merge <branch>` would write in `cwd`, which is on the target branch. */
export async function defaultMergeMessage(cwd: string, head: string, branch: string): Promise<string> {
  const message = await childOutput("git", ["fmt-merge-msg"], {
    cwd, encoding: "utf8", timeout: 5_000, env: authGitEnv(), input: `${head}\t\tbranch '${branch}' of .\n`,
  });
  return `${message.replace(/\n+$/, "")}\n`;
}

/** Write the signed object into the repository. No ref is changed. */
export async function writeCommitObject(cwd: string, object: Buffer): Promise<string> {
  const sha = (await childOutput("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd, encoding: "utf8", timeout: 5_000, env: authGitEnv(), input: object,
  })).trim();
  if (!SHA.test(sha)) throw new Error("git hash-object did not return an object id.");
  return sha;
}
