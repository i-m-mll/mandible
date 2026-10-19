import {
  parseAuthoredReferences,
  parseCommentRefTarget,
  parseIssueRefTarget,
} from "./authored-references.js";

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

// `[issue:<id>#<n>]` (n > 0) records the same comment-kind source that
// `[comment:<id>#<n>]` records; `#0` addresses the issue description, so it
// records an issue-kind source. Both feed the same issue-level `references`
// relationship as `[issue:<id>]`.
function parseExplicitReference(type: string, ref: string, raw: string): ParsedIssueReference | null {
  if (type === "issue") {
    const target = parseIssueRefTarget(ref);
    if (!target) return null;
    const commentOrdinal = target.ordinal !== undefined && target.ordinal > 0;
    return {
      kind: commentOrdinal ? "comment" : "issue",
      raw,
      normalized: ref,
      project: target.project,
      issueRef: target.issue,
      ...(commentOrdinal ? { commentRef: String(target.ordinal) } : {}),
    };
  }

  const target = parseCommentRefTarget(ref);
  if (!target) return null;
  return {
    kind: "comment",
    raw,
    normalized: ref,
    project: target.project,
    issueRef: target.issue,
    commentRef: target.comment,
  };
}
