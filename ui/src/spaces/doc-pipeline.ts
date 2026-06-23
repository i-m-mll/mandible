// Secure, NON-EXECUTABLE `spaces-doc.v1` parse -> sanitize pipeline
// (Spaces child C14a, issue 047d1be; umbrella de56ffa).
//
// This is the document parse/sanitize path for a Mandible Space *document*. It
// uses the `unified` + `remark-parse` + `remark-directive` toolchain to parse
// the canonical `spaces-doc.v1` text (CommonMark/GFM prose + the frozen
// non-executable directive grammar from C12 `src/spaces/serialize.ts`) into a
// tree of plain DATA nodes — `containerDirective` / `leafDirective` /
// `textDirective` mdast nodes whose attributes are captured verbatim as strings.
//
// SECURITY MODEL (standing AC #2 — renderer security):
//
//   - There is NO MDX/JSX/JavaScript path. `remark-directive` is the *directive*
//     extension only; it produces inert data nodes, never compiled components or
//     executable expressions. We deliberately do NOT add `remark-mdx`,
//     `@mdx-js/*`, or any evaluate/compile step.
//   - Directives are surfaced as structured data (block identity + classified
//     resource refs) that downstream fixed components (C14b renderer) render.
//     The pipeline itself emits no live HTML for directive nodes.
//   - Prose is rendered to HTML through the existing `marked` instance and then
//     passed through the shared DOMPurify sanitizer (`ui/src/sanitize.ts`).
//     DOMPurify strips `<script>`, inline event handlers, and
//     `javascript:`-scheme hrefs, so no script executes from document content.
//   - Script-enabled iframes are reserved for the standalone artifact-preview
//     surface and are NOT produced here; any `<iframe>` smuggled into prose is
//     removed by the sanitizer.
//
// This module CONSUMES the C12 frozen grammar (it does not redefine it) and the
// C6 shared resource-ref parser. It is the foundation for the C14b renderer
// view, which it intentionally does NOT implement.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkDirective from 'remark-directive';
import { marked } from 'marked';
import { sanitizeHtml } from '../sanitize';
import {
  SPACES_DOC_VERSION,
  FORMAT_KEY,
  BLOCK_DIRECTIVE,
  BLOCK_TYPES,
  type BlockType,
  parseSpacesDocDirectiveRef,
  parseDirectiveAttributes,
  assertNonExecutableGrammar,
  type SpacesDocDirectiveRef,
} from '../../../src/spaces/serialize';
import {
  parseResourceRef,
  type ParsedResourceRef,
} from '../resource-refs';
import { installSpacesDocRefRecognizer } from '../spaces-doc-refs';

// --- parsed data-node model --------------------------------------------------

/** Directive node kinds emitted by `remark-directive` (all inert data). */
export type DirectiveNodeType = 'containerDirective' | 'leafDirective' | 'textDirective';

/**
 * A `spaces-doc.v1` block-identity directive surfaced as a plain data record.
 * Mirrors the C12 frozen `:::block{...}` attribute contract (`id`, `parent`,
 * `sort`, `type`, optional `item`). All values are verbatim strings.
 */
export interface ParsedDocBlock {
  /** Block id from the directive (empty string when externally added w/o id). */
  id: string;
  /** Parent block id, or null for a top-level block (`parent="root"`). */
  parentId: string | null;
  /** Frozen C11 block type; falls back to `paragraph` for unknown values. */
  blockType: BlockType;
  /** Embedded item id for `*_embed` / `reference` blocks, else null. */
  itemId: string | null;
  /** Lexicographic sibling ordering key. */
  sortKey: string;
  /** Verbatim prose markdown body of the block (may be empty). */
  markdown: string;
  /** Sanitized HTML rendered from {@link markdown} (script-free). */
  html: string;
  /** Classified resource refs found inside this block's prose. */
  refs: ParsedDocRef[];
}

/**
 * A `spaces-doc.v1` ref/embed directive surfaced as a data record. The
 * classification reuses the C12 frozen directive-ref parser and the C6 shared
 * resource-ref parser so the directive grammar stays the single authority.
 */
export interface ParsedDocRef {
  /** Original directive text, e.g. `:ref[label]{href="…"}`. */
  raw: string;
  /** Canonical resource ref (resolver authority). */
  canonical: string;
  /** `ref` (inline) or `embed` (container/leaf). */
  directive: 'ref' | 'embed';
  /** Coarse ref kind from the C12 classifier. */
  kind: SpacesDocDirectiveRef['kind'];
  /** Optional human-friendly label. */
  label?: string;
  /** The C6 unified parse of the same ref, when the shared parser claims it. */
  resource: ParsedResourceRef | null;
}

