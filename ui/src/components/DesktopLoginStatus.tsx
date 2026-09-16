import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { isDesktopShell } from '../api';
import {
  beginLegacyBrowserRecovery,
  completeBrowserPairing,
  getBrowserSessionMigrationFailure,
  getClientAuthSessionState,
  isLegacyBrowserOrigin,
  logoutClientAuth,
  startBrowserPairing,
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
  const [pairingReference, setPairingReference] = useState<string | null>(null);

  useEffect(() => subscribeClientAuthSessionState(setSessionState), []);

  useEffect(() => {
    if (sessionState === 'migration-blocked') {
      setManualRetryAllowed(false);
      setBusy(false);
      return;
    }
    if (sessionState === 'enrolled') {
      resetDesktopLoginRecoveryEpisode();
      setManualRetryAllowed(false);
      setError(null);
      return;
    }
    if (!isDesktopShell()) {
      setManualRetryAllowed(true);
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
      if (!isDesktopShell()) {
        if (isLegacyBrowserOrigin()) {
          beginLegacyBrowserRecovery();
          return;
        }
        if (!pairingReference) {
          setPairingReference(await startBrowserPairing());
        } else {
          await completeBrowserPairing(pairingReference);
          setPairingReference(null);
        }
        return;
      }
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
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not reconnect this browser.');
    } finally {
      setBusy(false);
    }
  }, [pairingReference]);

  const handleLogout = useCallback(async () => {
    setBusy(true);
    try {
      await logoutClientAuth();
    } finally {
      setBusy(false);
    }
  }, []);

  if (sessionState === 'migration-blocked') {
    const message = getBrowserSessionMigrationFailure()
      ?? 'Existing browser state could not be migrated. Keep this profile intact and ask the operator to resolve it before conversion.';
    return placement === 'rail' ? (
      <div className="desktop-login desktop-login--rail" role="alert" title={message}>
        <span className="app-rail__item" aria-label="Browser migration blocked">
          <span className="app-rail__icon"><DesktopLoginIcon /></span>
          {showRailLabel ? <span className="app-rail__label">Migration blocked</span> : null}
        </span>
        <span className="sr-only">{message}</span>
      </div>
    ) : (
      <div className="desktop-login" role="alert">
        <span className="desktop-login__label">Migration blocked</span>
        <span className="desktop-login__error">{message}</span>
      </div>
    );
  }

  if (busy) {
    return null;
  }

  if (sessionState === 'enrolled') {
    return placement === 'rail' ? (
      <div className="desktop-login desktop-login--rail">
        <button
          type="button"
          className="app-rail__item desktop-login__rail-button"
          onClick={handleLogout}
          aria-label="Log out"
          title="Log out this browser profile"
        >
          <span className="app-rail__icon"><DesktopLoginIcon /></span>
          {showRailLabel ? <span className="app-rail__label">Log out</span> : null}
          {!showRailLabel ? <span className="app-rail__tooltip">Log out</span> : null}
        </button>
      </div>
    ) : (
      <button type="button" className="desktop-login__button" onClick={handleLogout}>
        Log out
      </button>
    );
  }

  if (!manualRetryAllowed) return null;

  const sessionLabel = sessionState === 'unreachable'
    ? 'Mandible unavailable'
    : sessionState === 'wrong-audience'
      ? 'Different Mandible instance'
      : sessionState === 'expired'
        ? 'Session expired'
        : sessionState === 'revoked'
          ? 'Session revoked'
          : 'Not logged in';
  const actionLabel = isDesktopShell() ? 'Log in'
    : isLegacyBrowserOrigin() ? 'Reconnect browser'
      : pairingReference ? 'Complete pairing' : 'Pair browser';
  const pairingHint = pairingReference
    ? `Approve ${pairingReference} with: mandible user pair ${pairingReference}`
    : null;

  if (placement === 'rail') {
    const statusDescription = pairingHint ?? (error ? `${sessionLabel}: ${error}` : sessionLabel);
    return (
      <div
        className="desktop-login desktop-login--rail"
        role={isDesktopShell() ? 'status' : undefined}
      >
        <button
          type="button"
          className="app-rail__item desktop-login__rail-button"
          onClick={handleLogin}
          aria-label={actionLabel}
          title={`${statusDescription}. ${isDesktopShell() ? 'Log in with the operator credential from the login keychain' : 'Retry the saved browser session or open a new pairing link'}`}
        >
          <span className="app-rail__icon">
            <DesktopLoginIcon />
          </span>
          {showRailLabel ? <span className="app-rail__label">{actionLabel}</span> : null}
          {!showRailLabel ? <span className="app-rail__tooltip">{statusDescription}</span> : null}
        </button>
        <span className="sr-only">{statusDescription}</span>
      </div>
    );
  }

  return (
    <div className="desktop-login" role={isDesktopShell() ? 'status' : undefined}>
      <span className="desktop-login__label">{sessionLabel}</span>
      <button
        type="button"
        className="desktop-login__button"
        onClick={handleLogin}
        title={isDesktopShell()
          ? 'Log in with the operator credential from the login keychain'
          : 'Retry the saved browser session or open a new pairing link'}
      >
        {actionLabel}
      </button>
      {error ? (
        <span className="desktop-login__error" title={error}>
          {error}
        </span>
      ) : null}
      {pairingHint ? <span className="desktop-login__error">{pairingHint}</span> : null}
    </div>
  );
}
