import type { Db } from "../db.js";
import type { EmbedGrant, EmbedIdentity } from "./contract.js";
import { loopbackOriginPort, resolveEmbedPage, systemEmbedProbe, type EmbedProcessProbe } from "./embed-identity.js";

/**
 * The operator's grants to embedding pages. A page's origin, as written, and the
 * directory its listener runs in are one request; the bridge gets an identity only
 * for a request the operator allowed in Mandible's own interface. Any other request
 * is recorded as pending so the operator can find it there.
 *
 * Pending requests are bounded, since any page on a loopback port can ask under
 * many `*.localhost` names: an unanswered request expires after a week, and each
 * port keeps only its latest few.
 */

export const PENDING_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_GRANTS_PER_PORT = 3;

export type EmbedAccess =
  | { ok: true; value: EmbedIdentity }
  | { ok: false; error: "origin_not_loopback" | "origin_not_registered" }
  | { ok: false; error: "origin_not_granted"; grant: EmbedGrant };

type GrantRow = {
  origin: string; directory: string; app: string; state: "pending" | "granted"; requested_at: number; decided_at: number | null;
  project_id: string; project_key: string; display_name: string;
};

const GRANT_SELECT = `SELECT g.origin, g.directory, g.app, g.state, g.requested_at, g.decided_at,
  g.project_id, p.project_key, p.display_name
  FROM interface_note_embed_grants g JOIN ledger_projects p ON p.id = g.project_id`;

function grantFromRow(row: GrantRow): EmbedGrant {
  return {
    origin: row.origin, directory: row.directory, app: row.app, state: row.state,
    requested_at: row.requested_at, decided_at: row.decided_at,
    project: { id: row.project_id, key: row.project_key, name: row.display_name },
  };
}

export class EmbedGrants {
  constructor(private readonly db: Db, private readonly probe: EmbedProcessProbe = systemEmbedProbe) {}

  async access(origin: string, now: number = Date.now()): Promise<EmbedAccess> {
    const page = await resolveEmbedPage(this.db, this.probe, origin);
    if (!page.ok) return page;
    const { directory, ...identity } = page.value;
    const existing = this.get(origin, directory);
    if (existing?.state === "granted" && existing.project.id === identity.project.id && existing.app === identity.app) {
      return { ok: true, value: identity };
    }
    // A request whose directory now names another app is asked afresh.
    this.prunePending(now, origin, directory);
    this.db.prepare(
      `INSERT INTO interface_note_embed_grants (origin, directory, app, project_id, state, requested_at, decided_at)
       VALUES (?, ?, ?, ?, 'pending', ?, NULL)
       ON CONFLICT (origin, directory) DO UPDATE SET app = excluded.app, project_id = excluded.project_id,
         state = 'pending', requested_at = excluded.requested_at, decided_at = NULL`,
    ).run(origin, directory, identity.app, identity.project.id, now);
    return { ok: false, error: "origin_not_granted", grant: this.get(origin, directory)! };
  }

  /** The apps an origin is allowed to write notes for: one per granted directory. */
  grantedApps(origin: string): ReadonlySet<string> {
    const rows = this.db.prepare("SELECT app FROM interface_note_embed_grants WHERE origin = ? AND state = 'granted'").all(origin) as Array<{ app: string }>;
    return new Set(rows.map((row) => row.app));
  }

  list(now: number = Date.now()): EmbedGrant[] {
    this.prunePending(now);
    return (this.db.prepare(`${GRANT_SELECT} ORDER BY g.state = 'granted', g.requested_at DESC`).all() as GrantRow[]).map(grantFromRow);
  }

  get(origin: string, directory: string): EmbedGrant | null {
    const row = this.db.prepare(`${GRANT_SELECT} WHERE g.origin = ? AND g.directory = ?`).get(origin, directory) as GrantRow | undefined;
    return row ? grantFromRow(row) : null;
  }

  allow(origin: string, directory: string, now: number = Date.now()): EmbedGrant | null {
    const changed = this.db.prepare(
      "UPDATE interface_note_embed_grants SET state = 'granted', decided_at = ? WHERE origin = ? AND directory = ?",
    ).run(now, origin, directory).changes;
    return changed ? this.get(origin, directory) : null;
  }

  /** Revokes a grant or dismisses a pending request; the page asks afresh on its next load. */
  remove(origin: string, directory: string): boolean {
    return this.db.prepare("DELETE FROM interface_note_embed_grants WHERE origin = ? AND directory = ?").run(origin, directory).changes > 0;
  }

  /**
   * Drops expired pending requests and, when `origin` is about to ask, that port's
   * oldest pending requests beyond the cap less one, leaving room for the new one.
   */
  private prunePending(now: number, origin?: string, directory?: string): void {
    this.db.prepare("DELETE FROM interface_note_embed_grants WHERE state = 'pending' AND requested_at < ?").run(now - PENDING_GRANT_TTL_MS);
    if (origin === undefined) return;
    const port = loopbackOriginPort(origin);
    const samePort = (this.db.prepare(
      "SELECT origin, directory FROM interface_note_embed_grants WHERE state = 'pending' ORDER BY requested_at DESC",
    ).all() as Array<{ origin: string; directory: string }>)
      .filter((row) => loopbackOriginPort(row.origin) === port && !(row.origin === origin && row.directory === directory));
    const remove = this.db.prepare("DELETE FROM interface_note_embed_grants WHERE origin = ? AND directory = ?");
    for (const row of samePort.slice(PENDING_GRANTS_PER_PORT - 1)) remove.run(row.origin, row.directory);
  }
}
