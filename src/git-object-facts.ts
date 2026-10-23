/**
 * Git answers that depend only on object ids never change: a commit's type,
 * tree, parents and message, whether one commit is an ancestor of another, and
 * whether a commit's signature verifies against a fixed set of allowed signers.
 * The auth queue's idle tick asks these questions about the same commits every
 * 30 seconds, and each answer is a synchronous Git child on the request event
 * loop, so the daemon asks each one once (issue 63c9031).
 *
 * Only definitive answers are remembered. A failure is asked again, because a
 * missing object can arrive later and a timed-out child said nothing.
 */
import { childOutput } from "./child-observation.js";
import { createHash } from "node:crypto";

const MAX_FACTS = 16_384;
const facts = new Map<string, unknown>();

/** Remember `ask`'s value under `key` when it reports the value as definitive. */
export async function rememberedObjectFact<T>(key: string, ask: () => Promise<{ value: T; definitive: boolean }>): Promise<T> {
  if (facts.has(key)) return facts.get(key) as T;
  const { value, definitive } = await ask();
  if (definitive) {
    if (facts.size >= MAX_FACTS) facts.delete(facts.keys().next().value!);
    facts.set(key, value);
  }
  return value;
}

const OBJECT_EXPRESSION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\^\{(?:tree|commit)\}|\^[12])?$/i;
const QUESTION_WORDS = new Set(["cat-file", "-t", "rev-parse", "--verify", "show", "-s", "--format=%P", "--format=%B", "merge-base", "--is-ancestor"]);

/**
 * Ask Git a question about objects named by full object ids and return its
 * trimmed stdout, remembering a successful answer. Throws as `execFileSync`
 * does. Naming a ref or any other mutable revision is a programming error.
 */
export async function gitObjectAnswer(cwd: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  for (const arg of args) {
    if (!QUESTION_WORDS.has(arg) && !OBJECT_EXPRESSION.test(arg)) {
      throw new Error(`Git object question names a mutable revision or unknown option: ${arg}`);
    }
  }
  return (await rememberedObjectFact(`git\0${cwd}\0${args.join("\0")}`, async () => ({
    value: (await childOutput("git", args, { cwd, env: options.env, timeout: options.timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim(),
    definitive: true,
  })));
}

export interface GitCommitFacts {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

/** Read immutable commit fields, without allowing mutable revision expressions. */
export async function gitCommitFacts(cwd: string, oid: string, options: { env: NodeJS.ProcessEnv; timeout: number }): Promise<GitCommitFacts> {
  return (await rememberedObjectFact(`commit\0${cwd}\0${oid}`, async () => ({ value: (await readGitCommitFacts(cwd, oid, options)), definitive: true })));
}

/** Observe the original object's bytes anew at a consequential security boundary. */
export async function readGitCommitFacts(cwd: string, oid: string, options: { env: NodeJS.ProcessEnv; timeout: number }): Promise<GitCommitFacts> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) throw new Error("Commit facts require a full object id.");
  const output = (await childOutput("git", ["--no-replace-objects", "cat-file", "--batch"], {
    cwd, env: options.env, timeout: options.timeout, input: `${oid}\n`, maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }));
  const headerEnd = output.indexOf(10);
  const header = output.subarray(0, headerEnd).toString("ascii");
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) commit ([0-9]+)$/.exec(header);
  if (!match || match[1] !== oid.toLowerCase()) throw new Error(`Git object is not an available commit: ${oid}`);
  const size = Number(match[2]);
  const body = output.subarray(headerEnd + 1, headerEnd + 1 + size);
  if (body.length !== size || output.length !== headerEnd + size + 2) throw new Error("Incomplete Git commit object.");
  const actualOid = createHash(oid.length === 64 ? "sha256" : "sha1").update(`commit ${size}\0`).update(body).digest("hex");
  if (actualOid !== oid.toLowerCase()) throw new Error("Git commit object does not match its object id.");
  const separator = body.indexOf(Buffer.from("\n\n"));
  if (separator < 0) throw new Error("Git commit has no message boundary.");
  const fields = body.subarray(0, separator).toString("utf8").split("\n");
  const tree = fields.find(line => line.startsWith("tree "))?.slice(5);
  const parents = fields.filter(line => line.startsWith("parent ")).map(line => line.slice(7));
  const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (!tree || !objectId.test(tree) || parents.some(parent => !objectId.test(parent))) throw new Error("Malformed Git commit links.");
  const encoding = fields.find(line => line.startsWith("encoding "))?.slice(9);
  // Git, rather than a second encoding implementation, converts legacy commit messages.
  const message = encoding && !/^utf-?8$/i.test(encoding)
    ? (await childOutput("git", ["--no-replace-objects", "show", "-s", "--no-show-signature", "--no-notes", "--encoding=UTF-8", "--format=%B", oid], {
      cwd, env: options.env, timeout: options.timeout, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    })).trim()
    : body.subarray(separator + 2).toString("utf8").trim();
  return Object.freeze({ tree, parents: Object.freeze(parents), message });
}
