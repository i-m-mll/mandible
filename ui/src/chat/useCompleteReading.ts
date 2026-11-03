import { skipToken, useQuery } from '@tanstack/preact-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { queryClient } from '../query/client';
import { readingManifestOptions, acquirePresentationRows, type ReadingRowsLease, isReadingPublicationChanged, ReadingPresentationError } from '../query/readingPresentation';
import { composeConversationReading, readingCompositionRequests, materializeConversationReading } from '../../../src/presentation/reading-composition';
import type { StreamEvent } from '../components/stream-renderer/types';
import type { ReadingProjection, ReadingRow } from './readingProjection';
import type { ReadingBodyDemand } from './readingBodyDemand';
import type { MeasurementRow, MaterializedMeasurementBatch } from './readingMeasurement';
import { activityTargetsFromReadingRows } from '../../../src/presentation/activity-presentation';
import { activityTargetKey } from '../../../src/presentation/activity-targets';
import { activityTargetOptions, useActivityTargetResolutions } from '../query/activityTargets';
import { activityTargetDisplayLabel, type ActivityTargetLabels } from '../components/shared/ActivityTargetLinks';

export const readingPayloadKey = (row: MeasurementRow): string => JSON.stringify([row.key, row.revision, row.disclosureIdentity ?? '']);
export const readingBodyKey = (row: MeasurementRow): string => JSON.stringify([row.key, row.revision, row.bodyIdentity ?? row.disclosureIdentity ?? '']);

