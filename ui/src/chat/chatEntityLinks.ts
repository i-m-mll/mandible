import type { ChatEntityClickAction } from '../../../src/contracts';

export type ChatPreviewTarget = {
  kind: 'issue';
  ref: string;
  repoId?: string;
  href: string;
  label: string;
};

export type ChatPreviewTargetResolver = (anchor: HTMLAnchorElement) => ChatPreviewTarget | null;

const ISSUE_REF_PATTERN = /\[issue:([^\]\s]+)\]/gi;

function issueParts(ref: string): { repoId?: string; issueId: string } | null {
  const value = ref.trim().replace(/^issue:/i, '');
  if (!value) return null;
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1
    ? { repoId: value.slice(0, slash), issueId: value.slice(slash + 1) }
    : { issueId: value };
}

export function issuePreviewTargetFromAnchor(anchor: HTMLAnchorElement): ChatPreviewTarget | null {
  const resourceRef = anchor.closest<HTMLElement>('[data-resource-ref]')?.dataset.resourceRef;
  if (resourceRef?.toLowerCase().startsWith('issue:')) {
    const parts = issueParts(resourceRef);
    if (!parts) return null;
    return {
      kind: 'issue',
      ref: parts.issueId,
      repoId: parts.repoId,
      href: anchor.getAttribute('href') ?? anchor.href,
      label: anchor.textContent?.trim() || parts.issueId,
    };
  }

  const rawHref = anchor.getAttribute('href') ?? '';
  try {
    const url = new URL(rawHref, window.location.href);
    if (url.protocol === 'mandible:') {
      const match = `${url.hostname}${url.pathname}`.match(/^([^/]+)\/issue\/([^/]+)$/);
      if (!match) return null;
      return {
        kind: 'issue',
        ref: decodeURIComponent(match[2]),
        repoId: decodeURIComponent(match[1]),
        href: rawHref,
        label: anchor.textContent?.trim() || decodeURIComponent(match[2]),
      };
    }
    const hash = url.hash.replace(/^#/, '');
    const [path, query = ''] = hash.split('?');
    if (path.replace(/^\//, '') !== 'issues') return null;
    const params = new URLSearchParams(query);
    const issueId = params.get('issue');
    if (!issueId) return null;
    return {
      kind: 'issue',
      ref: issueId,
      repoId: params.get('repo') ?? undefined,
      href: rawHref,
      label: anchor.textContent?.trim() || issueId,
    };
  } catch {
    return null;
  }
}

export function chatEntityLinkAction(
  defaultAction: ChatEntityClickAction,
  platform: 'mac' | 'other',
  modifiers: { metaKey: boolean; ctrlKey: boolean },
): ChatEntityClickAction {
  const alternate = platform === 'mac' ? modifiers.metaKey : modifiers.ctrlKey;
  if (!alternate) return defaultAction;
  return defaultAction === 'preview' ? 'open' : 'preview';
}

export function currentChatPlatform(navigatorValue: Navigator = navigator): 'mac' | 'other' {
  const platform = navigatorValue.platform || navigatorValue.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other';
}

export function linkifyChatIssueRefs(html: string): string {
  if (typeof document === 'undefined' || !html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest('a, code, pre')) return NodeFilter.FILTER_REJECT;
      ISSUE_REF_PATTERN.lastIndex = 0;
      return ISSUE_REF_PATTERN.test(node.nodeValue ?? '')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text);
  for (const textNode of textNodes) {
    const source = textNode.nodeValue ?? '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    ISSUE_REF_PATTERN.lastIndex = 0;
    for (let match = ISSUE_REF_PATTERN.exec(source); match; match = ISSUE_REF_PATTERN.exec(source)) {
      if (match.index > cursor) fragment.append(source.slice(cursor, match.index));
      const parts = issueParts(match[1]);
      if (!parts) {
        fragment.append(match[0]);
      } else {
        const anchor = document.createElement('a');
        const params = new URLSearchParams({ issue: parts.issueId });
        if (parts.repoId) params.set('repo', parts.repoId);
        anchor.href = `#/issues?${params.toString()}`;
        anchor.className = 'chat-entity-link';
        anchor.textContent = parts.repoId ? `${parts.repoId}/${parts.issueId}` : parts.issueId;
        anchor.title = `Open issue ${parts.issueId}`;
        fragment.append(anchor);
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) fragment.append(source.slice(cursor));
    textNode.replaceWith(fragment);
  }
  return container.innerHTML;
}
