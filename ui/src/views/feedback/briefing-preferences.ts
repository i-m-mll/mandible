export const BRIEFING_KEEP_SUBMITTED_ANNOTATIONS_SETTING = 'briefing.keep_submitted_annotations';

export function keepSubmittedBriefingAnnotations(settings: Record<string, string>): boolean {
  return settings[BRIEFING_KEEP_SUBMITTED_ANNOTATIONS_SETTING] === 'true';
}
