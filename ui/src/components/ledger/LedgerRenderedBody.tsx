import { useEffect, useMemo, useRef } from 'preact/hooks';

import { renderMarkdown } from '../../lib/markdown';
import { linkifyResourceRefs, attachResourceRefResolution } from '../../resource-refs';

export type LedgerRenderedBodyContext = {
  id: string;
  display_id: string;
  project: {
    project_key?: string | null;
    repo_id?: string | null;
    display_name: string;
  };
};

export function LedgerRenderedBody({
  source,
  className,
  empty,
  detail,
}: {
  source: string;
  className: string;
  empty: string;
  detail: LedgerRenderedBodyContext;
}): JSX.Element {
  const html = useMemo(() => {
    if (!source) return '';
    const sanitized = renderMarkdown(normalizeMarkdownSource(source));
    return linkifyResourceRefs(linkifyLedgerRefs(sanitized, detail));
  }, [
    source,
    detail.id,
    detail.display_id,
    detail.project.project_key,
    detail.project.repo_id,
    detail.project.display_name,
  ]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || !html) return undefined;
    return attachResourceRefResolution(node);
  }, [html]);
  if (!html) {
    return <div className={`${className} spec-panel--empty`}>{empty}</div>;
  }
  return <div ref={containerRef} className={`${className} rendered-markdown`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function normalizeMarkdownSource(source: string): string {
  if (!source.includes('\\n')) return source;
  const literalNewlineCount = (source.match(/\\n/g) ?? []).length;
  const actualNewlineCount = (source.match(/\n/g) ?? []).length;
  if (literalNewlineCount < 2 || actualNewlineCount > 0) return source;
  return source.replace(/\\n/g, '\n');
}

const REF_PATTERN = /\[#(\d+)\]|\[(issue|comment):([^\]\s]+)\]/g;

function linkifyLedgerRefs(html: string, detail: LedgerRenderedBodyContext): string {
  if (typeof document === 'undefined' || !html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  linkifyInlineCodeRefs(container, detail);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre')) return NodeFilter.FILTER_REJECT;
      REF_PATTERN.lastIndex = 0;
      return REF_PATTERN.test(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const textNode of nodes) {
    const fragment = document.createDocumentFragment();
    const text = textNode.nodeValue ?? '';
    REF_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REF_PATTERN.exec(text))) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const link = refLink(match, detail);
      fragment.appendChild(link ?? document.createTextNode(match[0]));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.replaceWith(fragment);
  }
  return container.innerHTML;
}

function linkifyInlineCodeRefs(container: HTMLElement, detail: LedgerRenderedBodyContext): void {
  const codeRefs = Array.from(container.querySelectorAll('code')).filter((code) => (
    !code.closest('a, pre') && Boolean(code.textContent?.trim())
  ));
  for (const code of codeRefs) {
    const text = code.textContent?.trim() ?? '';
    REF_PATTERN.lastIndex = 0;
    const match = REF_PATTERN.exec(text);
    if (!match || match.index !== 0 || match[0].length !== text.length) continue;
    const isExplicitRef = Boolean(match[2]);
    if (!isExplicitRef) continue;
    const link = refLink(match, detail);
    if (!link) continue;
    link.classList.add('ledger-xref--inline-code');
    code.replaceWith(link);
  }
}

function refLink(match: RegExpExecArray, detail: LedgerRenderedBodyContext): HTMLAnchorElement | null {
  const ordinalCommentRef = match[1];
  const explicitType = match[2];
  const explicitRef = match[3];
  if (ordinalCommentRef) {
    const anchor = document.createElement('a');
    anchor.className = 'ledger-xref';
    anchor.textContent = `#${ordinalCommentRef}`;
    anchor.href = issueHref(currentProjectRef(detail), detail.display_id, ordinalCommentRef);
    anchor.title = `Open comment #${ordinalCommentRef}`;
    return anchor;
  }
  const ref = explicitRef;
  if (!ref) return null;

  const anchor = document.createElement('a');
  anchor.className = 'ledger-xref';
  if (explicitType === 'comment') {
    const parsed = parseCommentRef(ref, detail);
    if (!parsed) return null;
    anchor.textContent = commentRefLabel(parsed, detail);
    anchor.href = issueHref(parsed.repo, parsed.issue, parsed.comment);
    anchor.title = `Open comment ${parsed.comment}`;
    return anchor;
  }

  const parsedIssue = parseIssueRef(ref, detail);
  if (!parsedIssue) return null;
  anchor.textContent = issueRefLabel(parsedIssue, detail);
  anchor.href = issueHref(parsedIssue.repo, parsedIssue.issue);
  anchor.title = `Open issue ${parsedIssue.issue}`;
  return anchor;
}

function issueRefLabel(parsed: { repo: string; issue: string }, detail: LedgerRenderedBodyContext): string {
  const currentRepo = currentProjectRef(detail);
  return parsed.repo === currentRepo ? parsed.issue : `${parsed.repo}/${parsed.issue}`;
}

function commentRefLabel(
  parsed: { repo: string; issue: string; comment: string },
  detail: LedgerRenderedBodyContext,
): string {
  const issueLabel = issueRefLabel(parsed, detail);
  return `${issueLabel}#${parsed.comment}`;
}

function parseIssueRef(ref: string, detail: LedgerRenderedBodyContext): { repo: string; issue: string } | null {
  const scoped = ref.match(/^([^/#]+)\/([^/#]+)$/);
  if (scoped) return { repo: scoped[1], issue: scoped[2] };
  return { repo: currentProjectRef(detail), issue: ref.replace(/^#/, '') };
}

function parseCommentRef(
  ref: string,
  detail: LedgerRenderedBodyContext,
): { repo: string; issue: string; comment: string } | null {
  if (ref.startsWith('#')) {
    return { repo: currentProjectRef(detail), issue: detail.display_id, comment: ref.slice(1) };
  }
  const scoped = ref.match(/^([^/#]+)\/([^/#]+)#([^#]+)$/);
  if (scoped) return { repo: scoped[1], issue: scoped[2], comment: scoped[3] };
  const currentProject = ref.match(/^([^/#]+)#([^#]+)$/);
  if (currentProject) {
    return { repo: currentProjectRef(detail), issue: currentProject[1], comment: currentProject[2] };
  }
  return null;
}

function currentProjectRef(detail: LedgerRenderedBodyContext): string {
  return (
    detail.project.project_key?.trim() ||
    detail.project.repo_id?.trim() ||
    detail.project.display_name.trim() ||
    detail.project.display_name
  );
}

function issueHref(repo: string, issue: string, comment?: string): string {
  const params = new URLSearchParams({ repo, issue });
  if (comment) params.set('comment', comment);
  return `#/issues?${params.toString()}`;
}
