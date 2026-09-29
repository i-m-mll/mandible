import { moveSidebarItem, reconcileSidebarOrder } from './components/shared/sidebar-order';

export const APP_RAIL_ORDER_SETTING_KEY = 'app_rail_order';
export const APP_RAIL_ORDER_VERSION = 1 as const;
export const APP_RAIL_PREVIEW_ORDER_STORAGE_KEY = 'mandible.appRail.previewOrder:v1';

export type AppRailGroup = 'primary' | 'secondary';

export type AppRailOrderPreference = {
  version: typeof APP_RAIL_ORDER_VERSION;
  groups: Record<AppRailGroup, string[]>;
};

export const DEFAULT_APP_RAIL_ORDER: AppRailOrderPreference = {
  version: APP_RAIL_ORDER_VERSION,
  groups: {
    primary: [],
    secondary: [],
  },
};

export function hasExplicitStartupDestination(hash: string): boolean {
  return /^#\/[^/?#]+/.test(hash);
}

export function startupRailDestination(
  hash: string,
  primary: readonly string[],
  secondary: readonly string[],
  showSecondary: boolean,
): string | null {
  if (hasExplicitStartupDestination(hash)) return null;
  const first = primary[0] ?? (showSecondary ? secondary[0] : undefined);
  return first ? `#/${first}` : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isAppRailOrderPreference(value: unknown): value is AppRailOrderPreference {
  if (
    typeof value !== 'object'
    || value === null
    || (value as { version?: unknown }).version !== APP_RAIL_ORDER_VERSION
  ) return false;
  const groups = (value as { groups?: unknown }).groups;
  return (
    typeof groups === 'object'
    && groups !== null
    && isStringArray((groups as { primary?: unknown }).primary)
    && isStringArray((groups as { secondary?: unknown }).secondary)
  );
}

/** Treat persisted settings payloads as untrusted. Malformed or old envelopes fail closed. */
export function normalizeAppRailOrderPreference(
  value: unknown,
  defaults: Readonly<AppRailOrderPreference> = DEFAULT_APP_RAIL_ORDER,
): AppRailOrderPreference {
  if (!isAppRailOrderPreference(value)) {
    return {
      version: APP_RAIL_ORDER_VERSION,
      groups: {
        primary: [...defaults.groups.primary],
        secondary: [...defaults.groups.secondary],
      },
    };
  }

  return {
    version: APP_RAIL_ORDER_VERSION,
    groups: {
      primary: [...value.groups.primary],
      secondary: [...value.groups.secondary],
    },
  };
}

export function tryParseAppRailOrderSetting(value: string | undefined): AppRailOrderPreference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isAppRailOrderPreference(parsed) ? normalizeAppRailOrderPreference(parsed) : null;
  } catch {
    return null;
  }
}

export function parseAppRailOrderSetting(value: string | undefined): AppRailOrderPreference {
  return tryParseAppRailOrderSetting(value) ?? normalizeAppRailOrderPreference(undefined);
}

export function serializeAppRailOrderSetting(value: AppRailOrderPreference): string {
  return JSON.stringify(normalizeAppRailOrderPreference(value));
}

type AppRailPreviewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readAppRailPreviewOrder(
  storage: Pick<AppRailPreviewStorage, 'getItem'>,
): AppRailOrderPreference | null {
  try {
    return tryParseAppRailOrderSetting(storage.getItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY) ?? undefined);
  } catch {
    return null;
  }
}

export function writeAppRailPreviewOrder(
  storage: Pick<AppRailPreviewStorage, 'setItem'>,
  value: AppRailOrderPreference,
): boolean {
  try {
    storage.setItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY, serializeAppRailOrderSetting(value));
    return true;
  } catch {
    return false;
  }
}

export function clearAppRailPreviewOrder(
  storage: Pick<AppRailPreviewStorage, 'removeItem'>,
): boolean {
  try {
    storage.removeItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep every recognized saved ID in user order, then append missing current
 * IDs in canonical order. Unknown, fixed, retired, and duplicate saved IDs are
 * ignored because callers provide only the current reorderable ID set.
 */
export function reconcileAppRailOrder(
  canonicalIds: readonly string[],
  savedIds: readonly string[],
): string[] {
  return reconcileSidebarOrder(canonicalIds, savedIds);
}

export function moveAppRailItem(
  ids: readonly string[],
  itemId: string,
  targetId: string,
): string[] {
  return moveSidebarItem(ids, itemId, targetId);
}
