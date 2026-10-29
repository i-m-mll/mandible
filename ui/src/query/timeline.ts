import { getProjectTimeline } from '../api';
import type { ProjectTimelineInput } from '../types/timeline';
import { normalizeTimelineInput, projectionKeys } from './projectionKeys';
import { snapshotOptions } from './snapshots';

export function timelineOptions(input: ProjectTimelineInput) {
  const request = normalizeTimelineInput(input);
  return snapshotOptions(projectionKeys.timeline(request), (signal) => getProjectTimeline(request, signal));
}
