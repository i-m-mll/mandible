export const AUTH_CHANGE_BREAKDOWN_VIEWS = [
  'language',
  'directory',
  'role',
  'flags',
  'largest',
] as const;

export type AuthChangeBreakdownView = typeof AUTH_CHANGE_BREAKDOWN_VIEWS[number];

export type AuthChangeBreakdownViewState = {
  expanded: boolean;
  view: AuthChangeBreakdownView;
  expandedGroups: string[];
  directoryPath: string[];
};

export const DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE: AuthChangeBreakdownViewState = {
  expanded: true,
  view: 'language',
  expandedGroups: [],
  directoryPath: [],
};

function isBreakdownView(value: unknown): value is AuthChangeBreakdownView {
  return typeof value === 'string'
    && (AUTH_CHANGE_BREAKDOWN_VIEWS as readonly string[]).includes(value);
}

const LEGACY_FLAG_GROUPS: Readonly<Record<string, string[]>> = {
  'flag:generated': ['flag:generated-only', 'flag:both'],
  'flag:not-generated': ['flag:third-party-only', 'flag:neither'],
  'flag:vendor': ['flag:third-party-only', 'flag:both'],
  'flag:not-vendor': ['flag:generated-only', 'flag:neither'],
};

export function normalizeAuthChangeBreakdownViewState(
  value: unknown,
  defaults: Readonly<AuthChangeBreakdownViewState>,
): AuthChangeBreakdownViewState {
  const record = value && typeof value === 'object'
    ? value as Partial<AuthChangeBreakdownViewState>
    : {};
  const expandedGroups = Array.isArray(record.expandedGroups)
    ? Array.from(new Set(record.expandedGroups.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      ).flatMap(id => LEGACY_FLAG_GROUPS[id] ?? [id])))
    : defaults.expandedGroups;
  const directoryPath = Array.isArray(record.directoryPath)
    ? record.directoryPath.filter(
        (item): item is string => typeof item === 'string' && item.length > 0 && !item.includes('/'),
      )
    : defaults.directoryPath;

  return {
    expanded: typeof record.expanded === 'boolean' ? record.expanded : defaults.expanded,
    view: isBreakdownView(record.view) ? record.view : defaults.view,
    expandedGroups,
    directoryPath,
  };
}

export function authChangeBreakdownStorageKey(requestId: string): string {
  return `mandible:auth:change-breakdown:v1:${requestId}`;
}
