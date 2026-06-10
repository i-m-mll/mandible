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
  const hostPath = [url.hostname, url.pathname.replace(/^\/+/, '')]
    .filter(Boolean)
    .join('/');
  const [route] = hostPath.split('/');
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

export function routeHashFromMandibleDeepLink(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'mandible:') return null;
  return issueRouteFromUrl(url);
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

  const deepLink: DeepLinkModule = await import('@tauri-apps/plugin-deep-link');
  const navigateAll = (urls: string[] | null | undefined) => {
    for (const url of urls ?? []) {
      if (navigateToMandibleDeepLink(url, navigateToHash)) break;
    }
  };

  navigateAll(await deepLink.getCurrent());
  return deepLink.onOpenUrl(navigateAll);
}
