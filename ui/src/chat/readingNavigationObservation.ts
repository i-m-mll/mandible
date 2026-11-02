import type { ConversationSourceCoordinate } from '../query/conversationData';
import type { ReadingRevealResult } from './readingProjection';

export type ReadingNavigationOrigin = 'source-navigation' | 'disclosure-pin' | 'initial' | 'latest';
export type ReadingNavigationObservation = {
  event: 'start' | 'terminal' | 'notice';
  origin?: ReadingNavigationOrigin;
  token: string;
  scope: string;
  positionSpaceId: string;
  target?: ConversationSourceCoordinate;
  status?: ReadingRevealResult['status'];
  currentScope: string;
  currentPositionSpaceId: string;
  currentToken?: string;
  terminal?: {
    reason: 'deadline' | 'settled-end' | 'settled-row' | 'settled-target' | 'preparation' | 'not-renderable' | 'cancelled';
    phase: 'prepare' | 'materialize' | 'align' | 'end' | 'row';
    rowKey?: string;
    preserveReaderPin?: boolean;
    pinOffset?: number;
    pinRect?: { top: number; bottom: number };
    wantedOffset?: number;
    scrollTop?: number;
    maxOffset?: number;
    scrolling: boolean;
    targetConnected: boolean;
    targetRect?: { top: number; bottom: number };
    viewportRect?: { top: number; bottom: number };
    appliedSerial?: number;
    indexedSerial?: number;
    pendingSerial?: number;
    readbackSerial?: number;
  };
};
export type ReadingNavigationObserver = (observation: ReadingNavigationObservation) => void;

/** Explicit, bounded diagnostics for observing the public reading-target lifecycle. */
export function readingNavigationObserver(): ReadingNavigationObserver | undefined {
  if (new URLSearchParams(window.location.search).get('reading_trace') !== '1') return;
  let remaining = 64;
  return observation => {
    if (remaining <= 0) return;
    remaining--;
    console.info('[mandible:reading-navigation]', JSON.stringify(observation));
  };
}
