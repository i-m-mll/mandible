export const AUTHORED_REFERENCE_KINDS = [
  "issue",
  "comment",
  "artifact",
  "artifact-version",
  "artifact-series",
  "artifact-blob",
  "auth",
] as const;

export type AuthoredReferenceKind = (typeof AUTHORED_REFERENCE_KINDS)[number];

export interface AuthoredReference {
  kind: AuthoredReferenceKind;
  raw: string;
  target: string;
  start: number;
  end: number;
}

const AUTHORED_REFERENCE_PATTERN = new RegExp(
  `\\[(${AUTHORED_REFERENCE_KINDS.join("|")}):([^\\]\\s]+)\\]`,
  "g",
);

export function parseAuthoredReferences(
  source: string,
  options: { includeProtected?: boolean } = {},
): AuthoredReference[] {
  if (!source) return [];
  const protectedRanges = options.includeProtected ? [] : collectProtectedRanges(source);
  const references: AuthoredReference[] = [];
  for (const match of source.matchAll(AUTHORED_REFERENCE_PATTERN)) {
    const start = match.index ?? 0;
    if (isProtected(protectedRanges, start)) continue;
    const kind = match[1] as AuthoredReferenceKind;
    const target = match[2];
    if (!isValidTarget(kind, target)) continue;
    references.push({ kind, raw: match[0], target, start, end: start + match[0].length });
  }
  return references;
}

function isValidTarget(kind: AuthoredReferenceKind, target: string): boolean {
  if (kind === "issue") return /^(?:[^\/#]+\/)?[^\/#]+$/.test(target);
  if (kind === "comment") return /^(?:[^\/#]+\/)?[^\/#]+#[^\/#]+$/.test(target);
  if (kind === "artifact") return !/^sha256:/i.test(target);
  // Auth request ids are global, so there is no project-qualified form.
  if (kind === "auth") return /^[^\/#]+$/.test(target);
  return true;
}

interface ProtectedRange {
  start: number;
  end: number;
}

function collectProtectedRanges(source: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  collectRanges(source, /```[\s\S]*?```/g, ranges);
  collectRanges(source, /`([^`\n]+)`/g, ranges);
  collectRanges(source, /\[[^\]]+\]\([^)]+\)/g, ranges);
  collectRanges(source, /https?:\/\/\S+/g, ranges);
  return ranges.sort((left, right) => left.start - right.start);
}

function collectRanges(source: string, pattern: RegExp, ranges: ProtectedRange[]): void {
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
}

function isProtected(ranges: ProtectedRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}
