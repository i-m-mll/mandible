import { useCallback, useMemo } from 'preact/hooks';

import {
  parseResourceRef,
  resourceRefHref,
  displayResourceRef,
  linkifyResourceRefs,
  type ParsedResourceRef,
} from '../../resource-refs';
import { installSpacesDocRefRecognizer } from '../../spaces-doc-refs';
import {
  parseSpacesDoc,
  type ParsedDoc,
  type ParsedDocBlock,
  type ParsedDocRef,
} from '../../spaces/doc-pipeline';
import {
  exportDocument,
  SPACES_DOC_VERSION,
  type DocTree,
  type DocBlock,
  type BlockType,
} from '../../../../src/spaces/serialize';
import type { SpaceBlock } from '../../api';
import { leadingMarkdownFrontmatter, renderMarkdownFrontmatter } from '../../lib/markdownFrontmatter';
import './DocumentRenderer.css';

// Ensure the C6 shared parser recognizes `spaces-doc.v1` directive refs so the
// document path classifies directive refs through the frozen grammar. Idempotent.
installSpacesDocRefRecognizer();

// --- block -> document-tree mapping (consumes C12, owns no grammar) ----------

/**
 * Map a `space_blocks` row set (C11 `SpaceBlock[]`) onto the C12 `DocTree`
 * serialization view. This renderer never re-derives the document text format:
 * it hands the tree to C12's `exportDocument` to produce canonical
 * `spaces-doc.v1` text, then renders that through the C14a pipeline. Block order
 * (`exportDocument` -> `orderBlocks`) is the canonical authority.
 */
export function blocksToDocTree(
  blocks: SpaceBlock[],
  frontmatter: Record<string, string> = {},
): DocTree {
  const docBlocks: DocBlock[] = blocks.map((b) => ({
    id: b.id,
    parent_id: b.parent_id,
    block_type: b.block_type as BlockType,
    item_id: b.item_id,
    sort_key: b.sort_key,
    markdown: b.markdown ?? '',
  }));
  return { frontmatter, blocks: docBlocks };
}

/** An embedded item's resolvable snapshot fields (degrades on detach). */
interface EmbedSnapshot {
  itemId: string | null;
  refType: string | null;
  refId: string | null;
  refUri: string | null;
  title: string | null;
  /**
   * The embedded item's metadata as captured in the snapshot. Finding embeds
   * carry their revision semantics here, so a detached embed still renders with
   * the pinned/latest state it was placed with.
   */
  metadata: Record<string, unknown> | null;
}

