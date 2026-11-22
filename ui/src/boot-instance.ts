import { normalizeInstanceInfo, type InstanceInfo } from './api';

type MandibleBootstrapData = {
  instance?: InstanceInfo | null;
  ui_asset_revision?: string;
  startup_epoch?: string;
};

declare global {
  interface Window {
    __MANDIBLE_BOOTSTRAP__?: MandibleBootstrapData;
  }
}

function readBootstrapData(): MandibleBootstrapData | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (window.__MANDIBLE_BOOTSTRAP__) return window.__MANDIBLE_BOOTSTRAP__;
  const raw = document.getElementById('mandible-bootstrap')?.textContent?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MandibleBootstrapData;
  } catch {
    return null;
  }
}

/** The instance the server described when it served this page. */
export function readBootInstanceInfo(): InstanceInfo | null {
  return normalizeInstanceInfo(readBootstrapData()?.instance);
}

export function servedUiAssetRevision(): string | undefined {
  return readBootstrapData()?.ui_asset_revision;
}

export function servedStartupEpoch(): string | undefined {
  return readBootstrapData()?.startup_epoch;
}

/**
 * The backend build that served this page. Browser caches of server data are
 * stamped with it and discarded under any other build, because a different
 * build may send differently shaped data.
 */
export function servedBackendGeneration(): string | null {
  return readBootInstanceInfo()?.backend_generation ?? null;
}