export function useCompleteReading(input: {
  scope: string; space: string; events: readonly StreamEvent[]; sourceVersion?: string | null; total?: number;
  initial: boolean; targetPosition?: number; targetRowKey?: string; targetMemberKey?: string; targetSummary?: boolean;
  actionIdentity: string; selectMode?: boolean; selectedBlockIds?: ReadonlySet<string>; extraRows: readonly (ReadingRow & { revision: string })[];
  expanded: Readonly<Record<string, boolean>>; disclosureRevisions: Readonly<Record<string, number>>;
  streaming?: boolean; local: ReadingProjection; enabled: boolean;
}) {
  const manifest = useQuery({ ...readingManifestOptions(input.scope, input.space), enabled: input.enabled && Boolean(input.space) }, queryClient);
  useEffect(() => { if (input.enabled) void queryClient.invalidateQueries({ queryKey: readingManifestOptions(input.scope, input.space).queryKey }); }, [input.scope, input.space, input.sourceVersion, input.total, input.enabled]);
  const composition = useMemo(() => manifest.data ? composeConversationReading({ manifest: manifest.data, events: input.events, expanded: input.expanded, streaming: input.streaming }) : null,
    [manifest.data, input.events, input.expanded, input.streaming]);
  const plan = composition?.plan ?? null;
  const bodyRows = useMemo<readonly MeasurementRow[]>(() => {
    const source = input.enabled ? plan?.rows ?? [] : input.local.rows;
    const ends = new Map<string, string>();
    for (const row of source) if (row.disclosureOwner) ends.set(row.disclosureOwner, row.key);
    return input.enabled ? [...(plan?.rows ?? []).map(row => ({ key: row.key, revision: row.revision,
    disclosureEnd: row.kind === 'activity-summary' ? ends.get(row.disclosureOwner!) : undefined,
    disclosureIdentity: JSON.stringify([input.disclosureRevisions[row.key] ?? 0, input.actionIdentity, Boolean(input.selectMode), row.sourcePositions.map(position => Boolean(input.expanded[`reveal:${position}`])),
      row.sourcePositions.some(position => input.selectedBlockIds?.has(`cblk:${input.scope}:${position}`))]) })), ...input.extraRows]
    : [...input.local.rows.map(row => ({ key: row.key, revision: JSON.stringify(row), disclosureIdentity: JSON.stringify([input.disclosureRevisions[row.key] ?? 0, row.sources.map(source => Boolean(input.expanded[`reveal:${source.position}`]))]), disclosureEnd: row.kind === 'activity-summary' ? ends.get(row.disclosureOwner!) : undefined })), ...input.extraRows]; },
  [plan, input.local, input.enabled, input.disclosureRevisions, input.extraRows, input.selectMode, input.selectedBlockIds, input.expanded, input.actionIdentity]);
  const rowMembers = useMemo(() => new Map(plan?.rows.map(row => [row.key, row.memberKeys]) ?? input.local.rows.map(row => [row.key, [row.key]])), [plan, input.local]);
  const demand = useRef<ReadingBodyDemand | null>(null);
  const pendingVector = useRef<readonly MeasurementRow[] | null>(null);
  const custody = useRef({ applied: new Set<string>(), pending: new Set<string>(), measuring: new Set<string>() });
  const [demandVersion, setDemandVersion] = useState(0);
  const current = useRef({ input, plan }); current.current = { input, plan };
  const vectorIndices = useRef(new WeakMap<readonly MeasurementRow[], ReadonlyMap<string, number>>());
  const candidates = useCallback((vector: readonly MeasurementRow[]) => {
    const snapshot = current.current;
    let byKey = vectorIndices.current.get(vector);
    if (!byKey) { byKey = new Map(vector.map((row, index) => [row.key, index])); vectorIndices.current.set(vector, byKey); }
    const selected = new Map<string, MeasurementRow>();
    for (const ref of demand.current?.required ?? vector.slice(0, 1)) { const index = byKey.get(ref.key); if (index !== undefined) selected.set(ref.key, vector[index]); }
    if (snapshot.input.initial) {
      const member = snapshot.input.targetMemberKey ? snapshot.plan?.viewMembership.get(snapshot.input.targetMemberKey) : snapshot.input.targetPosition === undefined ? undefined : snapshot.plan?.membership.get(snapshot.input.targetPosition);
      const targetKey = snapshot.input.targetRowKey && byKey.has(snapshot.input.targetRowKey) ? snapshot.input.targetRowKey : snapshot.input.targetSummary ? member?.summaryRowKey ?? member?.rowKey : member?.rowKey;
      const index = targetKey ? byKey.get(targetKey) ?? vector.length - 1 : vector.length - 1;
      for (const row of vector.slice(Math.max(0, index - 6), index + 7)) selected.set(row.key, row);
    }
    return [...selected.values()];
  }, []);
  const required = useMemo(() => candidates(bodyRows), [bodyRows, candidates, demandVersion, input.initial, input.targetPosition, input.targetSummary, input.targetRowKey, input.targetMemberKey]);
  const wanted = useMemo(() => {
    return [...new Map([...required, ...(demand.current?.prefetch ?? [])].map(ref => [readingBodyKey(ref), ref])).values()];
  }, [required, bodyRows]);
  const wantedKeys = useMemo(() => new Set(wanted.map(readingBodyKey)), [wanted]);
  const latestWanted = useRef(wantedKeys); latestWanted.current = wantedKeys;
  const bodyKey = useMemo(() => ['chat', 'conversation', input.scope, 'reading-bodies', input.space] as const, [input.scope, input.space]);
  const bodyQuery = useQuery({ queryKey: bodyKey, queryFn: skipToken, initialData: () => new Map<string, ReadingRow>(), enabled: false, gcTime: 0 }, queryClient);
  const bodies: ReadonlyMap<string, ReadingRow> = bodyQuery.data ?? new Map();
  const bodyRef = useRef(bodies); bodyRef.current = bodies;
  const targetsByBody = useMemo(() => new Map([...bodies].map(([key, body]) => [key, activityTargetsFromReadingRows([body])])), [bodies]);
  const targets = useMemo(() => [...targetsByBody.values()].flat(), [targetsByBody]);
  const resolutions = useActivityTargetResolutions(targets);
  const snapshots = useRef(new Map<string, string>());
  const rows = useMemo(() => bodyRows.map(row => {
    const bodyIdentity = row.disclosureIdentity ?? '';
    const bodyKey = readingBodyKey(row);
    const previous = snapshots.current.get(bodyKey);
    // Offscreen rows keep the label geometry already measured. Metadata updates
    // acquire bodies only for existing reader demand, never for title changes.
    if (!targetsByBody.has(bodyKey)) return {...row, bodyIdentity,
      disclosureIdentity:JSON.stringify([bodyIdentity,previous ?? '{}'])};
    const labels: Record<string, ActivityTargetLabels[string]> = {};
    for (const target of targetsByBody.get(bodyKey) ?? []) {
      const key = activityTargetKey(target);
      const resolved = resolutions.get(key);
      labels[key] = {label:activityTargetDisplayLabel(target,resolved?.status === 'resolved'?resolved.title:undefined),
        ...(resolved?.status === 'resolved' ? {selection:{type:'conversation' as const,id:resolved.conversationId}} : {})};
    }
    const identity = JSON.stringify(labels);
    snapshots.current.set(bodyKey,identity);
    return {...row, bodyIdentity, disclosureIdentity:JSON.stringify([bodyIdentity,identity]), targetLabels:Object.freeze(labels)};
  }), [bodyRows, targetsByBody, resolutions]);
  const liveRowKeys = new Set(bodyRows.map(readingBodyKey));
  for (const key of snapshots.current.keys()) if (!liveRowKeys.has(key)) snapshots.current.delete(key);
  const retainedKeys = useCallback(() => {
    const keys = new Set([...latestWanted.current, ...custody.current.applied, ...custody.current.pending, ...custody.current.measuring]);
    const selection = document.getSelection();
    for (const node of [document.activeElement, selection?.anchorNode, selection?.focusNode]) {
      const element = node instanceof Element ? node : node?.parentElement;
      const owner = element?.closest<HTMLElement>('[data-reading-payload]');
      const key = owner?.dataset.readingBody ?? owner?.dataset.readingPayload;
      if (key) keys.add(key);
    }
    return keys;
  }, []);
  const publishBodies = useCallback((additions: readonly { ref: MeasurementRow; body: ReadingRow }[] = []) => {
    const keep = retainedKeys();
    queryClient.setQueryData(bodyKey, (previous: ReadonlyMap<string, ReadingRow> | undefined) => {
      const next = new Map([...previous ?? []].filter(([key]) => keep.has(key)));
      for (const { ref, body } of additions) { const key = readingBodyKey(ref); if (keep.has(key)) next.set(key, body); }
      if (previous && next.size === previous.size && [...next].every(([key,body]) => previous.get(key) === body)) return previous;
      return next;
    });
  }, [bodyKey, retainedKeys]);
  useEffect(() => () => { queryClient.removeQueries({ queryKey: bodyKey, exact: true }); }, [bodyKey]);
  useEffect(() => { custody.current = { applied: new Set(), pending: new Set(), measuring: new Set() }; demand.current = null; setHydrationError(null); }, [input.scope, input.space]);
  const acquireMeasurement = useCallback(async (refs: readonly MeasurementRow[], signal: AbortSignal): Promise<MaterializedMeasurementBatch<ReadingRow>> => {
    const cached = refs.map(ref => bodyRef.current.get(readingBodyKey(ref)));
    if (cached.every((row): row is ReadingRow => row !== undefined)) return { bodies: cached, release: () => {} };
    const cachedByKey = new Map(refs.flatMap((ref, index) => cached[index] ? [[ref.key, cached[index]!] as const] : []));
    const missing = refs.filter(ref => !cachedByKey.has(ref.key));
    let lease: ReadingRowsLease | undefined;
    try {
      const extras = new Map(input.extraRows.map(row => [row.key, row]));
      let result: readonly ReadingRow[];
      if (!input.enabled) {
        const byKey = new Map([...input.local.rows, ...input.extraRows].map(row => [row.key, row]));
        result = refs.map(ref => { const body = byKey.get(ref.key); if (!body) throw new Error('Live presentation changed.'); return { ...body, revision: ref.revision }; });
      } else {
        if (!composition) throw new ReadingPresentationError('unavailable', 'The complete presentation is not available.');
        const durable = missing.filter(row => !extras.has(row.key));
        const requests = readingCompositionRequests(composition, durable);
        const canonical = requests.length ? (lease = await acquirePresentationRows(input.scope, { positionSpaceId: input.space, rows: requests, expanded: input.expanded, streaming: input.streaming }, signal)).rows : [];
        const composed = materializeConversationReading(composition, durable, canonical);
        if (composed.status !== 'source') throw new ReadingPresentationError('unavailable', composed.reason);
        const byKey = new Map([...cachedByKey, ...[...composed.rows, ...input.extraRows].map(row => [row.key, row] as const)]);
        result = refs.map(ref => { const body = byKey.get(ref.key); if (!body) throw new Error('Requested presentation row is unavailable.'); return { ...body, revision: ref.revision }; });
      }
      const keep = retainedKeys();
      const targets = activityTargetsFromReadingRows(result.filter((_body,index) => keep.has(readingBodyKey(refs[index])))).filter(target => target.kind !== 'pending-thread');
      await Promise.allSettled(targets.map(target => queryClient.fetchQuery(activityTargetOptions(target))));
      if (!signal.aborted) publishBodies(refs.map((ref, index) => ({ ref, body: result[index] })));
      return { bodies: result, release: () => lease?.release() };
    } catch (error) { lease?.release(); throw error; }
  }, [input.scope, input.space, input.expanded, input.streaming, input.enabled, input.local, input.extraRows, composition, publishBodies]);
  const materialize = useCallback(async (refs: readonly MeasurementRow[], signal: AbortSignal) => {
    const lease = await acquireMeasurement(refs, signal);
    try { return lease.bodies; } finally { lease.release(); }
  }, [acquireMeasurement]);
  const materializer = useRef(materialize); materializer.current = materialize;
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const currentKeys = useMemo(() => new Set(bodyRows.map(readingBodyKey)), [bodyRows]);
  const publication = queryClient.getQueryState(readingManifestOptions(input.scope, input.space).queryKey)?.dataUpdateCount ?? 0;
  const publicationBlocked = useRef<number | null>(null);
  const active = useRef<{ controller: AbortController; refs: readonly MeasurementRow[]; scope: string; space: string; publication: number } | null>(null);
  const failures = useRef(new Map<string, string>());
  useEffect(() => { failures.current.clear(); publicationBlocked.current = null; return () => { active.current?.controller.abort(); active.current = null; }; }, [input.scope, input.space]);
  useEffect(() => {
    publishBodies();
    const requiredKeys = new Set(required.map(readingBodyKey));
    const missingRequired = required.filter(ref => !bodyRef.current.has(readingBodyKey(ref)));
    for (const key of failures.current.keys()) if (!wantedKeys.has(key)) failures.current.delete(key);
    setHydrationError(missingRequired.map(ref => failures.current.get(readingBodyKey(ref))).find(Boolean) ?? null);
    const running = active.current;
    if (running) {
      const useful = running.refs.some(ref => wantedKeys.has(readingBodyKey(ref)));
      const related = running.refs.some(ref => requiredKeys.has(readingBodyKey(ref)));
      const invalid = running.scope !== input.scope || running.space !== input.space || running.refs.some(ref => !currentKeys.has(readingBodyKey(ref)));
      if (invalid || !useful || (missingRequired.length > 0 && !related)) {
        running.controller.abort(); active.current = null;
      } else return;
    }
    if (publicationBlocked.current !== null) {
      if (publication <= publicationBlocked.current) return;
      publicationBlocked.current = null;
    }
    const missing = (missingRequired.length ? missingRequired : wanted.filter(ref => !bodyRef.current.has(readingBodyKey(ref))))
      .filter(ref => currentKeys.has(readingBodyKey(ref)) && !failures.current.has(readingBodyKey(ref))).slice(0, 16);
    if (!missing.length) return;
    const request = { controller: new AbortController(), refs: missing, scope: input.scope, space: input.space, publication };
    active.current = request;
    void materializer.current(missing, request.controller.signal).catch(error => {
      if (!request.controller.signal.aborted) {
        if (isReadingPublicationChanged(error)) { publicationBlocked.current = request.publication; return; }
        const message = error instanceof Error ? error.message : String(error);
        for (const ref of missing) failures.current.set(readingBodyKey(ref), message);
      }
    }).finally(() => {
      if (active.current !== request) return;
      active.current = null;
      setDemandVersion(value => value + 1);
    });
  }, [wanted, required, wantedKeys, currentKeys, publication, manifest.dataUpdatedAt, manifest.isFetching, demandVersion, publishBodies, input.scope, input.space]);
  const onRange = useCallback((snapshot: ReadingBodyDemand) => {
    demand.current = snapshot;
    custody.current.applied = new Set(snapshot.required.map(readingBodyKey));
    setDemandVersion(value => value + 1);
  }, []);
  const retainMeasurement = useCallback((vector: readonly MeasurementRow[]) => {
    custody.current.measuring = new Set(candidates(vector).map(readingBodyKey));
  }, [candidates]);
  const retainGeometry = useCallback((vector: readonly MeasurementRow[]) => {
    pendingVector.current = vector;
    custody.current.pending = new Set(candidates(vector).map(readingBodyKey)); custody.current.measuring = new Set();
  }, [candidates]);
  const commitGeometry = useCallback((vector: readonly MeasurementRow[]) => {
    if (pendingVector.current !== vector) return;
    pendingVector.current = null; custody.current.pending = new Set(); setDemandVersion(value => value + 1);
  }, []);
  return { rows, plan, membership: plan?.viewMembership ?? input.local.viewMembership, rowMembers, actionRuns: composition?.actionRuns ?? input.local.actionRuns, lastAssistantTurnId: composition?.lastAssistantTurnId ?? input.local.lastAssistantTurnId,
    manifest: manifest.data, bodies, getBody: (ref: MeasurementRow) => {
      const identity = snapshots.current.get(readingBodyKey(ref));
      return !ref.targetLabels && identity !== undefined && identity !== '{}'
        ? undefined : bodies.get(readingBodyKey(ref));
    }, materialize, acquireMeasurement, onRange, retainMeasurement, retainGeometry, commitGeometry,
    protect: () => setDemandVersion(value => value + 1), error: manifest.error?.message ?? hydrationError, ready: !input.enabled || Boolean(plan), refresh: () => { failures.current.clear(); setHydrationError(null); setDemandVersion(value => value + 1); return manifest.refetch(); } };
}
