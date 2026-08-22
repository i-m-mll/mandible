// Read-only Spaces document renderer (umbrella de56ffa, child C14b / issue
// 591e568).
//
// This is the READ-ONLY document view over the `space_blocks` tree (C11). It is
// deliberately NOT an editor (block editing is C14c) and owns no `space_blocks`
// mutation, serialization grammar, or parse/sanitize pipeline — it CONSUMES the
// frozen surfaces of its dependencies:
//
//   - C14a `ui/src/spaces/doc-pipeline.ts`  -> the secure, NON-EXECUTABLE
//     parse/sanitize pipeline. All prose HTML this view renders comes from that
//     pipeline (marked -> DOMPurify); there is no other HTML-producing path, so
//     no document directive can ever execute script (standing AC #2).
//   - C12 `src/spaces/serialize.ts`         -> the frozen `spaces-doc.v1`
//     grammar + `exportDocument`. A `space_blocks` row set is mapped to a
//     `DocTree` and serialized to canonical text, then rendered through the C14a
//     pipeline so block identity + directive refs stay authoritative.
//   - C6 `ui/src/resource-refs.ts`          -> the shared resource-ref parser +
//     `linkifyResourceRefs` unresolved-ref UI. Markdown-link refs in prose AND
//     `:ref`/`:::embed` directive refs are rendered as quiet placeholders;
//     unresolved refs are never silently dropped.
//   - C11 `GET /api/spaces/:id/blocks`      -> the read-only block source.
//   - C10 `SpacesViewShell` mount contract   -> the `document` renderer mount.
//
// SECURITY: this view never injects raw, un-sanitized HTML. Block prose is
// rendered through the C14a pipeline (which sanitizes via DOMPurify) and then
// only re-processed by C6's DOM-based `linkifyResourceRefs`, which builds
// anchors with `textContent`/`setAttribute` and never re-introduces markup. A
// renderer test asserts that a document directive cannot execute script.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

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
  FORMAT_KEY,
  type DocTree,
  type DocBlock,
  type BlockType,
} from '../../../../src/spaces/serialize';
import type { SpaceBlock } from '../../api';
import { acquireSharedSse } from '../../sse-shared';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { leadingMarkdownFrontmatter, renderMarkdownFrontmatter } from '../../lib/markdownFrontmatter';
import type { SpaceRendererMountProps } from './SpacesViewShell';
import {
  documentStorageKey,
  normalizeDocumentViewState,
  reconcileDocumentViewState,
  EMPTY_DOCUMENT_VIEW_STATE,
} from './documentViewState';
import './DocumentRenderer.css';

const SPACE_EVENT_PREFIX = 'space:';

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
  const frontmatter = spaceId ? { space_id: spaceId } : {};
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
  collapsed = EMPTY_DOCUMENT_VIEW_STATE.collapsed,
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

// --- the renderer mount (read-only, fetches blocks) --------------------------

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; blocks: SpaceBlock[] }
  | { status: 'error'; message: string };

/**
 * Read-only block fetch for `GET /api/spaces/:id/blocks`. The renderer reads
 * blocks directly (this is a read path; the C3 typed client owns no block-list
 * helper), parameterized by an injectable `fetchImpl` for tests. It is GET-only:
 * this view never writes block or space state.
 */
async function fetchSpaceBlocks(
  spaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceBlock[]> {
  const response = await fetchImpl(`/api/spaces/${encodeURIComponent(spaceId)}/blocks`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`load blocks for ${spaceId} failed: ${response.status}`);
  }
  const payload = (await response.json()) as { blocks?: SpaceBlock[] };
  return Array.isArray(payload.blocks) ? payload.blocks : [];
}

export interface DocumentRendererProps extends SpaceRendererMountProps {
  /** Test seam: inject a fetch implementation for the read-only block load. */
  fetchImpl?: typeof fetch;
}

