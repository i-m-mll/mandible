import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";

export const BRIEFING_PROFILE = "mandible-briefing.v1" as const;

export type BriefingDirective = {
  key: string;
  required: boolean;
  start_offset: number;
  end_offset: number;
  body_start_offset: number;
  body_end_offset: number;
  body: string;
  definition_digest: string;
};

export class BriefingDirectiveError extends Error {}

type Node = { type?: string; name?: string; attributes?: Record<string, unknown>; children?: Node[];
  position?: { start?: { offset?: number }; end?: { offset?: number } } };

function offsets(node: Node): { start: number; end: number } {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new BriefingDirectiveError("directive source range is unavailable");
  }
  return { start, end };
}

function directiveBody(source: string, start: number, end: number): { start: number; end: number; body: string } {
  const openEnd = source.indexOf("\n", start);
  if (openEnd < start || openEnd >= end) throw new BriefingDirectiveError("directive body is empty");
  if (!/^:::spec-item\{key="[A-Za-z0-9._-]{1,128}"(?: required="(?:true|false)")?\}\r?$/.test(source.slice(start, openEnd))) {
    throw new BriefingDirectiveError("directive opener is not in the briefing grammar");
  }
  const closeStart = source.lastIndexOf("\n:::", end - 1);
  if (closeStart < openEnd || !/^:::\r?$/.test(source.slice(closeStart + 1, end))) {
    throw new BriefingDirectiveError("directive closing fence is invalid");
  }
  const bodyStart = openEnd + 1;
  const bodyEnd = source[closeStart - 1] === "\r" ? closeStart - 1 : closeStart;
  const body = source.slice(bodyStart, bodyEnd);
  if (!body.trim()) throw new BriefingDirectiveError("directive body is empty");
  return { start: bodyStart, end: bodyEnd, body };
}

/** Parses the deliberately small, inert briefing directive grammar. Offsets are JS UTF-16 code units. */
export function parseBriefingDirectives(source: string): BriefingDirective[] {
  const tree = unified().use(remarkParse).use(remarkDirective).parse(source) as unknown as Node;
  const directives: BriefingDirective[] = [];
  const seen = new Set<string>();
  const walk = (node: Node, topLevel: boolean): void => {
    const isDirective = typeof node.type === "string" && node.type.endsWith("Directive");
    if (isDirective) {
      if (!topLevel || node.type !== "containerDirective" || node.name !== "spec-item") {
        throw new BriefingDirectiveError("only top-level spec-item container directives are supported");
      }
      const attrs = node.attributes ?? {};
      const keys = Object.keys(attrs);
      if (keys.some((key) => key !== "key" && key !== "required")) {
        throw new BriefingDirectiveError("directive contains an unsupported attribute");
      }
      if (typeof attrs.key !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(attrs.key)) {
        throw new BriefingDirectiveError("directive key must use 1-128 ASCII letters, digits, '.', '_' or '-'");
      }
      if (attrs.required !== undefined && attrs.required !== "true" && attrs.required !== "false") {
        throw new BriefingDirectiveError("directive required must be true or false");
      }
      if (seen.has(attrs.key)) throw new BriefingDirectiveError("directive keys must be unique");
      seen.add(attrs.key);
      const range = offsets(node);
      const body = directiveBody(source, range.start, range.end);
      directives.push({
        key: attrs.key,
        required: attrs.required === "true",
        start_offset: range.start,
        end_offset: range.end,
        body_start_offset: body.start,
        body_end_offset: body.end,
        body: body.body,
        definition_digest: createHash("sha256").update(Buffer.from(source.slice(range.start, range.end), "utf8")).digest("hex"),
      });
      // remark-directive represents nested containers as children. They must
      // still be inspected instead of being hidden by this accepted parent.
      for (const child of node.children ?? []) walk(child, false);
      return;
    }
    for (const child of node.children ?? []) walk(child, node === tree);
  };
  walk(tree, false);
  if (directives.length === 0) throw new BriefingDirectiveError("briefing document has no spec-item directives");
  return directives;
}
