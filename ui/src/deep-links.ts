type DeepLinkModule = {
  getCurrent: () => Promise<string[] | null>;
  onOpenUrl: (handler: (urls: string[]) => void) => Promise<() => void>;
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
  return `#/issues?${params.toString()}`;
}

function authRouteFromUrl(url: URL): string | null {
  const route = firstRouteSegment(url);
  if (route !== 'auth') return null;

  const request = url.searchParams.get('request')?.trim();
  if (!request) return null;

  const params = new URLSearchParams({ request });
  return `#/auth?${params.toString()}`;
}

function artifactRouteFromUrl(url: URL): string | null {
  const route = firstRouteSegment(url);
  if (route !== 'artifacts') return null;

  const artifact = url.searchParams.get('artifact')?.trim();
  const ref = url.searchParams.get('ref')?.trim();
  if (!artifact && !ref) return null;

  const params = new URLSearchParams();
  if (artifact) params.set('artifact', artifact);
  if (ref) params.set('ref', ref);
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
  return issueRouteFromUrl(url) ?? authRouteFromUrl(url) ?? artifactRouteFromUrl(url);
}

export function navigateToMandibleDeepLink(
  rawUrl: string,
  navigateToHash: (hash: string) => void,
): boolean {
  const hash = routeHashFromMandibleDeepLink(rawUrl);
  if (!hash) return false;
  navigateToHash(hash);
  return true;
}

export async function installTauriDeepLinkHandler(
  navigateToHash: (hash: string) => void,
): Promise<() => void> {
  if (!isTauriWindow()) return () => undefined;

  const deepLinkModule = '@tauri-apps/plugin-deep-link';
  const deepLink: DeepLinkModule = await import(/* @vite-ignore */ deepLinkModule);
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
