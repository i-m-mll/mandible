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
import { parseFindingRef, parseResourceRef, type ParsedResourceRef } from '../../resource-refs';
import { SpaceFindingRef, useFindingResolution, type FindingResolver } from './SpaceFindingRef';
import { presentFinding, type FindingRefSource } from './findingModel';
import { shortRouteId } from '../../routing';
import { ArtifactDetail } from '../artifacts';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { detailRequestKey } from '../../detail-cache';
import { useKeyedAsyncDetail } from '../../hooks/useKeyedAsyncDetail';

export type SpaceReferenceDetailTarget =
  | { kind: 'issue'; ref: string }
  | { kind: 'artifact'; ref: string }
  | { kind: 'finding'; ref: string }
  | { kind: 'unsupported'; ref: string; label?: string };

export function detailTargetFromResourceRef(ref: string): SpaceReferenceDetailTarget {
  // `finding:<candidate id>` is resolved through its own endpoint rather than
  // the shared resource-ref resolver, so it is recognized before the grammar.
  const finding = parseFindingRef(ref);
  if (finding) return { kind: 'finding', ref: finding.candidateId };
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
  if (target.kind === 'finding') return <FindingReferenceDetail item={{ ref_id: target.ref }} />;
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
          window.location.hash = `#/auth?request=${encodeURIComponent(shortRouteId(id))}`;
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

/**
 * Read-only detail for a placed briefing finding (umbrella 99b74d6). Shows the
 * reference exactly as the renderers do — title, source, revision state, review
 * state — plus the resolved revision's provenance. It renders NO control that
 * could change review state: the Briefing view is the single write surface, and
 * this panel only links out to it.
 */
export function FindingReferenceDetail({
  item,
  resolve,
}: {
  item: FindingRefSource;
  /** Resolver override (tests / hosts with their own cache). */
  resolve?: FindingResolver;
}): JSX.Element {
  const resolution = useFindingResolution(item, resolve);
  const view = presentFinding(item, resolution);
  const revision = resolution?.effective_revision ?? null;
  const current = resolution?.current_revision ?? null;

  return (
    <div className="space-finding-detail" data-testid="space-finding-detail">
      <SpaceFindingRef source={item} resolution={resolution} />
      {revision?.why_notable ? (
        <p className="space-finding-detail__why" data-testid="space-finding-why">
          {revision.why_notable}
        </p>
      ) : null}
      <dl className="space-finding-detail__facts">
        <div>
          <dt>Reference</dt>
          <dd>{view.ref}</dd>
        </div>
        <div>
          <dt>Revision mode</dt>
          <dd data-testid="space-finding-detail-mode">
            {view.revisionMode === 'pinned' ? `pinned (${view.revisionLabel})` : 'latest (tracking)'}
          </dd>
        </div>
        <div>
          <dt>Showing revision</dt>
          <dd data-testid="space-finding-detail-revision">{revision?.id ?? 'unresolved'}</dd>
        </div>
        <div>
          <dt>Current revision</dt>
          <dd data-testid="space-finding-detail-current">{current?.id ?? 'unknown'}</dd>
        </div>
        {revision?.captured_at ? (
          <div>
            <dt>Captured</dt>
            <dd>{revision.captured_at}</dd>
          </div>
        ) : null}
        {revision?.evidence_kind ? (
          <div>
            <dt>Evidence</dt>
            <dd>{revision.evidence_kind}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
