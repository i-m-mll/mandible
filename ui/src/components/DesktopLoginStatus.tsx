import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { isDesktopShell } from '../api';
import {
  getClientAuthSessionState,
  subscribeClientAuthSessionState,
  type ClientAuthSessionState,
} from '../client-auth-token';
import {
  canRetryDesktopLoginManually,
  recoverDesktopLoginAutomatically,
  resetDesktopLoginRecoveryEpisode,
  retryDesktopLoginManually,
} from '../desktop-login';

// Desktop-shell login affordance (issue 54b5677). Before this, an unenrolled
// desktop webview looked identical to an enrolled one until a mutation failed.
// The affordance is persistent left chrome rather than a dismissible toast: it
// reflects session state, so it must not disappear until the state changes.

type DesktopLoginStatusProps = {
  placement?: 'chip' | 'rail';
  showRailLabel?: boolean;
};

function DesktopLoginIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="9" r="3" />
      <path d="M9 9h6M13 9v2M15 9v2" />
    </svg>
  );
}

export function DesktopLoginStatus({
  placement = 'chip',
  showRailLabel = true,
}: DesktopLoginStatusProps = {}): JSX.Element | null {
  const [sessionState, setSessionState] = useState<ClientAuthSessionState>(
    () => getClientAuthSessionState(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRetryAllowed, setManualRetryAllowed] = useState(false);

  useEffect(() => subscribeClientAuthSessionState(setSessionState), []);

  useEffect(() => {
    if (!isDesktopShell()) return;
    if (sessionState === 'enrolled') {
      resetDesktopLoginRecoveryEpisode();
      setManualRetryAllowed(false);
      setError(null);
      return;
    }

    let active = true;
    setBusy(true);
    setManualRetryAllowed(false);
    const reported: { message: string | null } = { message: null };
    void recoverDesktopLoginAutomatically({
      onError: (message) => {
        reported.message = message;
      },
    }).then((outcome) => {
      if (!active || outcome === 'enrolled') return;
      setManualRetryAllowed(canRetryDesktopLoginManually());
      if (outcome === 'failed') {
        setError(reported.message ?? 'Enrollment did not produce an operator session.');
      }
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [sessionState]);

  const handleLogin = useCallback(async () => {
    setBusy(true);
    setError(null);
    const reported: { message: string | null } = { message: null };
    try {
      const outcome = await retryDesktopLoginManually({
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

  if (!isDesktopShell() || sessionState === 'enrolled' || busy || !manualRetryAllowed) {
    return null;
  }

  const sessionLabel = sessionState === 'unreachable' ? 'Session unverified' : 'Not logged in';

  if (placement === 'rail') {
    const statusDescription = error ? `${sessionLabel}: ${error}` : sessionLabel;
    return (
      <div className="desktop-login desktop-login--rail" role="status">
        <button
          type="button"
          className="app-rail__item desktop-login__rail-button"
          onClick={handleLogin}
          aria-label="Log in"
          title={`${statusDescription}. Log in with the operator credential from the login keychain`}
        >
          <span className="app-rail__icon">
            <DesktopLoginIcon />
          </span>
          {showRailLabel ? <span className="app-rail__label">Log in</span> : null}
          {!showRailLabel ? <span className="app-rail__tooltip">{statusDescription}</span> : null}
        </button>
        <span className="sr-only">{statusDescription}</span>
      </div>
    );
  }

  return (
    <div className="desktop-login" role="status">
      <span className="desktop-login__label">{sessionLabel}</span>
      <button
        type="button"
        className="desktop-login__button"
        onClick={handleLogin}
        title="Log in with the operator credential from the login keychain"
      >
        Log in
      </button>
      {error ? (
        <span className="desktop-login__error" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
