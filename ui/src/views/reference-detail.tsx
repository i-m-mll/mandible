import { navigateAppHash } from '../app-history';
import { useEffect, useState } from "preact/hooks";
import { useQuery } from "@tanstack/preact-query";
import { useViewActive } from "../app-shell";
import { queryClient } from "../query/client";
import { issueDetailOptions, queryErrorMessage, detailQueryData } from "../query/details";
import { useArtifactDetail } from "../hooks/useArtifactDetail";
import { LedgerIssueDetail } from "../components/ledger/IssueDetail";
import { parseResourceRef, type ParsedResourceRef } from "../resource-refs";
import { shortRouteId } from "../routing";
import { ArtifactDetail, UnsupportedArtifactBlob, UnresolvedArtifact } from "./artifacts";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import type { DetailPanePresentation } from "../components/shared/DetailPaneShell";
import { DetailPaneNotice } from "../components/shared/DetailPaneNotice";

export type ReferenceDetailTarget =
  | { kind: 'issue'; ref: string; repoId?: string }
  | { kind: 'artifact'; ref: string }
  | { kind: 'unsupported'; ref: string; label?: string };

export function referenceDetailTargetFromResourceRef(ref: string): ReferenceDetailTarget {
  const parsed = parseResourceRef(ref);
  if (!parsed) return { kind: 'unsupported', ref };
  return detailTargetFromParsedRef(parsed);
}

function detailTargetFromParsedRef(parsed: ParsedResourceRef): ReferenceDetailTarget {
  if (parsed.kind === 'issue') {
    return { kind: 'issue', ref: parsed.canonical.replace(/^issue:/i, '') };
  }
  if (parsed.kind === 'artifact') {
    return { kind: 'artifact', ref: parsed.canonical };
  }
  return { kind: 'unsupported', ref: parsed.canonical, label: parsed.display };
}

export function ReferenceDetailContent({
  target,
  presentation = 'main',
  onErrorChange,
}: {
  target: ReferenceDetailTarget;
  presentation?: DetailPanePresentation;
  onErrorChange?: (error: string | null) => void;
}): JSX.Element {
  if (target.kind === 'issue') return <IssueReferenceDetail issueRef={target.ref} repoId={target.repoId} presentation={presentation} onErrorChange={onErrorChange} />;
  if (target.kind === 'artifact') return <ArtifactReferenceDetail artifactRef={target.ref} presentation={presentation} onErrorChange={onErrorChange} />;
  return (
    <div className="space-reference-detail__unsupported">
      No detail panel is available for {target.label ?? target.ref}.
    </div>
  );
}

export function IssueReferenceDetail({
  issueRef,
  repoId,
  presentation = 'main',
  onErrorChange,
}: {
  issueRef: string;
  repoId?: string;
  presentation?: DetailPanePresentation;
  onErrorChange?: (error: string | null) => void;
}): JSX.Element {
  const active = useViewActive();
  const options = issueDetailOptions(issueRef, repoId);
  const query = useQuery({ ...options, enabled: active }, queryClient);
  const detail = detailQueryData(query, options);
  const loading = query.isPending;
  const error = queryErrorMessage(query.error);
  useEffect(() => {
    onErrorChange?.(error);
  }, [error, onErrorChange]);
  useEffect(() => () => onErrorChange?.(null), [onErrorChange]);

  if (error && !detail) return onErrorChange
    ? <div className="space-reference-detail__empty">Issue unavailable.</div>
    : <DetailPaneNotice severity="error" title="Failed to load issue">{error}</DetailPaneNotice>;
  if (!detail) {
    return loading
      ? <LoadingSkeleton variant="detail" label="Loading issue detail" />
      : <div className="space-reference-detail__empty">No issue detail.</div>;
  }

  return (
    <>
    {error && !onErrorChange && <DetailPaneNotice severity="error" title="Issue refresh failed">{error}</DetailPaneNotice>}
    <LedgerIssueDetail
      detail={detail}
      compact
      presentation={presentation}
      hydrating={loading}
      onOpenEntity={(type, id, repoId) => {
        if (type === 'issue') {
          const params = new URLSearchParams({ issue: id });
          if (repoId) params.set('repo', repoId);
          navigateAppHash(`#/issues?${params.toString()}`);
        } else if (type === 'auth_request') {
          navigateAppHash(`#/auth?request=${encodeURIComponent(shortRouteId(id))}`);
        } else if (type === 'session') {
          navigateAppHash(`#/console?session=${encodeURIComponent(id)}`);
        }
      }}
    />
    </>
  );
}

export function ArtifactReferenceDetail({
  artifactRef,
  presentation = 'main',
  onErrorChange,
}: {
  artifactRef: string;
  presentation?: DetailPanePresentation;
  onErrorChange?: (error: string | null) => void;
}): JSX.Element {
  const [selection, setSelection] = useState<{ ref: string; versionNo?: number | null }>({ ref: artifactRef });
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  if (selection.ref !== artifactRef) setSelection({ ref: artifactRef });
  const detail = useArtifactDetail({ reference: artifactRef, versionNo: selection.ref === artifactRef ? selection.versionNo : undefined });
  useEffect(() => { onErrorChange?.(detail.error); }, [detail.error, onErrorChange]);
  useEffect(() => () => onErrorChange?.(null), [onErrorChange]);
  if (!detail.artifact) {
    if (detail.error) return onErrorChange
      ? <div className="space-reference-detail__empty">Artifact unavailable.</div>
      : <DetailPaneNotice severity="error" title="Failed to load artifact">{detail.error}</DetailPaneNotice>;
    if (detail.resolution?.target_type === 'artifact_blob') return <UnsupportedArtifactBlob resolution={detail.resolution} />;
    if (detail.resolution && !detail.loading) return <UnresolvedArtifact resolution={detail.resolution} />;
    return detail.loading ? <LoadingSkeleton variant="detail" label="Loading artifact detail" />
      : <div className="space-reference-detail__empty">No artifact detail.</div>;
  }
  return <ArtifactDetail
    artifact={detail.artifact} detailError={detail.error} resolution={detail.resolution}
    series={detail.history?.series ?? null} versions={detail.history?.versions ?? []}
    selectedVersion={detail.selectedVersion} selectedVersionNo={detail.selectedVersionNo}
    versionHistoryOpen={versionHistoryOpen}
    onVersionChange={(versionNo) => setSelection({ ref: artifactRef, versionNo })}
    onToggleVersionHistory={() => setVersionHistoryOpen((open) => !open)}
    onCloseVersionHistory={() => setVersionHistoryOpen(false)}
    content={detail.content} contentLoading={detail.contentLoading} contentError={detail.contentError}
    knowledgeBackrefs={detail.backrefs} knowledgeLoading={detail.backrefsLoading} knowledgeError={detail.backrefsError}
    presentation={presentation}
  />;
}
