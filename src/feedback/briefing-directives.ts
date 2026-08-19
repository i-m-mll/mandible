import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";

export const BRIEFING_PROFILE = "mandible-briefing.v2" as const;

export const BRIEFING_RESPONSE_TYPES = [
  "verdict", "single_choice", "multi_choice", "short_text", "long_text", "rating",
] as const;
export type BriefingResponseType = (typeof BRIEFING_RESPONSE_TYPES)[number];
export type BriefingOption = { key: string; label: string };

export type BriefingDirective = {
  key: string;
  type: BriefingResponseType;
  required: boolean;
  start_offset: number;
  end_offset: number;
  body_start_offset: number;
  body_end_offset: number;
  body: string;
  options: BriefingOption[];
  definition_digest: string;
};

export class BriefingDirectiveError extends Error {}

type Node = { type?: string; name?: string; value?: string; attributes?: Record<string, unknown>; children?: Node[];
  position?: { start?: { offset?: number }; end?: { offset?: number } } };

function offsets(node: Node): { start: number; end: number } {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new BriefingDirectiveError("directive source range is unavailable");
  }
  return { start, end };
}

function directiveBody(
  source: string,
  node: Node,
  start: number,
  end: number,
  type: BriefingResponseType,
): { start: number; end: number; body: string; options: BriefingOption[] } {
  const openEnd = source.indexOf("\n", start);
  if (openEnd < start || openEnd >= end) throw new BriefingDirectiveError("directive body is empty");
  if (!/^:::spec-item\{key="[A-Za-z0-9._-]{1,128}" type="(?:verdict|single_choice|multi_choice|short_text|long_text|rating)" required="(?:true|false)"\}\r?$/.test(source.slice(start, openEnd))) {
    throw new BriefingDirectiveError("directive opener is not in the briefing grammar");
  }
  const closeStart = source.lastIndexOf("\n:::", end - 1);
  if (closeStart < openEnd || !/^:::\r?$/.test(source.slice(closeStart + 1, end))) {
    throw new BriefingDirectiveError("directive closing fence is invalid");
  }
  const bodyStart = openEnd + 1;
  const containerBodyEnd = source[closeStart - 1] === "\r" ? closeStart - 1 : closeStart;
  const children = node.children ?? [];
  const firstOption = children.findIndex((child) => child.type === "leafDirective" && child.name === "option");
  const optionNodes = firstOption < 0 ? [] : children.slice(firstOption);
  if (optionNodes.some((child) => child.type !== "leafDirective" || child.name !== "option")) {
    throw new BriefingDirectiveError("options must be direct contiguous trailing leaves");
  }
  const choice = type === "single_choice" || type === "multi_choice";
  if (choice && (optionNodes.length < 2 || optionNodes.length > 12)) {
    throw new BriefingDirectiveError("choice directives require 2-12 options");
  }
  if (!choice && optionNodes.length > 0) {
    throw new BriefingDirectiveError("options are only supported by choice directives");
  }
  const options: BriefingOption[] = [];
  const optionKeys = new Set<string>();
  for (const [index, option] of optionNodes.entries()) {
    const range = offsets(option);
    const attrs = option.attributes ?? {};
    if (Object.keys(attrs).join(",") !== "key" || typeof attrs.key !== "string"
        || !/^[A-Za-z0-9._-]{1,128}$/.test(attrs.key)) {
      throw new BriefingDirectiveError("option key is invalid");
    }
    if (optionKeys.has(attrs.key)) throw new BriefingDirectiveError("option keys must be unique");
    optionKeys.add(attrs.key);
    if (option.children?.length !== 1 || option.children[0]?.type !== "text"
        || typeof option.children[0].value !== "string" || !option.children[0].value.trim()) {
      throw new BriefingDirectiveError("option labels must be nonblank plain text");
    }
    const label = option.children[0].value;
    const expected = `::option[${label}]{key="${attrs.key}"}`;
    if (source.slice(range.start, range.end) !== expected) {
      throw new BriefingDirectiveError("option leaf is not in the briefing grammar");
    }
    if (index > 0) {
      const previous = offsets(optionNodes[index - 1]);
      if (!/^(?:\r?\n)$/.test(source.slice(previous.end, range.start))) {
        throw new BriefingDirectiveError("option leaves must be contiguous");
      }
    }
    options.push({ key: attrs.key, label });
  }
  let bodyEnd = optionNodes.length > 0 ? offsets(optionNodes[0]).start : containerBodyEnd;
  while (bodyEnd > bodyStart && (source[bodyEnd - 1] === "\n" || source[bodyEnd - 1] === "\r")) bodyEnd -= 1;
  const body = source.slice(bodyStart, bodyEnd);
  if (!body.trim()) throw new BriefingDirectiveError("directive body is empty");
  return { start: bodyStart, end: bodyEnd, body, options };
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
      if (keys.join(",") !== "key,type,required") {
        throw new BriefingDirectiveError("directive contains an unsupported attribute");
      }
      if (typeof attrs.key !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(attrs.key)) {
        throw new BriefingDirectiveError("directive key must use 1-128 ASCII letters, digits, '.', '_' or '-'");
      }
      if (typeof attrs.type !== "string" || !(BRIEFING_RESPONSE_TYPES as readonly string[]).includes(attrs.type)) {
        throw new BriefingDirectiveError("directive type is unsupported");
      }
      if (attrs.required !== "true" && attrs.required !== "false") {
        throw new BriefingDirectiveError("directive required must be true or false");
      }
      if (seen.has(attrs.key)) throw new BriefingDirectiveError("directive keys must be unique");
      seen.add(attrs.key);
      const range = offsets(node);
      const body = directiveBody(source, node, range.start, range.end, attrs.type as BriefingResponseType);
      directives.push({
        key: attrs.key,
        type: attrs.type as BriefingResponseType,
        required: attrs.required === "true",
        start_offset: range.start,
        end_offset: range.end,
        body_start_offset: body.start,
        body_end_offset: body.end,
        body: body.body,
        options: body.options,
        definition_digest: createHash("sha256").update(Buffer.from(source.slice(range.start, range.end), "utf8")).digest("hex"),
      });
      // remark-directive represents nested containers as children. They must
      // still be inspected instead of being hidden by this accepted parent.
      for (const child of node.children ?? []) {
        if (child.type === "leafDirective" && child.name === "option") continue;
        walk(child, false);
      }
      return;
    }
    for (const child of node.children ?? []) walk(child, node === tree);
  };
  walk(tree, false);
  if (directives.length === 0) throw new BriefingDirectiveError("briefing document has no spec-item directives");
  return directives;
}
