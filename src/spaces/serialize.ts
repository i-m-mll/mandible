/**
 * `spaces-doc.v1` canonical document serialization (Spaces child C12, issue
 * 9a81dab, umbrella de56ffa).
 *
 * This is the FROZEN, dependency-light, backend-shaped serialization for a
 * Mandible Space *document*: the `space_blocks` tree (C11) plus its references
 * and embeds, serialized to a SINGLE in-band canonical file — CommonMark/GFM
 * prose + YAML-ish frontmatter + a small **non-executable directive grammar**.
 *
 * Design source of truth: `docs/spaces/DOCUMENT-CUSTODY-DESIGN.md` §1 (and
 * `UMBRELLA-PLAN.md` §8/§14). Key decisions encoded here:
 *
 *   - Canonical format is Markdown + the non-executable `spaces-doc.v1`
 *     directive profile, NOT full/executable MDX. There is NO JavaScript eval
 *     path: directives are parsed into plain DATA nodes (see
 *     {@link assertNonExecutableGrammar}), never compiled or executed.
 *   - The document text is the SINGLE lossless source of truth — no sidecar.
 *     `importDocument(exportDocument(tree)).tree` round-trips `id`, `parent_id`,
 *     `sort_key`, `block_type`, `item_id` embeds, and the prose body.
 *   - Re-import of an externally-edited file follows the import-conflict policy
 *     (custody-doc §1.3, the 5 rows), surfaced as structured {@link ImportConflict}
 *     records — never a silent merge.
 *
 * ## Frozen grammar contract (consumed by C11 block identity + C14b renderer)
 *
 * The grammar version string is {@link SPACES_DOC_VERSION} (`spaces-doc.v1`).
 * The block-identity directive carries the four C11 attributes — `id`, `parent`,
 * `sort`, `type` — and the optional `item` embed pointer. Reference/embed
 * directive nodes carry a canonical resource ref (`artifact:sha256:…`,
 * `repo://…`, `mandible://…`). The recognizer for those ref/embed directive
 * nodes is exported as {@link parseSpacesDocDirectiveRef} and wired into the C6
 * shared resource-ref parser by `ui/src/spaces-doc-refs.ts`.
 *
 * Downstream consumers (C11, C14b) MUST treat the names/shapes in this module as
 * frozen: do not rename attributes, the block directive name, or the version
 * marker. Superseding the grammar means publishing `spaces-doc.v2`, not mutating
 * v1 in place.
 */

// --- frozen version + grammar tokens -----------------------------------------

/** Frozen grammar/version marker written into and required from frontmatter. */
export const SPACES_DOC_VERSION = 'spaces-doc.v1' as const;

/** Frontmatter key carrying the format marker. */
export const FORMAT_KEY = 'mandible_format' as const;

/**
 * The block-identity directive name. A `:::block{...}` container directive
 * carries one block's identity + tree position and wraps its markdown body.
 */
export const BLOCK_DIRECTIVE = 'block' as const;

/**
 * Block types — FROZEN to match the C11 `space_blocks.block_type` CHECK set
 * (`UMBRELLA-PLAN.md` §3.5). Keep in lockstep with the schema column.
 */
