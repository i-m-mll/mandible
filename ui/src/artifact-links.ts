const CUSTOM_URI_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+|artifact:sha256:[0-9a-f]{7,64})/gi;
const DIRECT_NAV_SCHEMES = new Set(['http', 'https', 'mailto']);

export function artifactHref(ref: string): string {
  return `#/artifacts?ref=${encodeURIComponent(ref)}`;
}

export function artifactDetailHref(id: string): string {
  return `#/artifacts?artifact=${encodeURIComponent(id)}`;
}

export function isArtifactLikeRef(ref: string): boolean {
  const scheme = schemeForRef(ref);
  if (!scheme) return /^artifact:sha256:[0-9a-f]{7,64}$/i.test(ref);
  return !DIRECT_NAV_SCHEMES.has(scheme);
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
      const ref = trimTrailingPunctuation(match[0]);
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      if (isArtifactLikeRef(ref)) {
        const anchor = document.createElement('a');
        anchor.className = 'artifact-xref';
        anchor.href = artifactHref(ref);
        anchor.textContent = ref;
        anchor.title = `Open artifact reference ${ref}`;
        fragment.appendChild(anchor);
        if (ref.length < match[0].length) {
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
