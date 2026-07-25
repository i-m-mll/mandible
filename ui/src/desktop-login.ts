// Desktop-shell operator login (issue 54b5677).
//
// The Tauri shell owns the credential: each enrollment command reads a
// protected local secret, redeems it for a bounded dashboard session against
// the daemon itself, and navigates this webview to a URL whose fragment carries
// only that session. No durable credential ever reaches this renderer. This
// module only decides which sources to try, waits for the injected fragment,
// and re-runs the normal handshake that adopts, strips, and rotates it.
//
// Enrollment is attempted only when this surface has no working session, and at
// most once automatically per shell process, because the daemon keeps exactly
// one operator dashboard session: every successful handshake rotates it and
// revokes whichever surface held it before (see the rotation note on
// client_auth_keychain_enroll in src-tauri/src/lib.rs).

import {
  enrollDesktopClientAuth,
  isDesktopShell,
  type DesktopEnrollmentSource,
} from './api';
import {
  ensureClientAuthToken,
  getClientAuthSessionState,
  type ClientAuthSessionState,
} from './client-auth-token';

/** Boot order: the one-shot bootstrap proof first, then the durable keychain item. */
export const AUTOMATIC_ENROLLMENT_SOURCES: readonly DesktopEnrollmentSource[] = [
  'bootstrap',
  'keychain',
];

/** An explicit "Log in" retries the keychain; the bootstrap proof is long gone by then. */
export const MANUAL_ENROLLMENT_SOURCES: readonly DesktopEnrollmentSource[] = ['keychain'];

export type DesktopLoginOutcome =
  /** A credential was injected and the handshake produced an operator session. */
  | 'enrolled'
  /** Nothing to enroll from — no bootstrap file, no keychain item. */
  | 'unavailable'
  /** The shell refused, or an injected credential did not produce a session. */
  | 'failed';

const FRAGMENT_POLL_INTERVAL_MS = 40;
const FRAGMENT_TIMEOUT_MS = 2000;

export interface DesktopLoginDeps {
  enroll(source: DesktopEnrollmentSource): Promise<boolean>;
  awaitCredentialFragment(): Promise<boolean>;
  refreshSession(): Promise<ClientAuthSessionState>;
  onError?(message: string): void;
}

/**
 * Try each enrollment source in order, stopping at the first one that yields a
 * working operator session. A source that has nothing to offer is not an error:
 * it just moves on to the next one.
 */
export async function attemptDesktopLogin(
  sources: readonly DesktopEnrollmentSource[],
  deps: DesktopLoginDeps,
): Promise<DesktopLoginOutcome> {
  let failed = false;
  for (const source of sources) {
    let injected = false;
    try {
      injected = await deps.enroll(source);
    } catch (error) {
      failed = true;
      deps.onError?.(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!injected) continue;
    await deps.awaitCredentialFragment();
    if ((await deps.refreshSession()) === 'enrolled') return 'enrolled';
    failed = true;
  }
  return failed ? 'failed' : 'unavailable';
}

/**
 * Strip any `mandible_auth` already present in the hash before it is forwarded
 * as the return route. The dashboard reads the first occurrence, so forwarding
 * a stale one would shadow the session the shell injects after it and leave a
 * credential sitting in the visible URL. The Rust side refuses such a route as
 * well; this keeps the UI from ever asking for it.
 */
export function sanitizeEnrollmentHash(hash: string): string {
  const raw = hash.replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  if (queryIndex < 0) return raw;
  const params = new URLSearchParams(raw.slice(queryIndex + 1));
  if (!params.has('mandible_auth')) return raw;
  params.delete('mandible_auth');
  const remaining = params.toString();
  return `${raw.slice(0, queryIndex)}${remaining ? `?${remaining}` : ''}`;
}

function hasCredentialFragment(): boolean {
  return typeof window !== 'undefined' && window.location.hash.includes('mandible_auth=');
}

/**
 * The shell injects the fragment with a fire-and-forget script evaluation, so
 * it can land after the invoke() promise settles.
 */
async function awaitCredentialFragment(): Promise<boolean> {
  const deadline = Date.now() + FRAGMENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasCredentialFragment()) return true;
    await new Promise((resolve) => {
      window.setTimeout(resolve, FRAGMENT_POLL_INTERVAL_MS);
    });
  }
  return hasCredentialFragment();
}

/**
 * Adopt the injected credential, then put the router back on the view the
 * operator was looking at. The shell already navigates back to that route, so
 * this is a no-op guard; the hashchange nudge is what matters, because the
 * adoption strips the credential with replaceState, which fires no event of
 * its own and would otherwise leave the token in the parsed route state.
 */
async function refreshSessionAndSyncRoute(returnHash: string): Promise<ClientAuthSessionState> {
  await ensureClientAuthToken();
  if (typeof window !== 'undefined') {
    if (returnHash && window.location.hash !== returnHash) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${returnHash}`,
      );
    }
    window.dispatchEvent(new Event('hashchange'));
  }
  return getClientAuthSessionState();
}

/**
 * Log this desktop webview in. `manual` marks an explicit operator action: it
 * retries the keychain even after the shell's automatic attempt was spent.
 * Outside the desktop shell this is always 'unavailable' — browsers enroll
 * through `mandible user dashboard-link`.
 */
export async function runDesktopLogin(
  options: { manual?: boolean; onError?: (message: string) => void } = {},
): Promise<DesktopLoginOutcome> {
  if (!isDesktopShell()) return 'unavailable';
  const manual = options.manual === true;
  const sanitized = sanitizeEnrollmentHash(
    typeof window !== 'undefined' ? window.location.hash : '',
  );
  const returnHash = sanitized ? `#${sanitized}` : '';
  const route = sanitized || '/';
  return attemptDesktopLogin(manual ? MANUAL_ENROLLMENT_SOURCES : AUTOMATIC_ENROLLMENT_SOURCES, {
    enroll: (source) => enrollDesktopClientAuth(source, { route, force: manual }),
    awaitCredentialFragment,
    refreshSession: () => refreshSessionAndSyncRoute(returnHash),
    onError: options.onError,
  });
}