/** A non-block diagnostic surfaced during parsing (never thrown). */
export interface DocPipelineDiagnostic {
  kind: 'unknown_format' | 'unresolved_reference' | 'non_block_prose';
  detail: string;
  ref?: string;
}

/** Result of parsing + sanitizing a `spaces-doc.v1` document. */
export interface ParsedDoc {
  /** Frozen format marker, when present in frontmatter. */
  format: string | null;
  /** Document-level frontmatter (string values only). */
  frontmatter: Record<string, string>;
  /** Block-identity directives as ordered data records. */
  blocks: ParsedDocBlock[];
  /** All classified refs across the document, in document order. */
  refs: ParsedDocRef[];
  /** Sanitized HTML for the whole prose body (script-free). */
  html: string;
  /** Non-fatal diagnostics (unknown format, unresolved refs, …). */
  diagnostics: DocPipelineDiagnostic[];
}

// --- minimal mdast shapes we read (data-only) --------------------------------

interface MdastNode {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  value?: string;
  children?: MdastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

// --- the processor (no executable extensions) --------------------------------

// A single shared processor. `remark-directive` is the ONLY non-core plugin:
// it adds directive *syntax* recognition that yields inert data nodes. There is
// deliberately no MDX/evaluate plugin in this chain.
const processor = unified().use(remarkParse).use(remarkDirective);

// Ensure the C6 shared parser recognizes `spaces-doc.v1` directive refs so
// `parseResourceRef` can classify the directive text we extract. Idempotent.
installSpacesDocRefRecognizer();

// --- frontmatter splitting (kept in lockstep with C12 serialize.ts) ----------

const FRONTMATTER_FENCE = '---';

function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  const normalized = (text ?? '').replace(/^﻿/, '');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return { frontmatter, body: normalized };
  }
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_FENCE) {
      i++;
      break;
    }
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const key = lines[i].slice(0, idx).trim();
    let value = lines[i].slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    if (key) frontmatter[key] = value;
  }
  if (lines[i]?.trim() === '') i++;
  return { frontmatter, body: lines.slice(i).join('\n') };
}

// --- prose rendering -> sanitized HTML ---------------------------------------

// Inline/leaf ref+embed directive tokens are surfaced as structured ref DATA
// (see {@link ParsedDocRef}); they are stripped from prose before rendering so
// directive source text never leaks into HTML as literal content. Replaced with
// the directive label (for `:ref[label]{…}`) or removed.
const INLINE_DIRECTIVE_TOKEN = /:(?:ref|embed)(?:\[([^\]]*)\])?\{[^}]*\}/g;
// A leading `:::block{…}` / `:::embed{…}` header or bare `:::` fence on its own
// line is structural, not prose, and is removed before rendering.
const DIRECTIVE_FENCE_LINE = /^\s*:::[A-Za-z][\w-]*\{[^}]*\}\s*$|^\s*:::\s*$/gm;

/**
 * Strip directive syntax from a prose body so only renderable markdown remains.
 * Directives carry no executable payload; their data is surfaced separately as
 * structured {@link ParsedDocRef} records.
 */
function stripDirectiveSyntax(markdown: string): string {
  return markdown
    .replace(DIRECTIVE_FENCE_LINE, '')
    .replace(INLINE_DIRECTIVE_TOKEN, (_m, label) => (label ? String(label) : ''));
}

/**
 * Render a markdown prose string to SANITIZED HTML. Directive syntax is stripped
 * first (directives are data, not inline HTML), then the existing `marked`
 * instance renders markdown->HTML, then DOMPurify (`sanitizeHtml`) strips any
 * scriptable surface (`<script>`, event handlers, `javascript:` hrefs,
 * `<iframe>`). This is the only HTML-producing path in the pipeline.
 */
export function renderProseToSafeHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return '';
  const prose = stripDirectiveSyntax(markdown);
  if (!prose.trim()) return '';
  const rawHtml = marked.parse(prose, { async: false }) as string;
  return sanitizeHtml(rawHtml);
}

// --- directive attribute access (verbatim strings) ---------------------------

function attrString(
  attrs: Record<string, string | null | undefined> | null | undefined,
  key: string,
): string {
  const v = attrs?.[key];
  return typeof v === 'string' ? v : '';
}

function normalizeBlockType(value: string): BlockType {
  const v = value.trim() as BlockType;
  return (BLOCK_TYPES as readonly string[]).includes(v) ? v : 'paragraph';
}

// --- ref extraction from a node subtree --------------------------------------

/**
 * Reconstruct the directive source text for a ref/embed directive node so the
 * frozen C12 parser can classify it from its own canonical grammar, rather than
 * re-deriving classification here. We never evaluate any attribute value.
 */