function embedSnapshot(block: SpaceBlock | undefined): EmbedSnapshot {
  const snap = (block?.item_snapshot ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const metadata =
    snap.metadata && typeof snap.metadata === 'object' && !Array.isArray(snap.metadata)
      ? (snap.metadata as Record<string, unknown>)
      : null;
  return {
    itemId: block?.item_id ?? str(snap.item_id),
    refType: str(snap.ref_type),
    refId: str(snap.ref_id),
    refUri: str(snap.ref_uri),
    title: str(snap.title),
    metadata,
  };
}

/** The canonical resource ref an embed block points at (snapshot-aware). */
function embedRef(snapshot: EmbedSnapshot): string | null {
  return snapshot.refUri || snapshot.refId || null;
}

// --- rendered document model -------------------------------------------------

/**
 * A renderable document derived from the C14a pipeline. Prose HTML is
 * pipeline-sanitized, then markdown-link resource refs are linkified through C6
 * so both markdown-link refs and directive refs become resolve-affordance
 * placeholders.
 */
export interface RenderedDocument {
  /** Frozen format marker when the document declared one. */
  format: string | null;
  /** Per-block render records in canonical document order. */
  blocks: RenderedBlock[];
  /** Sanitized + linkified HTML for the whole prose body (no block tree). */
  html: string;
  /** Every classified directive ref in document order. */
  refs: ParsedDocRef[];
  /** True when the source declared (or parsed as) the `spaces-doc.v1` format. */
  isSpacesDoc: boolean;
}

export interface RenderedBlock {
  id: string;
  parentId: string | null;
  blockType: BlockType;
  itemId: string | null;
  /** Sanitized + linkified prose HTML (script-free). */
  html: string;
  /** Directive refs found inside this block. */
  refs: ParsedDocRef[];
}

/**
 * Post-process pipeline-sanitized prose HTML so markdown-link resource refs
 * become C6 unresolved-ref placeholders. `linkifyResourceRefs` is DOM-based and
 * builds anchors with `textContent`/`setAttribute`; it re-introduces no markup,
 * so the security guarantee of the C14a pipeline is preserved.
 */
function linkifyProse(html: string): string {
  if (!html) return '';
  return linkifyLegacyArtifactHashRefs(linkifyResourceRefs(html));
}

const LEGACY_ARTIFACT_HASH_REF_PATTERN = /artifact:sha256:[0-9a-f]{64}/gi;

function legacyArtifactHashAnchor(ref: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.className = 'artifact-xref resource-ref__link';
  anchor.href = resourceRefHref(ref);
  anchor.textContent = ref;
  anchor.title = `Resource reference ${ref} (legacy artifact hash)`;
  return anchor;
}

function linkifyLegacyArtifactHashRefs(html: string): string {
  if (typeof document === 'undefined' || !html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;

  for (const anchor of Array.from(container.querySelectorAll('a'))) {
    const text = anchor.textContent?.trim() ?? '';
    const exact = /^artifact:sha256:[0-9a-f]{64}$/i.exec(text)?.[0];
    if (exact && !anchor.getAttribute('href')) {
      anchor.replaceWith(legacyArtifactHashAnchor(exact));
    }
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('a, code, pre, .resource-ref')) return NodeFilter.FILTER_REJECT;
      LEGACY_ARTIFACT_HASH_REF_PATTERN.lastIndex = 0;
      return LEGACY_ARTIFACT_HASH_REF_PATTERN.test(node.nodeValue ?? '')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const textNode of nodes) {
    const text = textNode.nodeValue ?? '';
    LEGACY_ARTIFACT_HASH_REF_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const fragment = document.createDocumentFragment();
    while ((match = LEGACY_ARTIFACT_HASH_REF_PATTERN.exec(text))) {
      const ref = match[0];
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      fragment.appendChild(legacyArtifactHashAnchor(ref));
      lastIndex = match.index + ref.length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.replaceWith(fragment);
  }
  return container.innerHTML;
}

/**
 * Render `spaces-doc.v1` / Markdown TEXT to a {@link RenderedDocument} through
 * the C14a pipeline (the only HTML-producing path) plus C6 linkification.
 *
 * This is the shared text entry point used by BOTH the block-tree renderer and
 * the repo-authoritative document path (artifacts.tsx). Plain Markdown (no
 * frontmatter) renders as a single loose-prose document; `spaces-doc.v1` text
 * renders as an ordered block tree with directive refs surfaced.
 */
export function renderDocumentText(text: string): RenderedDocument {
  const parsed: ParsedDoc = parseSpacesDoc(text ?? '');
  const frontmatter = leadingMarkdownFrontmatter(text ?? '');
  const blocks: RenderedBlock[] = parsed.blocks.map((b: ParsedDocBlock) => ({
    id: b.id,
    parentId: b.parentId,
    blockType: b.blockType,
    itemId: b.itemId,
    html: linkifyProse(b.html),
    refs: b.refs,
  }));
  return {
    format: parsed.format,
    blocks,
    html: `${frontmatter ? renderMarkdownFrontmatter(frontmatter) : ''}${linkifyProse(parsed.html)}`,
    refs: parsed.refs,
    isSpacesDoc: parsed.format === SPACES_DOC_VERSION,
  };
}

/**
 * Render a `space_blocks` row set to a {@link RenderedDocument}. The blocks are
 * mapped to a C12 `DocTree`, serialized to canonical `spaces-doc.v1` text, and
 * rendered through {@link renderDocumentText}. Block identity (id / parent /
 * type / item embed) round-trips through the frozen grammar.
 */
export function renderSpaceBlocks(
  blocks: SpaceBlock[],
  spaceId?: string,
): RenderedDocument {
  const frontmatter: Record<string, string> = spaceId ? { space_id: spaceId } : {};
  const text = exportDocument(blocksToDocTree(blocks, frontmatter));
  return renderDocumentText(text);
}

// --- inline ref placeholder (C6 unresolved-ref UI) ---------------------------

/**
 * One directive-ref placeholder rendered with the shared C6 unresolved-ref UI:
 * starts as a quiet unresolved link/label. No raw ref text is injected as HTML.
 */
function DirectiveRef({ docRef }: { docRef: ParsedDocRef }): JSX.Element {
  const canonical = docRef.canonical;
  const parsed: ParsedResourceRef | null = useMemo(
    () => docRef.resource ?? parseResourceRef(canonical),
    [docRef.resource, canonical],
  );
  const label = docRef.label || (parsed ? parsed.display : displayResourceRef(canonical));
  // Unknown refs (no resolver authority) stay as inert placeholders.
  const href = parsed && parsed.kind !== 'unknown' ? resourceRefHref(canonical) : undefined;

  return (
    <span
      className="spaces-doc-ref"
      data-kind={docRef.kind}
      data-directive={docRef.directive}
      data-state="unresolved"
      data-testid="spaces-doc-ref"
    >
      {href ? (
        <a className="spaces-doc-ref__link" href={href}>
          {label}
        </a>
      ) : (
        <code className="spaces-doc-ref__label">{label}</code>
      )}
    </span>
  );
}

// --- embedded item preview (fixed Preact component, read-only) ---------------

/**
 * Read-only embedded-item preview rendered through a FIXED Preact component (the
 * C14a contract: embeds render via fixed components, never compiled markup). The
 * embed degrades to a resolve-affordance placeholder via the snapshot when the
 * underlying item is unresolved or deleted.
 */
function EmbedBlock({
  block,
  source,
}: {
  block: RenderedBlock;
  source: SpaceBlock | undefined;
}): JSX.Element {
  const snapshot = useMemo(() => embedSnapshot(source), [source]);
  const ref = embedRef(snapshot);
  const parsedRef = useMemo(() => (ref ? parseResourceRef(ref) : null), [ref]);
  const title = snapshot.title || (parsedRef ? parsedRef.display : ref) || snapshot.itemId || 'Embedded item';
  const kind = (snapshot.refType || block.blockType.replace(/_embed$/, '')) || 'reference';

  return (
    <figure
      className="spaces-doc-embed"
      data-block-type={block.blockType}
      data-kind={kind}
      data-testid="spaces-doc-embed"
    >
      <figcaption className="spaces-doc-embed__caption">
        <span className="spaces-doc-embed__kind">{kind}</span>
        {ref ? (
          <DirectiveRef
            docRef={{
              raw: ref,
              canonical: ref,
              directive: 'embed',
              kind: (parsedRef?.kind ?? 'unknown') as ParsedDocRef['kind'],
              label: typeof title === 'string' ? title : undefined,
              resource: parsedRef,
            }}
          />
        ) : (
          <span className="spaces-doc-embed__title">{title}</span>
        )}
      </figcaption>
      {block.html ? (
        <div
          className="spaces-doc-embed__body rendered-markdown"
          // eslint-disable-next-line react/no-danger -- pipeline-sanitized HTML only.
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      ) : (
        <div className="spaces-doc-embed__placeholder">
          Embedded {kind} preview is not available; showing the resolvable reference.
        </div>
      )}
    </figure>
  );
}

// --- block tree rendering ----------------------------------------------------

interface DocBlockNode {
  block: RenderedBlock;
  source: SpaceBlock | undefined;
  children: DocBlockNode[];
}

const EMBED_TYPES = new Set<BlockType>([
  'reference',
  'artifact_embed',
  'issue_embed',
  'comment_embed',
]);

/** Build a parent/child tree from the canonical-ordered flat block list. */
function buildBlockTree(
  blocks: RenderedBlock[],
  sources: Map<string, SpaceBlock>,
): DocBlockNode[] {
  const nodes = new Map<string, DocBlockNode>();
  const roots: DocBlockNode[] = [];
  for (const block of blocks) {
    nodes.set(block.id, { block, source: sources.get(block.id), children: [] });
  }
  for (const block of blocks) {
    const node = nodes.get(block.id)!;
    const parent = block.parentId ? nodes.get(block.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function DocBlockView({
  node,
  collapsed,
  onToggleCollapse,
}: {
  node: DocBlockNode;
  collapsed: Record<string, boolean>;
  onToggleCollapse: (id: string) => void;
}): JSX.Element {
  const { block } = node;
  const isEmbed = EMBED_TYPES.has(block.blockType);
  const hasChildren = node.children.length > 0;
  const isCollapsible = block.blockType === 'heading' && hasChildren;
  const isCollapsed = isCollapsible && !!collapsed[block.id];

  return (
    <div
      className="spaces-doc-block"
      data-block-id={block.id}
      data-block-type={block.blockType}
      data-testid="spaces-doc-block"
    >
      {isCollapsible && (
        <button
          type="button"
          className="spaces-doc-block__toggle"
          aria-expanded={!isCollapsed}
          onClick={() => onToggleCollapse(block.id)}
          data-testid="spaces-doc-block-toggle"
        >
          {isCollapsed ? '▸' : '▾'}
        </button>
      )}
      {isEmbed ? (
        <EmbedBlock block={block} source={node.source} />
      ) : block.html ? (
        <div
          className="spaces-doc-block__prose rendered-markdown"
          // eslint-disable-next-line react/no-danger -- pipeline-sanitized HTML only.
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      ) : null}
      {block.refs.length > 0 && (
        <div className="spaces-doc-block__refs" data-testid="spaces-doc-block-refs">
          {block.refs.map((ref, i) => (
            <DirectiveRef key={`${block.id}:${i}:${ref.canonical}`} docRef={ref} />
          ))}
        </div>
      )}
      {hasChildren && !isCollapsed && (
        <div className="spaces-doc-block__children">
          {node.children.map((child) => (
            <DocBlockView
              key={child.block.id}
              node={child}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pure read-only document body: render a {@link RenderedDocument} as a block
 * tree (when it has blocks) or as a single sanitized prose body (plain
 * Markdown / repo-authoritative documents). Exported for the repo-authoritative
 * document path and for tests.
 */
export function DocumentBody({
  document: doc,
  sources,
  collapsed = {},
  onToggleCollapse,
}: {
  document: RenderedDocument;
  sources?: Map<string, SpaceBlock>;
  collapsed?: Record<string, boolean>;
  onToggleCollapse?: (id: string) => void;
}): JSX.Element {
  const sourceMap = sources ?? new Map<string, SpaceBlock>();
  const tree = useMemo(() => buildBlockTree(doc.blocks, sourceMap), [doc.blocks, sourceMap]);
  const noop = useCallback(() => {}, []);
  const toggle = onToggleCollapse ?? noop;

  // Repo-authoritative Markdown (no blocks) renders directly as one prose body.
  if (doc.blocks.length === 0) {
    return (
      <div className="spaces-doc" data-testid="spaces-document" data-format={doc.format ?? ''}>
        {doc.html ? (
          <div
            className="spaces-doc__prose rendered-markdown"
            // eslint-disable-next-line react/no-danger -- pipeline-sanitized HTML only.
            dangerouslySetInnerHTML={{ __html: doc.html }}
          />
        ) : (
          <div className="spaces-doc__empty">This document is empty.</div>
        )}
        {doc.refs.length > 0 && (
          <div className="spaces-doc__refs" data-testid="spaces-document-refs">
            {doc.refs.map((ref, i) => (
              <DirectiveRef key={`${i}:${ref.canonical}`} docRef={ref} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="spaces-doc" data-testid="spaces-document" data-format={doc.format ?? ''}>
      {tree.map((node) => (
        <DocBlockView
          key={node.block.id}
          node={node}
          collapsed={collapsed}
          onToggleCollapse={toggle}
        />
      ))}
    </div>
  );
}
