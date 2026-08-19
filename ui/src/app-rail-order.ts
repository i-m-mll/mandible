export const APP_RAIL_ORDER_SETTING_KEY = 'app_rail_order';
export const APP_RAIL_ORDER_VERSION = 1 as const;

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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Treat persisted settings payloads as untrusted. Malformed or old envelopes fail closed. */
export function normalizeAppRailOrderPreference(
  value: unknown,
  defaults: Readonly<AppRailOrderPreference> = DEFAULT_APP_RAIL_ORDER,
): AppRailOrderPreference {
  if (
    typeof value !== 'object'
    || value === null
    || (value as { version?: unknown }).version !== APP_RAIL_ORDER_VERSION
  ) {
    return {
      version: APP_RAIL_ORDER_VERSION,
      groups: {
        primary: [...defaults.groups.primary],
        secondary: [...defaults.groups.secondary],
      },
    };
  }

  const groups = (value as { groups?: unknown }).groups;
  if (
    typeof groups !== 'object'
    || groups === null
    || !isStringArray((groups as { primary?: unknown }).primary)
    || !isStringArray((groups as { secondary?: unknown }).secondary)
  ) {
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
      primary: [...groups.primary],
      secondary: [...groups.secondary],
    },
  };
}

export function parseAppRailOrderSetting(value: string | undefined): AppRailOrderPreference {
  if (!value) return normalizeAppRailOrderPreference(undefined);
  try {
    return normalizeAppRailOrderPreference(JSON.parse(value));
  } catch {
    return normalizeAppRailOrderPreference(undefined);
  }
}

export function serializeAppRailOrderSetting(value: AppRailOrderPreference): string {
  return JSON.stringify(normalizeAppRailOrderPreference(value));
}

/**
 * Fill the canonical slots occupied by saved IDs in saved order. This retains
 * the user's relative order while leaving new/returning IDs in their canonical
 * fallback slots. Unknown, retired, and duplicate saved IDs are ignored.
 */
export function reconcileAppRailOrder(
  canonicalIds: readonly string[],
  savedIds: readonly string[],
): string[] {
  const canonicalSet = new Set(canonicalIds);
  const seen = new Set<string>();
  const recognized = savedIds.filter((id) => {
    if (!canonicalSet.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const recognizedSet = new Set(recognized);
  let savedIndex = 0;

  return canonicalIds.map((id) => (
    recognizedSet.has(id) ? recognized[savedIndex++] : id
  ));
}

export function moveAppRailItem(
  ids: readonly string[],
  itemId: string,
  targetId: string,
): string[] {
  const from = ids.indexOf(itemId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, itemId);
  return next;
}
