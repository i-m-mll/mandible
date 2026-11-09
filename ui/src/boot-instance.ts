import { normalizeInstanceInfo, type InstanceInfo } from './api';

type MandibleBootstrapData = {
  instance?: InstanceInfo | null;
};

declare global {
  interface Window {
    __MANDIBLE_BOOTSTRAP__?: MandibleBootstrapData;
  }
}

/** The instance the server described when it served this page. */
export function readBootInstanceInfo(): InstanceInfo | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const normalizedGlobalInstance = normalizeInstanceInfo(window.__MANDIBLE_BOOTSTRAP__?.instance);
  if (normalizedGlobalInstance) return normalizedGlobalInstance;
  const raw = document.getElementById('mandible-bootstrap')?.textContent?.trim();
  if (!raw) return null;
  try {
    return normalizeInstanceInfo((JSON.parse(raw) as MandibleBootstrapData).instance);
  } catch {
    return null;
  }
}

/**
 * The backend build that served this page. Browser caches of server data are
 * stamped with it and discarded under any other build, because a different
 * build may send differently shaped data.
 */
export function servedBackendGeneration(): string | null {
  return readBootInstanceInfo()?.backend_generation ?? null;
}