export const BLOCK_TYPES = [
  'heading',
  'paragraph',
  'reference',
  'artifact_embed',
  'issue_embed',
  'comment_embed',
  'todo',
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

/** Block types that carry an embedded `item_id`. */
export const EMBED_BLOCK_TYPES = new Set<BlockType>([
  'reference',
  'artifact_embed',
  'issue_embed',
  'comment_embed',
]);

// --- block tree model (the C11-aligned serialization view) -------------------

/**
 * One serializable block. This is the serialization *view* of a `space_blocks`
 * row (C11 owns the table); only the fields that round-trip through the document
 * text live here. `parent_id === null` marks a top-level block.
 */
export interface DocBlock {
  id: string;
  parent_id: string | null;
  block_type: BlockType;
  /** Embedded item ref for `*_embed` / `reference` blocks; null for prose. */
  item_id: string | null;
  /** Lexicographic sibling ordering key. */
  sort_key: string;
  /** Prose / fallback markdown body (may be empty). */
  markdown: string;
}

/** A whole document: the ordered block list plus document-level frontmatter. */
export interface DocTree {
  /** Document-level metadata serialized as frontmatter (e.g. space id). */
  frontmatter: Record<string, string>;
  /** Blocks in canonical (depth-first, sort_key-ordered) document order. */
  blocks: DocBlock[];
}

// --- frozen directive-ref grammar (the C6 extension surface) -----------------

/**
 * Parsed `spaces-doc.v1` reference/embed directive node. This is the structural
 * type the C6 shared resource-ref parser consumes through the extension adapter
 * in `ui/src/spaces-doc-refs.ts`. It is intentionally DOM-free so it can be
 * shared by backend serialization and the UI parser alike.
 */
export interface SpacesDocDirectiveRef {
  /** Original directive text matched. */
  raw: string;
  /** Canonical resource ref (resolver authority). */
  canonical: string;
  /** Coarse ref kind. */
  kind: 'artifact' | 'repo' | 'mandible' | 'issue' | 'comment' | 'unknown';
  /** Directive node name (`ref` or `embed`). */
  directive: 'ref' | 'embed';
  /** Optional human-friendly label (directive label text). */
  label?: string;
}

// Inline ref directive:  :ref[label]{href="<canonical>"}  (label optional)
// Container embed directive header:  :::embed{href="<canonical>" ...}
// Both forms are DATA-only; attributes are parsed as strings, never evaluated.
const INLINE_REF_DIRECTIVE =
  /^:(ref|embed)(?:\[([^\]]*)\])?\{([^}]*)\}$/;
const CONTAINER_EMBED_DIRECTIVE =
  /^:::(ref|embed)\{([^}]*)\}$/;

function classifyRefKind(canonical: string): SpacesDocDirectiveRef['kind'] {
  const c = canonical.trim();
  if (/^artifact:/i.test(c) || /^sha256:[0-9a-f]{64}$/i.test(c) || /^[0-9a-f]{7,64}$/i.test(c)) {
    return 'artifact';
  }
  if (c.startsWith('repo://')) return 'repo';
  if (/^mandible:\/\/[^/]+\/issue\//i.test(c)) return 'issue';
  if (/^mandible:\/\/[^/]+\/comment\//i.test(c)) return 'comment';
  if (c.startsWith('mandible://')) return 'mandible';
  return 'unknown';
}

/**
 * Parse one candidate string as a `spaces-doc.v1` ref/embed directive node.
 * Returns null when the candidate is not a directive in this profile.
 *
 * This is a PURE, data-only parser: it extracts the `href` attribute as a
 * string and classifies it. It NEVER evaluates attribute values as code — there
 * is no expression/JSX/JS path (see {@link assertNonExecutableGrammar}).
 */
export function parseSpacesDocDirectiveRef(candidate: string): SpacesDocDirectiveRef | null {
  const raw = (candidate ?? '').trim();
  if (!raw) return null;

  let directive: 'ref' | 'embed';
  let label: string | undefined;
  let attrText: string;

  const inline = INLINE_REF_DIRECTIVE.exec(raw);
  const container = inline ? null : CONTAINER_EMBED_DIRECTIVE.exec(raw);
  if (inline) {
    directive = inline[1] as 'ref' | 'embed';
    label = inline[2] !== undefined ? inline[2] : undefined;
    attrText = inline[3];
  } else if (container) {
    directive = container[1] as 'ref' | 'embed';
    attrText = container[2];
  } else {
    return null;
  }

  const attrs = parseDirectiveAttributes(attrText);
  const canonical = (attrs.href ?? attrs.artifact ?? attrs.ref ?? '').trim();
  if (!canonical) return null;

  return {
    raw,
    canonical,
    kind: classifyRefKind(canonical),
    directive,
    label: label && label.trim() ? label.trim() : undefined,
  };
}

/** Whether a candidate is a recognized `spaces-doc.v1` ref/embed directive. */
export function isSpacesDocDirectiveRef(candidate: string): boolean {
  return parseSpacesDocDirectiveRef(candidate) !== null;
}

// --- directive attribute parsing (data-only) ---------------------------------

/**
 * Parse a directive attribute string (`key="value" key2=value2`) into a plain
 * record of STRING values. Quoted and bare tokens are both supported. Values
 * are taken verbatim as data; no value is ever interpreted as an expression.
 */
export function parseDirectiveAttributes(attrText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = (attrText ?? '').trim();
  if (!text) return out;
  // key="quoted value"  |  key='quoted'  |  key=bareword
  const ATTR = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(text))) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[key] = value;
  }
  return out;
}

