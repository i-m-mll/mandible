import { getArtifactStandingNotes } from '../api';
import { queryClient } from '../query/client';
import { useProjectionQuery } from '../query/useProjectionQuery';

const key = ['artifact-standing-notes'] as const;

export function useArtifactStandingNotes(ref: string | null) {
  return useProjectionQuery({ queryKey: [...key, ref],
    queryFn: ({ signal }) => getArtifactStandingNotes(ref!, signal) }, ref !== null);
}

export function invalidateArtifactStandingNotes() {
  return queryClient.invalidateQueries({ queryKey: key });
}
