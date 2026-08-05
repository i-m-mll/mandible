// Issue 1624ee9 — single home for Mandible-Issue commit-trailer parsing.
// Four independent regex copies had drifted (auth-queue, operational-links x2,
// sse), and the sse copy silently captured only the FIRST trailer. All call
// sites now share these helpers so trailer grammar changes land in one place.

const ISSUE_TRAILER_RE = /^Mandible-Issue:\s+(\S+)/gm;
const CLOSING_ISSUE_TRAILER_RE = /^Closes-Mandible-Issue:\s+(\S+)/gm;

function extractTrailerRefs(message: string | null | undefined, pattern: RegExp): string[] {
  if (!message) return [];
  const refs: string[] = [];
  // Fresh lastIndex per call — the module-level regexes are stateful (/g).
  const regex = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(message)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/** All `Mandible-Issue:` trailer refs, in message order, without dedup. */
export function extractMandibleIssueRefs(message: string | null | undefined): string[] {
  return extractTrailerRefs(message, ISSUE_TRAILER_RE);
}

/** All `Closes-Mandible-Issue:` trailer refs, in message order, without dedup. */
export function extractMandibleClosingIssueRefs(message: string | null | undefined): string[] {
  return extractTrailerRefs(message, CLOSING_ISSUE_TRAILER_RE);
}