/**
 * Read-only Spaces document renderer mount. Registered for the `document`
 * renderer in the C10 shell. It fetches the `space_blocks` tree, renders it
 * through the C14a pipeline + C12 grammar + C6 ref UI, and preserves browser-
 * local collapse state across refetches, SSE reconciliation, and remounts
 * (Dataful-UX contract): SSE `space:*` events refetch blocks but never reset
 * collapse state.
 */
export function DocumentRenderer({
  projectId,
  spaceId,
  fetchImpl,
}: DocumentRendererProps): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [viewState, setViewState] = usePersistedViewState(
    spaceId ? documentStorageKey(projectId, spaceId) : '',
    normalizeDocumentViewState,
    EMPTY_DOCUMENT_VIEW_STATE,
  );
  const fetchRef = useRef(fetchImpl);
  fetchRef.current = fetchImpl;

  const loadBlocks = useCallback(
    async (isReconcile: boolean) => {
      if (!spaceId) {
        setLoad({ status: 'idle' });
        return;
      }
      if (!isReconcile) setLoad({ status: 'loading' });
      try {
        const blocks = await fetchSpaceBlocks(spaceId, fetchRef.current ?? fetch);
        setLoad({ status: 'ready', blocks });
        // Reconcile collapse keys against live block ids without resetting
        // user collapse intent (Dataful-UX: refetch is a reconciliation input).
        setViewState((prior) =>
          reconcileDocumentViewState(prior, blocks.map((b) => b.id)),
        );
      } catch (err) {
        setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [spaceId],
  );

  useEffect(() => {
    void loadBlocks(false);
  }, [loadBlocks]);

  // SSE reconciliation: any `space:*` event refetches blocks as a reconciliation
  // input. Collapse state is preserved across the refetch.
  useEffect(() => {
    if (!spaceId) return;
    const client = acquireSharedSse();
    const unsubscribe = client.on('*', (payload) => {
      if (typeof payload.type === 'string' && payload.type.startsWith(SPACE_EVENT_PREFIX)) {
        void loadBlocks(true);
      }
    });
    // Reconnect resync: refetch after a dropped stream so events missed during
    // the gap are reconciled.
    const offState = client.onState((_state, { reconnected }) => {
      if (reconnected) void loadBlocks(true);
    });
    client.connect();
    return () => {
      unsubscribe();
      offState();
      client.close();
    };
  }, [spaceId, loadBlocks]);

  const onToggleCollapse = useCallback((id: string) => {
    setViewState((prior) => ({
      ...prior,
      collapsed: { ...prior.collapsed, [id]: !prior.collapsed[id] },
    }));
  }, []);

  const rendered = useMemo(
    () => (load.status === 'ready' ? renderSpaceBlocks(load.blocks, spaceId ?? undefined) : null),
    [load, spaceId],
  );
  const sources = useMemo(() => {
    const map = new Map<string, SpaceBlock>();
    if (load.status === 'ready') for (const b of load.blocks) map.set(b.id, b);
    return map;
  }, [load]);

  if (!spaceId) {
    return (
      <div className="spaces-doc-renderer spaces-doc-renderer--empty" data-testid="spaces-document-renderer">
        Select a Space to view its document.
      </div>
    );
  }

  return (
    <div className="spaces-doc-renderer" data-testid="spaces-document-renderer">
      {load.status === 'loading' && (
        <div className="spaces-doc-renderer__status">Loading document…</div>
      )}
      {load.status === 'error' && (
        <div className="spaces-doc-renderer__error">Failed to load document: {load.message}</div>
      )}
      {rendered && (
        <DocumentBody
          document={rendered}
          sources={sources}
          collapsed={viewState.collapsed}
          onToggleCollapse={onToggleCollapse}
        />
      )}
    </div>
  );
}

export default DocumentRenderer;

// Re-export the frozen markers consumers commonly need alongside the renderer.
export { SPACES_DOC_VERSION, FORMAT_KEY };
