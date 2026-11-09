import {
  getCurrent as getCurrentDeepLinks,
  onOpenUrl as onOpenDeepLinks,
} from '@tauri-apps/plugin-deep-link';

import { adoptAgentSessionBinding, agentSessionFromSearch } from './agent-page-binding';

type DeepLinkModule = {
  getCurrent: () => Promise<string[] | null>;
  onOpenUrl: (handler: (urls: string[]) => void) => Promise<() => void>;
};

const tauriDeepLink: DeepLinkModule = {
  getCurrent: getCurrentDeepLinks,
  onOpenUrl: onOpenDeepLinks,
};

type TauriDeepLinkWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

function isTauriWindow(): boolean {
  if (typeof window === 'undefined') return false;
  const tauriWindow = window as TauriDeepLinkWindow;
  return Boolean(tauriWindow.__TAURI__ || tauriWindow.__TAURI_INTERNALS__);
}

/**
 * The in-app path a `mandible:///<path>?<query>` deep link names. Links with a
 * host (`mandible://connections/setup`) belong to the native shell.
 */
export function appPathFromMandibleDeepLink(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'mandible:' || url.host !== '' || !url.pathname.startsWith('/')) return null;
  return `${url.pathname}${url.search}`;
}

export function navigateToMandibleDeepLink(
  rawUrl: string,
  navigate: (path: string) => void,
): boolean {
  const path = appPathFromMandibleDeepLink(rawUrl);
  if (!path) return false;
  // The Tauri handoff arrives after boot adoption. A supplied binding replaces
  // the current page-local value and remains present in the routed path.
  adoptAgentSessionBinding(agentSessionFromSearch(path.includes('?') ? path.slice(path.indexOf('?')) : ''));
  navigate(path);
  return true;
}

export async function installTauriDeepLinkHandler(
  navigate: (path: string) => void,
  deepLink: DeepLinkModule = tauriDeepLink,
): Promise<() => void> {
  if (!isTauriWindow()) return () => undefined;

  const navigateAll = (urls: string[] | null | undefined) => {
    for (const url of urls ?? []) {
      if (navigateToMandibleDeepLink(url, navigate)) break;
    }
  };

  const removeListener = await deepLink.onOpenUrl(navigateAll);
  try {
    navigateAll(await deepLink.getCurrent());
  } catch (error) {
    removeListener();
    throw error;
  }
  return removeListener;
}
