export type IssueReferenceKind = "issue" | "comment" | "deprecated_iss_alias";

export interface ParsedIssueReference {
  kind: IssueReferenceKind;
  raw: string;
  normalized: string;
  project?: string;
  issueRef: string;
  commentRef?: string;
}

const EXPLICIT_REF_PATTERN = /\[(issue|comment):([^\]\s]+)\]/g;
const HASH_REF_PATTERN = /(?<![\w/])#([0-9a-f]{7,64})\b/g;
const BARE_HEX_REF_PATTERN = /(?<![\w/])([0-9a-f]{7,64})\b/g;
const DEPRECATED_ISS_REF_PATTERN = /(?<![\w])iss_[A-Za-z0-9_]+/g;

export function parseIssueReferences(source: string): ParsedIssueReference[] {
  if (!source) return [];
  const protectedRanges = collectProtectedRanges(source);
  const refs: ParsedIssueReference[] = [];
  const seen = new Set<string>();
  const add = (ref: ParsedIssueReference) => {
    const key = `${ref.kind}:${ref.project ?? ""}:${ref.issueRef}:${ref.commentRef ?? ""}:${ref.normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  for (const match of source.matchAll(EXPLICIT_REF_PATTERN)) {
    if (isProtected(protectedRanges, match.index ?? 0)) continue;
    const ref = parseExplicitReference(match[1], match[2], match[0]);
    if (ref) add(ref);
  }

  for (const match of source.matchAll(HASH_REF_PATTERN)) {
    if (isProtected(protectedRanges, match.index ?? 0)) continue;
    add({
      kind: "issue",
      raw: match[0],
      normalized: match[1],
      issueRef: match[1],
    });
  }

  for (const match of source.matchAll(BARE_HEX_REF_PATTERN)) {
    const index = match.index ?? 0;
    if (isProtected(protectedRanges, index)) continue;
    if (isCommitLikeContext(source, index) || isAuthRequestContext(source, index)) continue;
    add({
      kind: "issue",
      raw: match[0],
      normalized: match[1],
      issueRef: match[1],
    });
  }

  for (const match of source.matchAll(DEPRECATED_ISS_REF_PATTERN)) {
    const index = match.index ?? 0;
    if (isProtected(protectedRanges, index)) continue;
    add({
      kind: "deprecated_iss_alias",
      raw: match[0],
      normalized: match[0],
      issueRef: match[0],
    });
  }

  return refs;
}

function parseExplicitReference(type: string, ref: string, raw: string): ParsedIssueReference | null {
  if (type === "issue") {
    const scoped = ref.match(/^([^/#]+)\/([^/#]+)$/);
    const issueRef = scoped ? scoped[2] : ref;
    return {
      kind: "issue",
      raw,
      normalized: ref,
      project: scoped?.[1],
      issueRef,
    };
  }

  const scoped = ref.match(/^([^/#]+)\/([^/#]+)#([^#]+)$/);
  if (scoped) {
    return {
      kind: "comment",
      raw,
      normalized: ref,
      project: scoped[1],
      issueRef: scoped[2],
      commentRef: scoped[3],
    };
  }
  const currentProject = ref.match(/^([^/#]+)#([^#]+)$/);
  if (currentProject) {
    return {
      kind: "comment",
      raw,
      normalized: ref,
      issueRef: currentProject[1],
      commentRef: currentProject[2],
    };
  }
  return null;
}

interface ProtectedRange {
  start: number;
  end: number;
}

function collectProtectedRanges(source: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  collectRanges(source, /```[\s\S]*?```/g, ranges);
  collectInlineCodeRanges(source, ranges);
  collectRanges(source, /\[[^\]]+\]\([^)]+\)/g, ranges);
  collectRanges(source, /https?:\/\/\S+/g, ranges);
  return ranges.sort((a, b) => a.start - b.start);
}

function collectRanges(source: string, pattern: RegExp, ranges: ProtectedRange[]): void {
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
}

function collectInlineCodeRanges(source: string, ranges: ProtectedRange[]): void {
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    const start = match.index ?? 0;
    const content = match[1].trim();
    const isLegacyIssueRef = /^[0-9a-f]{7,64}$/.test(content) || /^iss_[A-Za-z0-9_]+$/.test(content);
    if (isLegacyIssueRef && !isCommitLikeContext(source, start) && !isAuthRequestContext(source, start)) {
      continue;
    }
    ranges.push({ start, end: start + match[0].length });
  }
}

function isProtected(ranges: ProtectedRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function isCommitLikeContext(text: string, matchIndex: number): boolean {
  return /(?:merge|commit(?:\s+(?:is|was|hash|sha))?|superseding\s+the\s+earlier|earlier)\s+$/i
    .test(text.slice(Math.max(0, matchIndex - 64), matchIndex));
}

function isAuthRequestContext(text: string, matchIndex: number): boolean {
  return /(?:auth\s+request|auth)\s+$/i.test(text.slice(Math.max(0, matchIndex - 32), matchIndex));
}