function directiveSourceText(node: MdastNode): string {
  const name = node.name ?? '';
  const attrs = node.attributes ?? {};
  // Serialize attributes back to the `key="value"` directive header form.
  const attrText = Object.keys(attrs)
    .filter((k) => typeof attrs[k] === 'string')
    .map((k) => `${k}="${String(attrs[k]).replace(/"/g, '”')}"`)
    .join(' ');
  // The `[label]` text of an inline/leaf directive lives in its text children
  // (remark-directive does not fold it into attributes); reconstruct it so the
  // frozen C12 parser can recover the optional label.
  const label = directiveLabelText(node);
  const labelPart = label ? `[${label}]` : '';
  // Inline/leaf -> `:name[label]{...}`; container -> `:::name{...}`.
  if (node.type === 'containerDirective') return `:::${name}{${attrText}}`;
  return `:${name}${labelPart}{${attrText}}`;
}

/** Concatenated text content of a directive node's children (the `[label]`). */
function directiveLabelText(node: MdastNode): string {
  const parts: string[] = [];
  const walk = (n: MdastNode): void => {
    if (typeof n.value === 'string') parts.push(n.value);
    for (const c of n.children ?? []) walk(c);
  };
  for (const c of node.children ?? []) walk(c);
  return parts.join('').trim();
}

function collectRefsFromNode(node: MdastNode, refs: ParsedDocRef[]): void {
  const isDirective =
    node.type === 'textDirective' ||
    node.type === 'leafDirective' ||
    node.type === 'containerDirective';
  if (isDirective && (node.name === 'ref' || node.name === 'embed')) {
    const source = directiveSourceText(node);
    const parsed = parseSpacesDocDirectiveRef(source);
    if (parsed) {
      // Classify against the C6 shared parser. Prefer the directive form (the
      // installed C12 extension claims it); fall back to the canonical ref
      // string, which C6 recognizes natively regardless of extension state.
      const resource = parseResourceRef(source) ?? parseResourceRef(parsed.canonical);
      refs.push({
        raw: parsed.raw,
        canonical: parsed.canonical,
        directive: parsed.directive,
        kind: parsed.kind,
        label: parsed.label,
        resource,
      });
    }
  }
  for (const child of node.children ?? []) collectRefsFromNode(child, refs);
}

// --- prose extraction for a block (directive nodes stripped) -----------------

/**
 * Extract the verbatim prose body of a block-directive node from the source
 * text using its mdast position offsets. We slice the ORIGINAL source rather
 * than re-stringifying, so the C12 round-trip body (which `marked` understands)
 * is preserved without introducing a markdown serializer dependency.
 */
function blockBodyMarkdown(node: MdastNode, source: string): string {
  const children = node.children ?? [];
  if (!children.length) return '';
  const start = children[0]?.position?.start?.offset;
  const end = children[children.length - 1]?.position?.end?.offset;
  if (typeof start === 'number' && typeof end === 'number' && end >= start) {
    return source.slice(start, end).replace(/^\n+/, '').replace(/\n+$/, '');
  }
  return '';
}

// --- the pipeline ------------------------------------------------------------

/**
 * Parse `spaces-doc.v1` text into structured data nodes + sanitized HTML.
 *
 * This is the secure, non-executable document pipeline:
 *   1. Split frozen-format frontmatter (C12 contract).
 *   2. Parse the body with unified + remark-directive into inert mdast data
 *      nodes (no MDX/JS path).
 *   3. Surface `:::block{…}` identity directives and `:ref`/`:::embed` refs as
 *      plain data records, classified through the frozen C12 grammar and the C6
 *      shared parser.
 *   4. Render prose to sanitized (script-free) HTML via marked + DOMPurify.
 *
 * Never throws on malformed input: problems are returned as
 * {@link DocPipelineDiagnostic}s.
 */
