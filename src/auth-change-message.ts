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

/** Reserved section headings and trailers the CLI composes, never the agent. */
const RESERVED_HEADING = /^(?:Verification|Mandible-Issue|Closes-Mandible-Issue)\s*:/;
/** A git-trailer-shaped line: `Token:` optionally followed by a value. */
const TRAILER_SHAPED = /^[A-Za-z][A-Za-z0-9_-]*:([ \t].*)?$/;
const VERIFICATION_HEADING = "Verification:";
const ISSUE_TRAILER_PREFIX = "Mandible-Issue: ";

export interface CanonicalChangeMessageFields {
  /** Verification text exactly as supplied through the structured field. */
  verification: string | null | undefined;
  /** Reference-only issue refs, in composition order. */
  issueReferences?: string[] | null;
  /** Close-on-merge issue refs. They are referenced in the message, never closed by it. */
  issueClosures?: string[] | null;
}

/**
 * The trailer set a canonical message is allowed to carry, derived from the
 * structured issue fields.
 *
 * Issue 529f0f2 / external review: closure is exclusively the structured
 * `issue_closures` machinery. `issue_closures` stays editable after approval
 * while the message is frozen, and `cli/auth-merge.sh` reads
 * `Closes-Mandible-Issue:` out of commit messages as a live closure
 * instruction — so a closure trailer inside a signed message could disagree
 * with the authorization actually executed. Closure issues are therefore
 * referenced with a plain `Mandible-Issue:` trailer, which no control path
 * acts on, and `Closes-Mandible-Issue:` is refused anywhere in the message.
 */
export function expectedIssueTrailerRefs(fields: CanonicalChangeMessageFields): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of [...(fields.issueReferences ?? []), ...(fields.issueClosures ?? [])]) {
    if (typeof ref !== "string" || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
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
    if (TRAILER_SHAPED.test(line)) {
      return `The 'verification' text must not contain a trailer-shaped line: ${line}`;
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

/** Issue refs are single tokens; a newline or space would forge extra trailers. */
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
 * The message body is agent prose, but the subject prefix, the `Verification:`
 * section, and the trailer block are mechanism. Validating them here — rather
 * than trusting the CLI that composed them — is what makes "control actions
 * never derive from message text" true for every submitter, including raw API
 * clients. `message` must already be in canonical form.
 */
export function validateCanonicalChangeMessage(
  message: string,
  fields: CanonicalChangeMessageFields,
): string | null {
  if (!isCanonicalChangeMessage(message)) {
    return "The canonical change message is not in canonical form.";
  }

  const refError =
    validateIssueRefTokens(fields.issueReferences) ?? validateIssueRefTokens(fields.issueClosures);
  if (refError) return refError;

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
    if (/^Closes-Mandible-Issue\s*:/.test(line)) {
      return (
        "The canonical change message must not contain a 'Closes-Mandible-Issue:' trailer; " +
        "closure is carried only by the request's issue_closures field."
      );
    }
  }

  // Exactly one Verification section, spelled exactly as composed.
  const verificationIndexes = lines
    .map((line, index) => (RESERVED_HEADING.test(line) && /^Verification\s*:/.test(line) ? index : -1))
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

  // The trailer block is the final contiguous run of Mandible-Issue lines, and
  // no issue trailer may appear anywhere else.
  const expectedRefs = expectedIssueTrailerRefs(fields);
  const trailerIndexes = lines
    .map((line, index) => (/^Mandible-Issue\s*:/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (trailerIndexes.length !== expectedRefs.length) {
    return (
      `The canonical change message must carry exactly ${expectedRefs.length} 'Mandible-Issue:' ` +
      `trailer(s) derived from the request's issue fields, but carries ${trailerIndexes.length}.`
    );
  }
  if (expectedRefs.length > 0) {
    const firstTrailer = trailerIndexes[0]!;
    const expectedStart = lines.length - expectedRefs.length;
    if (firstTrailer !== expectedStart) {
      return "The 'Mandible-Issue:' trailers must be the final contiguous block of the message.";
    }
    if (expectedStart > 0 && lines[expectedStart - 1] !== "") {
      return "The 'Mandible-Issue:' trailer block must be preceded by a blank line.";
    }
    for (let offset = 0; offset < expectedRefs.length; offset += 1) {
      const expected = `${ISSUE_TRAILER_PREFIX}${expectedRefs[offset]}`;
      if (lines[expectedStart + offset] !== expected) {
        return (
          "The 'Mandible-Issue:' trailers do not match the request's issue fields; expected " +
          `${JSON.stringify(expected)}.`
        );
      }
    }
  }

  return null;
}
