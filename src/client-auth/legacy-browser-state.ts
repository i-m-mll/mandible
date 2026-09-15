// One contract for old-origin localStorage export, conversion ingress, and
// new-origin restore. Exclude known credential/control keys by exact identity:
// an "auth" substring also occurs in legitimate view settings.
export const LEGACY_BEARER_STORAGE_KEY = "mandible.client_auth.token";
export const PENDING_LOGOUT_STORAGE_KEY = "mandible.session.revocation_pending";
export const LEGACY_BROWSER_STATE_MAX_ENTRIES = 512;
export const LEGACY_BROWSER_STATE_MAX_KEY_BYTES = 160;
export const LEGACY_BROWSER_STATE_MAX_VALUE_BYTES = 64 * 1024;
export const LEGACY_BROWSER_STATE_MAX_BYTES = 256 * 1024;

const credentialKeys = new Set([LEGACY_BEARER_STORAGE_KEY, PENDING_LOGOUT_STORAGE_KEY]);
const encoder = new TextEncoder();

export class LegacyBrowserStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyBrowserStateError";
  }
}

export function validateLegacyBrowserState(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyBrowserStateError("Legacy browser state is not an entry map; migration was stopped without discarding it.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > LEGACY_BROWSER_STATE_MAX_ENTRIES) {
    throw new LegacyBrowserStateError(`Legacy browser state has ${entries.length} entries, above the ${LEGACY_BROWSER_STATE_MAX_ENTRIES}-entry migration limit; none were silently truncated.`);
  }
  for (const [key, item] of entries) {
    if (credentialKeys.has(key)) {
      throw new LegacyBrowserStateError("Legacy browser state contains a reusable credential or session control key; migration was stopped.");
    }
    if (!key || encoder.encode(key).length > LEGACY_BROWSER_STATE_MAX_KEY_BYTES || typeof item !== "string" ||
        encoder.encode(item).length > LEGACY_BROWSER_STATE_MAX_VALUE_BYTES) {
      throw new LegacyBrowserStateError("Legacy browser state contains an invalid or oversized entry; migration was stopped without discarding it.");
    }
  }
  const result = Object.fromEntries(entries) as Record<string, string>;
  if (encoder.encode(JSON.stringify(result)).length > LEGACY_BROWSER_STATE_MAX_BYTES) {
    throw new LegacyBrowserStateError(`Legacy browser state exceeds the ${LEGACY_BROWSER_STATE_MAX_BYTES}-byte migration limit; none was silently truncated.`);
  }
  return result;
}

export function exportLegacyBrowserState(storage: Pick<Storage, "length" | "key" | "getItem">): Record<string, string> {
  const entries: Array<[string, string]> = [];
  try {
    const length = storage.length;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key === null) throw new LegacyBrowserStateError("Legacy browser storage changed during export; migration was stopped.");
      if (credentialKeys.has(key)) continue;
      const item = storage.getItem(key);
      if (item === null) throw new LegacyBrowserStateError("Legacy browser storage changed during export; migration was stopped.");
      entries.push([key, item]);
      if (entries.length > LEGACY_BROWSER_STATE_MAX_ENTRIES) break;
    }
    if (storage.length !== length || entries.some(([key, item]) => storage.getItem(key) !== item)) {
      throw new LegacyBrowserStateError("Legacy browser storage changed during export; migration was stopped.");
    }
  } catch (error) {
    if (error instanceof LegacyBrowserStateError) throw error;
    throw new LegacyBrowserStateError("Legacy browser storage could not be read; migration was stopped without discarding it.");
  }
  return validateLegacyBrowserState(Object.fromEntries(entries));
}

export function restoreLegacyBrowserState(storage: Pick<Storage, "setItem">, value: unknown): void {
  const state = validateLegacyBrowserState(value);
  for (const [key, item] of Object.entries(state)) {
    try {
      storage.setItem(key, item);
    } catch {
      throw new LegacyBrowserStateError("Legacy browser state could not be restored to this profile; conversion remains pending for a retry.");
    }
  }
}