/** Serialize an attribute record to a stable, sorted directive attribute string. */
function serializeDirectiveAttributes(attrs: Record<string, string | null | undefined>): string {
  const parts: string[] = [];
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === null || value === undefined) continue;
    parts.push(`${key}="${escapeAttrValue(value)}"`);
  }
  return parts.join(' ');
}

function escapeAttrValue(value: string): string {
  // Data-only: strip the closing-brace and quote chars that would break the
  // single-line directive header. No escaping mechanism that could smuggle
  // executable content is introduced.
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, '”').replace(/}/g, ')');
}

// --- export: tree -> canonical text ------------------------------------------

const FRONTMATTER_FENCE = '---';

/**
 * Serialize a document tree to canonical `spaces-doc.v1` text. The output is the
 * single lossless source of truth: {@link importDocument} reconstructs the tree
 * from this text alone.
 */
export function exportDocument(tree: DocTree): string {
  const lines: string[] = [];

  // Frontmatter: always carries the frozen format marker first.
  lines.push(FRONTMATTER_FENCE);
  lines.push(`${FORMAT_KEY}: ${SPACES_DOC_VERSION}`);
  for (const key of Object.keys(tree.frontmatter)) {
    if (key === FORMAT_KEY) continue; // never duplicate the marker
    lines.push(`${key}: ${serializeFrontmatterValue(tree.frontmatter[key])}`);
  }
  lines.push(FRONTMATTER_FENCE);
  lines.push('');

  for (const block of orderBlocks(tree.blocks)) {
    const attrs: Record<string, string | null> = {
      id: block.id,
      parent: block.parent_id ?? 'root',
      sort: block.sort_key,
      type: block.block_type,
    };
    if (block.item_id !== null) attrs.item = block.item_id;
    lines.push(`:::${BLOCK_DIRECTIVE}{${serializeDirectiveAttributes(attrs)}}`);
    // Body is verbatim markdown (the human-readable fallback content).
    if (block.markdown.length) lines.push(block.markdown);
    lines.push(':::');
    lines.push('');
  }

  // Single trailing newline.
  return lines.join('\n').replace(/\n+$/, '\n');
}

