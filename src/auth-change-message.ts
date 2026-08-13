import { createHash } from "node:crypto";

/**
 * Canonical change message (issue 7d64d8f).
 *
 * One auth request carries at most one *canonical change message*: the
 * agent-authored merge commit message, composed at request time by
 * `mandible auth request`, reviewed as part of the request, and consumed
 * verbatim by `cli/auth-merge.sh` as the merge commit message.
 *
 * Canonical bytes are defined so that the CLI (bash, `shasum -a 256`) and the
 * daemon (Node, `crypto`) always agree on the digest:
 *
 *   1. UTF-8 text.
 *   2. Carriage returns are removed (CRLF and lone CR both collapse to LF).
 *   3. Trailing spaces and tabs are stripped from every line.
 *   4. Runs of blank lines collapse to a single blank line.
 *   5. Leading and trailing blank lines are removed.
 *   6. Exactly one trailing newline is appended.
 *
 * Rules 3–5 are deliberately the same normalizations git's own message cleanup
 * performs, so the canonical bytes survive `git merge -m` unchanged and the
 * merge commit really does carry the approved message. (A line starting with
 * `#` would still be at risk, so `mandible auth request` refuses to compose
 * one.)
 *
 * An input that canonicalizes to nothing is "no message" and yields the empty
 * string, never a bare newline. The transform is idempotent, so re-canonicalizing
 * stored bytes before hashing is safe and is exactly what the merge script does.
 *
 * The mirror implementation lives in `cli/auth-merge.sh`
 * (`canonicalize_change_message` / `change_message_digest`); keep the two in
 * sync.
 */
export function canonicalizeChangeMessage(input: string | null | undefined): string {
  if (input == null) return "";
  const trimmed = input
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  const lines: string[] = [];
  for (const line of trimmed) {
    if (line === "" && lines[lines.length - 1] === "") continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length > 0 && lines[0] === "") lines.shift();
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

/** Lowercase hex SHA-256 of the canonical bytes. Empty input has no digest. */
export function changeMessageDigest(input: string | null | undefined): string | null {
  const canonical = canonicalizeChangeMessage(input);
  if (canonical.length === 0) return null;
  return createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
}
