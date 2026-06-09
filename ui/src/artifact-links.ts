const CUSTOM_URI_PATTERN = /\[artifact:([^\]\s]+)\]|\b(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+|artifact:sha256:[0-9a-f]{7,64}|artifact:[0-9a-f]{7,64}|sha256:[0-9a-f]{7,64})/gi;
const DIRECT_NAV_SCHEMES = new Set(['http', 'https', 'mailto']);
const SHA_ARTIFACT_REF = /^(?:artifact(?::|:\/\/)sha256[:/]|sha256[:/])([0-9a-f]{7,64})$/i;
const FULL_SHA_ARTIFACT_REF = /^(?:artifact(?::|:\/\/)sha256[:/]|sha256[:/])([0-9a-f]{64})$/i;
const COMPACT_SHA_ARTIFACT_REF = /^artifact:([0-9a-f]{7,64})$/i;

export function artifactHref(ref: string): string {
  return `#/artifacts?ref=${encodeURIComponent(ref)}`;
}

export function artifactDetailHref(id: string): string {
  return `#/artifacts?artifact=${encodeURIComponent(id)}`;
}

export function isArtifactLikeRef(ref: string): boolean {
  const scheme = schemeForRef(ref);
  if (!scheme) return /^artifact:sha256:[0-9a-f]{7,64}$/i.test(ref);
  if (scheme === 'artifact') {
    return SHA_ARTIFACT_REF.test(ref) || COMPACT_SHA_ARTIFACT_REF.test(ref);
  }
  if (scheme === 'sha256') return /^sha256:[0-9a-f]{7,64}$/i.test(ref);
  return !DIRECT_NAV_SCHEMES.has(scheme);
}

export function compactArtifactRef(hash: string, length = 12): string {
  return `artifact:${hash.slice(0, Math.max(7, Math.min(length, hash.length))).toLowerCase()}`;
}

export function displayArtifactRef(ref: string): string {
  const trimmed = ref.trim();
  const sha = SHA_ARTIFACT_REF.exec(trimmed);
  if (sha) return compactArtifactRef(sha[1], sha[1].length >= 12 ? 12 : sha[1].length);
  const compact = COMPACT_SHA_ARTIFACT_REF.exec(trimmed);
  if (compact) return compactArtifactRef(compact[1], compact[1].length);
  return trimmed;
}

function isVerboseArtifactHashRef(ref: string): boolean {
  return FULL_SHA_ARTIFACT_REF.test(ref.trim());
}

export function linkifyArtifactRefs(html: string): string {
  if (typeof document === 'undefined' || !html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  rewriteExistingLinks(container);
  linkifyTextNodes(container);
  return container.innerHTML;
}

function rewriteExistingLinks(container: HTMLElement): void {
  for (const anchor of Array.from(container.querySelectorAll('a'))) {
    const href = anchor.getAttribute('href') ?? anchor.textContent?.trim() ?? '';
    if (!isArtifactLikeRef(href)) continue;
    anchor.setAttribute('href', artifactHref(href));
    anchor.classList.add('artifact-xref');
    anchor.setAttribute('title', `Open artifact reference ${href}`);
    const text = anchor.textContent?.trim() ?? '';
    if (!text || text === href || isVerboseArtifactHashRef(text)) {
      anchor.textContent = displayArtifactRef(href);
    }
  }
}

function linkifyTextNodes(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre')) return NodeFilter.FILTER_REJECT;
      CUSTOM_URI_PATTERN.lastIndex = 0;
      return CUSTOM_URI_PATTERN.test(node.nodeValue ?? '')
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
    CUSTOM_URI_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const fragment = document.createDocumentFragment();
    while ((match = CUSTOM_URI_PATTERN.exec(text))) {
      const raw = match[1] ?? match[0];
      const ref = trimTrailingPunctuation(raw);
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      if (isArtifactLikeRef(ref)) {
        const anchor = document.createElement('a');
        anchor.className = 'artifact-xref';
        anchor.href = artifactHref(ref);
        anchor.textContent = displayArtifactRef(ref);
        anchor.title = `Open artifact reference ${ref}`;
        fragment.appendChild(anchor);
        if (!match[1] && ref.length < match[0].length) {
          fragment.appendChild(document.createTextNode(match[0].slice(ref.length)));
        }
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

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, '');
}

function schemeForRef(ref: string): string | null {
  const match = ref.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : null;
}
