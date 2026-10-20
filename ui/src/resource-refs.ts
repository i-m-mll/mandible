// Shared resource-ref parser (Spaces UMBRELLA-PLAN §8).
//
// One parser/linkifier used by the issue renderer, the artifacts UI, and the
// auth review surfaces. It recognizes the canonical Mandible resource-ref forms
// as plain text and as markdown-link hrefs:
//
//   - artifact:<id-or-prefix>       (logical artifact)
//   - artifact-series:<id-or-prefix>[@<version>|@latest]
//   - artifact-version:<id-or-prefix>
//   - artifact-blob:<hash-or-prefix>
//   - repo://<repo>@<ref>/<path>    (repo-relative custody refs)
//   - issue:<id>[#<n>]              (Mandible issue refs; #<n> is a comment ordinal)
//   - comment:<issue>#<comment>     (legacy Mandible comment refs)
//   - auth:<id-or-prefix>           (Mandible auth request refs)
//   - briefing:<id-or-prefix>       (Mandible Briefing refs)
//   - mandible://<repo>/issue/<id>  (app-route entity refs)
//
// It drives an unresolved-reference UI: every recognized ref is linkified with a
// visible placeholder and a resolve affordance instead of being silently
// dropped, resolving against the C2 unified resolver endpoint
// (`/api/spaces/resolve`).
//
// C12 (the `spaces-doc.v1` directive grammar) extends recognition through the
// `registerResourceRefRecognizer` extension point; this module deliberately
// owns only the resource-ref grammar, not directive nodes.

import type { ResolverRefKind, ResolverResult } from '../../src/contracts';
import { parseCommentRefTarget, parseIssueRefTarget } from '../../src/ledger/authored-references';

// --- ref grammar -------------------------------------------------------------

export type ResourceRefKind = 'artifact' | 'repo' | 'mandible' | 'issue' | 'comment' | 'auth' | 'briefing' | 'submission' | 'unknown';

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

export type PreviewableResourceRef =
  | {
      kind: 'issue';
      ref: string;
      repoId?: string;
      comment?: string;
      href: string;
      label: string;
    }
  | {
      kind: 'artifact';
      ref: string;
      href: string;
      label: string;
    };

const DIRECT_NAV_SCHEMES = new Set(['http', 'https', 'mailto']);

