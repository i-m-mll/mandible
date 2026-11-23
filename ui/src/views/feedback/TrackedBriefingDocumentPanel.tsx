import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { TrackedBriefingDocument } from '../../../../src/contracts';
import { isMarkdownFile } from '../../../../src/presentation/markdown-file';
import { MarkdownDocument, PlainTextDocument } from '../../components/MarkdownDocument';
import { CollapsiblePanel } from '../../components/shared/CollapsiblePanel';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { BRIEFING_MARKDOWN_PREVIEW } from './BriefingDirectiveControls';

export function TrackedBriefingDisclosure({ title, children }: { title: ComponentChildren; children: ComponentChildren }) {
  const [expanded, setExpanded] = useState(false);
  return <CollapsiblePanel title={title} expanded={expanded} onExpandedChange={setExpanded}>{children}</CollapsiblePanel>;
}

export function TrackedBriefingDocumentPanel({ document, showCommit, pending, children }: {
  document: TrackedBriefingDocument;
  showCommit?: boolean;
  pending?: number;
  children?: ComponentChildren;
}) {
  const { path, project_key, commit_sha } = document;
  return (
    <TrackedBriefingDisclosure title={<>
      {path} · {project_key}
      {showCommit && commit_sha ? ` · ${commit_sha.slice(0, 10)}` : ''}
      {pending ? <span className="change-list__badge">{pending} pending</span> : null}
    </>}>
      <TrackedBriefingDocumentContent document={document} />
      {children}
    </TrackedBriefingDisclosure>
  );
}

export function TrackedBriefingDocumentContent({ document }: { document: TrackedBriefingDocument }) {
  const { path, content } = document;
  const Document = isMarkdownFile(path) ? MarkdownDocument : PlainTextDocument;
  return content === null
    ? <DetailPaneNotice severity="warning" density="compact" title="File unavailable">{null}</DetailPaneNotice>
    : <Document value={content} readOnly ariaLabel={path} previewPolicy={BRIEFING_MARKDOWN_PREVIEW} />;
}
