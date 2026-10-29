import { useQuery } from '@tanstack/preact-query';
import { useState } from 'preact/hooks';
import { resolvedArtifactRecord } from '../../../src/artifact-identity';
import { useViewActive } from '../app-shell';
import { isApiErrorStatus } from '../api';
import { queryClient } from '../query/client';
import {
  artifactResolutionOptions, artifactVersionsOptions, artifactRecordOptions,
  artifactContentOptions, artifactBackrefsOptions, queryErrorMessage, detailQueryData,
} from '../query/details';

export function useArtifactDetail({ reference = null, seriesRef = null, versionNo }: {
  reference?: string | null;
  seriesRef?: string | null;
  versionNo?: number | null;
}) {
  const active = useViewActive();
  const resolutionOptions = artifactResolutionOptions(reference);
  const resolutionQuery = useQuery({ ...resolutionOptions, enabled: active && Boolean(reference) }, queryClient);
  const resolution = reference ? detailQueryData(resolutionQuery, resolutionOptions) ?? null : null;
  const resolvedRecord = resolution?.target_type === 'artifact_blob' ? null : resolvedArtifactRecord(resolution);
  const historyRef = seriesRef ?? (resolution?.logical_artifact
    ? `artifact-series:${resolution.logical_artifact.id.replace(/^artifact(?:-series)?:/i, '')}`
    : resolvedRecord?.id ?? null);
  const versionsOptions = artifactVersionsOptions(historyRef);
  const versionsQuery = useQuery({ ...versionsOptions, enabled: active && Boolean(historyRef) }, queryClient);
  const invalidHistory = isApiErrorStatus(versionsQuery.error, 404) || isApiErrorStatus(versionsQuery.error, 409);
  const history = historyRef && !invalidHistory ? detailQueryData(versionsQuery, versionsOptions) ?? null : null;
  const pinned = resolution?.artifact_version && !resolution.warnings?.includes('series_latest_not_pinned')
    ? resolution.artifact_version.version_no : null;
  const selectedVersionNo = versionNo === undefined ? pinned : versionNo;
  const selectedVersion = selectedVersionNo === null
    ? history?.versions[0] ?? null
    : history?.versions.find((entry) => entry.version_no === selectedVersionNo) ?? null;
  const id = selectedVersion?.artifact_id ?? resolvedRecord?.id ?? null;
  const recordOptions = artifactRecordOptions(id);
  const recordQuery = useQuery({ ...recordOptions, enabled: active && Boolean(id) }, queryClient);
  const contentOptions = artifactContentOptions(id);
  const contentQuery = useQuery({ ...contentOptions, enabled: active && Boolean(id) }, queryClient);
  let artifact = id ? detailQueryData(recordQuery, recordOptions) ?? (resolvedRecord?.id === id ? resolvedRecord : null) : null;
  let content = id ? detailQueryData(contentQuery, contentOptions) ?? null : null;
  let displayedVersion = selectedVersion;
  const displayScope = JSON.stringify([historyRef, selectedVersionNo]);
  const [displayed, setDisplayed] = useState<{ scope: string; id: string } | null>(null);
  if (artifact?.id === id && content?.artifact_id === id) {
    if (id && (displayed?.scope !== displayScope || displayed.id !== id)) setDisplayed({ scope: displayScope, id });
  } else if (displayed && displayed.scope !== displayScope) {
    setDisplayed(null);
  } else if (selectedVersionNo === null && displayed?.scope === displayScope) {
    const previousRecordOptions = artifactRecordOptions(displayed.id);
    const previousContentOptions = artifactContentOptions(displayed.id);
    const previousArtifact = queryClient.getQueryData(previousRecordOptions.queryKey) ?? previousRecordOptions.restartSnapshot();
    const previousContent = queryClient.getQueryData(previousContentOptions.queryKey) ?? previousContentOptions.restartSnapshot();
    const previousVersion = history?.versions.find((version) => version.artifact_id === displayed.id);
    if (previousArtifact && previousContent && previousVersion) {
      artifact = previousArtifact;
      content = previousContent;
      displayedVersion = previousVersion;
    }
  }
  const backrefsId = artifact?.id ?? id;
  const backrefsOptions = artifactBackrefsOptions(backrefsId);
  const backrefsQuery = useQuery({ ...backrefsOptions, enabled: active && Boolean(backrefsId) }, queryClient);
  const error = queryErrorMessage(resolutionQuery.error ?? versionsQuery.error ?? recordQuery.error);
  return {
    resolution, history, selectedVersion: displayedVersion, selectedVersionNo,
    historyCurrent: !versionsQuery.isPlaceholderData && !versionsQuery.isError,
    artifact: invalidHistory ? null : artifact,
    content,
    backrefs: backrefsId ? detailQueryData(backrefsQuery, backrefsOptions) ?? [] : [],
    loading: Boolean((reference && resolutionQuery.isPending) || (historyRef && versionsQuery.isPending) || (id && recordQuery.isPending)),
    error,
    contentLoading: Boolean(id && !content && contentQuery.isPending),
    contentError: queryErrorMessage(contentQuery.error),
    backrefsLoading: Boolean(id && backrefsQuery.isPending),
    backrefsError: queryErrorMessage(backrefsQuery.error),
  };
}
