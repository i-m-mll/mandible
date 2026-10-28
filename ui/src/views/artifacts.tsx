import { NativeSelect } from '../components/shared/NativeSelect';
import { Icon } from '../components/icons/Icon';
import { navigateAppHash } from '../app-history';
import { resolvedArtifactRecord } from "../../../src/artifact-identity.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { useKeyedAsyncDetail } from '../hooks/useKeyedAsyncDetail';
import { beginDetailRequest, detailRequestKey, removePersistedDetail, writePersistedDetail } from '../detail-cache';
import { ARTIFACT_ROUTE_SELECTORS, routeHashWithParams, parseArtifactVersionParam, shortRouteId } from '../routing';
import { PRODUCTION_ORIGIN } from '../../../src/canonical-origin';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import {
  deleteArtifactDraft,
  createBriefingFromArtifactVersion,
  getArtifact,
  getArtifactContent,
  getArtifactDiff,
  getArtifactDraft,
  getArtifactKnowledgeBackrefs,
  getArtifactSeriesList,
  getArtifactVersions,
  getLedgerIssueDetail,
  isApiErrorStatus,
  openArtifactExternally,
  publishArtifactDraft,
  rebaseArtifactDraft,
  resolveArtifact,
  saveArtifactDraft,
  type ArtifactContentResult,
  type ArtifactDiffResult,
  type ArtifactDraftRecord,
  type ArtifactDraftPublishResult,
  type ArtifactLinkRecord,
  type ArtifactRecord,
  type ArtifactQueryParams,
  type ArtifactResolveResult,
  type ArtifactSeriesRecord,
  type ArtifactSeriesSummary,
  type ArtifactVersionHistory,
  type ArtifactVersionRecord,
  type KnowledgeBackrefRecord,
} from '../api';
import { DiffView } from '../components/DiffView';
import {
  artifactDetailHref,
  compactArtifactBlobRef,
  displayResourceRef,
  seriesDetailHref,
  versionDetailHref,
} from '../resource-refs';
import { renderDocumentText } from './spaces/DocumentRenderer';
import { MarkdownSourceEditor } from './spaces/MarkdownSourceEditor';
import { ViewSidebar } from '../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../view-sidebar-geometry';
import { AddToSpace, type AddToSpaceTarget } from '../components/spaces/AddToSpace';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneMenuTrigger } from '../components/shared/DetailPaneMenuTrigger';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { DetailPaneShell, type DetailPanePresentation } from '../components/shared/DetailPaneShell';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { useRouteLoad } from '../app-shell';
import { artifactLinkBadgeLabel } from '../lib/format';
import { useSidebarListNavigation } from '../hooks/useSidebarListNavigation';
import { readPersistedViewState, usePersistedViewState } from '../hooks/usePersistedViewState';
import { briefingRoute } from '../routing';

type ArtifactsViewProps = {
  initialArtifactId?: string;
  initialRef?: string;
  initialSeriesRef?: string;
  initialVersionNo?: number | null;
  initialRepo?: string;
  initialRole?: string;
  sidebarHidden?: boolean;
};

type ArtifactFilters = {
  q: string;
  repo: string;
  provider: string;
  role: string;
  custody: string;
  availability: string;
  scheme: string;
  location: string;
};

type ArtifactSortField = 'updated' | 'title' | 'created' | 'versions';
type ArtifactSortDirection = 'asc' | 'desc';

type ArtifactListViewState = {
  filters: ArtifactFilters;
  sortField: ArtifactSortField;
  sortDirection: ArtifactSortDirection;
  selectedSeriesRef: string | null;
  selectedVersionNo: number | null;
};

const EMPTY_FILTERS: ArtifactFilters = {
  q: '',
  repo: '',
  provider: '',
  role: '',
  custody: '',
  availability: '',
  scheme: '',
  location: '',
};

const DEFAULT_ARTIFACT_LIST_STATE: ArtifactListViewState = {
  filters: EMPTY_FILTERS,
  sortField: 'updated',
  sortDirection: 'desc',
  selectedSeriesRef: null,
  selectedVersionNo: null,
};

const ARTIFACT_LIST_STATE_KEY = 'mandible:artifacts:list-controls:v1';

function normalizeArtifactListViewState(value: unknown): ArtifactListViewState {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawFilters = record.filters && typeof record.filters === 'object'
    ? record.filters as Record<string, unknown>
    : {};
  const filters = Object.fromEntries(
    Object.keys(EMPTY_FILTERS).map((key) => [key, typeof rawFilters[key] === 'string' ? rawFilters[key] : '']),
  ) as ArtifactFilters;
  const sortFields: ArtifactSortField[] = ['updated', 'title', 'created', 'versions'];
  return {
    filters,
    sortField: sortFields.includes(record.sortField as ArtifactSortField)
      ? record.sortField as ArtifactSortField
      : 'updated',
    sortDirection: record.sortDirection === 'asc' ? 'asc' : 'desc',
    selectedSeriesRef: typeof record.selectedSeriesRef === 'string' && record.selectedSeriesRef.trim()
      ? record.selectedSeriesRef
      : null,
    selectedVersionNo: typeof record.selectedVersionNo === 'number' && Number.isInteger(record.selectedVersionNo)
      ? record.selectedVersionNo
      : null,
  };
}

type ArtifactRouteSelection = {
  artifactId?: string;
  ref?: string;
  seriesRef: string | null;
  versionNo: number | null;
  hasDeepLink: boolean;
  hasInvalidSeries: boolean;
};

function artifactRouteSelection(input: {
  artifactId?: string;
  ref?: string;
  seriesRef?: string;
  versionNo?: number | null;
}): ArtifactRouteSelection {
  const artifactId = input.artifactId?.trim() || undefined;
  const ref = input.ref?.trim() || undefined;
  const rawSeriesRef = input.seriesRef?.trim() || undefined;
  const seriesRef = rawSeriesRef ? normalizeInitialSeriesRef(rawSeriesRef) : null;
  return {
    artifactId,
    ref,
    seriesRef,
    versionNo: input.versionNo ?? null,
    hasDeepLink: Boolean(artifactId || ref || rawSeriesRef),
    hasInvalidSeries: Boolean(rawSeriesRef && !seriesRef),
  };
}

function artifactSeriesListRequest(filters: ArtifactFilters): ArtifactQueryParams {
  return {
    q: filters.q || undefined,
    repo: filters.repo || undefined,
    provider: filters.provider || undefined,
    role: filters.role || undefined,
    custody: filters.custody || undefined,
    availability: filters.availability || undefined,
    scheme: filters.scheme || undefined,
    location: filters.location || undefined,
    limit: 200,
    summary: true,
  };
}

function artifactSelectedSeriesRef(
  current: string | null,
  hasDeepLink: boolean,
  ordered: readonly ArtifactSeriesSummary[],
): string | null {
  if (current || hasDeepLink || !ordered[0]) return current;
  return seriesRef(ordered[0]);
}

type BundleMemberPreview = {
  artifactId: string;
  role: string;
  recoverability: string;
  order: number;
};

type MetadataRow = [label: string, value: string, copyable?: boolean, copyValue?: string];

type ArtifactPreview =
  | {
      kind: 'json' | 'text';
      value: string;
      rawValue: string;
      autoFormatted: boolean;
      highlightLanguage: ArtifactHighlightLanguage | null;
      partial: boolean;
      previewBytes?: number;
      totalBytes?: number;
      omittedBytes?: number;
      formatSkipped?: 'partial_preview';
    }
  | { kind: 'markdown' | 'html' | 'empty'; value: string }
  | { kind: 'binary'; value: string }
  | { kind: 'bundle'; manifestText: string; name: string; members: BundleMemberPreview[] };

type LastWrittenHashRef = {
  current: { seriesRef: string; versionNo: number | null } | null;
};

function isAbortError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && error.name === 'AbortError',
  );
}