const LOGICAL_ARTIFACT_REF = /^artifact:(?!sha256:)([^\s]+)$/i;
const ARTIFACT_SERIES_REF = /^artifact-series:([^@#\s]+)(?:([@#])([^\s]+))?$/i;
const ARTIFACT_VERSION_REF = /^artifact-version:([^\s]+)$/i;
const ARTIFACT_BLOB_REF = /^artifact-blob:([0-9a-f]{7,64})$/i;
const ISSUE_REF = /^issue:([^\s\]]+)$/i;
const COMMENT_REF = /^comment:([^\s\]]+)$/i;
// Auth request ids are global, so the authority has no project qualifier.
const AUTH_REF = /^auth:([^\s\]\/#]+)$/i;
// Briefing ids are global too. Some legacy ids store a `briefing:` prefix, so
// the server link route owns resolution of both id spellings.
const BRIEFING_REF = /^briefing:([^\s\]\/#]+)$/i;
const SUBMISSION_REF = /^submission:([0-9a-f][0-9a-f-]{6,})(?:#([1-9][0-9]*))?$/i;

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

  const logical = LOGICAL_ARTIFACT_REF.exec(raw);
  if (logical) {
    return { raw, canonical: raw, kind: 'artifact', display: compactArtifactRef(raw) };
  }

  const artifactSeries = ARTIFACT_SERIES_REF.exec(raw);
  if (artifactSeries) {
    return { raw, canonical: raw, kind: 'artifact', display: compactArtifactSeriesRef(raw) };
  }

  const artifactVersion = ARTIFACT_VERSION_REF.exec(raw);
  if (artifactVersion) {
    return { raw, canonical: raw, kind: 'artifact', display: compactArtifactVersionRef(raw) };
  }

  const artifactBlob = ARTIFACT_BLOB_REF.exec(raw);
  if (artifactBlob) {
    return { raw, canonical: raw, kind: 'artifact', display: compactArtifactBlobRef(raw) };
  }

  // repo://<repo>@<ref>/<path>
  if (raw.startsWith('repo://')) {
    return { raw, canonical: raw, kind: 'repo', display: raw };
  }

  // issue:<id> and comment:<issue>#<comment> inline refs. Keep the authority
  // opaque here; the resolver owns validation and entity lookup.
  if (ISSUE_REF.test(raw)) {
    return { raw, canonical: raw, kind: 'issue', display: compactIssueRef(raw) };
  }
  if (COMMENT_REF.test(raw)) {
    return { raw, canonical: raw, kind: 'comment', display: compactCommentRef(raw) };
  }
  if (AUTH_REF.test(raw)) {
    return { raw, canonical: raw, kind: 'auth', display: compactAuthRef(raw) };
  }
  if (BRIEFING_REF.test(raw)) {
    return { raw, canonical: raw, kind: 'briefing', display: compactBriefingRef(raw) };
  }
  if (SUBMISSION_REF.test(raw)) {
    return { raw, canonical: raw, kind: 'submission', display: compactSubmissionRef(raw) };
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

export function compactArtifactVersionRef(ref: string, length = 7): string {
  return ref.replace(
    /^artifact-version:(.+)$/i,
    (_match, id: string) => `artifact-version:${compactLongIdSegments(id, length)}`,
  );
}

export function compactArtifactSeriesRef(ref: string, length = 12): string {
  return ref.replace(
    /^artifact-series:([^@#\s]+)(.*)$/i,
    (_match, id: string, selector: string) =>
      `artifact-series:${compactLongIdSegments(id, length)}${selector ?? ''}`,
  );
}

export function compactArtifactBlobRef(ref: string, length = 12): string {
  return ref.replace(
    /^artifact-blob:(.+)$/i,
    (_match, id: string) => `artifact-blob:${compactLongIdSegments(id, length)}`,
  );
}

export function compactLongIdSegments(value: string, length = 7): string {
  return value
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      (segment) => segment.slice(0, 8).toLowerCase(),
    )
    .replace(/[0-9a-f]{12,64}/gi, (segment) =>
      segment.slice(0, Math.max(7, Math.min(length, segment.length))).toLowerCase(),
    );
}

export function compactIssueRef(ref: string): string {
  return ref.replace(
    /^issue:(.+)$/i,
    (_match, id: string) => `issue:${compactLongIdSegments(id)}`,
  );
}

export function compactCommentRef(ref: string): string {
  return ref.replace(
    /^comment:(.+)$/i,
    (_match, id: string) => `comment:${compactLongIdSegments(id)}`,
  );
}

export function compactAuthRef(ref: string): string {
  return ref.replace(
    /^auth:(.+)$/i,
    (_match, id: string) => `auth:${compactLongIdSegments(id)}`,
  );
}

export function compactBriefingRef(ref: string): string {
  return ref.replace(
    /^briefing:(.+)$/i,
    (_match, id: string) => `briefing:${compactLongIdSegments(id)}`,
  );
}

export function compactSubmissionRef(ref: string): string {
  return ref.replace(
    /^submission:([0-9a-f-]+)(#[1-9][0-9]*)?$/i,
    (_match, id: string, ordinal: string | undefined) =>
      `submission:${id.slice(0, Math.min(7, id.length)).toLowerCase()}${ordinal ?? ''}`,
  );
}

/** Compact human-friendly label for a ref; passthrough for unrecognized text. */
export function displayResourceRef(ref: string): string {
  const parsed = parseResourceRef(ref);
  return parsed ? parsed.display : ref.trim();
}

// --- nav hrefs ---------------------------------------------------------------

export function resourceRefHref(ref: string): string {
  const issue = issueAuthorityFromResourceRef(ref) ?? commentAuthorityFromResourceRef(ref);
  if (issue) {
    const params = new URLSearchParams({ issue: issue.ref });
    if (issue.repoId) params.set('repo', issue.repoId);
    if (issue.comment) params.set('comment', issue.comment);
    return `#/issues?${params.toString()}`;
  }
  const auth = AUTH_REF.exec(ref.trim());
  if (auth) {
    // The auth view resolves prefixes; inbound refs pass through untouched so a
    // full id keeps its power to disambiguate.
    return `#/auth?request=${encodeURIComponent(auth[1])}`;
  }
  if (BRIEFING_REF.test(ref.trim())) {
    // The web link route resolves typed refs and legacy prefixed ids to the
    // canonical id before opening the Briefing view.
    return `/briefing/${encodeURIComponent(ref.trim())}`;
  }
  if (SUBMISSION_REF.test(ref.trim())) {
    return `/r/submission/${encodeURIComponent(ref.trim())}`;
  }
  const series = ARTIFACT_SERIES_REF.exec(ref.trim());
  if (series) {
    const seriesRef = `artifact-series:${series[1]}`;
    const selector = series[3]?.toLowerCase();
    if (selector && selector !== 'latest' && /^\d+$/.test(selector)) {
      return versionDetailHref(seriesRef, Number(selector));
    }
    return seriesDetailHref(selector === 'latest' ? `${seriesRef}@latest` : seriesRef);
  }
  return `#/artifacts?ref=${encodeURIComponent(ref)}`;
}

type IssueAuthority = { ref: string; repoId?: string; comment?: string };

function issueParts(value: string): IssueAuthority | null {
  const target = parseIssueRefTarget(value.trim().replace(/^issue:/i, ''));
  if (!target) return null;
  return {
    ref: target.issue,
    ...(target.project ? { repoId: target.project } : {}),
    ...(target.ordinal !== undefined ? { comment: String(target.ordinal) } : {}),
  };
}

/** Issue route authority for a legacy `comment:<issue>#<comment>` ref. */
function commentAuthorityFromResourceRef(value: string): IssueAuthority | null {
  const parsed = parseResourceRef(value);
  if (parsed?.kind !== 'comment') return null;
  const target = parseCommentRefTarget(parsed.canonical.replace(/^comment:/i, ''));
  if (!target) return null;
  return {
    ref: target.issue,
    ...(target.project ? { repoId: target.project } : {}),
    comment: target.comment,
  };
}

/** Resolve every canonical issue resource form through the shared grammar. */
export function issueAuthorityFromResourceRef(value: string): IssueAuthority | null {
  const parsed = parseResourceRef(value);
  if (!parsed) return null;
  if (parsed.kind === 'issue') return issueParts(parsed.canonical);
  if (parsed.kind !== 'mandible') return null;
  try {
    const url = new URL(parsed.canonical);
    const route = `${url.hostname}${url.pathname}`.replace(/^\/+/, '');
    const entityMatch = route.match(/^([^/]+)\/issue\/([^/]+)$/);
    if (entityMatch) {
      return {
        repoId: decodeURIComponent(entityMatch[1]),
        ref: decodeURIComponent(entityMatch[2]),
      };
    }
    if (route !== 'issues') return null;
    const ref = url.searchParams.get('issue');
    if (!ref) return null;
    return { ref, repoId: url.searchParams.get('repo') ?? undefined };
  } catch {
    return null;
  }
}

/**
 * Resolve a rendered anchor to a previewable resource without introducing a
 * second link grammar. The resource wrapper is authoritative when present;
 * ordinary issue-route anchors are admitted through the same issue authority.
 */
export function previewableResourceFromAnchor(anchor: HTMLAnchorElement): PreviewableResourceRef | null {
  const wrapped = anchor.closest<HTMLElement>('[data-resource-ref]')?.dataset.resourceRef;
  if (wrapped) {
    const parsed = parseResourceRef(wrapped);
    const href = anchor.getAttribute('href') ?? anchor.href;
    const label = anchor.textContent?.trim() || parsed?.display || wrapped;
    const wrappedIssue = issueAuthorityFromResourceRef(wrapped);
    if (wrappedIssue) return { kind: 'issue', ...wrappedIssue, href, label };
    if (parsed?.kind === 'artifact') return { kind: 'artifact', ref: parsed.canonical, href, label };
  }

  const rawHref = anchor.getAttribute('href') ?? '';
  const directIssue = issueAuthorityFromResourceRef(rawHref);
  if (directIssue) {
    return {
      kind: 'issue',
      ...directIssue,
      href: rawHref,
      label: anchor.textContent?.trim() || directIssue.ref,
    };
  }
  try {
    const url = new URL(rawHref, window.location.href);
    const [path, query = ''] = url.hash.replace(/^#/, '').split('?');
    const route = path.replace(/^\//, '');
    const params = new URLSearchParams(query);
    if (route === 'issues') {
      const ref = params.get('issue');
      if (!ref) return null;
      return {
        kind: 'issue',
        ref,
        repoId: params.get('repo') ?? undefined,
        href: rawHref,
        label: anchor.textContent?.trim() || ref,
      };
    }
    if (route !== 'artifacts') return null;
    const ref = params.get('ref') ?? params.get('series') ?? params.get('artifact');
    if (!ref) return null;
    return {
      kind: 'artifact',
      ref,
      href: rawHref,
      label: anchor.textContent?.trim() || displayResourceRef(ref),
    };
  } catch {
    return null;
  }
}

export function artifactDetailHref(id: string): string {
  const trimmed = id.trim();
  const oldHash = /^artifact:sha256:([0-9a-f]{64})$/i.exec(trimmed)?.[1];
  if (oldHash) return resourceRefHref(`artifact-blob:${oldHash}`);
  if (/^artifact(?:-version|-blob)?:/i.test(trimmed)) return resourceRefHref(trimmed);
  return `#/artifacts?artifact=${encodeURIComponent(trimmed)}`;
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

export type { ResolverRefKind, ResolverResult };

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

const CUSTOM_BRACKET_PATTERN = /\[((?:artifact|artifact-series|artifact-version|artifact-blob|repo|mandible|issue|comment|auth|briefing|submission):[^\]\s]+)\]/gi;

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, '');
}

// `[artifact:<scheme>://…]` bracket syntax: the leading `artifact:` is a
// bracket wrapper, not part of the ref, when `<inner>` is itself a non-artifact
// `scheme://` URI (e.g. `[artifact:repo://…]`, `[artifact:feedbax://…]`). The
// ref is the unwrapped inner so the display label and href match the canonical
// resource form rather than the doubly-prefixed `artifact:repo://…`. Logical
// artifact refs (`[artifact:<id>]`) are left intact for the built-in grammar,
// which keeps the `artifact:` authority.
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
