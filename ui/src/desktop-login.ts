import {
  enrollDesktopClientAuth,
  isDesktopShell,
  type DesktopEnrollmentSource,
} from './api';
import { initializeBrowserSession } from './client-auth-token';

export const AUTOMATIC_ENROLLMENT_SOURCES: readonly DesktopEnrollmentSource[] = ['bootstrap'];
export const MANUAL_ENROLLMENT_SOURCES: readonly DesktopEnrollmentSource[] = ['keychain'];

export type DesktopLoginOutcome = 'enrolled' | 'unavailable' | 'failed';

export interface DesktopLoginDeps {
  enroll(source: DesktopEnrollmentSource): Promise<boolean>;
  refreshSession(): Promise<'enrolled' | string>;
  onError?(message: string): void;
}

export class DesktopLoginRecoveryCoordinator {
  private automaticAttempt: Promise<DesktopLoginOutcome> | null = null;
  private manualRetryAllowed = false;

  recover(run: () => Promise<DesktopLoginOutcome>): Promise<DesktopLoginOutcome> {
    if (this.automaticAttempt) return this.automaticAttempt;
    this.automaticAttempt = run().then((outcome) => {
      this.manualRetryAllowed = outcome !== 'enrolled';
      return outcome;
    });
    return this.automaticAttempt;
  }

  retry(run: () => Promise<DesktopLoginOutcome>): Promise<DesktopLoginOutcome> {
    return this.manualRetryAllowed ? run() : Promise.resolve('unavailable');
  }

  reset(): void {
    this.automaticAttempt = null;
    this.manualRetryAllowed = false;
  }

  canRetryManually(): boolean {
    return this.manualRetryAllowed;
  }
}

const coordinator = new DesktopLoginRecoveryCoordinator();

export async function attemptDesktopLogin(
  sources: readonly DesktopEnrollmentSource[],
  deps: DesktopLoginDeps,
): Promise<DesktopLoginOutcome> {
  let failed = false;
  for (const source of sources) {
    try {
      if (!await deps.enroll(source)) continue;
      return await deps.refreshSession() === 'enrolled' ? 'enrolled' : 'failed';
    } catch (error) {
      failed = true;
      deps.onError?.(error instanceof Error ? error.message : String(error));
    }
  }
  return failed ? 'failed' : 'unavailable';
}

export async function runDesktopLogin(
  options: { manual?: boolean; onError?: (message: string) => void } = {},
): Promise<DesktopLoginOutcome> {
  if (!isDesktopShell()) return 'unavailable';
  return attemptDesktopLogin(
    options.manual ? MANUAL_ENROLLMENT_SOURCES : AUTOMATIC_ENROLLMENT_SOURCES,
    {
      enroll: (source) => enrollDesktopClientAuth(source),
      refreshSession: () => initializeBrowserSession(),
      onError: options.onError,
    },
  );
}

export function recoverDesktopLoginAutomatically(
  options: { onError?: (message: string) => void } = {},
): Promise<DesktopLoginOutcome> {
  return isDesktopShell()
    ? coordinator.recover(() => runDesktopLogin(options))
    : Promise.resolve('unavailable');
}

export function retryDesktopLoginManually(
  options: { onError?: (message: string) => void } = {},
): Promise<DesktopLoginOutcome> {
  return coordinator.retry(() => runDesktopLogin({ ...options, manual: true }));
}

export function resetDesktopLoginRecoveryEpisode(): void {
  coordinator.reset();
}

export function canRetryDesktopLoginManually(): boolean {
  return coordinator.canRetryManually();
}
