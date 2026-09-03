import { parseAuthoredReferences } from "./authored-references.js";

export type IssueReferenceKind = "issue" | "comment";

export interface ParsedIssueReference {
  kind: IssueReferenceKind;
  raw: string;
  normalized: string;
  project?: string;
  issueRef: string;
  commentRef?: string;
}

export function parseIssueReferences(source: string): ParsedIssueReference[] {
  if (!source) return [];
  const refs: ParsedIssueReference[] = [];
  const seen = new Set<string>();
  const add = (ref: ParsedIssueReference) => {
    const key = `${ref.kind}:${ref.project ?? ""}:${ref.issueRef}:${ref.commentRef ?? ""}:${ref.normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  for (const match of parseAuthoredReferences(source)) {
    if (match.kind !== "issue" && match.kind !== "comment") continue;
    const ref = parseExplicitReference(match.kind, match.target, match.raw);
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