export function ArtifactsView({
  initialArtifactId,
  initialRef,
  initialSeriesRef,
  initialVersionNo = null,
  initialRepo,
  initialRole,
  sidebarHidden = false,
}: ArtifactsViewProps): JSX.Element {
  const routeSelection = artifactRouteSelection({
    artifactId: initialArtifactId,
    ref: initialRef,
    seriesRef: initialSeriesRef,
    versionNo: initialVersionNo,
  });
  const initialSeriesSelection = routeSelection.seriesRef;
  const [listViewState, setListViewState] = usePersistedViewState(
    ARTIFACT_LIST_STATE_KEY,
    normalizeArtifactListViewState,
    DEFAULT_ARTIFACT_LIST_STATE,
  );
  const { filters, sortField, sortDirection } = listViewState;
  const [series, setSeries] = useState<ArtifactSeriesSummary[]>([]);
  const [selectedSeriesRef, setSelectedSeriesRef] = useState<string | null>(
    routeSelection.artifactId || routeSelection.ref
      ? null
      : initialSeriesSelection ?? (routeSelection.hasDeepLink ? null : listViewState.selectedSeriesRef),
  );
  const [selectedVersionNo, setSelectedVersionNo] = useState<number | null>(
    routeSelection.artifactId || routeSelection.ref || routeSelection.hasInvalidSeries
      ? null
      : initialSeriesSelection
        ? routeSelection.versionNo
        : listViewState.selectedVersionNo,
  );
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(initialArtifactId ?? null);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactRecord | null>(null);
  const [versionHistory, setVersionHistory] = useState<ArtifactVersionHistory | null>(null);
  const [resolution, setResolution] = useState<ArtifactResolveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [detailMetadataOpen, setDetailMetadataOpen] = useState(false);
  const [facetSeries, setFacetSeries] = useState<ArtifactSeriesSummary[]>([]);
  const deepLinkActiveRef = useRef(routeSelection.hasDeepLink);
  const listRequestIdRef = useRef(0);
  const facetRequestIdRef = useRef(0);
  const lastWrittenHashRef = useRef<{ seriesRef: string; versionNo: number | null } | null>(null);
  const lastAppliedInitialSeriesRef = useRef<{ seriesRef: string; versionNo: number | null } | null>(
    initialSeriesSelection ? { seriesRef: initialSeriesSelection, versionNo: routeSelection.versionNo } : null,
  );

  const routeKey = JSON.stringify([initialArtifactId, initialRef, initialSeriesRef, initialVersionNo]);
  const [appliedRouteKey, setAppliedRouteKey] = useState(routeKey);
  const intentGenerationRef = useRef(0);
  if (appliedRouteKey !== routeKey) {
    setAppliedRouteKey(routeKey);
    intentGenerationRef.current += 1;
    deepLinkActiveRef.current = routeSelection.hasDeepLink;
    const ownWrite = lastWrittenHashRef.current;
    if (!(ownWrite && ownWrite.seriesRef === initialSeriesSelection && ownWrite.versionNo === initialVersionNo)) {
      setSelectedSeriesRef(initialSeriesSelection ?? (routeSelection.hasDeepLink ? null : listViewState.selectedSeriesRef));
      setSelectedVersionNo(initialSeriesSelection ? initialVersionNo : null);
      setSelectedArtifactId(null);
      setSelectedArtifact(null);
      setVersionHistory(null);
      setResolution(null);
      setError(null);
      setDetailLoading(Boolean(initialArtifactId || initialRef));
    }
  }

  useEffect(() => {
    setListViewState((current) => {
      if (!initialRepo || current.filters.repo === initialRepo) return current;
      return { ...current, filters: { ...current.filters, repo: initialRepo } };
    });
  }, [initialRepo, setListViewState]);

  useEffect(() => {
    setListViewState((current) => {
      if (!initialRole || current.filters.role === initialRole) return current;
      return { ...current, filters: { ...current.filters, role: initialRole } };
    });
  }, [initialRole, setListViewState]);

  useEffect(() => {
    deepLinkActiveRef.current = routeSelection.hasDeepLink;
  }, [initialArtifactId, initialRef, initialSeriesRef]);

  const applyResolutionSelection = useCallback((next: ArtifactResolveResult, options?: { forcePinned?: boolean }) => {
    setResolution(next);
    if (next.target_type === 'artifact_blob') {
      setSelectedSeriesRef(null);
      setSelectedVersionNo(null);
      setSelectedArtifactId(null);
      setSelectedArtifact(null);
      return;
    }
    const nextSeriesRef = next.logical_artifact ? canonicalArtifactSeriesRef(next.logical_artifact.id) : null;
    const latestTracking = next.warnings?.includes('series_latest_not_pinned') && !options?.forcePinned;
    setSelectedSeriesRef(nextSeriesRef);
    setSelectedVersionNo(next.artifact_version && !latestTracking ? next.artifact_version.version_no : null);
    setSelectedArtifactId(resolvedArtifactRecord(next)?.id ?? next.artifact_version?.id ?? null);
    setSelectedArtifact(resolvedArtifactRecord(next));
  }, []);

  const applyArtifactDeepLinkSelection = useCallback(async (
    next: ArtifactResolveResult,
    isCancelled: () => boolean,
  ) => {
    if (resolvedArtifactRecord(next) && !next.logical_artifact && !next.artifact_version) {
      try {
        const history = sortedVersionHistory(await getArtifactVersions(resolvedArtifactRecord(next)!.id));
        if (isCancelled()) return;
        const pinnedVersion = history.versions.find((version) => version.artifact_id === resolvedArtifactRecord(next)?.id) ?? null;
        if (pinnedVersion) {
          setResolution(next);
          setVersionHistory(history);
          setSelectedSeriesRef(seriesRecordRef(history.series));
          setSelectedVersionNo(pinnedVersion.version_no);
          setSelectedArtifactId(resolvedArtifactRecord(next)!.id);
          setSelectedArtifact(resolvedArtifactRecord(next));
          return;
        }
      } catch (err) {
        if (!isApiErrorStatus(err, 404)) {
          if (!isCancelled()) {
            applyResolutionSelection(next, { forcePinned: !/^artifact-series:/i.test(next.ref) });
            setError(err instanceof Error ? err.message : String(err));
          }
          return;
        }
      }
    }
    if (!isCancelled()) {
      applyResolutionSelection(next, { forcePinned: !/^artifact-series:/i.test(next.ref) });
    }
  }, [applyResolutionSelection]);

  const loadSeries = useCallback(async () => {
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    const show = (next: ArtifactSeriesSummary[]) => {
      const ordered = sortArtifactSeries(next, sortField, sortDirection);
      setSeries(ordered);
      setSelectedSeriesRef((current) => {
        return artifactSelectedSeriesRef(current, deepLinkActiveRef.current, ordered);
      });
      setSelectedArtifactId((current) => {
        if (current || deepLinkActiveRef.current || !ordered[0]?.latest_version) return current;
        return ordered[0].latest_version.artifact_id;
      });
      setSelectedArtifact((current) => {
        if (current || deepLinkActiveRef.current || !ordered[0]?.latest_artifact) return current;
        return ordered[0].latest_artifact;
      });
    };
    try {
      const next = await getArtifactSeriesList(artifactSeriesListRequest(filters), { onCached: show });
      if (listRequestIdRef.current !== requestId) return;
      show(next);
    } catch (err) {
      if (listRequestIdRef.current === requestId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (listRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [filters, sortDirection, sortField]);

  const initialFiltersApplied = !(initialRepo && filters.repo !== initialRepo) && !(initialRole && filters.role !== initialRole);
  useRouteLoad((register) => {
    const read = loadSeries();
    if (initialFiltersApplied) register(read);
  }, [loadSeries]);

  const loadFacetSeries = useCallback(async () => {
    const requestId = facetRequestIdRef.current + 1;
    facetRequestIdRef.current = requestId;
    try {
      const next = await getArtifactSeriesList({
        q: filters.q || undefined,
        location: filters.location || undefined,
        limit: 500,
        summary: true,
      });
      if (facetRequestIdRef.current !== requestId) return;
      setFacetSeries(next);
    } catch {
      // Keep the last successful option corpus so transient reload failures do not collapse selects.
    }
  }, [filters.q, filters.location]);

  useRouteLoad((register) => {
    const read = loadFacetSeries();
    if (initialFiltersApplied) register(read);
  }, [loadFacetSeries]);

  useEffect(() => {
    if (!initialArtifactId) return;
    let cancelled = false;
    const generation = intentGenerationRef.current;
    const isCancelled = () => cancelled || generation !== intentGenerationRef.current;
    setDetailLoading(true);
    setError(null);
    setResolution(null);
    resolveArtifact(initialArtifactId)
      .then((next) => {
        if (isCancelled()) return;
        return applyArtifactDeepLinkSelection(next, isCancelled);
      })
      .catch((err) => {
        if (isCancelled()) return;
        setSelectedSeriesRef(null);
        setSelectedVersionNo(null);
        setSelectedArtifactId(initialArtifactId);
        setSelectedArtifact(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!isCancelled()) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyArtifactDeepLinkSelection, initialArtifactId]);

  useEffect(() => {
    if (!initialRef) return;
    let cancelled = false;
    const generation = intentGenerationRef.current;
    const isCancelled = () => cancelled || generation !== intentGenerationRef.current;
    setDetailLoading(true);
    setError(null);
    setResolution(null);
    setSelectedArtifact(null);
    resolveArtifact(initialRef)
      .then((next) => {
        if (isCancelled()) return;
        applyResolutionSelection(next);
      })
      .catch((err) => {
        if (!isCancelled()) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!isCancelled()) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyResolutionSelection, initialRef]);

  useEffect(() => {
    if (!initialSeriesRef) return;
    const nextSeriesRef = normalizeInitialSeriesRef(initialSeriesRef);
    if (!nextSeriesRef) {
      lastAppliedInitialSeriesRef.current = null;
      setSelectedSeriesRef(null);
      setSelectedVersionNo(null);
      setSelectedArtifactId(null);
      setSelectedArtifact(null);
      setVersionHistory(null);
      setResolution(null);
      setError(`Invalid series reference: ${initialSeriesRef}`);
      return;
    }
    const nextVersionNo = initialVersionNo;
    const lastWritten = lastWrittenHashRef.current;
    if (lastWritten?.seriesRef === nextSeriesRef && lastWritten.versionNo === nextVersionNo) {
      lastWrittenHashRef.current = null;
      lastAppliedInitialSeriesRef.current = { seriesRef: nextSeriesRef, versionNo: nextVersionNo };
      return;
    }
    const lastApplied = lastAppliedInitialSeriesRef.current;
    if (lastApplied?.seriesRef === nextSeriesRef && lastApplied.versionNo === nextVersionNo) return;
    lastAppliedInitialSeriesRef.current = { seriesRef: nextSeriesRef, versionNo: nextVersionNo };
    setSelectedSeriesRef(nextSeriesRef);
    setSelectedVersionNo(nextVersionNo);
    setResolution(null);
    setError(null);
  }, [initialSeriesRef, initialVersionNo]);

  const loadVersions = useCallback(async (signal: AbortSignal) => (
    sortedVersionHistory(await getArtifactVersions(selectedSeriesRef!, { signal }))
  ), [selectedSeriesRef, selectedVersionNo]);
  const versionsDetail = useKeyedAsyncDetail({
    namespace: 'artifact-versions',
    requestKey: selectedSeriesRef ? detailRequestKey('artifact-versions', { ref: selectedSeriesRef }) : null,
    load: loadVersions,
  });
  useLayoutEffect(() => {
    if (versionsDetail.error) {
      const invalidIdentity = isApiErrorStatus(versionsDetail.failure, 404) || isApiErrorStatus(versionsDetail.failure, 409);
      if (invalidIdentity) {
        if (selectedSeriesRef) removePersistedDetail('artifact-versions', detailRequestKey('artifact-versions', { ref: selectedSeriesRef }));
        setVersionHistory(null);
        setSelectedArtifactId(null);
        setSelectedArtifact(null);
        setResolution(null);
      }
      if (isApiErrorStatus(versionsDetail.failure, 404) && !deepLinkActiveRef.current) {
        setSelectedSeriesRef(null);
        setSelectedVersionNo(null);
        setSelectedArtifactId(null);
        setSelectedArtifact(null);
        setResolution(null);
        setError(null);
      }
      return;
    }
    if (!selectedSeriesRef) {
      setVersionHistory(null);
      return;
    }
    if (!versionsDetail.data) return;
    const history = sortedVersionHistory(versionsDetail.data);
    const canonicalSeriesRef = seriesRecordRef(history.series);
    if (!versionsDetail.stale && canonicalSeriesRef !== selectedSeriesRef) {
      writePersistedDetail('artifact-versions', detailRequestKey('artifact-versions', { ref: canonicalSeriesRef }), history);
      setSelectedSeriesRef(canonicalSeriesRef);
    }
    setVersionHistory(history);
    const version = selectedVersionNo === null
      ? history.versions[0] ?? null
      : history.versions.find((entry) => entry.version_no === selectedVersionNo) ?? null;
    if (version || !versionsDetail.stale) setSelectedArtifactId(version?.artifact_id ?? null);
  }, [selectedSeriesRef, selectedVersionNo, versionsDetail.data, versionsDetail.error, versionsDetail.failure, versionsDetail.stale]);

  const recordResolved = selectedArtifact?.id === selectedArtifactId
    && resolvedArtifactRecord(resolution)?.id === selectedArtifactId
    && Boolean(selectedArtifact?.links && selectedArtifact?.aliases);
  const loadRecord = useCallback((signal: AbortSignal) => (
    getArtifact(selectedArtifactId!, { signal })
  ), [selectedArtifactId]);
  const acceptRecord = useCallback((artifact: ArtifactRecord) => artifact.id === selectedArtifactId, [selectedArtifactId]);
  const recordDetail = useKeyedAsyncDetail({
    namespace: 'artifact-record',
    requestKey: selectedArtifactId && !recordResolved ? detailRequestKey('artifact-record', { id: selectedArtifactId }) : null,
    load: loadRecord,
    accept: acceptRecord,
  });
  useLayoutEffect(() => {
    if (recordDetail.data) setSelectedArtifact(recordDetail.data);
  }, [recordDetail.data]);

  const loadContent = useCallback((signal: AbortSignal) => (
    getArtifactContent(selectedArtifactId!, { signal })
  ), [selectedArtifactId]);
  const acceptContent = useCallback((content: ArtifactContentResult) => content.artifact_id === selectedArtifactId, [selectedArtifactId]);
  const contentDetail = useKeyedAsyncDetail({
    namespace: 'artifact-content',
    requestKey: selectedArtifactId ? detailRequestKey('artifact-content', { id: selectedArtifactId }) : null,
    load: loadContent,
    accept: acceptContent,
  });
  const artifactContent = contentDetail.data;
  const contentLoading = contentDetail.loading || contentDetail.revalidating;
  const contentError = contentDetail.error;

  const backrefsId = selectedArtifact?.id === selectedArtifactId ? selectedArtifactId : null;
  const loadBackrefs = useCallback((signal: AbortSignal) => (
    getArtifactKnowledgeBackrefs(backrefsId!, { signal })
  ), [backrefsId]);
  const backrefsDetail = useKeyedAsyncDetail({
    namespace: 'artifact-backrefs',
    requestKey: backrefsId ? detailRequestKey('artifact-backrefs', { id: backrefsId }) : null,
    load: loadBackrefs,
  });
  const knowledgeBackrefs = backrefsDetail.data ?? [];
  const knowledgeLoading = backrefsDetail.loading || backrefsDetail.revalidating;
  const knowledgeError = backrefsDetail.error;
  const detailError = versionsDetail.error ?? recordDetail.error ?? error;
  const requestDetailLoading = detailLoading || versionsDetail.loading || recordDetail.loading;

  const facetOptions = useMemo(() => buildFacetOptions(facetSeries), [facetSeries]);
  const coherentVersionHistory = selectedSeriesRef && versionHistory
    && seriesRecordRef(versionHistory.series) === selectedSeriesRef
    ? versionHistory
    : null;
  const selectedVersion = useMemo(() => (
    selectedVersionNo === null
      ? coherentVersionHistory?.versions.find((version) => version.artifact_id === selectedArtifactId) ?? coherentVersionHistory?.versions[0] ?? null
      : coherentVersionHistory?.versions.find((version) => version.version_no === selectedVersionNo) ?? null
  ), [coherentVersionHistory, selectedArtifactId, selectedVersionNo]);
  const selectedSeries = useMemo(() => (
    series.find((entry) => seriesRef(entry) === selectedSeriesRef) ?? null
  ), [selectedSeriesRef, series]);
  useEffect(() => {
    if (selectedSeriesRef || deepLinkActiveRef.current) return;
    const fallback = series[0];
    if (!fallback) return;
    setSelectedSeriesRef(seriesRef(fallback));
    setSelectedVersionNo(null);
    setSelectedArtifactId(fallback.latest_version?.artifact_id ?? null);
    setSelectedArtifact(fallback.latest_artifact);
    setResolution(null);
  }, [selectedSeriesRef, series]);
  const coherentSelectedArtifact = selectedArtifact?.id === selectedArtifactId ? selectedArtifact : null;
  const coherentArtifactContent = artifactContent?.artifact_id === coherentSelectedArtifact?.id ? artifactContent : null;
  const coherentContentLoading = Boolean(
    coherentSelectedArtifact
    && !contentError
    && (contentLoading || !coherentArtifactContent)
  );
  const detailPending = Boolean(selectedArtifactId && !coherentSelectedArtifact);

  const selectSeries = useCallback((entry: ArtifactSeriesSummary) => {
    intentGenerationRef.current += 1;
    setDetailLoading(false);
    setError(null);
    const ref = seriesRef(entry);
    setSelectedSeriesRef(ref);
    setSelectedVersionNo(null);
    setSelectedArtifactId(entry.latest_version?.artifact_id ?? null);
    setSelectedArtifact(entry.latest_artifact);
    setResolution(null);
    writeArtifactHash(ref, null, lastWrittenHashRef);
  }, []);

  useEffect(() => {
    if (!selectedSeriesRef) return;
    setListViewState((current) => (
      current.selectedSeriesRef === selectedSeriesRef && current.selectedVersionNo === selectedVersionNo
        ? current
        : { ...current, selectedSeriesRef, selectedVersionNo }
    ));
  }, [selectedSeriesRef, selectedVersionNo, setListViewState]);

  const artifactListNavigation = useSidebarListNavigation({
    items: series,
    getKey: seriesRef,
    selectedKey: selectedSeriesRef,
    onSelect: selectSeries,
  });

  const selectVersion = (versionNo: number | null) => {
    intentGenerationRef.current += 1;
    setSelectedVersionNo(versionNo);
    const version = versionNo === null
      ? coherentVersionHistory?.versions[0] ?? null
      : coherentVersionHistory?.versions.find((candidate) => candidate.version_no === versionNo) ?? null;
    setSelectedArtifactId(version?.artifact_id ?? null);
    setResolution(null);
    if (!selectedSeriesRef) return;
    writeArtifactHash(selectedSeriesRef, versionNo, lastWrittenHashRef);
  };

  const handleVersionPublished = useCallback((published: ArtifactDraftPublishResult) => {
    const nextSeriesRef = canonicalArtifactSeriesRef(published.result.logical_artifact.id);
    setSelectedSeriesRef(nextSeriesRef);
    setSelectedVersionNo(published.result.artifact_version.version_no);
    setSelectedArtifactId(published.result.artifact_version.id);
    setSelectedArtifact(resolvedArtifactRecord(published.result));
    setResolution(published.result);
    writeArtifactHash(nextSeriesRef, published.result.artifact_version.version_no, lastWrittenHashRef);
    void loadSeries();
  }, [loadSeries]);

  const updateFilter = (key: keyof ArtifactFilters, value: string) => {
    setListViewState((current) => ({
      ...current,
      filters: { ...current.filters, [key]: value },
    }));
  };

  const clearFilters = () => {
    setListViewState((current) => ({
      ...DEFAULT_ARTIFACT_LIST_STATE,
      selectedSeriesRef: current.selectedSeriesRef,
      selectedVersionNo: current.selectedVersionNo,
    }));
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length
    + Number(sortField !== DEFAULT_ARTIFACT_LIST_STATE.sortField)
    + Number(sortDirection !== DEFAULT_ARTIFACT_LIST_STATE.sortDirection);
  return (
    <div className="artifacts-view">
      <ViewSidebar
        {...VIEW_SIDEBAR_GEOMETRY.artifacts}
        className="artifacts-sidebar"
        ariaLabel="Artifacts"
        hidden={sidebarHidden}
        header={
          <SidebarSearchFilterHeader
            value={filters.q}
            onValueChange={(value) => updateFilter('q', value)}
            placeholder="Search artifacts"
            searchAriaLabel="Search artifacts"
            clearAriaLabel="Clear artifact search"
            filterTrigger={{
              ariaLabel: 'Artifact filters',
              title: 'Artifact filters',
              open: advancedOpen,
              active: activeFilterCount > 0,
              count: activeFilterCount,
              onToggle: () => setAdvancedOpen((open) => !open),
            }}
            panel={advancedOpen ? {
              id: 'artifact-filter-panel',
              variant: 'popover',
              ariaLabel: 'Artifact filter and sort controls',
              onDismiss: () => setAdvancedOpen(false),
              children: (
                <>
                <div className="sidebar-search-filter__section sidebar-search-filter__section--header">
                  <span>Filters and sorting</span>
                  <button type="button" className="sidebar-search-filter__clear-action" onClick={clearFilters}>Reset</button>
                </div>
                <div className="sidebar-search-filter__section">
                  <span className="sidebar-search-filter__label">Sort</span>
                  <FacetSelect label="Field" value={sortField} options={['updated', 'title', 'created', 'versions']} onChange={(value) => setListViewState((current) => ({ ...current, sortField: value as ArtifactSortField }))} />
                  <div className="sidebar-search-filter__options sidebar-search-filter__options--segmented">
                    {(['asc', 'desc'] as ArtifactSortDirection[]).map((direction) => (
                      <button key={direction} type="button" className={`sidebar-search-filter__option${sortDirection === direction ? ' sidebar-search-filter__option--active' : ''}`} aria-pressed={sortDirection === direction} onClick={() => setListViewState((current) => ({ ...current, sortDirection: direction }))}>
                        {direction === 'asc' ? 'Ascending' : 'Descending'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sidebar-search-filter__section">
                <span className="sidebar-search-filter__label">Facets</span>
                <FacetSelect label="Location" value={filters.scheme} options={facetOptions.schemes} onChange={(value) => updateFilter('scheme', value)} />
                <FacetSelect label="Custody" value={filters.custody} options={facetOptions.custodies} onChange={(value) => updateFilter('custody', value)} />
                <FacetSelect label="Availability" value={filters.availability} options={facetOptions.availabilities} onChange={(value) => updateFilter('availability', value)} />
                <FacetSelect label="Repo" value={filters.repo} options={facetOptions.repos} onChange={(value) => updateFilter('repo', value)} />
                <FacetSelect label="Provider" value={filters.provider} options={facetOptions.providers} onChange={(value) => updateFilter('provider', value)} />
                <FacetSelect label="Role" value={filters.role} options={facetOptions.roles} onChange={(value) => updateFilter('role', value)} />
                <label className="sidebar-search-filter__field">
                  <span>Path or locator</span>
                  <input value={filters.location} placeholder="Path or locator" onInput={(e) => updateFilter('location', e.currentTarget.value)} />
                </label>
                </div>
                </>
              ),
            } : undefined}
          />
        }
        bodyClassName="artifacts-sidebar__list"
      >
              {loading && series.length === 0 && <div className="artifacts-sidebar__empty">Loading artifacts...</div>}
              {!loading && series.length === 0 && <div className="artifacts-sidebar__empty">No artifacts</div>}
              {series.map((entry, index) => {
                const navigation = artifactListNavigation.getItemNavigationProps(entry, index);
                return (
                  <button
                    key={seriesRef(entry)}
                    ref={navigation.ref}
                    type="button"
                    tabIndex={navigation.tabIndex}
                    aria-current={navigation['aria-current']}
                    className={`sidebar-list-item artifacts-sidebar__item${seriesRef(entry) === selectedSeriesRef ? ' artifacts-sidebar__item--active' : ''}`}
                    onKeyDown={navigation.onKeyDown}
                    onClick={() => selectSeries(entry)}
                  >
                    <span className="artifacts-sidebar__name">{seriesTitle(entry)}</span>
                    <span className="artifacts-sidebar__meta">
                      <span>{shortSeriesId(seriesRef(entry))}</span>
                      {entry.latest_artifact?.role ? <em>{entry.latest_artifact.role}</em> : null}
                    </span>
                  </button>
                );
              })}
      </ViewSidebar>
      <main className={`artifacts-detail${coherentSelectedArtifact && detailMetadataOpen ? ' artifacts-detail--metadata-open' : ''}`}>
        {detailError && !coherentSelectedArtifact && <DetailPaneNotice severity="error" title="Artifacts could not be loaded">{detailError}</DetailPaneNotice>}
        {(requestDetailLoading || detailPending) && !coherentSelectedArtifact && !resolution && (
          <LoadingSkeleton variant="detail" label="Loading artifact..." />
        )}
        {!detailError && !requestDetailLoading && !detailPending && !coherentSelectedArtifact && !resolution && (
          <div className="artifacts-empty">No artifacts in this view.</div>
        )}
        {!requestDetailLoading && !detailPending && resolution?.target_type === 'artifact_blob' && (
          <UnsupportedArtifactBlob resolution={resolution} />
        )}
        {!requestDetailLoading && !detailPending && resolution && resolution.target_type !== 'artifact_blob' && !resolvedArtifactRecord(resolution) && (
          <UnresolvedArtifact resolution={resolution} />
        )}
        {coherentSelectedArtifact && (
          <ArtifactDetail
            artifact={coherentSelectedArtifact}
            detailError={detailError}
            resolution={resolution}
            series={coherentVersionHistory?.series ?? selectedSeries ?? null}
            versions={coherentVersionHistory?.versions ?? []}
            selectedVersion={selectedVersion}
            selectedVersionNo={selectedVersionNo}
            versionHistoryOpen={versionHistoryOpen}
            onVersionChange={selectVersion}
            onToggleVersionHistory={() => setVersionHistoryOpen((open) => !open)}
            onCloseVersionHistory={() => setVersionHistoryOpen(false)}
            onVersionPublished={handleVersionPublished}
            onMetadataOpenChange={setDetailMetadataOpen}
            content={coherentArtifactContent}
            contentLoading={coherentContentLoading}
            contentError={detailError ? null : contentError}
            knowledgeBackrefs={knowledgeBackrefs}
            knowledgeLoading={knowledgeLoading}
            knowledgeError={knowledgeError}
          />
        )}
      </main>
    </div>
  );
}

function FacetSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}): JSX.Element {
  const renderedOptions = value && !options.includes(value)
    ? [...options, value].sort()
    : options;
  return (
    <label className="sidebar-search-filter__field">
      <span>{label}</span>
      <NativeSelect value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">Any</option>
        {renderedOptions.map((option) => <option key={option} value={option}>{option}</option>)}
      </NativeSelect>
    </label>
  );
}

function sortArtifactSeries(
  entries: ArtifactSeriesSummary[],
  field: ArtifactSortField,
  direction: ArtifactSortDirection,
): ArtifactSeriesSummary[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...entries].sort((left, right) => {
    let comparison: number;
    if (field === 'title') {
      comparison = seriesTitle(left).localeCompare(seriesTitle(right), undefined, { sensitivity: 'base' });
    } else if (field === 'created') {
      comparison = left.created_at - right.created_at;
    } else if (field === 'versions') {
      comparison = left.version_count - right.version_count;
    } else {
      comparison = left.updated_at - right.updated_at;
    }
    return comparison * multiplier || seriesRef(left).localeCompare(seriesRef(right));
  });
}

export type ArtifactDetailProps = {
  presentation?: DetailPanePresentation;
  artifact: ArtifactRecord;
  detailError?: string | null;
  resolution: ArtifactResolveResult | null;
  series: ArtifactSeriesRecord | ArtifactSeriesSummary | null;
  versions: ArtifactVersionRecord[];
  selectedVersion: ArtifactVersionRecord | null;
  selectedVersionNo: number | null;
  versionHistoryOpen: boolean;
  onVersionChange: (versionNo: number | null) => void;
  onToggleVersionHistory: () => void;
  onCloseVersionHistory: () => void;
  onVersionPublished?: (published: ArtifactDraftPublishResult) => void;
  onMetadataOpenChange?: (open: boolean) => void;
  content: ArtifactContentResult | null;
  contentLoading: boolean;
  contentError: string | null;
  knowledgeBackrefs: KnowledgeBackrefRecord[];
  knowledgeLoading: boolean;
  knowledgeError: string | null;
};

export function ArtifactDetail({
  presentation = 'main',
  artifact,
  detailError = null,
  resolution,
  series,
  versions,
  selectedVersion,
  selectedVersionNo,
  versionHistoryOpen,
  onVersionChange,
  onToggleVersionHistory,
  onCloseVersionHistory,
  onVersionPublished,
  onMetadataOpenChange,
  content,
  contentLoading,
  contentError,
  knowledgeBackrefs,
  knowledgeLoading,
  knowledgeError,
}: ArtifactDetailProps): JSX.Element {
  const preview = content ? artifactPreview(content) : null;
  const detailIdentity = artifactDetailIdentity(artifact, series, selectedVersion);
  const formattedPreviewAvailable = Boolean(
    preview && (preview.kind === 'json' || preview.kind === 'text') && preview.autoFormatted,
  );
  const [jsonView, setJsonView] = useState<'formatted' | 'raw'>('formatted');
  const [actionsOpen, setActionsOpen] = useState(false);
  const [spacePickerOpen, setSpacePickerOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuStyle = useAnchoredMenu({
    open: actionsOpen,
    anchorRef: actionsTriggerRef,
    menuRef: actionsMenuRef,
    onDismiss: () => setActionsOpen(false),
  });
  const headerRef = useRef<HTMLElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  // Resolve a project scope for the Add-to-Space picker. Artifacts are not
  // project-scoped in the data model, but an issue-linked artifact (the common
  // case) lets us derive the owning project from that issue. When no issue link
  // exists the picker self-disables with an explanatory tooltip (child 08c312a).
  const spaceProjectId = useArtifactSpaceProject(artifact);
  const spaceTargets: AddToSpaceTarget[] = [
    {
      ref_type: 'artifact',
      ref_id: artifact.id,
      ref_uri: artifact.uri,
      title: artifactTitle(artifact),
    },
  ];
  const spaceActionDisabled = !spaceProjectId || spaceTargets.length === 0;
  const seriesRefValue = series ? seriesRecordRef(series) : '';
  const immutableArtifactRef = artifact.id;
  const selectedArtifactRef = selectedVersion?.id || immutableArtifactRef;
  const headerShortId = seriesRefValue ? shortSeriesId(seriesRefValue) : shortArtifactId(artifact.id);
  const headerCopyValue = series ? canonicalArtifactSeriesRef(series.id) : immutableArtifactRef;
  const headerCopyLabel = series ? 'Copy artifact series ref' : 'Copy artifact ref';
  const createdUpdated = artifactCreatedUpdated(artifact, series, versions);
  const identityRows: MetadataRow[] = [
    ['Series', seriesRefValue, true, series ? canonicalArtifactSeriesRef(series.id) : seriesRefValue],
    ['Selected version', selectedVersion ? `v${selectedVersion.version_no}` : 'Latest'],
    ['URI', artifact.uri, true],
    ['Content hash', artifact.content_hash, true],
    ['Short ID', shortArtifactId(artifact.id), true, immutableArtifactRef],
    ['Home repo', artifact.home_repo_id],
    ['Provider', artifact.provider_id],
    ['Manifest', artifact.manifest_id],
    ['Resolved from', resolution?.ref ?? ''],
  ].filter(([, value]) => Boolean(value)) as MetadataRow[];
  const custodyRows: MetadataRow[] = [
    ['Mode', artifact.custody_mode ?? 'Unstored blob'],
    ['Role', artifact.role ?? ''],
    ['Media type', artifact.media_type ?? ''],
    ['Size', formatBytes(artifact.size_bytes)],
    ['Created', formatTime(artifact.created_at)],
  ].filter(([, value]) => Boolean(value)) as MetadataRow[];
  const locatorRows = artifact.aliases ?? [];
  const editableState = artifactEditableState(artifact, content);
  const baseVersion = selectedVersion ?? versions[0] ?? null;
  const previousVersion = selectedVersion
    ? versions
      .filter((version) => version.version_no < selectedVersion.version_no)
      .sort((a, b) => b.version_no - a.version_no)[0] ?? null
    : null;
  const [draft, setDraft] = useState<ArtifactDraftRecord | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [draftLabel, setDraftLabel] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingExternally, setOpeningExternally] = useState(false);
  const [briefingCreating, setBriefingCreating] = useState(false);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [versionDiff, setVersionDiff] = useState<ArtifactDiffResult | null>(null);
  const latestDraftRef = useRef<ArtifactDraftRecord | null>(null);
  latestDraftRef.current = draft;

  useEffect(() => {
    setJsonView('formatted');
  }, [content?.artifact_id]);

  useEffect(() => {
    if (!versionHistoryOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const node = historyPanelRef.current;
      if (!node || node.contains(event.target as Node)) return;
      onCloseVersionHistory();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseVersionHistory();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [versionHistoryOpen, onCloseVersionHistory]);

  useEffect(() => {
    onMetadataOpenChange?.(metadataOpen);
    return () => {
      if (metadataOpen) onMetadataOpenChange?.(false);
    };
  }, [metadataOpen, onMetadataOpenChange]);

  useEffect(() => {
    if (!seriesRefValue) {
      setDraft(null);
      setDraftValue('');
      setEditMode(false);
      return undefined;
    }
    const controller = new AbortController();
    setDraftLoading(true);
    setDraftError(null);
    getArtifactDraft(seriesRefValue, { signal: controller.signal })
      .then((nextDraft) => {
        setDraft(nextDraft);
        setDraftValue(nextDraft?.content ?? '');
        setDraftLabel(nextDraft?.label ?? '');
        setDraftNote(nextDraft?.note ?? '');
        setEditMode(Boolean(nextDraft));
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setDraftError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setDraftLoading(false));
    return () => controller.abort();
  }, [seriesRefValue]);

  useEffect(() => {
    if (!editMode || !draft || draftValue === draft.content || !seriesRefValue) return undefined;
    setDraftSaving(true);
    const timer = window.setTimeout(() => {
      saveArtifactDraft({
        ref: seriesRefValue,
        base_version_id: draft.base_version_id,
        content: draftValue,
        media_type: editableState.mediaType,
        label: draftLabel || null,
        note: draftNote || null,
      })
        .then((saved) => {
          setDraft(saved);
          setDraftStatus('Draft saved');
          setDraftError(null);
        })
        .catch((err) => setDraftError(err instanceof Error ? err.message : String(err)))
        .finally(() => setDraftSaving(false));
    }, 700);
    return () => {
      window.clearTimeout(timer);
      setDraftSaving(false);
    };
  }, [draft, draftLabel, draftNote, draftValue, editMode, editableState.mediaType, seriesRefValue]);

  useEffect(() => {
    setDiffOpen(false);
    setVersionDiff(null);
    setDiffError(null);
  }, [selectedVersion?.id]);

  useEffect(() => {
    if (!diffOpen || !selectedVersion || !previousVersion) return undefined;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    getArtifactDiff(previousVersion.id, selectedVersion.id)
      .then((diff) => {
        if (!cancelled) setVersionDiff(diff);
      })
      .catch((err) => {
        if (!cancelled) setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [diffOpen, previousVersion, selectedVersion]);

  const closeActionsAfter = (callback: () => void) => {
    callback();
    setActionsOpen(false);
  };

  const externalOpenState = content?.status === 'available' && content.source
    ? { enabled: true, reason: '' }
    : { enabled: false, reason: content?.reason ?? 'Artifact material is not available as a local file.' };
  const briefingCreateState = selectedVersion && content?.status === 'available' && content.kind === 'markdown'
    ? { enabled: true, reason: '' }
    : { enabled: false, reason: 'Create briefing requires one explicitly resolved, materializable Markdown artifact version.' };

  const createBriefing = async () => {
    if (!selectedVersion || !briefingCreateState.enabled) return;
    setBriefingCreating(true);
    setBriefingError(null);
    try {
      const receipt = await createBriefingFromArtifactVersion({
        artifact_version_ref: selectedVersion.id,
        title: artifactTitle(artifact),
      });
      if (receipt.outcome === 'active_candidates') {
        const guidance = receipt.active_candidates.map((candidate) =>
          `${candidate.title} (${candidate.briefing_id.slice(0, 8)}): ${candidate.guidance === 'reuse_round' ? 'reuse exact round' : 'add a round'}`,
        ).join('; ');
        const archived = receipt.archived_candidates.length > 0
          ? ` Archived advisories: ${receipt.archived_candidates.length}.`
          : '';
        setBriefingError(`Active Briefing candidates: ${guidance}.${archived}`);
        return;
      }
      if (typeof window !== 'undefined') {
        navigateAppHash(briefingRoute(receipt.briefing_id, receipt.round_id).slice(1));
      }
    } catch (error) {
      setBriefingError(error instanceof Error ? error.message : String(error));
    } finally {
      setBriefingCreating(false);
    }
  };

  const openSelectedArtifactExternally = async () => {
    setActionsOpen(false);
    setOpeningExternally(true);
    setOpenError(null);
    try {
      await openArtifactExternally(selectedVersion?.artifact_id ?? artifact.id);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningExternally(false);
    }
  };

  const saveDraftNow = useCallback(async () => {
    if (!seriesRefValue || !draft) return null;
    setDraftSaving(true);
    try {
      const saved = await saveArtifactDraft({
        ref: seriesRefValue,
        base_version_id: draft.base_version_id,
        content: draftValue,
        media_type: editableState.mediaType,
        label: draftLabel || null,
        note: draftNote || null,
      });
      setDraft(saved);
      setDraftStatus('Draft saved');
      setDraftError(null);
      return saved;
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setDraftSaving(false);
    }
  }, [draft, draftLabel, draftNote, draftValue, editableState.mediaType, seriesRefValue]);

  const startEdit = useCallback(async () => {
    if (!editableState.editable || !seriesRefValue || !baseVersion || !editableState.sourceText) return;
    setDraftSaving(true);
    setDraftError(null);
    try {
      const saved = await saveArtifactDraft({
        ref: seriesRefValue,
        base_version_id: draft?.base_version_id ?? baseVersion.id,
        content: draft?.content ?? editableState.sourceText,
        media_type: editableState.mediaType,
        label: draftLabel || null,
        note: draftNote || null,
      });
      setDraft(saved);
      setDraftValue(saved.content);
      setDraftLabel(saved.label ?? '');
      setDraftNote(saved.note ?? '');
      setEditMode(true);
      setDraftStatus(saved.stale ? 'Draft resumed from an older base' : 'Draft ready');
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftSaving(false);
    }
  }, [baseVersion, draft, draftLabel, draftNote, editableState, seriesRefValue]);

  const discardDraft = useCallback(async () => {
    if (!seriesRefValue) return;
    setDraftSaving(true);
    try {
      await deleteArtifactDraft(seriesRefValue);
      setDraft(null);
      setDraftValue('');
      setEditMode(false);
      setDraftStatus('Draft discarded');
      setDraftError(null);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftSaving(false);
    }
  }, [seriesRefValue]);

  const publishDraft = useCallback(async (allowStale: boolean) => {
    if (!seriesRefValue) return;
    const saved = await saveDraftNow();
    const activeDraft = saved ?? latestDraftRef.current;
    if (!activeDraft) return;
    setDraftSaving(true);
    try {
      const published = await publishArtifactDraft({
        ref: seriesRefValue,
        label: draftLabel || null,
        note: draftNote || null,
        allow_stale: allowStale,
      });
      setDraft(null);
      setDraftValue('');
      setEditMode(false);
      setDraftStatus(`Published v${published.result.artifact_version.version_no}`);
      setDraftError(null);
      onVersionPublished?.(published);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftSaving(false);
    }
  }, [draftLabel, draftNote, onVersionPublished, saveDraftNow, seriesRefValue]);

  const rebaseDraft = useCallback(async () => {
    if (!seriesRefValue) return;
    await saveDraftNow();
    setDraftSaving(true);
    try {
      const rebased = await rebaseArtifactDraft(seriesRefValue);
      setDraft(rebased);
      setDraftValue(rebased.content);
      setDraftStatus('Draft rebased; resolve conflict markers before publishing');
      setDraftError(null);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftSaving(false);
    }
  }, [saveDraftNow, seriesRefValue]);

  const overlays = (
    <>
      {versionHistoryOpen && (
        <div className="artifact-detail__modal" role="dialog" aria-modal="true" aria-labelledby="artifact-version-history-title">
          <div className="artifact-detail__modal-panel" ref={historyPanelRef}>
            <div className="artifact-detail__modal-header">
              <h3 id="artifact-version-history-title">Version history</h3>
              <button
                type="button"
                className="artifact-detail__modal-close"
                aria-label="Close version history"
                onClick={onCloseVersionHistory}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="artifact-detail__list">
              {versions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  className={`artifact-detail__list-item${version.artifact_id === artifact.id ? ' artifact-detail__list-item--active' : ''}`}
                  onClick={() => {
                    onVersionChange(version.version_no);
                    onCloseVersionHistory();
                  }}
                >
                  <code>v{version.version_no}</code>
                  <span>{version.label || version.note || version.source_kind}</span>
                  <span>{formatTime(version.created_at)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {metadataOpen && (
        <DetailPaneModal
          open={metadataOpen}
          onClose={() => setMetadataOpen(false)}
          titleId="artifact-metadata-title"
          title="Artifact metadata"
          closeLabel="Close artifact metadata"
          excludeAboveRef={headerRef}
          scrollOwnerSelector=".artifacts-detail"
          scrollLockClassName="artifacts-detail--metadata-open"
          className="artifact-detail__metadata-modal"
          panelClassName="artifact-detail__metadata-panel"
        >
          <section className="artifact-detail__section">
            <h3>Identity</h3>
            <MetadataKeyValue rows={identityRows} />
          </section>
          <section className="artifact-detail__section">
            <h3>Custody</h3>
            <MetadataKeyValue rows={custodyRows} />
          </section>
          {locatorRows.length > 0 && (
            <section className="artifact-detail__section">
              <h3>Locators</h3>
              <div className="artifact-detail__list">
                {locatorRows.map((alias) => (
                  <div key={alias.id} className="artifact-detail__list-item">
                    <code>{alias.normalized_ref}</code>
                    <span>{alias.scheme}</span>
                    <span>{alias.resolution_status}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </DetailPaneModal>
      )}
    </>
  );

  const detailFailures = [
    detailError && `Artifact detail: ${detailError}`,
    openError && `Open artifact: ${openError}`,
    briefingError && `Create briefing: ${briefingError}`,
    editMode && draftError && `Edit artifact: ${draftError}`,
    !editMode && contentError && `Artifact content: ${contentError}`,
    diffOpen && diffError && `Version diff: ${diffError}`,
    knowledgeError && `Knowledge references: ${knowledgeError}`,
  ].filter((message): message is string => Boolean(message));

  return (
    <DetailPaneShell
      presentation={presentation}
      className="artifact-detail"
      headerClassName="artifact-detail__header"
      bodyClassName={`artifact-detail__pane${metadataOpen ? ' artifact-detail__pane--metadata-open' : ''}`}
      headerRef={headerRef}
      ariaBusy={contentLoading}
      notice={detailFailures.length > 0 ? (
        <DetailPaneNotice severity="error" density="compact" title="Artifact needs attention">
          {detailFailures.map((message) => <div key={message}>{message}</div>)}
        </DetailPaneNotice>
      ) : null}
      header={(
        <DetailPaneHeader
          presentation={presentation}
          variant="versioned"
          identity={{
            displayRef: headerShortId,
            canonicalRef: headerCopyValue,
            copyLabel: headerCopyLabel,
          }}
          title={detailIdentity.title}
          supportingMetadata={(
            <div className="artifact-detail__header-context">
              <span className="artifact-detail__subline">
                {[
                  detailIdentity.filename ? `File: ${detailIdentity.filename}` : '',
                  artifact.custody_mode,
                  artifact.role,
                ].filter(Boolean).join(' · ')}
              </span>
              <span className="artifact-detail__dates">
                <span>Created: {formatTime(createdUpdated.created)}</span>
                <span>Updated: {formatTime(createdUpdated.updated)}</span>
              </span>
            </div>
          )}
          state={selectedVersionNo === null ? 'Latest' : undefined}
          selector={{
            label: 'Artifact version',
            control: (
              <NativeSelect
                aria-label="Artifact version"
                value={selectedVersionNo === null ? '' : String(selectedVersionNo)}
                onChange={(event) => onVersionChange(event.currentTarget.value ? Number(event.currentTarget.value) : null)}
              >
                <option value="">Latest</option>
                {versions.map((version) => (
                  <option key={version.id} value={String(version.version_no)}>
                    v{version.version_no}{version.label ? ` · ${version.label}` : ''}
                  </option>
                ))}
              </NativeSelect>
            ),
            selectedCanonicalRef: selectedArtifactRef,
            copyLabel: 'Copy selected artifact-version reference',
          }}
          actions={(
          <div className="artifact-detail__actions">
            <DetailPaneMenuTrigger
              buttonRef={actionsTriggerRef}
              label="Artifact actions"
              expanded={actionsOpen}
              onClick={() => setActionsOpen((open) => !open)}
            />
            {actionsOpen && (
              <div
                ref={actionsMenuRef}
                className="artifact-detail__actions-menu app-anchored-menu"
                role="menu"
                popover="manual"
                style={actionsMenuStyle}
              >
                <button
                  type="button"
                  className="artifact-detail__actions-item"
                  role="menuitem"
                  disabled={!externalOpenState.enabled || openingExternally}
                  title={externalOpenState.enabled ? 'Open with the OS default application' : externalOpenState.reason}
                  onClick={() => void openSelectedArtifactExternally()}
                >
                  {openingExternally ? 'Opening…' : 'Open externally'}
                </button>
                <button
                  type="button"
                  className="artifact-detail__actions-item"
                  role="menuitem"
                  disabled={!briefingCreateState.enabled || briefingCreating}
                  title={briefingCreateState.enabled ? 'Create a new Briefing from this exact selected version' : briefingCreateState.reason}
                  onClick={() => closeActionsAfter(() => void createBriefing())}
                >
                  {briefingCreating ? 'Creating briefing…' : 'Create briefing'}
                </button>
                <button
                  type="button"
                  className="artifact-detail__actions-item"
                  role="menuitem"
                  disabled={spaceActionDisabled}
                  title={!spaceProjectId ? 'No project context for Spaces' : 'Add to Space'}
                  onClick={() => closeActionsAfter(() => setSpacePickerOpen(true))}
                >
                  Add to Space
                </button>
                <button
                  type="button"
                  className="artifact-detail__actions-item"
                  role="menuitem"
                  onClick={() => closeActionsAfter(() => setMetadataOpen(true))}
                >
                  Show metadata
                </button>
                {formattedPreviewAvailable && (
                  <>
                    <button
                      type="button"
                      className={`artifact-detail__actions-item${jsonView === 'formatted' ? ' artifact-detail__actions-item--active' : ''}`}
                      role="menuitemradio"
                      aria-checked={jsonView === 'formatted'}
                      onClick={() => closeActionsAfter(() => setJsonView('formatted'))}
                    >
                      Formatted JSON
                      {jsonView === 'formatted' ? <Icon name="menuSelected" className="artifact-detail__actions-item-check" /> : null}
                    </button>
                    <button
                      type="button"
                      className={`artifact-detail__actions-item${jsonView === 'raw' ? ' artifact-detail__actions-item--active' : ''}`}
                      role="menuitemradio"
                      aria-checked={jsonView === 'raw'}
                      onClick={() => closeActionsAfter(() => setJsonView('raw'))}
                    >
                      Raw JSON
                      {jsonView === 'raw' ? <Icon name="menuSelected" className="artifact-detail__actions-item-check" /> : null}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="artifact-detail__actions-item"
                  role="menuitem"
                  disabled={!editableState.editable || draftSaving}
                  title={editableState.editable ? 'Edit artifact content' : editableState.reason}
                  onClick={() => closeActionsAfter(() => void startEdit())}
                >
                  {draft ? 'Resume draft' : 'Edit content'}
                </button>
                <button
                  type="button"
                  className="artifact-detail__actions-item"
                  role="menuitem"
                  onClick={() => closeActionsAfter(onToggleVersionHistory)}
                >
                  Version history
                </button>
                {selectedVersionNo !== null && (
                  <button
                    type="button"
                    className="artifact-detail__actions-item"
                    role="menuitem"
                    onClick={() => closeActionsAfter(() => onVersionChange(null))}
                  >
                    Jump to latest
                  </button>
                )}
                <button
                  type="button"
                  className="artifact-detail__actions-item"
                  role="menuitem"
                  disabled={!selectedVersion || !previousVersion}
                  onClick={() => closeActionsAfter(() => setDiffOpen((open) => !open))}
                >
                  Diff vs previous
                </button>
              </div>
            )}
            <AddToSpace
              anchorRef={actionsTriggerRef}
              projectId={spaceProjectId}
              targets={spaceTargets}
              label="Add to Space"
              hideTrigger
              open={spacePickerOpen}
              onOpenChange={setSpacePickerOpen}
            />
          </div>
          )}
          actionsLabel="Artifact actions"
        />
      )}
      overlays={overlays}
    >
        {resolution?.warnings?.includes('series_latest_not_pinned') && (
          <div className="artifact-detail__warning">series_latest_not_pinned</div>
        )}
        {editMode && draft ? (
            <ArtifactEditorSection
              draft={draft}
              value={draftValue}
              label={draftLabel}
              note={draftNote}
              saving={draftSaving}
              loading={draftLoading}
              status={draftStatus}
              onChange={setDraftValue}
              onLabelChange={setDraftLabel}
              onNoteChange={setDraftNote}
              onSave={() => void saveDraftNow()}
              onPublish={() => void publishDraft(false)}
              onPublishStale={() => void publishDraft(true)}
              onRebase={() => void rebaseDraft()}
              onDiscard={() => void discardDraft()}
              onClose={() => setEditMode(false)}
            />
          ) : (
            <>
              {!editableState.editable && editableState.showBodyHint && (
                <div className="artifact-detail__hint artifact-detail__hint--edit">{editableState.reason}</div>
              )}
              {draft && (
                <div className="artifact-detail__draft-banner">
                  <span>Draft saved for v{draft.base_version_no}</span>
                  <button type="button" className="artifact-detail__inline-button" onClick={() => setEditMode(true)}>Resume</button>
                  <button type="button" className="artifact-detail__inline-button" onClick={() => void discardDraft()}>Discard</button>
                </div>
              )}
              <PreviewSection
                preview={preview}
                content={content}
                contentLoading={contentLoading}
                contentError={contentError}
                jsonView={jsonView}
              />
            </>
          )}
          {diffOpen && selectedVersion && previousVersion && (
            <section className="artifact-detail__section artifact-detail__diff" aria-label="Artifact version diff">
              <div className="artifact-detail__section-heading">
                <h3>Diff v{previousVersion.version_no} → v{selectedVersion.version_no}</h3>
                <button type="button" className="artifact-detail__inline-button" onClick={() => setDiffOpen(false)}>Hide</button>
              </div>
              {diffLoading && <div className="artifacts-empty" role="status">Loading diff...</div>}
              {!diffLoading && diffError && <div className="artifacts-empty">Diff unavailable.</div>}
              {!diffLoading && !diffError && versionDiff?.unified && (
                <DiffView diffText={versionDiff.unified} ariaLabel="Artifact version diff" />
              )}
              {!diffLoading && !diffError && versionDiff && !versionDiff.unified && (
                <div className="artifacts-empty">{versionDiff.reason || 'No textual diff is available.'}</div>
              )}
            </section>
          )}
          {artifact.links && artifact.links.length > 0 && (
            <section className="artifact-detail__section">
              <h3>Links</h3>
              <div className="artifact-detail__list">
                {artifact.links.map((link) => (
                  <div key={link.id} className="artifact-detail__list-item artifact-detail__list-item--artifact-link">
                    <a className="artifact-detail__entity-link" href={entityHref(link.entity_type, link.entity_id, link.repo_id)}>
                      <code>{link.entity_type}:{link.entity_id}</code>
                    </a>
                    <span className="artifact-detail__link-meta">
                      <span>{link.link_type}</span>
                      <a
                        className={`type-badge type-badge--sm artifact-link-badge artifact-link-badge--${artifactLinkKind(link)}`}
                        href={artifactLinkBadgeHref(link)}
                      >
                        {artifactLinkBadgeLabel(link)}
                      </a>
                    </span>
                    <span>{link.role || link.source}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {(knowledgeLoading || knowledgeError || knowledgeBackrefs.length > 0) && (
            <section className="artifact-detail__section">
              <h3>Knowledge Backrefs</h3>
              {knowledgeLoading && <div className="artifacts-empty">Loading knowledge references...</div>}
              {!knowledgeLoading && knowledgeError && <div className="artifacts-empty">Knowledge references unavailable.</div>}
              {!knowledgeLoading && !knowledgeError && knowledgeBackrefs.length > 0 && (
                <div className="artifact-detail__list">
                  {knowledgeBackrefs.map((backref) => (
                    <div key={backref.id} className="artifact-detail__list-item artifact-detail__list-item--backref">
                      <code>{backref.external_ref || backref.external_id}</code>
                      <span>{backref.ref_type}</span>
                      <span>{backref.provider_id}</span>
                      <span>{backref.status}</span>
                    </div>
                  ))}
                </div>
            )}
          </section>
          )}
    </DetailPaneShell>
  );
}

/**
 * Resolve the project scope for an artifact's Add-to-Space picker from its first
 * issue link. Artifacts carry repo-scoped links, not a project id; an issue link
 * is the durable bridge to a `ledger_projects.id`. Returns `null` when the
 * artifact has no issue link (the picker then self-disables).
 */
function useArtifactSpaceProject(artifact: ArtifactRecord): string | null {
  const issueLink = (artifact.links ?? []).find((link) => link.entity_type === 'issue');
  const issueEntityId = issueLink?.entity_id ?? null;
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!issueEntityId) {
      setProjectId(null);
      return undefined;
    }
    let active = true;
    setProjectId(null);
    getLedgerIssueDetail(issueEntityId)
      .then((detail) => {
        if (active) setProjectId(detail.project.id);
      })
      .catch(() => {
        if (active) setProjectId(null);
      });
    return () => {
      active = false;
    };
  }, [issueEntityId]);

  return projectId;
}

type ArtifactEditableState = {
  editable: boolean;
  reason: string;
  showBodyHint: boolean;
  sourceText: string;
  mediaType: string | null;
};

function artifactEditableState(
  artifact: ArtifactRecord,
  content: ArtifactContentResult | null,
): ArtifactEditableState {
  const mediaType = content?.media_type ?? artifact.media_type ?? null;
  if (!content || content.status !== 'available' || !content.preview) {
    return {
      editable: false,
      reason: 'Editing unavailable until artifact text is materialized.',
      showBodyHint: true,
      sourceText: '',
      mediaType,
    };
  }
  if (content.preview.truncated) {
    return {
      editable: false,
      reason: 'Editing unavailable for partial previews; full text is required.',
      showBodyHint: true,
      sourceText: '',
      mediaType,
    };
  }
  if (content.kind !== 'text' && content.kind !== 'markdown') {
    return {
      editable: false,
      reason: 'Edit content is unavailable for this artifact type.',
      showBodyHint: false,
      sourceText: '',
      mediaType,
    };
  }
  return {
    editable: true,
    reason: artifact.custody_mode === 'git'
      ? 'Publishing will snapshot the edited text as a managed artifact version.'
      : 'Editable text artifact.',
    showBodyHint: false,
    sourceText: content.preview.text,
    mediaType,
  };
}

function ArtifactEditorSection({
  draft,
  value,
  label,
  note,
  saving,
  loading,
  status,
  onChange,
  onLabelChange,
  onNoteChange,
  onSave,
  onPublish,
  onPublishStale,
  onRebase,
  onDiscard,
  onClose,
}: {
  draft: ArtifactDraftRecord;
  value: string;
  label: string;
  note: string;
  saving: boolean;
  loading: boolean;
  status: string | null;
  onChange: (value: string) => void;
  onLabelChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSave: () => void;
  onPublish: () => void;
  onPublishStale: () => void;
  onRebase: () => void;
  onDiscard: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <section className="artifact-detail__section artifact-editor" aria-label="Artifact editor">
      <div className="artifact-editor__header">
        <div>
          <h3>Edit content</h3>
          <p>Draft based on v{draft.base_version_no}{draft.latest_version_no ? `; latest is v${draft.latest_version_no}` : ''}</p>
        </div>
        <div className="artifact-editor__status" role="status">
          {saving ? 'Saving...' : loading ? 'Loading draft...' : status}
        </div>
      </div>
      {draft.stale && (
        <div className="artifact-detail__warning artifact-editor__stale">
          <span>Draft based on v{draft.base_version_no}; v{draft.latest_version_no} exists.</span>
          <button type="button" onClick={onPublishStale}>Publish anyway</button>
          <button type="button" onClick={onRebase}>Rebase draft</button>
          <button type="button" onClick={onDiscard}>Discard draft</button>
        </div>
      )}
      <div className="artifact-editor__fields">
        <label>
          <span>Version label</span>
          <input value={label} onInput={(event) => onLabelChange(event.currentTarget.value)} placeholder="Optional label" />
        </label>
        <label>
          <span>Version note</span>
          <input value={note} onInput={(event) => onNoteChange(event.currentTarget.value)} placeholder="Optional note" />
        </label>
      </div>
      <MarkdownSourceEditor
        blockId={`artifact-draft:${draft.series_id}`}
        value={value}
        ariaLabel="Artifact draft Markdown source"
        onChange={(nextValue) => onChange(nextValue)}
        onBlur={(nextValue) => onChange(nextValue)}
        onCaretChange={() => undefined}
        onSelectionChange={() => undefined}
        onItemCommand={() => undefined}
        onOpenReference={() => undefined}
        onBoundaryArrow={(_blockId, _direction) => false}
      />
      <div className="artifact-editor__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>Close editor</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onSave} disabled={saving}>Save draft</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDiscard} disabled={saving}>Discard draft</button>
        <button type="button" className="btn btn--primary btn--sm" onClick={onPublish} disabled={saving || draft.stale}>
          Save as new version
        </button>
      </div>
    </section>
  );
}

function PreviewSection({
  preview,
  content,
  contentLoading,
  contentError,
  jsonView,
}: {
  preview: ArtifactPreview | null;
  content: ArtifactContentResult | null;
  contentLoading: boolean;
  contentError: string | null;
  jsonView: 'formatted' | 'raw';
}): JSX.Element {
  const showPreview = !contentError && preview !== null;
  const codePreview = preview && (preview.kind === 'json' || preview.kind === 'text') ? preview : null;
  const previewValue = codePreview
    ? (codePreview.autoFormatted && jsonView === 'raw' ? codePreview.rawValue : codePreview.value)
    : '';
  const highlightLanguage = codePreview
    && !codePreview.partial
    && previewValue.length <= ARTIFACT_HIGHLIGHT_MAX_CHARS
    ? codePreview.highlightLanguage
    : null;
  const highlightedPreview = useMemo(() => (
    codePreview ? highlightArtifactCode(previewValue, highlightLanguage) : null
  ), [codePreview, previewValue, highlightLanguage]);
  const virtualizedPreview = Boolean(
    codePreview && !highlightedPreview && shouldVirtualizeArtifactPreview(previewValue),
  );
  const codeClassName = highlightedPreview
    ? `hljs language-${highlightedPreview.language}`
    : undefined;
  const codePreviewClassName = [
    'artifact-preview',
    'artifact-preview--code',
    codePreview?.partial ? 'artifact-preview--partial' : '',
  ].filter(Boolean).join(' ');
  return (
    <>
        {!showPreview && contentLoading && <div className="artifacts-empty" role="status">Loading preview...</div>}
        {!contentLoading && contentError && <div className="artifacts-empty">Content unavailable.</div>}
        {showPreview && content?.warnings?.map((warning) => (
        <div key={warning} className="artifact-detail__warning">{warning}</div>
        ))}
        {showPreview && preview.kind === 'bundle' && <BundlePreview preview={preview} />}
        {showPreview && preview.kind === 'json' && (
          virtualizedPreview ? (
            <VirtualizedCodePreview value={previewValue} className={codePreviewClassName} codeClassName={codeClassName} />
          ) : (
            <pre className={codePreviewClassName}>
              {highlightedPreview ? (
                <code className={codeClassName} dangerouslySetInnerHTML={{ __html: highlightedPreview.html }} />
              ) : (
                <code>{previewValue}</code>
              )}
            </pre>
          )
        )}
        {showPreview && preview.kind === 'text' && (
          virtualizedPreview ? (
            <VirtualizedCodePreview value={previewValue} className={codePreviewClassName} codeClassName={codeClassName} />
          ) : (
            <pre className={codePreviewClassName}>
              {highlightedPreview ? (
                <code className={codeClassName} dangerouslySetInnerHTML={{ __html: highlightedPreview.html }} />
              ) : (
                <code>{previewValue}</code>
              )}
            </pre>
          )
        )}
        {showPreview && virtualizedPreview && (
          <div className="artifact-detail__hint">
            Large preview windowed for smoother scrolling. <button type="button" className="artifact-detail__inline-button" onClick={() => void copyText(previewValue)}>Copy full preview</button>
          </div>
        )}
        {showPreview && preview.kind === 'html' && (
          <iframe
            className="artifact-preview artifact-preview--html"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={preview.value}
            title="Artifact HTML preview"
          />
        )}
        {showPreview && preview.kind === 'markdown' && (
          <div className="artifact-preview spec-panel rendered-markdown" dangerouslySetInnerHTML={{ __html: preview.value }} />
        )}
        {showPreview && preview.kind === 'binary' && (
          <div className="artifacts-empty">
            Binary artifact available ({formatBytes(content?.download.size_bytes ?? 0) || content?.download.media_type}).
          </div>
        )}
        {showPreview && preview.kind === 'empty' && <div className="artifacts-empty">{preview.value}</div>}
        {showPreview && preview && (preview.kind === 'json' || preview.kind === 'text') && preview.partial && (
          <div className="artifact-detail__hint">
            Showing the first {formatBytes(preview.previewBytes ?? content?.preview?.preview_bytes ?? 0) || 'preview'} of {formatBytes(preview.totalBytes ?? content?.size_bytes ?? 0) || 'the artifact'}.
            {preview.formatSkipped ? ' Formatting and highlighting are skipped for this partial preview.' : ''}
          </div>
        )}
        {showPreview && content?.preview?.truncated && (!preview || preview.kind === 'markdown' || preview.kind === 'html') && (
          <div className="artifact-detail__hint">Preview truncated at the server limit.</div>
        )}
    </>
  );
}

type VirtualRange = { start: number; end: number };

const ARTIFACT_PREVIEW_VIRTUALIZE_MIN_CHARS = 100 * 1024;
const ARTIFACT_PREVIEW_VIRTUALIZE_MIN_LINES = 400;
const ARTIFACT_PREVIEW_LINE_HEIGHT = 20;
const ARTIFACT_PREVIEW_OVERSCAN_LINES = 16;

function shouldVirtualizeArtifactPreview(value: string): boolean {
  if (value.length < ARTIFACT_PREVIEW_VIRTUALIZE_MIN_CHARS) return false;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
    if (lines >= ARTIFACT_PREVIEW_VIRTUALIZE_MIN_LINES) return true;
  }
  return false;
}

function VirtualizedCodePreview({
  value,
  className,
  codeClassName,
}: {
  value: string;
  className: string;
  codeClassName?: string;
}): JSX.Element {
  const scrollerRef = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => value.split('\n'), [value]);
  const maxLineLength = useMemo(
    () => lines.reduce((max, line) => Math.max(max, line.length), 1),
    [lines],
  );
  const [range, setRange] = useState<VirtualRange>(() => ({
    start: 0,
    end: Math.min(lines.length, 80),
  }));

  const updateRange = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const visibleLines = Math.ceil(node.clientHeight / ARTIFACT_PREVIEW_LINE_HEIGHT);
    const start = Math.max(0, Math.floor(node.scrollTop / ARTIFACT_PREVIEW_LINE_HEIGHT) - ARTIFACT_PREVIEW_OVERSCAN_LINES);
    const end = Math.min(lines.length, start + visibleLines + ARTIFACT_PREVIEW_OVERSCAN_LINES * 2);
    setRange((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, [lines.length]);

  useEffect(() => {
    updateRange();
    const node = scrollerRef.current;
    if (!node) return undefined;
    node.addEventListener('scroll', updateRange, { passive: true });
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateRange) : null;
    resizeObserver?.observe(node);
    return () => {
      node.removeEventListener('scroll', updateRange);
      resizeObserver?.disconnect();
    };
  }, [updateRange]);

  const visibleLines = lines.slice(range.start, range.end);
  const totalHeight = Math.max(lines.length, 1) * ARTIFACT_PREVIEW_LINE_HEIGHT;
  return (
    <pre
      ref={scrollerRef}
      className={`${className} artifact-preview--virtualized`}
      aria-label={`Large preview, ${lines.length} lines`}
    >
      <code
        className={codeClassName}
        style={{ height: `${totalHeight}px`, minWidth: `${maxLineLength}ch` }}
      >
        <span
          className="artifact-preview__virtual-window"
          style={{ transform: `translateY(${range.start * ARTIFACT_PREVIEW_LINE_HEIGHT}px)` }}
        >
          {visibleLines.map((line, index) => (
            <span key={range.start + index} className="artifact-preview__virtual-line">
              {line || ' '}
            </span>
          ))}
        </span>
      </code>
    </pre>
  );
}

function BundlePreview({ preview }: { preview: Extract<ArtifactPreview, { kind: 'bundle' }> }): JSX.Element {
  return (
    <div className="artifact-preview-bundle">
      <div className="artifact-detail__hint">
        {preview.name ? `${preview.name}: ` : ''}{preview.members.length} member{preview.members.length === 1 ? '' : 's'}
      </div>
      {preview.members.length > 0 ? (
        <div className="artifact-detail__list artifact-detail__list--bundle">
          {preview.members.map((member) => (
            <a
              key={`${member.artifactId}:${member.order}`}
              className="artifact-detail__list-item artifact-detail__list-item--bundle"
              href={artifactDetailHref(member.artifactId)}
            >
              <code>{member.artifactId}</code>
              <span>{member.role || 'member'}</span>
              <span>{member.recoverability || 'recoverability unknown'}</span>
            </a>
          ))}
        </div>
      ) : (
        <div className="artifacts-empty">Bundle manifest has no members.</div>
      )}
      <details className="artifact-preview__details">
        <summary>Manifest JSON</summary>
        <pre className="artifact-preview"><code>{preview.manifestText}</code></pre>
      </details>
    </div>
  );
}

function UnresolvedArtifact({ resolution }: { resolution: ArtifactResolveResult }): JSX.Element {
  return (
    <article className="artifact-detail">
      <header className="artifact-detail__header">
        <div>
          <div className="artifact-detail__type">unresolved reference</div>
          <h2>{resolution.normalized_ref}</h2>
        </div>
      </header>
      <section className="artifact-detail__section">
        <h3>Resolver</h3>
        <KeyValue rows={[
          ['Scheme', resolution.scheme],
          ['Raw ref', resolution.ref],
          ['Normalized ref', resolution.normalized_ref],
          ['Status', resolution.status],
          ['Source', resolution.alias?.source ?? ''],
        ]} />
      </section>
    </article>
  );
}

function UnsupportedArtifactBlob({ resolution }: { resolution: ArtifactResolveResult }): JSX.Element {
  const issueUrl = `${PRODUCTION_ORIGIN}/#/issues?repo=mandible&issue=7da339a&sidebar=hidden`;
  return (
    <article className="artifact-detail">
      <header className="artifact-detail__header">
        <div>
          <div className="artifact-detail__type">artifact blob</div>
          <h2>{resolution.normalized_ref}</h2>
        </div>
      </header>
      <section className="artifact-detail__section">
        <h3>Direct blob view unavailable</h3>
        <p>
          Artifact blobs identify bytes, not logical artifacts or versions. Direct viewing is not supported yet;
          see issue <a href={issueUrl}>7da339a</a>.
        </p>
      </section>
    </article>
  );
}

function MetadataKeyValue({ rows }: { rows: MetadataRow[] }): JSX.Element {
  return (
    <div className="artifact-detail__kv">
      {rows.filter(([, value]) => value).map(([key, value, copyable, copyValue]) => (
        <div key={key}>
          <span>{key}</span>
          {copyable ? (
            <button
              type="button"
              className="artifact-detail__copy-value"
              onClick={() => void copyText(copyValue ?? value)}
              title={`Copy ${key}`}
            >
              <code>{value}</code>
            </button>
          ) : (
            <code>{value}</code>
          )}
        </div>
      ))}
    </div>
  );
}

function KeyValue({ rows }: { rows: Array<[string, string]> }): JSX.Element {
  return <MetadataKeyValue rows={rows} />;
}

function buildFacetOptions(series: ArtifactSeriesSummary[]): {
  schemes: string[];
  custodies: string[];
  availabilities: string[];
  repos: string[];
  providers: string[];
  roles: string[];
} {
  const schemes = new Set<string>();
  const custodies = new Set<string>();
  const availabilities = new Set<string>();
  const repos = new Set<string>();
  const providers = new Set<string>();
  const roles = new Set<string>();
  for (const entry of series) {
    const artifact = entry.latest_artifact;
    if (!artifact) {
      if (entry.repo_id) repos.add(entry.repo_id);
      continue;
    }
    if (artifact.custody_mode) custodies.add(artifact.custody_mode);
    availabilities.add(artifact.availability);
    if (artifact.home_repo_id) repos.add(artifact.home_repo_id);
    if (artifact.provider_id) providers.add(artifact.provider_id);
    if (artifact.role) roles.add(artifact.role);
    for (const alias of artifact.aliases ?? []) {
      schemes.add(alias.scheme);
    }
    for (const scheme of artifact.alias_schemes ?? []) {
      schemes.add(scheme);
    }
    const uriScheme = artifact.uri.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
    if (uriScheme) schemes.add(uriScheme.toLowerCase());
  }
  return {
    schemes: [...schemes].sort(),
    custodies: [...custodies].sort(),
    availabilities: [...availabilities].sort(),
    repos: [...repos].sort(),
    providers: [...providers].sort(),
    roles: [...roles].sort(),
  };
}

function seriesRef(series: ArtifactSeriesSummary): string {
  return series.ref || canonicalArtifactSeriesRef(series.id);
}

function seriesRecordRef(series: ArtifactSeriesRecord | ArtifactSeriesSummary): string {
  if ('ref' in series && series.ref) return series.ref;
  return canonicalArtifactSeriesRef(series.id);
}

function artifactLinkKind(link: ArtifactLinkRecord): 'pinned' | 'living' {
  return link.link_kind === 'living' ? 'living' : 'pinned';
}

function artifactLinkBadgeHref(link: ArtifactLinkRecord): string {
  const seriesRef = link.series_ref ? normalizeSeriesRef(link.series_ref) : link.series_id ? canonicalArtifactSeriesRef(link.series_id) : null;
  if (link.link_kind === 'living') {
    return seriesRef ? seriesDetailHref(seriesRef) : artifactDetailHref(link.artifact_id);
  }
  return seriesRef && typeof link.resolved_version_no === 'number'
    ? versionDetailHref(seriesRef, link.resolved_version_no)
    : artifactDetailHref(link.artifact_id);
}

function normalizeSeriesRef(ref: string): string {
  const trimmed = ref.trim();
  if (/^artifact-series:/i.test(trimmed)) return trimmed;
  return canonicalArtifactSeriesRef(trimmed);
}

function normalizeInitialSeriesRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (/^(artifact-blob:|artifact-version:|artifact:sha256:)/i.test(trimmed)) return null;
  return normalizeSeriesRef(trimmed);
}

function sortedVersionHistory(history: ArtifactVersionHistory): ArtifactVersionHistory {
  return {
    ...history,
    versions: [...history.versions].sort((a, b) => b.version_no - a.version_no),
  };
}

function writeArtifactHash(
  seriesRefValue: string,
  versionNo: number | null,
  lastWrittenHashRef: LastWrittenHashRef,
): void {
  if (typeof window === 'undefined') return;
  const nextHash = routeHashWithParams(window.location.hash, 'artifacts', {
    series: seriesRefValue, version: versionNo === null ? null : String(versionNo),
  }, ARTIFACT_ROUTE_SELECTORS);
  if (typeof window !== 'undefined' && window.location.hash !== nextHash) {
    lastWrittenHashRef.current = { seriesRef: seriesRefValue, versionNo };
    navigateAppHash(nextHash);
  }
}

function seriesTitle(series: ArtifactSeriesSummary): string {
  return artifactTitleCandidate(series.title ?? '')
    || artifactTitleCandidate(series.logical_name ?? '')
    || (series.latest_artifact ? artifactTitle(series.latest_artifact) : '')
    || series.series_key
    || seriesRef(series);
}

export type ArtifactDetailIdentity = {
  title: string;
  filename: string | null;
};

export function artifactDetailIdentity(
  artifact: ArtifactRecord,
  series: ArtifactSeriesRecord | ArtifactSeriesSummary | null,
  selectedVersion: ArtifactVersionRecord | null,
): ArtifactDetailIdentity {
  const logicalTitle = artifactTitleCandidate(series?.title ?? '')
    || artifactTitleCandidate(series?.logical_name ?? '')
    || artifactTitle(artifact);
  const filename = artifactFilename(artifact, selectedVersion);
  return {
    title: logicalTitle,
    filename: filename && filename !== logicalTitle ? filename : null,
  };
}

function artifactFilename(
  artifact: ArtifactRecord,
  selectedVersion: ArtifactVersionRecord | null,
): string {
  const declared = typeof artifact.metadata.filename === 'string' ? artifact.metadata.filename.trim() : '';
  if (declared) return basename(declared);
  const locator = selectedVersion?.observed_path
    || selectedVersion?.repo_path
    || (typeof artifact.repo_locator.path === 'string' ? artifact.repo_locator.path : '')
    || artifact.uri;
  return basename(locator);
}

function basename(locator: string): string {
  const withoutQuery = locator.trim().split(/[?#]/, 1)[0].replace(/[\\/]+$/, '');
  return withoutQuery.split(/[\\/]/).pop() ?? '';
}

function artifactTitle(artifact: ArtifactRecord): string {
  const metadataTitle = typeof artifact.metadata.title === 'string' ? artifact.metadata.title : '';
  const filename = typeof artifact.metadata.filename === 'string' ? artifact.metadata.filename : '';
  const logicalName = typeof artifact.metadata.logical_name === 'string' ? artifact.metadata.logical_name : '';
  const repoLocator = artifactRepoLocator(artifact);
  return artifactTitleCandidate(metadataTitle)
    || artifactTitleCandidate(logicalName)
    || filename
    || repoLocator
    || artifact.role
    || compactArtifactBlobRef(`artifact-blob:${artifact.content_hash}`);
}

function artifactRepoLocator(artifact: ArtifactRecord): string {
  const repoId = typeof artifact.repo_locator.repo_id === 'string' ? artifact.repo_locator.repo_id : '';
  const repoPath = typeof artifact.repo_locator.path === 'string' ? artifact.repo_locator.path : '';
  if (!repoId || !repoPath) return '';
  const ref = typeof artifact.repo_locator.ref === 'string' ? artifact.repo_locator.ref : '';
  return `repo://${repoId}${ref ? `@${ref}` : ''}/${repoPath.replace(/^\/+/, '')}`;
}

function artifactTitleCandidate(value: string): string {
  return value && displayResourceRef(value) === value ? value : '';
}

function shortSeriesId(ref: string): string {
  return ref.trim().replace(/^artifact-series:/i, '').replace(/^artifact:/i, '').slice(0, 7);
}

function shortArtifactId(ref: string): string {
  return ref.trim().replace(/^artifact:sha256:/i, '').replace(/^artifact-blob:/i, '').replace(/^artifact:/i, '').replace(/^sha256:/i, '').slice(0, 7).toLowerCase();
}

function canonicalArtifactSeriesRef(ref: string): string {
  const trimmed = ref.trim();
  const bare = trimmed.replace(/^artifact-series:/i, '').replace(/^artifact:/i, '');
  return `artifact-series:${bare}`;
}

function artifactCreatedUpdated(
  artifact: ArtifactRecord,
  series: ArtifactSeriesRecord | ArtifactSeriesSummary | null,
  versions: ArtifactVersionRecord[],
): { created: number; updated: number } {
  const versionTimes = versions.map((version) => version.created_at).filter((value) => value > 0);
  if (versionTimes.length > 0) {
    return {
      created: Math.min(...versionTimes),
      updated: Math.max(...versionTimes),
    };
  }
  return {
    created: series?.created_at || artifact.created_at,
    updated: series?.updated_at || artifact.created_at,
  };
}

async function copyText(value: string): Promise<void> {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
  await navigator.clipboard.writeText(value);
}

export function artifactPreview(content: ArtifactContentResult): ArtifactPreview {
  if (content.kind === 'json' && content.preview) {
    const bundle = content.preview.truncated ? null : artifactBundlePreview(content.preview.text);
    if (bundle) return bundle;
    const rawValue = content.preview.raw_text ?? content.preview.text;
    return {
      kind: 'json',
      value: content.preview.text,
      rawValue,
      autoFormatted: content.preview.formatted === 'json' && rawValue !== content.preview.text,
      highlightLanguage: content.preview.truncated ? null : 'json',
      partial: content.preview.truncated,
      previewBytes: content.preview.preview_bytes,
      totalBytes: content.preview.total_bytes,
      omittedBytes: content.preview.omitted_bytes,
      formatSkipped: content.preview.format_skipped,
    };
  }
  if (content.kind === 'html' && content.preview) {
    return { kind: 'html', value: content.preview.text };
  }
  if (content.kind === 'markdown' && content.preview) {
    // Repo-authoritative document path (Spaces C14b, issue 591e568). A
    // registered repo file that is Markdown / `spaces-doc.v1` renders directly
    // through the SECURE, NON-EXECUTABLE C14a pipeline (parse -> sanitize via
    // DOMPurify) instead of a raw `marked.parse`, so no document directive can
    // execute script. `spaces-doc.v1` block prose is composed in document order;
    // plain Markdown renders as a single sanitized prose body. Both forms have
    // their resource refs linkified through the shared C6 unresolved-ref UI.
    const rendered = renderDocumentText(content.preview.text);
    return { kind: 'markdown', value: rendered.html };
  }
  if (content.kind === 'text' && content.preview) {
    const formattedJson = formatJsonLikePreview(content.preview.text, content.preview.truncated);
    if (formattedJson) {
      return {
        kind: 'text',
        value: formattedJson,
        rawValue: content.preview.text,
        autoFormatted: true,
        highlightLanguage: 'json',
        partial: false,
        previewBytes: content.preview.preview_bytes,
        totalBytes: content.preview.total_bytes,
        omittedBytes: content.preview.omitted_bytes,
      };
    }
    return {
      kind: 'text',
      value: content.preview.text,
      rawValue: content.preview.text,
      autoFormatted: false,
      highlightLanguage: content.preview.truncated ? null : artifactHighlightLanguage(content),
      partial: content.preview.truncated,
      previewBytes: content.preview.preview_bytes,
      totalBytes: content.preview.total_bytes,
      omittedBytes: content.preview.omitted_bytes,
      formatSkipped: content.preview.format_skipped,
    };
  }
  if (content.kind === 'binary' && content.download.available) {
    return { kind: 'binary', value: content.download.media_type };
  }
  if (content.reason) {
    return { kind: 'empty', value: content.reason };
  }
  return { kind: 'empty', value: 'No inline preview is available for this artifact.' };
}

const ARTIFACT_HIGHLIGHT_LANGUAGES = {
  bash,
  cpp,
  css,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  r,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

type ArtifactHighlightLanguage = keyof typeof ARTIFACT_HIGHLIGHT_LANGUAGES;
const ARTIFACT_HIGHLIGHT_MAX_CHARS = 256 * 1024;

const REGISTERED_ARTIFACT_HIGHLIGHT_LANGUAGES = new Set<ArtifactHighlightLanguage>();

function ensureArtifactHighlightLanguage(language: ArtifactHighlightLanguage): void {
  if (REGISTERED_ARTIFACT_HIGHLIGHT_LANGUAGES.has(language)) return;
  hljs.registerLanguage(language, ARTIFACT_HIGHLIGHT_LANGUAGES[language]);
  REGISTERED_ARTIFACT_HIGHLIGHT_LANGUAGES.add(language);
}

export function highlightArtifactCode(
  code: string,
  language: ArtifactHighlightLanguage | null,
): { html: string; language: ArtifactHighlightLanguage } | null {
  if (!language || !code) return null;
  if (code.length > ARTIFACT_HIGHLIGHT_MAX_CHARS) return null;
  ensureArtifactHighlightLanguage(language);
  return {
    html: hljs.highlight(code, { language, ignoreIllegals: true }).value,
    language,
  };
}

export function artifactHighlightLanguage(content: ArtifactContentResult): ArtifactHighlightLanguage | null {
  if (content.kind === 'json') return 'json';
  const mediaType = content.media_type.toLowerCase();
  if (mediaType.includes('json')) return 'json';
  if (mediaType.includes('javascript')) return 'javascript';
  if (mediaType.includes('typescript')) return 'typescript';
  if (mediaType.includes('python')) return 'python';
  if (mediaType.includes('x-sh') || mediaType.includes('shellscript')) return 'bash';
  const filename = content.download.filename?.toLowerCase() ?? '';
  return ARTIFACT_HIGHLIGHT_LANGUAGE_BY_EXTENSION[fileExtension(filename)] ?? null;
}

const ARTIFACT_HIGHLIGHT_LANGUAGE_BY_EXTENSION: Record<string, ArtifactHighlightLanguage> = {
  '.bash': 'bash',
  '.c': 'cpp',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.css': 'css',
  '.go': 'go',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.html': 'xml',
  '.htm': 'xml',
  '.ini': 'ini',
  '.java': 'java',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.mjs': 'javascript',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.py': 'python',
  '.r': 'r',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'bash',
  '.sql': 'sql',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'bash',
};

function fileExtension(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const index = basename.lastIndexOf('.');
  return index > 0 ? basename.slice(index) : '';
}

function formatJsonLikePreview(text: string, truncated: boolean): string | null {
  if (truncated) return null;
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) && !isRecord(parsed)) return null;
    const formatted = JSON.stringify(parsed, null, 2);
    return formatted !== trimmed ? formatted : null;
  } catch {
    return null;
  }
}

function artifactBundlePreview(text: string): Extract<ArtifactPreview, { kind: 'bundle' }> | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(manifest) || manifest.schema_version !== 'mandible.artifact_bundle.v1') return null;
  const members = Array.isArray(manifest.members) ? manifest.members : [];
  return {
    kind: 'bundle',
    manifestText: text,
    name: stringValue(manifest.name),
    members: members.map((member, index): BundleMemberPreview | null => {
      if (!isRecord(member)) return null;
      const artifactId = stringValue(member.artifact_id);
      if (!artifactId) return null;
      return {
        artifactId,
        role: stringValue(member.role),
        recoverability: stringValue(member.recoverability),
        order: typeof member.order === 'number' ? member.order : index,
      };
    }).filter((member): member is BundleMemberPreview => Boolean(member)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: number): string {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function entityHref(type: string, id: string, repoId: string | null): string {
  if (type === 'issue') {
    const params = new URLSearchParams({ issue: id });
    if (repoId) params.set('repo', repoId);
    return `#/issues?${params.toString()}`;
  }
  if (type === 'auth_request') return `#/auth?request=${encodeURIComponent(shortRouteId(id))}`;
  if (type === 'session') return `#/sessions?session=${encodeURIComponent(id)}`;
  if (type === 'provider_manifest') return `#/graph?mode=provider-lineage&focus=${encodeURIComponent(id)}`;
  return `#/graph?focus=${encodeURIComponent(id)}`;
}

async function warmArtifactDetail(artifactId: string, knownArtifact: ArtifactRecord | null): Promise<void> {
  const detailStarted = beginDetailRequest();
  const artifact = knownArtifact?.id === artifactId ? knownArtifact : await getArtifact(artifactId);
  writePersistedDetail('artifact-record', detailRequestKey('artifact-record', { id: artifactId }), artifact, undefined, detailStarted);
  const [content, backrefs] = await Promise.all([
    getArtifactContent(artifactId),
    getArtifactKnowledgeBackrefs(artifactId),
  ]);
  writePersistedDetail('artifact-content', detailRequestKey('artifact-content', { id: artifactId }), content, undefined, detailStarted);
  writePersistedDetail('artifact-backrefs', detailRequestKey('artifact-backrefs', { id: artifactId }), backrefs, undefined, detailStarted);
}

/** Warm the Artifacts list and only its explicit, saved, or default selection. */
export async function warmInitialData(params: Record<string, string>): Promise<void> {
  const detailStarted = beginDetailRequest();
  const selection = artifactRouteSelection({
    artifactId: params.artifact,
    ref: params.ref,
    seriesRef: params.series,
    versionNo: parseArtifactVersionParam(params.version),
  });
  const viewState = readPersistedViewState(
    ARTIFACT_LIST_STATE_KEY,
    normalizeArtifactListViewState,
    DEFAULT_ARTIFACT_LIST_STATE,
  );
  const listFilters = {
    ...viewState.filters,
    repo: params.repo || viewState.filters.repo,
    role: params.role || viewState.filters.role,
  };
  const ordered = sortArtifactSeries(
    await getArtifactSeriesList(artifactSeriesListRequest(listFilters)),
    viewState.sortField,
    viewState.sortDirection,
  );

  let selectedSeriesRef: string | null = null;
  let selectedVersionNo: number | null = null;
  let selectedArtifactId: string | null = null;
  let resolvedArtifact: ArtifactRecord | null = null;
  let loadedHistory: ArtifactVersionHistory | null = null;

  if (selection.artifactId || selection.ref) {
    const resolution = await resolveArtifact(selection.artifactId ?? selection.ref ?? '');
    if (resolution.target_type === 'artifact_blob') return;
    resolvedArtifact = resolvedArtifactRecord(resolution);
    selectedSeriesRef = resolution.logical_artifact
      ? canonicalArtifactSeriesRef(resolution.logical_artifact.id)
      : null;
    const forcePinned = Boolean(selection.artifactId) && !/^artifact-series:/i.test(resolution.ref);
    const latestTracking = resolution.warnings?.includes('series_latest_not_pinned') && !forcePinned;
    selectedVersionNo = resolution.artifact_version && !latestTracking
      ? resolution.artifact_version.version_no
      : null;
    selectedArtifactId = resolvedArtifactRecord(resolution)?.id ?? resolution.artifact_version?.id ?? null;

    if (selection.artifactId && resolvedArtifactRecord(resolution) && !resolution.logical_artifact && !resolution.artifact_version) {
      try {
        loadedHistory = sortedVersionHistory(await getArtifactVersions(resolvedArtifactRecord(resolution)!.id));
        writePersistedDetail(
          'artifact-versions',
          detailRequestKey('artifact-versions', { ref: resolvedArtifactRecord(resolution)!.id }),
          loadedHistory,
          undefined,
          detailStarted,
        );
        const pinnedVersion = loadedHistory.versions.find((version) => version.artifact_id === resolvedArtifactRecord(resolution)?.id) ?? null;
        if (pinnedVersion) {
          selectedSeriesRef = seriesRecordRef(loadedHistory.series);
          selectedVersionNo = pinnedVersion.version_no;
          selectedArtifactId = resolvedArtifactRecord(resolution)!.id;
        }
      } catch (error) {
        if (!isApiErrorStatus(error, 404)) throw error;
      }
    }
  } else if (selection.hasInvalidSeries) {
    return;
  } else {
    selectedSeriesRef = selection.seriesRef
      ?? viewState.selectedSeriesRef
      ?? (selection.hasDeepLink ? null : (ordered[0] ? seriesRef(ordered[0]) : null));
    selectedVersionNo = selection.seriesRef
      ? selection.versionNo
      : viewState.selectedSeriesRef ? viewState.selectedVersionNo : null;
  }

  if (selectedSeriesRef) {
    loadedHistory = loadedHistory && seriesRecordRef(loadedHistory.series) === selectedSeriesRef
      ? loadedHistory
      : sortedVersionHistory(await getArtifactVersions(selectedSeriesRef));
    writePersistedDetail(
      'artifact-versions',
      detailRequestKey('artifact-versions', { ref: selectedSeriesRef }),
      loadedHistory,
      undefined,
      detailStarted,
    );
    const selectedVersion = selectedVersionNo === null
      ? loadedHistory.versions[0] ?? null
      : loadedHistory.versions.find((version) => version.version_no === selectedVersionNo) ?? null;
    selectedArtifactId = selectedVersion?.artifact_id ?? null;
  }

  if (selectedArtifactId) await warmArtifactDetail(selectedArtifactId, resolvedArtifact);
}
