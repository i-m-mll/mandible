import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { isDesktopShell } from '../api';
import {
  getClientAuthSessionState,
  subscribeClientAuthSessionState,
  type ClientAuthSessionState,
} from '../client-auth-token';
import { runDesktopLogin } from '../desktop-login';

// Desktop-shell login affordance (issue 54b5677). Before this, an unenrolled
// desktop webview looked identical to an enrolled one until a mutation failed.
// The chip is a persistent header element rather than a dismissible toast: it
// reflects session state, so it must not disappear until the state changes.

export function DesktopLoginStatus(): JSX.Element | null {
  const [sessionState, setSessionState] = useState<ClientAuthSessionState>(
    () => getClientAuthSessionState(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeClientAuthSessionState(setSessionState), []);

  const handleLogin = useCallback(async () => {
    setBusy(true);
    setError(null);
    const reported: { message: string | null } = { message: null };
    try {
      const outcome = await runDesktopLogin({
        manual: true,
        onError: (message) => {
          reported.message = message;
        },
      });
      if (outcome === 'unavailable') {
        setError('No operator credential found in the login keychain.');
      } else if (outcome === 'failed') {
        setError(reported.message ?? 'Enrollment did not produce an operator session.');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  if (!isDesktopShell() || sessionState === 'enrolled') {
    return null;
  }

  return (
    <div className="desktop-login" role="status">
      <span className="desktop-login__label">
        {sessionState === 'unreachable' ? 'Session unverified' : 'Not logged in'}
      </span>
      <button
        type="button"
        className="desktop-login__button"
        onClick={handleLogin}
        disabled={busy}
        title="Log in with the operator credential from the login keychain"
      >
        {busy ? 'Logging in…' : 'Log in'}
      </button>
      {error ? (
        <span className="desktop-login__error" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
