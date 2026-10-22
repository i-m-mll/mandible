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
 * merge commit really does carry the approved message. A `#`-leading line would
 * still be at risk, so it is refused outright (see validateCanonicalChangeMessage).
 *
 * An input that canonicalizes to nothing is "no message" and yields the empty
 * string, never a bare newline. The transform is idempotent.
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

/** True when `bytes` is already exactly its own canonical form (and non-empty). */
export function isCanonicalChangeMessage(bytes: string): boolean {
  return bytes.length > 0 && bytes === canonicalizeChangeMessage(bytes);
}

/**
 * Lowercase hex SHA-256 of the bytes exactly as given.
 *
 * This deliberately does NOT canonicalize first. The digest must bind the bytes
 * that are actually stored and later committed — including the terminal newline
 * — so every consumer hashes the same octets. Callers assert canonical form
 * separately (isCanonicalChangeMessage) and fail closed when it does not hold,
 * rather than silently digesting a normalized copy of something else.
 */
export function changeMessageDigest(bytes: string): string {
  return createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");
}

const VERIFICATION_HEADING = "Verification:";

export interface CanonicalChangeMessageFields {
  verification: string | null | undefined;
}

/** Validate the verification text a canonical message is allowed to carry. */
export function validateVerificationText(verification: string | null | undefined): string | null {
  if (typeof verification !== "string") {
    return "A canonical change message requires the structured 'verification' field.";
  }
  const lines = verification.replace(/\r/g, "").split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length > 0 && lines[0] === "") lines.shift();
  if (lines.length === 0) return "The 'verification' text must not be empty.";
  for (const line of lines) {
    if (line === "") return "The 'verification' text must be a single paragraph.";
    if (line.startsWith("#")) {
      return "The 'verification' text must not contain a line starting with '#'.";
    }

  }
  return null;
}

/** The exact verification lines a canonical message must carry. */
export function verificationLines(verification: string): string[] {
  const lines = verification.replace(/\r/g, "").split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length > 0 && lines[0] === "") lines.shift();
  return lines;
}

export interface MergeChangeMessageFields {
  canonical_message?: boolean;
  commit_message?: string | null;
  verification?: string | null;
}

/**
 * Issue 4720024 — a protected merge request must carry a canonical change
 * message and its verification text, just as a commit needs a message. The
 * daemon's submission and revision routes refuse merge requests without them,
 * so no client can bypass the rule. Returns the refusal text, or null.
 */
export function mergeChangeMessageRequirement(fields: MergeChangeMessageFields): string | null {
  const message = typeof fields.commit_message === "string" ? fields.commit_message.trim() : "";
  if (fields.canonical_message !== true || message === "") {
    return "Merge requests require a canonical change message: pass --message <text> or --message-file <file> " +
      "(API: canonical_message=true with commit_message). It becomes the reviewed merge commit message: " +
      "an outcome line, then a short Why paragraph.";
  }
  if (typeof fields.verification !== "string" || fields.verification.trim() === "") {
    return "Merge requests require --verification <text> (API: verification): the checks you ran and their results. " +
      "It becomes the merge commit's Verification section.";
  }
  return null;
}

/** One reviewed Description uses the historical commit_message storage key. */
export function authDescriptionRequirement(fields: MergeChangeMessageFields & { type?: string }): string | null {
  if (typeof fields.commit_message !== "string" || fields.commit_message.trim() === "") {
    return "Every approval request requires a nonblank Description: pass --message <text> or --message-file <file> (API: commit_message).";
  }
  if ((fields.type ?? "merge") === "merge") return mergeChangeMessageRequirement(fields);
  if (fields.canonical_message === true || fields.verification != null) {
    return "canonical_message and verification apply only to merge requests; other Descriptions are explanatory Markdown.";
  }
  return null;
}

/** Issue refs are single tokens; whitespace is not part of an issue identity. */
export function validateIssueRefTokens(refs: readonly unknown[] | null | undefined): string | null {
  for (const ref of refs ?? []) {
    if (typeof ref !== "string" || ref.length === 0) {
      return "Issue refs must be non-empty strings.";
    }
    if (/\s/.test(ref)) {
      return `Issue ref ${JSON.stringify(ref)} must not contain whitespace or newlines.`;
    }
  }
  return null;
}

/**
 * Enforce, at the daemon boundary and before anything is digested, that the
 * machine-owned envelope of a canonical change message is exactly what the
 * structured fields would compose.
 *
 * The message body is prose. Only the canonical formatting and the explicit
 * Verification section are validated; issue relationships are separate records.
 */
export function validateCanonicalChangeMessage(
  message: string,
  fields: CanonicalChangeMessageFields,
): string | null {
  if (!isCanonicalChangeMessage(message)) {
    return "The canonical change message is not in canonical form.";
  }


  const verificationError = validateVerificationText(fields.verification);
  if (verificationError) return verificationError;
  const expectedVerification = verificationLines(fields.verification as string);

  const lines = message.slice(0, -1).split("\n");
  if (lines[0] === undefined || lines[0].trim() === "") {
    return "The canonical change message must open with a subject line.";
  }

  for (const line of lines) {
    if (line.startsWith("#")) {
      return `The canonical change message must not contain a line starting with '#': ${line}`;
    }

  }

  // Exactly one Verification section, spelled exactly as composed.
  const verificationIndexes = lines
    .map((line, index) => (/^Verification\s*:/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (verificationIndexes.length !== 1) {
    return "The canonical change message must contain exactly one 'Verification:' section.";
  }
  const verificationIndex = verificationIndexes[0]!;
  if (lines[verificationIndex] !== VERIFICATION_HEADING) {
    return "The 'Verification:' heading must be on a line of its own.";
  }
  const observedVerification: string[] = [];
  for (let index = verificationIndex + 1; index < lines.length; index += 1) {
    if (lines[index] === "") break;
    observedVerification.push(lines[index]!);
  }
  if (observedVerification.join("\n") !== expectedVerification.join("\n")) {
    return "The 'Verification:' section does not match the structured 'verification' field.";
  }

  return null;
}