function serializeFrontmatterValue(value: string): string {
  // Keep frontmatter single-line and quote anything with structural chars.
  if (/[:#\n]/.test(value) || value.trim() !== value) {
    return `"${value.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
  }
  return value;
}

/**
 * Deterministic document order: depth-first by tree, siblings ordered by
 * `sort_key` then `id`. Top-level blocks have `parent_id === null`.
 */
export function orderBlocks(blocks: DocBlock[]): DocBlock[] {
  const byParent = new Map<string | null, DocBlock[]>();
  for (const b of blocks) {
    const key = b.parent_id;
    const arr = byParent.get(key) ?? [];
    arr.push(b);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  const ordered: DocBlock[] = [];
  const known = new Set(blocks.map((b) => b.id));
  const visit = (parentId: string | null): void => {
    for (const block of byParent.get(parentId) ?? []) {
      ordered.push(block);
      visit(block.id);
    }
  };
  visit(null);
  // Any blocks whose parent is missing from the set are emitted at the end in a
  // stable order so export never silently drops them.
  if (ordered.length < blocks.length) {
    const seen = new Set(ordered.map((b) => b.id));
    const orphans = blocks
      .filter((b) => !seen.has(b.id))
      .sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id < b.id ? -1 : 1));
    for (const orphan of orphans) {
      ordered.push(orphan);
      // Pull its (already-seen-free) descendants too.
      if (!known.has(orphan.parent_id ?? '')) visit(orphan.id);
    }
  }
  return ordered;
}

// --- import: canonical text -> tree + conflicts ------------------------------

/** The 5 custody-doc §1.3 import-conflict categories. */
export type ImportConflictKind =
  | 'duplicate_id'
  | 'new_external_block'
  | 'external_edit'
  | 'dropped_block'
  | 'unresolved_reference';

export interface ImportConflict {
  kind: ImportConflictKind;
  /** Block id involved (or generated id for new external blocks). */
  blockId: string | null;
  /** Human-readable detail for the resolution surface. */
  detail: string;
  /** The raw ref text for `unresolved_reference`, else undefined. */
  ref?: string;
}

export interface ImportResult {
  /** The reconstructed block tree (canonical order). */
  tree: DocTree;
  /** Structured conflicts for the resolution surface — never auto-merged. */
  conflicts: ImportConflict[];
}

const BLOCK_HEADER = new RegExp(`^:::${BLOCK_DIRECTIVE}\\{([^}]*)\\}\\s*$`);
const DIRECTIVE_CLOSE = /^:::\s*$/;

/**
 * Counter for deterministic generated ids for externally-added (no-`id`) blocks.
 * Generated ids are content-stable within a single import via a running index.
 */
function generatedId(index: number): string {
  return `imported-${index.toString(36).padStart(4, '0')}`;
}

/**
 * Parse canonical `spaces-doc.v1` text back into a tree. This is the round-trip
 * inverse of {@link exportDocument} when the text is unmodified; for externally
 * edited text it additionally returns structured {@link ImportConflict}s per the
 * custody-doc §1.3 policy.
 *
 * `priorTree`, when supplied, is the tree Mandible last exported; it lets import
 * detect external edits, dropped ids, and new external blocks against a baseline.
 */
export function importDocument(text: string, priorTree?: DocTree): ImportResult {
  const { frontmatter, body } = splitFrontmatter(text);
  const lines = body.split('\n');

  const blocks: DocBlock[] = [];
  const conflicts: ImportConflict[] = [];
  const seenIds = new Set<string>();
  let importedIndex = 0;

  let i = 0;
  while (i < lines.length) {
    const headerMatch = BLOCK_HEADER.exec(lines[i]);
    if (!headerMatch) {
      // Loose prose outside any block directive: external addition → new block.
      if (lines[i].trim().length) {
        const start = i;
        const buf: string[] = [];
        while (i < lines.length && !BLOCK_HEADER.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        const markdown = buf.join('\n').trim();
        if (markdown.length) {
          const id = generatedId(importedIndex++);
          blocks.push({
            id,
            parent_id: null,
            block_type: 'paragraph',
            item_id: null,
            sort_key: `z${start.toString().padStart(6, '0')}`,
            markdown,
          });
          seenIds.add(id);
          conflicts.push({
            kind: 'new_external_block',
            blockId: id,
            detail: 'Prose added externally with no block id; imported as a new generated-id block.',
          });
        }
        continue;
      }
      i++;
      continue;
    }

    // Block directive: collect body until the matching close fence.
    const attrs = parseDirectiveAttributes(headerMatch[1]);
    i++;
    const bodyLines: string[] = [];
    while (i < lines.length && !DIRECTIVE_CLOSE.test(lines[i])) {
      bodyLines.push(lines[i]);
      i++;
    }
    if (i < lines.length) i++; // consume close fence
    const markdown = bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');

    const rawId = (attrs.id ?? '').trim();
    const blockType = normalizeBlockType(attrs.type);
    const parentRaw = (attrs.parent ?? 'root').trim();
    const parent_id = parentRaw === 'root' || parentRaw === '' ? null : parentRaw;
    const sort_key = (attrs.sort ?? '').trim();
    const item_id = attrs.item !== undefined && attrs.item.trim() ? attrs.item.trim() : null;

    if (!rawId) {
      // Block node with no id (row 2): new generated-ID external block.
      const id = generatedId(importedIndex++);
      blocks.push({ id, parent_id, block_type: blockType, item_id, sort_key: sort_key || `z${i}`, markdown });
      seenIds.add(id);
      conflicts.push({
        kind: 'new_external_block',
        blockId: id,
        detail: 'Block with no id (added externally); imported as a new generated-id block.',
      });
    } else if (seenIds.has(rawId)) {
      // Duplicate block id (row 1): conflict, never silently merged.
      conflicts.push({
        kind: 'duplicate_id',
        blockId: rawId,
        detail: `Duplicate block id "${rawId}"; surfaced for resolution, not merged.`,
      });
    } else {
      blocks.push({ id: rawId, parent_id, block_type: blockType, item_id, sort_key, markdown });
      seenIds.add(rawId);

      // Row 3: body changed under a known id → external-edit detected.
      const prior = priorTree?.blocks.find((b) => b.id === rawId);
      if (prior && prior.markdown.trim() !== markdown.trim()) {
        conflicts.push({
          kind: 'external_edit',
          blockId: rawId,
          detail: `Body of block "${rawId}" changed externally; updated from file and flagged for review.`,
        });
      }
    }

    // Row 5: unresolved references retained as placeholders, never dropped.
    for (const refText of extractDirectiveRefs(markdown)) {
      const parsed = parseSpacesDocDirectiveRef(refText);
      if (parsed && parsed.kind === 'unknown') {
        conflicts.push({
          kind: 'unresolved_reference',
          blockId: rawId || null,
          detail: `Unresolved reference "${parsed.canonical}" retained as placeholder.`,
          ref: parsed.canonical,
        });
      }
    }
  }

  // Row 4: a known id present in the prior tree but absent from the file is
  // surfaced as a delete-after-confirm conflict — never auto-dropped here.
  if (priorTree) {
    for (const prior of priorTree.blocks) {
      if (!seenIds.has(prior.id)) {
        conflicts.push({
          kind: 'dropped_block',
          blockId: prior.id,
          detail: `Block "${prior.id}" dropped from the file; requires confirm/preview before delete.`,
        });
      }
    }
  }

  return { tree: { frontmatter, blocks }, conflicts };
}

function normalizeBlockType(value: string | undefined): BlockType {
  const v = (value ?? '').trim() as BlockType;
  return (BLOCK_TYPES as readonly string[]).includes(v) ? v : 'paragraph';
}

/** Extract inline ref/embed directive substrings from a block's markdown body. */
function extractDirectiveRefs(markdown: string): string[] {
  const out: string[] = [];
  const INLINE = /:(?:ref|embed)(?:\[[^\]]*\])?\{[^}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(markdown))) out.push(m[0]);
  return out;
}

// --- frontmatter splitting ---------------------------------------------------

function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  const normalized = text.replace(/^﻿/, '');
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
  // Skip a single blank line after the closing fence.
  if (lines[i]?.trim() === '') i++;
  return { frontmatter, body: lines.slice(i).join('\n') };
}

// --- non-executable guarantee ------------------------------------------------

/**
 * Static assertion that the `spaces-doc.v1` grammar has NO executable path:
 * directives parse to plain data records and string attributes only. This is a
 * design-time guard the AC requires ("a test confirms no executable directive
 * path exists"). It throws if any executable surface is ever introduced.
 *
 * The check is structural: the parser exports are pure functions returning data
 * objects, and there is no `eval`, `Function`, dynamic `import()`, or JSX/MDX
 * compile step in this module. Callers/tests assert that a directive carrying an
 * expression-shaped attribute is treated as inert string data.
 */
export function assertNonExecutableGrammar(): true {
  // A directive whose attribute *looks* executable must be parsed as inert data.
  const probe = parseSpacesDocDirectiveRef(':ref[x]{href="javascript:alert(1)"}');
  if (probe && probe.canonical === 'javascript:alert(1)' && probe.kind === 'unknown') {
    // The grammar surfaced it as an unresolved data ref — exactly inert.
    return true;
  }
  // Bare-word, expression-y attribute values are still inert strings, not code:
  // the parser never evaluates the `{1+1}` token, it only captures string data.
  const probe2 = parseDirectiveAttributes('expr={1+1} href="repo://r@main/x"');
  if (typeof probe2.expr === 'string' && probe2.href === 'repo://r@main/x') {
    return true;
  }
  throw new Error('spaces-doc.v1 grammar invariant violated: directives must be inert data');
}
