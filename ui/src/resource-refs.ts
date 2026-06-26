// Shared resource-ref parser (Spaces UMBRELLA-PLAN §8).
//
// One parser/linkifier used by the issue renderer, the artifacts UI, and the
// auth review surfaces. It recognizes the canonical Mandible resource-ref forms
// as plain text and as markdown-link hrefs:
//
//   - artifact:sha256:<64hex>       (canonical artifact id form)
//   - artifact:<7-64hex>            (compact artifact ref form)
//   - <7-64hex> / sha256:<64hex>    (bare hash forms)
//   - repo://<repo>@<ref>/<path>    (repo-relative custody refs)
//   - mandible://<repo>/issue/<id>  (app-route entity refs)
//
// It drives an unresolved-reference UI: every recognized ref is linkified with a
// visible placeholder and a resolve affordance instead of being silently
// dropped, resolving against the C2 unified resolver endpoint
// (`/api/spaces/resolve`).
//
// HISTORICAL BUG (fixed here): the previous `COMPACT_SHA_ARTIFACT_REF =
// /^artifact:([0-9a-f]{7,64})$/i` could not match `artifact:sha256:<hash>` —
// the `sha256:` prefix fails the `[0-9a-f]` character class — so canonical
// artifact ids were never linkified. The parser below recognizes both forms.
//
// C12 (the `spaces-doc.v1` directive grammar) extends recognition through the
// `registerResourceRefRecognizer` extension point; this module deliberately
// owns only the resource-ref grammar, not directive nodes.

// --- ref grammar -------------------------------------------------------------

export type ResourceRefKind = 'artifact' | 'repo' | 'mandible' | 'issue' | 'comment' | 'unknown';

export interface ParsedResourceRef {
  /** The original matched ref text (trimmed of trailing punctuation). */
  raw: string;
  /** The canonical ref string used as resolver authority (href authority). */
  canonical: string;
  /** Coarse ref kind for navigation/affordance selection. */
  kind: ResourceRefKind;
  /** A compact, human-friendly display label for the ref. */
  display: string;
}

const DIRECT_NAV_SCHEMES = new Set(['http', 'https', 'mailto']);

// `artifact:sha256:<hash>` (canonical id) OR compact `artifact:<7-64hex>`.
const ARTIFACT_SHA256_REF = /^artifact:sha256:([0-9a-f]{64})$/i;
const COMPACT_ARTIFACT_REF = /^artifact:([0-9a-f]{7,64})$/i;
const BARE_SHA_REF = /^[0-9a-f]{7,64}$/i;
const BARE_SHA256_REF = /^sha256:([0-9a-f]{64})$/i;

/**
 * A recognizer turns a candidate ref string into a ParsedResourceRef, or null
 * if it does not own the form. Recognizers are tried in registration order;
 * built-in recognizers run last so extensions (e.g. C12 directive refs) can
 * claim a form first.
 */
export type ResourceRefRecognizer = (candidate: string) => ParsedResourceRef | null;

const extensionRecognizers: ResourceRefRecognizer[] = [];

/**
 * Grammar-extension point. C12's `spaces-doc.v1` directive grammar registers
 * additional recognizers here without modifying this module's built-in forms.
 * Returns an unregister function.
 */
export function registerResourceRefRecognizer(recognizer: ResourceRefRecognizer): () => void {
  extensionRecognizers.push(recognizer);
  return () => {
    const idx = extensionRecognizers.indexOf(recognizer);
    if (idx >= 0) extensionRecognizers.splice(idx, 1);
  };
}

/** Test seam: drop all registered extension recognizers. */
export function __resetResourceRefRecognizers(): void {
  extensionRecognizers.length = 0;
}

function schemeForRef(ref: string): string | null {
  const match = ref.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : null;
}

