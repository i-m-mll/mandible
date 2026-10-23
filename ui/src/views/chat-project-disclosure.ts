import { useCallback, useState } from 'preact/hooks';

const STORAGE_KEY = 'mandible.chat.expandedProjects:v1';

function readExpandedProjects(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Session-local disclosure, separate from canonical project selection and leaf quotas. */
export function useChatProjectDisclosure(): [ReadonlySet<string>, (projectId: string) => void] {
  const [expandedProjects, setExpandedProjects] = useState(readExpandedProjects);
  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // The current view remains usable when browser storage is unavailable.
      }
      return next;
    });
  }, []);
  return [expandedProjects, toggleProject];
}
