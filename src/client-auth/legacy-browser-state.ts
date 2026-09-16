// One contract for old-origin localStorage export, conversion ingress, and
// new-origin restore. Exclude known credential/control keys by exact identity:
// an "auth" substring also occurs in legitimate view settings.
export const LEGACY_BEARER_STORAGE_KEY = "mandible.client_auth.token";
export const PENDING_LOGOUT_STORAGE_KEY = "mandible.session.revocation_pending";
export const LEGACY_BROWSER_STATE_MAX_ENTRIES = 512;
export const LEGACY_BROWSER_STATE_MAX_KEY_BYTES = 512;
export const LEGACY_BROWSER_STATE_MAX_VALUE_BYTES = 64 * 1024;
export const LEGACY_BROWSER_STATE_MAX_BYTES = 256 * 1024;

const credentialKeys = new Set([LEGACY_BEARER_STORAGE_KEY, PENDING_LOGOUT_STORAGE_KEY]);
const encoder = new TextEncoder();
const APP_CACHE_KEY = "mandible_state_cache";
const appCacheFields = new Set([
  "authQueue", "authHistory", "workRepos", "workBranches", "issueRepos",
  "inboxData", "consoleSessions", "settings", "selectedAuthId", "selectedInboxItemId",
]);
const appCacheIntentFields = ["settings", "selectedAuthId", "selectedInboxItemId"] as const;

export class LegacyBrowserStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyBrowserStateError";
  }
}

// The old app cache mixes a few user choices with megabytes of API responses.
// Transfer only the choices; each destination refetches its own server data.
function projectAppCache(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LegacyBrowserStateError("The old app cache could not be read; migration was stopped without discarding it.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      (parsed as { v?: unknown }).v !== 2 ||
      typeof (parsed as { state?: unknown }).state !== "object" ||
      (parsed as { state?: unknown }).state === null ||
      Array.isArray((parsed as { state?: unknown }).state)) {
    throw new LegacyBrowserStateError("The old app cache has an unknown format; migration was stopped without discarding it.");
  }
  const state = (parsed as { state: Record<string, unknown> }).state;
  if (Object.keys(state).some((field) => !appCacheFields.has(field))) {
    throw new LegacyBrowserStateError("The old app cache has an unknown field; migration was stopped without discarding it.");
  }
  const intent = Object.fromEntries(appCacheIntentFields
    .filter((field) => Object.hasOwn(state, field))
    .map((field) => [field, state[field]]));
  return JSON.stringify({ v: 2, state: intent });
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
    const keyBytes = encoder.encode(key).length;
    const valueBytes = typeof item === "string" ? encoder.encode(item).length : null;
    if (!key || keyBytes > LEGACY_BROWSER_STATE_MAX_KEY_BYTES || valueBytes === null ||
        valueBytes > LEGACY_BROWSER_STATE_MAX_VALUE_BYTES) {
      const keyLabel = keyBytes <= LEGACY_BROWSER_STATE_MAX_KEY_BYTES ? JSON.stringify(key) : "an oversized key";
      throw new LegacyBrowserStateError(`Legacy browser state entry ${keyLabel} has ${keyBytes} key bytes and ${valueBytes ?? "non-text"} value bytes; migration was stopped without discarding it.`);
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
      entries.push([key, key === APP_CACHE_KEY ? projectAppCache(item) : item]);
      if (entries.length > LEGACY_BROWSER_STATE_MAX_ENTRIES) break;
    }
    if (storage.length !== length || entries.some(([key, item]) => {
      const current = storage.getItem(key);
      return current === null || (key === APP_CACHE_KEY ? projectAppCache(current) : current) !== item;
    })) {
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
