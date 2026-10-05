import { resolvedArtifactRecord } from "../../../src/artifact-identity.js";
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import {
  getArtifact,
  getArtifactContent,
  getArtifactKnowledgeBackrefs,
  getArtifactVersions,
  getLedgerIssueDetailByIssueId,
  getLedgerIssueDetailByRef,
  resolveArtifact,
  type ArtifactContentResult,
  type ArtifactRecord,
  type ArtifactResolveResult,
  type ArtifactVersionHistory,
  type ArtifactVersionRecord,
  type KnowledgeBackrefRecord,
  type LedgerIssueDetailProjection,
} from '../api';
import { LedgerIssueDetail } from '../components/ledger/IssueDetail';
import { parseResourceRef, type ParsedResourceRef } from '../resource-refs';
import { shortRouteId } from '../routing';
import { ArtifactDetail } from './artifacts';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { detailRequestKey } from '../detail-cache';
import { useKeyedAsyncDetail } from '../hooks/useKeyedAsyncDetail';
import type { DetailPanePresentation } from '../components/shared/DetailPaneShell';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';

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
  const loadDetail = useCallback(
    (_signal: AbortSignal) => repoId
      ? getLedgerIssueDetailByRef(repoId, issueRef)
      : getLedgerIssueDetailByIssueId(issueRef),
    [issueRef, repoId],
  );
  const { data: detail, loading, error } = useKeyedAsyncDetail<LedgerIssueDetailProjection>({
    requestKey: detailRequestKey('issue', { issueId: issueRef, repoId: repoId ?? null }),
    namespace: 'issue-detail',
    load: loadDetail,
  });
  useEffect(() => {
    onErrorChange?.(error);
  }, [error, onErrorChange]);
  useEffect(() => () => onErrorChange?.(null), [onErrorChange]);

  if (error) return onErrorChange
    ? <div className="space-reference-detail__empty">Issue unavailable.</div>
    : <DetailPaneNotice severity="error" title="Failed to load issue">{error}</DetailPaneNotice>;
  if (!detail) {
    return loading
      ? <LoadingSkeleton variant="detail" label="Loading issue detail" />
      : <div className="space-reference-detail__empty">No issue detail.</div>;
  }

  return (
    <LedgerIssueDetail
      detail={detail}
      compact
      presentation={presentation}
      hydrating={loading}
      onOpenEntity={(type, id, repoId) => {
        if (type === 'issue') {
          const params = new URLSearchParams({ issue: id });
          if (repoId) params.set('repo', repoId);
          window.location.hash = `#/issues?${params.toString()}`;
        } else if (type === 'auth_request') {
          window.location.hash = `#/auth?request=${encodeURIComponent(shortRouteId(id))}`;
        } else if (type === 'session') {
          window.location.hash = `#/console?session=${encodeURIComponent(id)}`;
        }
      }}
    />
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
  const [resolution, setResolution] = useState<ArtifactResolveResult | null>(null);
  const [artifact, setArtifact] = useState<ArtifactRecord | null>(null);
  const [versionHistory, setVersionHistory] = useState<ArtifactVersionHistory | null>(null);
  const [selectedVersionNo, setSelectedVersionNo] = useState<number | null>(null);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [content, setContent] = useState<ArtifactContentResult | null>(null);
  const [knowledgeBackrefs, setKnowledgeBackrefs] = useState<KnowledgeBackrefRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const payloadGenerationRef = useRef(0);
  useEffect(() => {
    onErrorChange?.(error);
  }, [error, onErrorChange]);
  useEffect(() => () => onErrorChange?.(null), [onErrorChange]);

  const loadArtifactPayload = useCallback(async (nextArtifact: ArtifactRecord, generation: number) => {
    if (generation !== payloadGenerationRef.current) return;
    setArtifact(nextArtifact);
    setContent(null);
    setKnowledgeBackrefs([]);
    setContentLoading(true);
    setKnowledgeLoading(true);
    setContentError(null);
    setKnowledgeError(null);
    try {
      const nextContent = await getArtifactContent(nextArtifact.id);
      if (generation === payloadGenerationRef.current) setContent(nextContent);
    } catch (err) {
      if (generation === payloadGenerationRef.current) {
        setContent(null);
        setContentError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === payloadGenerationRef.current) setContentLoading(false);
    }
    try {
      const nextBackrefs = await getArtifactKnowledgeBackrefs(nextArtifact.id);
      if (generation === payloadGenerationRef.current) setKnowledgeBackrefs(nextBackrefs);
    } catch (err) {
      if (generation === payloadGenerationRef.current) {
        setKnowledgeBackrefs([]);
        setKnowledgeError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === payloadGenerationRef.current) setKnowledgeLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const generation = ++payloadGenerationRef.current;
    setLoading(true);
    setError(null);
    setResolution(null);
    setArtifact(null);
    setVersionHistory(null);
    setContent(null);
    setKnowledgeBackrefs([]);
    resolveArtifact(artifactRef)
      .then(async (nextResolution) => {
        if (cancelled) return;
        const nextArtifact =
          resolvedArtifactRecord(nextResolution) ??
          (nextResolution.artifact_version
            ? await getArtifact(nextResolution.artifact_version.id)
            : await getArtifact(artifactRef));
        if (cancelled) return;
        setResolution(nextResolution);
        setSelectedVersionNo(nextResolution.artifact_version?.version_no ?? null);
        const historyRef = nextResolution.logical_artifact?.id ?? nextArtifact.id;
        try {
          const history = await getArtifactVersions(historyRef);
          if (!cancelled) {
            setVersionHistory({
              ...history,
              versions: [...history.versions].sort((a, b) => b.version_no - a.version_no),
            });
          }
        } catch {
          if (!cancelled) setVersionHistory(null);
        }
        if (!cancelled) await loadArtifactPayload(nextArtifact, generation);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (payloadGenerationRef.current === generation) payloadGenerationRef.current += 1;
    };
  }, [artifactRef, loadArtifactPayload]);

  const versions = versionHistory?.versions ?? [];
  const selectedVersion = selectedVersionNo === null
    ? versions[0] ?? null
    : versions.find((version: ArtifactVersionRecord) => version.version_no === selectedVersionNo) ?? null;

  const handleVersionChange = useCallback(
    (versionNo: number | null) => {
      const generation = ++payloadGenerationRef.current;
      setSelectedVersionNo(versionNo);
      setError(null);
      setArtifact(null);
      setContent(null);
      setKnowledgeBackrefs([]);
      setLoading(true);
      const nextVersion = versionNo === null
        ? versions[0] ?? null
        : versions.find((version) => version.version_no === versionNo) ?? null;
      if (!nextVersion) {
        setLoading(false);
        return;
      }
      void getArtifact(nextVersion.artifact_id)
        .then((nextArtifact) => loadArtifactPayload(nextArtifact, generation))
        .catch((err) => {
          if (generation === payloadGenerationRef.current) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (generation === payloadGenerationRef.current) setLoading(false);
        });
    },
    [versions, loadArtifactPayload],
  );

  if (error) return onErrorChange
    ? <div className="space-reference-detail__empty">Artifact unavailable.</div>
    : <DetailPaneNotice severity="error" title="Failed to load artifact">{error}</DetailPaneNotice>;
  if (!artifact) {
    return loading
      ? <LoadingSkeleton variant="detail" label="Loading artifact detail" />
      : <div className="space-reference-detail__empty">No artifact detail.</div>;
  }

  return (
    <ArtifactDetail
      artifact={artifact}
      resolution={resolution}
      series={versionHistory?.series ?? null}
      versions={versions}
      selectedVersion={selectedVersion}
      selectedVersionNo={selectedVersionNo}
      versionHistoryOpen={versionHistoryOpen}
      onVersionChange={handleVersionChange}
      onToggleVersionHistory={() => setVersionHistoryOpen((open) => !open)}
      onCloseVersionHistory={() => setVersionHistoryOpen(false)}
      content={content}
      contentLoading={contentLoading}
      contentError={contentError}
      knowledgeBackrefs={knowledgeBackrefs}
      knowledgeLoading={knowledgeLoading}
      knowledgeError={knowledgeError}
      presentation={presentation}
    />
  );
}
