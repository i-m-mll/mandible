import { useQuery } from '@tanstack/preact-query';
import { getArtifactStandingNotes } from '../api';
import { queryClient } from '../query/client';

const key = ['artifact-standing-notes'] as const;

export function useArtifactStandingNotes(ref: string | null) {
  return useQuery({ queryKey: [...key, ref], enabled: ref !== null,
    queryFn: ({ signal }) => getArtifactStandingNotes(ref!, signal) }, queryClient);
}

export function invalidateArtifactStandingNotes() {
  return queryClient.invalidateQueries({ queryKey: key });
}