function recognizeBuiltin(candidate: string): ParsedResourceRef | null {
  const raw = candidate.trim();
  if (!raw) return null;

  // artifact:sha256:<64hex> — canonical artifact id form (the historically
  // unmatched case). Canonical href authority is the full id.
  const sha256 = ARTIFACT_SHA256_REF.exec(raw);
  if (sha256) {
    return { raw, canonical: raw, kind: 'artifact', display: compactArtifactRef(sha256[1]) };
  }

  // artifact:<7-64hex> — compact artifact ref form.
  const compact = COMPACT_ARTIFACT_REF.exec(raw);
  if (compact) {
    return { raw, canonical: raw, kind: 'artifact', display: compactArtifactRef(compact[1]) };
  }

  // sha256:<64hex> bare-hash form — normalize display, keep canonical authority.
  const bareSha256 = BARE_SHA256_REF.exec(raw);
  if (bareSha256) {
    return { raw, canonical: raw, kind: 'artifact', display: compactArtifactRef(bareSha256[1]) };
  }

  // bare <7-64hex> hash.
  if (BARE_SHA_REF.test(raw)) {
    return { raw, canonical: raw, kind: 'artifact', display: compactArtifactRef(raw) };
  }

  // repo://<repo>@<ref>/<path>
  if (raw.startsWith('repo://')) {
    return { raw, canonical: raw, kind: 'repo', display: raw };
  }

  // mandible://<repo>/issue/<id> and other mandible app-route refs.
  if (raw.startsWith('mandible://')) {
    return { raw, canonical: raw, kind: 'mandible', display: raw };
  }

  // Any other non-direct-navigation scheme:// ref is treated as a resolvable
  // resource ref rather than a literal hyperlink.
  const scheme = schemeForRef(raw);
  if (scheme && raw.includes('://') && !DIRECT_NAV_SCHEMES.has(scheme)) {
    return { raw, canonical: raw, kind: 'unknown', display: raw };
  }

  return null;
}

/**
 * Parse a single candidate ref string into a structured descriptor, trying
 * registered extension recognizers before the built-in resource-ref grammar.
 * Returns null when the candidate is not a recognized resource ref.
 */
export function parseResourceRef(candidate: string): ParsedResourceRef | null {
  const raw = (candidate ?? '').trim();
  if (!raw) return null;
  for (const recognizer of extensionRecognizers) {
    const parsed = recognizer(raw);
    if (parsed) return parsed;
  }
  return recognizeBuiltin(raw);
}

/** Whether a candidate string is a recognized resource ref. */
export function isResourceRef(candidate: string): boolean {
  return parseResourceRef(candidate) !== null;
}

// --- display helpers ---------------------------------------------------------

export function compactArtifactRef(hash: string, length = 12): string {
  const bare = hash.trim().replace(/^artifact:/i, '').replace(/^sha256:/i, '');
  const clipped = bare.slice(0, Math.max(7, Math.min(length, bare.length))).toLowerCase();
  return `artifact:${clipped}`;
}

/** Compact human-friendly label for a ref; passthrough for unrecognized text. */
export function displayResourceRef(ref: string): string {
  const parsed = parseResourceRef(ref);
  return parsed ? parsed.display : ref.trim();
}

// --- nav hrefs ---------------------------------------------------------------

export function resourceRefHref(ref: string): string {
  // The artifacts route resolves a compact `artifact:<7-64hex>` ref by its bare
  // hash (the historical `#/artifacts?ref=<hash>` contract). Canonical id and
  // scheme forms (`artifact:sha256:<hash>`, `repo://…`, `mandible://…`) keep
  // their full ref as the resolver authority.
  const compact = COMPACT_ARTIFACT_REF.exec(ref.trim());
  const navRef = compact ? compact[1] : ref;
  return `#/artifacts?ref=${encodeURIComponent(navRef)}`;
}

export function artifactDetailHref(id: string): string {
  return `#/artifacts?artifact=${encodeURIComponent(id)}`;
}

export function seriesDetailHref(ref: string): string {
  return `#/artifacts?series=${encodeURIComponent(ref)}`;
}

export function versionDetailHref(ref: string, versionNo: number): string {
  const params = new URLSearchParams({
    series: ref,
    version: String(versionNo),
  });
  return `#/artifacts?${params.toString()}`;
}

