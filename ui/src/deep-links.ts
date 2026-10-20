import {
  getCurrent as getCurrentDeepLinks,
  onOpenUrl as onOpenDeepLinks,
} from '@tauri-apps/plugin-deep-link';

import {
  adoptAgentSessionBinding,
  agentSessionFromHash,
} from './agent-page-binding';
import { normalizeArtifactRouteParams } from './routing';

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

// Issue f59b5bd — deep links compose with extra query params (notably
// agent_session appended by session-bound agents). Params the route builder
// itself owns always win; everything else carries through untouched.
function appendExtraParams(params: URLSearchParams, url: URL): URLSearchParams {
  url.searchParams.forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });
  return params;
}

function issueRouteFromUrl(url: URL): string | null {
  const route = firstRouteSegment(url);
  if (route !== 'issues') return null;

  const issue = url.searchParams.get('issue')?.trim();
  if (!issue) return null;

  const params = new URLSearchParams({ issue });
  const repo = url.searchParams.get('repo')?.trim();
  const comment = url.searchParams.get('comment')?.trim();
  if (repo) params.set('repo', repo);
  if (comment) params.set('comment', comment);
  return `#/issues?${appendExtraParams(params, url).toString()}`;
}

// Routes whose deep link carries one required identity param map straight
// onto the same-named hash route.
function singleParamRouteFromUrl(url: URL, routeName: string, param: string): string | null {
  if (firstRouteSegment(url) !== routeName) return null;

  const value = url.searchParams.get(param)?.trim();
  if (!value) return null;

  const params = new URLSearchParams({ [param]: value });
  return `#/${routeName}?${appendExtraParams(params, url).toString()}`;
}

function artifactRouteFromUrl(url: URL): string | null {
  const route = firstRouteSegment(url);
  if (route !== 'artifacts') return null;

  const artifact = url.searchParams.get('artifact')?.trim();
  const ref = url.searchParams.get('ref')?.trim();
  const series = url.searchParams.get('series')?.trim();
  const version = url.searchParams.get('version')?.trim();
  if (!artifact && !ref && !series) return null;

  const normalized = normalizeArtifactRouteParams({
    ...(artifact ? { artifact } : {}),
    ...(ref ? { ref } : {}),
    ...(series ? { series } : {}),
    ...(version ? { version } : {}),
  });
  const params = new URLSearchParams();
  for (const key of ['series', 'version', 'ref', 'artifact']) {
    if (normalized[key]) params.set(key, normalized[key]);
  }
  // Carry extra params through, but never re-add the artifact identity params
  // the normalizer deliberately dropped.
  url.searchParams.forEach((value, key) => {
    if (['series', 'version', 'ref', 'artifact'].includes(key)) return;
    if (!params.has(key)) params.set(key, value);
  });
  return `#/artifacts?${params.toString()}`;
}

function firstRouteSegment(url: URL): string {
  const hostPath = [url.hostname, url.pathname.replace(/^\/+/, '')]
    .filter(Boolean)
    .join('/');
  const [route] = hostPath.split('/');
  return route ?? '';
}

export function routeHashFromMandibleDeepLink(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'mandible:') return null;
  return issueRouteFromUrl(url)
    ?? singleParamRouteFromUrl(url, 'auth', 'request')
    ?? singleParamRouteFromUrl(url, 'briefing', 'briefing')
    ?? artifactRouteFromUrl(url);
}

export function navigateToMandibleDeepLink(
  rawUrl: string,
  navigateToHash: (hash: string) => void,
): boolean {
  const hash = routeHashFromMandibleDeepLink(rawUrl);
  if (!hash) return false;
  // The Tauri handoff arrives after boot adoption. A supplied binding replaces
  // the current page-local value and remains present in the routed hash.
  adoptAgentSessionBinding(agentSessionFromHash(hash));
  navigateToHash(hash);
  return true;
}

export async function installTauriDeepLinkHandler(
  navigateToHash: (hash: string) => void,
  deepLink: DeepLinkModule = tauriDeepLink,
): Promise<() => void> {
  if (!isTauriWindow()) return () => undefined;

  const navigateAll = (urls: string[] | null | undefined) => {
    for (const url of urls ?? []) {
      if (navigateToMandibleDeepLink(url, navigateToHash)) break;
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
