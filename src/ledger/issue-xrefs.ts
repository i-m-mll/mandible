export type IssueReferenceKind = "issue" | "comment";

export interface ParsedIssueReference {
  kind: IssueReferenceKind;
  raw: string;
  normalized: string;
  project?: string;
  issueRef: string;
  commentRef?: string;
}

const EXPLICIT_REF_PATTERN = /\[(issue|comment):([^\]\s]+)\]/g;

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
    ranges.push({ start, end: start + match[0].length });
  }
}

function isProtected(ranges: ProtectedRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}