// --- C2 resolver -------------------------------------------------------------

export type ResolverRefKind = 'issue' | 'comment' | 'artifact' | 'mandible' | 'repo' | 'unknown';

export interface ResolverResult {
  ref: string;
  kind: ResolverRefKind;
  resolved: boolean;
  entity: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  error?: string;
}

/**
 * Resolve a resource ref against the C2 unified resolver endpoint. The endpoint
 * is read-only (GET) and resolution-only; this module never mutates ledger or
 * space state.
 */
export async function resolveResourceRef(
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolverResult> {
  const path = `/api/spaces/resolve?ref=${encodeURIComponent(ref)}`;
  const response = await fetchImpl(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`resolve ${ref} failed: ${response.status}`);
  }
  const payload = (await response.json()) as { resolution?: ResolverResult } | ResolverResult;
  const resolution =
    payload && typeof payload === 'object' && 'resolution' in payload && payload.resolution
      ? (payload as { resolution: ResolverResult }).resolution
      : (payload as ResolverResult);
  return resolution;
}

// --- linkify -----------------------------------------------------------------

const CUSTOM_BRACKET_PATTERN = /\[((?:artifact|repo|mandible):[^\]\s]+)\]/gi;

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, '');
}

// `[artifact:<scheme>://…]` bracket syntax: the leading `artifact:` is a
// bracket wrapper, not part of the ref, when `<inner>` is itself a non-artifact
// `scheme://` URI (e.g. `[artifact:repo://…]`, `[artifact:feedbax://…]`). The
// ref is the unwrapped inner so the display label and href match the canonical
// resource form rather than the doubly-prefixed `artifact:repo://…`. Compact /
// canonical artifact refs (`[artifact:<hex>]`, `[artifact:sha256:<hex>]`) are
// left intact for the built-in grammar, which keeps the `artifact:` authority.
function unwrapBracketRef(ref: string): string {
  const inner = ref.replace(/^artifact:/i, '');
  if (inner === ref) return ref;
  if (inner.includes('://') && schemeForRef(inner) !== 'artifact') return inner;
  return ref;
}

/**
 * Linkify recognized resource refs in an HTML fragment. Existing anchors whose
 * href/text is a resource ref are rewritten; bracketed inline refs in text are
 * converted to anchors. Each linkified ref is rendered in the unresolved state
 * with a resolve affordance so refs are never silently dropped.
 *
 * Safety: all anchors/affordances are built with DOM APIs and `textContent` /
 * `setAttribute`, never by injecting raw ref text as HTML, and hrefs are always
 * internal `#/artifacts?ref=` hashes. No untrusted markup is produced.
 */
export function linkifyResourceRefs(html: string): string {
  if (typeof document === 'undefined' || !html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  rewriteExistingLinks(container);
  linkifyTextNodes(container);
  return container.innerHTML;
}

/**
 * Build a quiet resource-ref anchor in the unresolved state, wrapped in a single
 * inline `<span>`. Retry/repair controls are reserved for actual failed lookup
 * surfaces rather than every normal ref.
 */
function buildRefElement(parsed: ParsedResourceRef, labelOverride?: string): HTMLSpanElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'resource-ref resource-ref--unresolved';
  wrapper.setAttribute('data-resource-ref', parsed.canonical);
  wrapper.setAttribute('data-resource-kind', parsed.kind);
  wrapper.setAttribute('data-ref-state', 'unresolved');

  const anchor = document.createElement('a');
  anchor.className = 'artifact-xref resource-ref__link';
  // Canonical href authority is the resolver-nav hash; the visible label may
  // differ but the href is the authority.
  anchor.href = resourceRefHref(parsed.canonical);
  anchor.textContent = labelOverride && labelOverride.trim() ? labelOverride : parsed.display;
  anchor.title = `Resource reference ${parsed.canonical} (unresolved)`;
  wrapper.appendChild(anchor);

  return wrapper;
}

