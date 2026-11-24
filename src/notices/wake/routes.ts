import fs from "node:fs";
import path from "node:path";
import * as z from "zod";
import { REGISTERED_ROUTE } from "../contract.js";
import type { RegisteredRoute } from "./types.js";

const FILE = z.object({
  version: z.literal(1),
  routes: z.array(z.object({ session_id: z.string().min(1), route: REGISTERED_ROUTE })),
});

/** The route store sits beside the instance's private local socket, like the execution outbox. */
export function wakeRouteFile(socketPath: string): string {
  return path.join(path.dirname(socketPath), `${path.basename(socketPath, ".sock")}.wake-routes.json`);
}

export type RouteLoadError = { code: "unreadable" | "malformed"; detail: string };

/**
 * The routes that Claude and Antigravity CLI sessions registered from inside
 * themselves, keyed by provider and session. Held in memory and mirrored to a
 * mode-0600 file so that a daemon restart keeps them; never in the database.
 */
export class WakeRouteStore {
  private readonly routes = new Map<string, RegisteredRoute>();

  private constructor(private readonly file: string | null) {}

  /** A store with no file, for tests and for daemons that keep no routes across restarts. */
  static memory(): WakeRouteStore {
    return new WakeRouteStore(null);
  }

  /**
   * Loads the file if it exists. A file that cannot be read or parsed yields an
   * empty store, which rewrites the file at its next change, and the error.
   */
  static open(file: string): { store: WakeRouteStore; error: RouteLoadError | null } {
    const store = new WakeRouteStore(file);
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { store, error: null };
      return { store, error: { code: "unreadable", detail: String(error) } };
    }
    let parsed: z.infer<typeof FILE>;
    try { parsed = FILE.parse(JSON.parse(raw)); }
    catch (error) { return { store, error: { code: "malformed", detail: error instanceof Error ? error.message.slice(0, 500) : "invalid" } }; }
    for (const entry of parsed.routes) store.routes.set(key(entry.route.provider, entry.session_id), entry.route);
    return { store, error: null };
  }

  get(provider: string, sessionId: string): RegisteredRoute | null {
    return this.routes.get(key(provider, sessionId)) ?? null;
  }

  /** Whether the stored route changed. */
  register(sessionId: string, route: RegisteredRoute): boolean {
    const id = key(route.provider, sessionId);
    const previous = this.routes.get(id);
    if (previous && JSON.stringify(previous) === JSON.stringify(route)) return false;
    this.routes.set(id, route);
    this.persist();
    return true;
  }

  drop(provider: string, sessionId: string): void {
    if (this.routes.delete(key(provider, sessionId))) this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    const routes = [...this.routes].map(([id, route]) => ({ session_id: id.slice(id.indexOf("\0") + 1), route }));
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, routes }), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, this.file);
  }
}

function key(provider: string, sessionId: string): string {
  return `${provider}\0${sessionId}`;
}
