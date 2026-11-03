import { useMemo } from 'preact/hooks';
import { buildStreamState, type StreamState } from '../../../src/presentation/model';
import type { StreamEvent } from '../../../src/presentation/types';
export * from '../../../src/presentation/model';

export function useStreamState(events: StreamEvent[], standaloneItems = false): StreamState {
  return useMemo(() => buildStreamState(events, standaloneItems), [events, standaloneItems]);
}
