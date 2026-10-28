export type PanelPoint = { x: number; y: number };
export type AppearancePanelState = { version: 1; open: boolean; collapsed: boolean; position: PanelPoint | null };
export const APPEARANCE_PANEL_DEFAULTS: AppearancePanelState = { version: 1, open: false, collapsed: false, position: null };

export function normalizeAppearancePanelState(value: unknown): AppearancePanelState {
  if (!value || typeof value !== 'object') return APPEARANCE_PANEL_DEFAULTS;
  const source = value as Partial<AppearancePanelState>;
  if (source.version !== 1) return APPEARANCE_PANEL_DEFAULTS;
  const point = source.position;
  return { version: 1, open: source.open === true, collapsed: source.collapsed === true,
    position: point && typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y)
      ? { x: point.x, y: point.y } : null };
}