function rewriteExistingLinks(container: HTMLElement): void {
  for (const anchor of Array.from(container.querySelectorAll('a'))) {
    // Markdown-link hrefs are the resolution authority; fall back to text.
    const href = anchor.getAttribute('href') ?? anchor.textContent?.trim() ?? '';
    const parsed = parseResourceRef(href);
    if (!parsed) continue;
    const label = anchor.textContent?.trim() ?? '';
    const replacement = buildRefElement(
      parsed,
      label && label !== href && label !== parsed.canonical ? label : undefined,
    );
    anchor.replaceWith(replacement);
  }
}

function linkifyTextNodes(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre, .resource-ref')) return NodeFilter.FILTER_REJECT;
      CUSTOM_BRACKET_PATTERN.lastIndex = 0;
      return CUSTOM_BRACKET_PATTERN.test(node.nodeValue ?? '')
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
    CUSTOM_BRACKET_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const fragment = document.createDocumentFragment();
    while ((match = CUSTOM_BRACKET_PATTERN.exec(text))) {
      const ref = unwrapBracketRef(trimTrailingPunctuation(match[1]));
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const parsed = parseResourceRef(ref);
      if (parsed) {
        fragment.appendChild(buildRefElement(parsed));
      } else {
        fragment.appendChild(document.createTextNode(match[0]));
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.replaceWith(fragment);
  }
}

// --- unresolved-reference UI behavior ----------------------------------------

export interface AttachResolutionOptions {
  /** Resolver implementation; defaults to the C2 endpoint resolver. */
  resolve?: (ref: string) => Promise<ResolverResult>;
}

function markWrapperState(wrapper: HTMLElement, state: 'resolved' | 'error', detail: string): void {
  wrapper.classList.remove('resource-ref--unresolved');
  wrapper.classList.add(state === 'resolved' ? 'resource-ref--resolved' : 'resource-ref--error');
  wrapper.setAttribute('data-ref-state', state);
  const anchor = wrapper.querySelector('a.resource-ref__link');
  if (anchor) anchor.setAttribute('title', detail);
  const button = wrapper.querySelector('button.resource-ref__resolve');
  if (button) button.remove();
}

/**
 * Wire resolve affordances inside a rendered container to the C2 resolver. Each
 * resolve button resolves its ref and updates the placeholder to a resolved or
 * error state; on success the ref is no longer "unresolved". Returns a detach
 * function. Idempotent per container (re-attach replaces the handler).
 */
export function attachResourceRefResolution(
  container: HTMLElement,
  options: AttachResolutionOptions = {},
): () => void {
  const resolve = options.resolve ?? ((ref: string) => resolveResourceRef(ref));
  const handler = async (event: Event): Promise<void> => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest?.('button.resource-ref__resolve') as HTMLButtonElement | null;
    if (!button || !container.contains(button)) return;
    event.preventDefault();
    const ref = button.getAttribute('data-resolve-ref') ?? '';
    const wrapper = button.closest('.resource-ref') as HTMLElement | null;
    if (!wrapper || !ref) return;
    button.disabled = true;
    wrapper.setAttribute('data-ref-state', 'resolving');
    try {
      const result = await resolve(ref);
      if (result.resolved) {
        markWrapperState(wrapper, 'resolved', `Resolved ${ref} (${result.kind})`);
      } else {
        markWrapperState(wrapper, 'error', result.error ? `Unresolved: ${result.error}` : `Unresolved: ${ref}`);
      }
    } catch (error) {
      wrapper.setAttribute('data-ref-state', 'unresolved');
      button.disabled = false;
      const anchor = wrapper.querySelector('a.resource-ref__link');
      if (anchor) anchor.setAttribute('title', `Resolve failed: ${String(error)}`);
    }
  };
  container.addEventListener('click', handler);
  return () => container.removeEventListener('click', handler);
}

// --- backward-compatible aliases ---------------------------------------------
// Existing call sites import these names from the former `artifact-links`
// module; preserved here so migration is a pure import-path swap.

export const artifactHref = resourceRefHref;
export const isArtifactLikeRef = isResourceRef;
export const displayArtifactRef = displayResourceRef;
export const linkifyArtifactRefs = linkifyResourceRefs;