export function parseSpacesDoc(text: string): ParsedDoc {
  const { frontmatter, body } = splitFrontmatter(text);
  const tree = processor.parse(body) as unknown as MdastNode;

  const diagnostics: DocPipelineDiagnostic[] = [];
  const format = frontmatter[FORMAT_KEY] ?? null;
  if (format !== null && format !== SPACES_DOC_VERSION) {
    diagnostics.push({
      kind: 'unknown_format',
      detail: `Unexpected ${FORMAT_KEY} "${format}"; expected "${SPACES_DOC_VERSION}".`,
    });
  }

  const blocks: ParsedDocBlock[] = [];
  const allRefs: ParsedDocRef[] = [];
  // Document HTML is composed from per-fragment sanitized HTML in document
  // order — never by re-rendering the raw body (which would leak directive
  // source text into the output as literal content).
  const htmlFragments: string[] = [];

  const noteRefs = (refs: ParsedDocRef[]): void => {
    for (const ref of refs) {
      allRefs.push(ref);
      if (ref.kind === 'unknown') {
        diagnostics.push({
          kind: 'unresolved_reference',
          detail: `Unresolved reference "${ref.canonical}" retained as placeholder.`,
          ref: ref.canonical,
        });
      }
    }
  };

  for (const node of tree.children ?? []) {
    if (node.type === 'containerDirective' && node.name === BLOCK_DIRECTIVE) {
      const attrs = node.attributes ?? {};
      const parentRaw = attrString(attrs, 'parent').trim() || 'root';
      const itemRaw = attrString(attrs, 'item').trim();
      const markdown = blockBodyMarkdown(node, body);

      const blockRefs: ParsedDocRef[] = [];
      collectRefsFromNode(node, blockRefs);
      noteRefs(blockRefs);

      const html = renderProseToSafeHtml(markdown);
      if (html) htmlFragments.push(html);

      blocks.push({
        id: attrString(attrs, 'id').trim(),
        parentId: parentRaw === 'root' || parentRaw === '' ? null : parentRaw,
        blockType: normalizeBlockType(attrString(attrs, 'type')),
        itemId: itemRaw ? itemRaw : null,
        sortKey: attrString(attrs, 'sort').trim(),
        markdown,
        html,
        refs: blockRefs,
      });
    } else if (node.type !== 'containerDirective') {
      // Loose prose outside any block directive: surface its refs and render it,
      // matching C12's "new external block" leniency (no silent drop).
      const looseRefs: ParsedDocRef[] = [];
      collectRefsFromNode(node, looseRefs);
      noteRefs(looseRefs);

      const looseMarkdown = blockBodyMarkdownFromSlice(node, body);
      const looseHtml = renderProseToSafeHtml(looseMarkdown);
      if (looseHtml) htmlFragments.push(looseHtml);

      if (node.type !== 'text' && (node.children?.length || node.value)) {
        diagnostics.push({
          kind: 'non_block_prose',
          detail: 'Prose found outside a block directive; rendered but not block-identified.',
        });
      }
    }
  }

  return {
    format,
    frontmatter,
    blocks,
    refs: allRefs,
    html: htmlFragments.join('\n'),
    diagnostics,
  };
}

/** Slice a node's own source span (used for loose top-level prose nodes). */
function blockBodyMarkdownFromSlice(node: MdastNode, source: string): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start === 'number' && typeof end === 'number' && end >= start) {
    return source.slice(start, end);
  }
  return node.value ?? '';
}

// --- non-executable guarantee (delegates to the frozen C12 invariant) --------

/**
 * Assert the document pipeline has NO executable directive path. Delegates to
 * the frozen C12 grammar invariant (directives parse to inert data) and adds a
 * pipeline-level structural check: parsing an attacker-controlled "executable"
 * directive yields only data nodes and produces no script-bearing HTML.
 *
 * Throws if any executable surface is ever introduced.
 */
export function assertNoExecutableDirectivePath(): true {
  // 1. The frozen grammar invariant: directives are inert data.
  assertNonExecutableGrammar();

  // 2. Pipeline-level: an "executable-looking" document must produce only data
  //    nodes and script-free HTML.
  const hostile =
    ':::block{id="x" type="paragraph"}\n' +
    'Inline <script>alert(1)</script> and ' +
    ':ref[x]{href="javascript:alert(1)"} and <img src=x onerror=alert(1)>.\n' +
    ':::\n';
  const parsed = parseSpacesDoc(hostile);

  // No directive node ever becomes an executable component: the ref classifies
  // as an inert `unknown` data ref (a `javascript:` href is not a resource ref).
  const jsRef = parsed.refs.find((r) => r.canonical === 'javascript:alert(1)');
  if (!jsRef || jsRef.kind !== 'unknown') {
    throw new Error('spaces-doc pipeline invariant violated: directive ref was not inert');
  }

  // The rendered HTML must carry no scriptable surface after sanitization.
  const html = parsed.html.toLowerCase();
  if (html.includes('<script') || html.includes('onerror=') || html.includes('javascript:')) {
    throw new Error('spaces-doc pipeline invariant violated: sanitized HTML contains a script surface');
  }
  return true;
}

// Re-export the frozen markers consumers commonly need alongside the pipeline.
export {
  SPACES_DOC_VERSION,
  FORMAT_KEY,
  BLOCK_DIRECTIVE,
  parseDirectiveAttributes,
  type BlockType,
};
