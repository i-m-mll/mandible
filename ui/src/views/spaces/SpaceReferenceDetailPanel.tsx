import { useCallback, useEffect, useState } from 'preact/hooks';

import {
  getArtifact,
  getArtifactContent,
  getArtifactKnowledgeBackrefs,
  getArtifactVersions,
  getLedgerIssueDetailByIssueId,
  resolveArtifact,
  type ArtifactContentResult,
  type ArtifactRecord,
  type ArtifactResolveResult,
  type ArtifactVersionHistory,
  type ArtifactVersionRecord,
  type KnowledgeBackrefRecord,
  type LedgerIssueDetailProjection,
} from '../../api';
import { LedgerIssueDetail } from '../../components/ledger/IssueDetail';
import { parseResourceRef, type ParsedResourceRef } from '../../resource-refs';
import { ArtifactDetail } from '../artifacts';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { detailRequestKey } from '../../detail-cache';
import { useKeyedAsyncDetail } from '../../hooks/useKeyedAsyncDetail';

export type SpaceReferenceDetailTarget =
  | { kind: 'issue'; ref: string }
  | { kind: 'artifact'; ref: string }
  | { kind: 'unsupported'; ref: string; label?: string };

export function detailTargetFromResourceRef(ref: string): SpaceReferenceDetailTarget {
  const parsed = parseResourceRef(ref);
  if (!parsed) return { kind: 'unsupported', ref };
  return detailTargetFromParsedRef(parsed);
}

function detailTargetFromParsedRef(parsed: ParsedResourceRef): SpaceReferenceDetailTarget {
  if (parsed.kind === 'issue') {
    return { kind: 'issue', ref: parsed.canonical.replace(/^issue:/i, '') };
  }
  if (parsed.kind === 'artifact') {
    return { kind: 'artifact', ref: parsed.canonical };
  }
  return { kind: 'unsupported', ref: parsed.canonical, label: parsed.display };
}

export function SpaceReferenceDetailContent({
  target,
}: {
  target: SpaceReferenceDetailTarget;
}): JSX.Element {
  if (target.kind === 'issue') return <IssueReferenceDetail issueRef={target.ref} />;
  if (target.kind === 'artifact') return <ArtifactReferenceDetail artifactRef={target.ref} />;
  return (
    <div className="space-reference-detail__unsupported">
      No detail panel is available for {target.label ?? target.ref}.
    </div>
  );
}

export function IssueReferenceDetail({ issueRef }: { issueRef: string }): JSX.Element {
  const loadDetail = useCallback(
    (_signal: AbortSignal) => getLedgerIssueDetailByIssueId(issueRef),
    [issueRef],
  );
  const { data: detail, loading, error } = useKeyedAsyncDetail<LedgerIssueDetailProjection>({
    requestKey: detailRequestKey('issue', { issueId: issueRef }),
    namespace: 'issue-detail',
    load: loadDetail,
  });

  if (error) return <div className="space-reference-detail__error">Failed to load issue: {error}</div>;
  if (!detail) {
    return loading
      ? <LoadingSkeleton variant="detail" label="Loading issue detail" />
      : <div className="space-reference-detail__empty">No issue detail.</div>;
  }

  return (
    <LedgerIssueDetail
      detail={detail}
      compact
      hydrating={loading}
      onOpenEntity={(type, id, repoId) => {
        if (type === 'issue') {
          const params = new URLSearchParams({ issue: id });
          if (repoId) params.set('repo', repoId);
          window.location.hash = `#/issues?${params.toString()}`;
        } else if (type === 'auth_request') {
          window.location.hash = `#/auth?request=${encodeURIComponent(id)}`;
        } else if (type === 'session') {
          window.location.hash = `#/console?session=${encodeURIComponent(id)}`;
        }
      }}
    />
  );
}

export function ArtifactReferenceDetail({ artifactRef }: { artifactRef: string }): JSX.Element {
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

  const loadArtifactPayload = useCallback(async (nextArtifact: ArtifactRecord) => {
    setArtifact(nextArtifact);
    setContentLoading(true);
    setKnowledgeLoading(true);
    setContentError(null);
    setKnowledgeError(null);
    try {
      setContent(await getArtifactContent(nextArtifact.id));
    } catch (err) {
      setContent(null);
      setContentError(err instanceof Error ? err.message : String(err));
    } finally {
      setContentLoading(false);
    }
    try {
      setKnowledgeBackrefs(await getArtifactKnowledgeBackrefs(nextArtifact.id));
    } catch (err) {
      setKnowledgeBackrefs([]);
      setKnowledgeError(err instanceof Error ? err.message : String(err));
    } finally {
      setKnowledgeLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
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
          nextResolution.artifact ??
          (nextResolution.version
            ? await getArtifact(nextResolution.version.artifact_id)
            : await getArtifact(artifactRef));
        if (cancelled) return;
        setResolution(nextResolution);
        setSelectedVersionNo(nextResolution.version?.version_no ?? null);
        const historyRef = nextResolution.series?.id ?? nextArtifact.id;
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
        if (!cancelled) await loadArtifactPayload(nextArtifact);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactRef, loadArtifactPayload]);

  const versions = versionHistory?.versions ?? [];
  const selectedVersion = selectedVersionNo === null
    ? versions[0] ?? null
    : versions.find((version: ArtifactVersionRecord) => version.version_no === selectedVersionNo) ?? null;

  const handleVersionChange = useCallback(
    (versionNo: number | null) => {
      setSelectedVersionNo(versionNo);
      const nextVersion = versionNo === null
        ? versions[0] ?? null
        : versions.find((version) => version.version_no === versionNo) ?? null;
      if (!nextVersion) return;
      void getArtifact(nextVersion.artifact_id)
        .then(loadArtifactPayload)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [versions, loadArtifactPayload],
  );

  if (error) return <div className="space-reference-detail__error">Failed to load artifact: {error}</div>;
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
    />
  );
}
