import { diffLines } from "diff";
import { leadingMarkdownFrontmatter } from "../markdown-frontmatter.js";
import { remarkDirectives } from "../presentation/remark-directives.js";
import type { DiffFilePair, GitChangeFile } from "../contracts.js";

export type NarrativeReference = { start: number; end: number; path: string; quote: string; index: number };

export function requestNarrativeChanges(source: string, files: readonly Pick<GitChangeFile, "old_path" | "new_path">[]): NarrativeReference[] {
  const start = leadingMarkdownFrontmatter(source)?.end ?? 0;
  const paths = new Map<string, number | null>();
  files.forEach((file, index) => {
    for (const path of new Set([file.new_path, file.old_path])) {
      if (path !== null) paths.set(path, paths.has(path) ? null : index);
    }
  });
  return remarkDirectives.parse(source.slice(start)).children.flatMap(node => {
    if (node.type !== "containerDirective" || node.name !== "change" || !node.position) return [];
    const path = node.attributes?.path;
    const from = start + node.position.start.offset!;
    const to = start + node.position.end.offset!;
    if (typeof path !== "string" || Object.keys(node.attributes ?? {}).length !== 1) return [];
    const index = paths.get(path);
    if (index == null) return [];
    const raw = source.slice(from, to);
    const opening = /^(:{3,})change\{path="[^"\r\n]+"\}(?:\r\n|\r|\n)/.exec(raw);
    if (!opening) return [];
    const closer = new RegExp(`(?:\\r\\n|\\r|\\n)${opening[1]}$`).exec(raw);
    if (!closer) return [];
    return [{ start: from, end: to, path, index, quote: raw.slice(opening[0].length, closer.index) }];
  });
}

export type TextSpan = { start: number; end: number };
export type NarrativeHunk = { before: TextSpan; after: TextSpan };
type TextPair = Extract<DiffFilePair, { kind: "text" }>;

export function narrativeHunks(before: string, after: string): NarrativeHunk[] | null {
  const parts = diffLines(before, after, { timeout: 100 });
  if (!parts) return null;
  const hunks: NarrativeHunk[] = [];
  let a = 0;
  let b = 0;
  let hunk: NarrativeHunk | undefined;
  for (const part of parts) {
    const length = part.value.length;
    if (!part.added && !part.removed) {
      hunk = undefined;
      a += length;
      b += length;
      continue;
    }
    if (!hunk) {
      hunk = { before: { start: a, end: a }, after: { start: b, end: b } };
      hunks.push(hunk);
    }
    if (part.removed) hunk.before.end = a += length;
    if (part.added) hunk.after.end = b += length;
  }
  return hunks;
}

export function resolveNarrativeChange(source: string, quote: string, hunks: readonly NarrativeHunk[]) {
  const start = quote.length ? source.indexOf(quote) : -1;
  if (start === -1 || source.indexOf(quote, start + 1) !== -1) return null;
  const end = start + quote.length;
  const matches = hunks.filter(({ after }) => after.start < end && start < after.end);
  return matches.length === 1 ? matches[0] : null;
}

export function narrativeHunkPair(pair: TextPair, hunk: NarrativeHunk): TextPair {
  return {
    ...pair,
    before: { ...pair.before, contents: pair.before.contents.slice(hunk.before.start, hunk.before.end) },
    after: { ...pair.after, contents: pair.after.contents.slice(hunk.after.start, hunk.after.end) },
  };
}

export function narrativeDraftSpan(proposed: string, draft: string, span: TextSpan): TextSpan | null {
  if (proposed === draft) return span;
  const changes = narrativeHunks(proposed, draft);
  if (!changes) return null;
  const map = (offset: number, edge: "start" | "end") => {
    let delta = 0;
    for (const { before, after } of changes) {
      if (offset < before.start) break;
      if (offset === before.start) return edge === "end" && before.start === before.end ? after.end : after.start;
      if (offset < before.end) return null;
      if (offset === before.end) return after.end;
      delta = after.end - before.end;
    }
    return offset + delta;
  };
  const start = map(span.start, "start");
  const end = map(span.end, "end");
  return start === null || end === null ? null : { start, end };
}
