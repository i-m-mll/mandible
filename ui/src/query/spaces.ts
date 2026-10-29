import { useMemo, useRef } from 'preact/hooks';
import { getSpaceFactPacket, isApiErrorStatus } from '../api';
import { useViewActive } from '../app-shell';
import { projectionKeys } from './projectionKeys';
import { detailQueryData, snapshotOptions } from './snapshots';
import { useProjectionQuery } from './useProjectionQuery';

export function spacePacketOptions(ref: string | null, load = getSpaceFactPacket) {
  const key = projectionKeys.spacePacket(ref);
  const options = snapshotOptions(key, (signal) => load(key[2]!, { signal }));
  if (/^[0-9a-f]{8}$/i.test(key[2] ?? '')) {
    return { ...options, staleTime: 0, placeholderData: undefined, restartSnapshot: () => undefined };
  }
  return options;
}

export function useSpacePacket(ref: string | null, load = getSpaceFactPacket) {
  const active = useViewActive();
  const options = useMemo(() => spacePacketOptions(ref, load), [ref, load]);
  const query = useProjectionQuery(options, active && Boolean(ref));
  const verifiedRef = useRef<string | null>(null);
  if (verifiedRef.current !== ref) verifiedRef.current = null;
  if (query.isSuccess && !query.isFetching && !query.isPlaceholderData) verifiedRef.current = ref;
  const verified = !/^[0-9a-f]{8}$/i.test(ref ?? '') || verifiedRef.current === ref;
  const unavailable = isApiErrorStatus(query.error, 404) || isApiErrorStatus(query.error, 409);
  const packet = useMemo(() => unavailable || !verified ? undefined : detailQueryData(query, options),
    [unavailable, verified, query.data, query.isError, options]);
  return { packet, error: query.error, isFetching: query.isFetching, isPlaceholderData: query.isPlaceholderData, options };
}
