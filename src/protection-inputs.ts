/**
 * Change signal for the inputs that decide who may move a protected branch:
 * the `protected_branches` setting, registered checkouts and their default
 * branches, the operator identity, and the operator's signing credentials.
 *
 * Writers call `notifyProtectionInputsChanged` after a change. Listeners are
 * registered only by the production daemon, so library callers such as the
 * CLI and tests pay nothing. The signal carries no payload: listeners re-read
 * current state, which keeps a missed or duplicated signal harmless.
 */
type Listener = (reason: string) => void;

const listeners = new Set<Listener>();

export function onProtectionInputsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyProtectionInputsChanged(reason: string): void {
  for (const listener of listeners) {
    try {
      listener(reason);
    } catch {
      // A listener failure must never fail the write that signalled it.
    }
  }
}
