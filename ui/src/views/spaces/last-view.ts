const SPACES_LAST_VIEW_KEY = 'mandible.spaces.lastView:v1';

export type SpacesLastView = { projectId: string | null; spaceId: string };

export function readSpacesLastView(): SpacesLastView | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SPACES_LAST_VIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SpacesLastView>;
    if (typeof parsed.spaceId !== 'string' || !parsed.spaceId.trim()) return null;
    return {
      projectId: typeof parsed.projectId === 'string' && parsed.projectId ? parsed.projectId : null,
      spaceId: parsed.spaceId,
    };
  } catch {
    return null;
  }
}

export function savedSpacesSelection(params: Record<string, string>): SpacesLastView | null {
  return params.project || params.space || params.renderer ? null : readSpacesLastView();
}

export function writeSpacesLastView(view: SpacesLastView): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SPACES_LAST_VIEW_KEY, JSON.stringify(view));
  } catch {
    // Browser-local view restoration is best-effort only.
  }
}

export function discardSpacesLastView(spaceId: string): void {
  if (typeof window === 'undefined' || readSpacesLastView()?.spaceId !== spaceId) return;
  try {
    window.localStorage.removeItem(SPACES_LAST_VIEW_KEY);
  } catch {
    // Browser-local view restoration is best-effort only.
  }
}
