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
import { execFileSync } from "node:child_process";

const MAX_FACTS = 16_384;
const facts = new Map<string, unknown>();

/** Remember `ask`'s value under `key` when it reports the value as definitive. */
export function rememberedObjectFact<T>(key: string, ask: () => { value: T; definitive: boolean }): T {
  if (facts.has(key)) return facts.get(key) as T;
  const { value, definitive } = ask();
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
export function gitObjectAnswer(cwd: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeout: number }): string {
  for (const arg of args) {
    if (!QUESTION_WORDS.has(arg) && !OBJECT_EXPRESSION.test(arg)) {
      throw new Error(`Git object question names a mutable revision or unknown option: ${arg}`);
    }
  }
  return rememberedObjectFact(`git\0${cwd}\0${args.join("\0")}`, () => ({
    value: execFileSync("git", args, { cwd, env: options.env, timeout: options.timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    definitive: true,
  }));
}
