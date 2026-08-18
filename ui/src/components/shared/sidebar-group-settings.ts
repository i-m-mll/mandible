export const SIDEBAR_GROUP_LIMIT_DEFAULT = 5;
export const SIDEBAR_GROUP_LIMIT_MIN = 1;
export const SIDEBAR_GROUP_LIMIT_MAX = 50;

export function normalizeSidebarGroupLimit(value: unknown): number {
  const text = String(value ?? '').trim();
  const parsed = typeof value === 'number' ? value : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(parsed)) return SIDEBAR_GROUP_LIMIT_DEFAULT;
  return Math.min(SIDEBAR_GROUP_LIMIT_MAX, Math.max(SIDEBAR_GROUP_LIMIT_MIN, Math.trunc(parsed)));
}
