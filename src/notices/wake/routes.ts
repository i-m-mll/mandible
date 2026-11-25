import type { RegisteredRoute } from "./types.js";

/**
 * The routes that Claude and Antigravity CLI sessions registered from inside
 * themselves, keyed by provider and session. Held in the daemon's memory only:
 * after a restart a session's route returns with its next hook call or
 * `mandible` command.
 */
export class WakeRouteStore {
  private readonly routes = new Map<string, RegisteredRoute>();

  get(provider: string, sessionId: string): RegisteredRoute | null {
    return this.routes.get(key(provider, sessionId)) ?? null;
  }

  /** Whether the stored route changed. */
  register(sessionId: string, route: RegisteredRoute): boolean {
    const id = key(route.provider, sessionId);
    const previous = this.routes.get(id);
    if (previous && JSON.stringify(previous) === JSON.stringify(route)) return false;
    this.routes.set(id, route);
    return true;
  }

  drop(provider: string, sessionId: string): void {
    this.routes.delete(key(provider, sessionId));
  }
}

function key(provider: string, sessionId: string): string {
  return `${provider}\0${sessionId}`;
}
