import type { Db } from "../db.js";
import type { EmbedGrant, EmbedIdentity } from "./contract.js";
import { resolveEmbedPage, systemEmbedProbe, type EmbedProcessProbe } from "./embed-identity.js";

/**
 * The operator's grants to other apps. A grant is for an app of a project
 * (`feedbax:web`): once allowed, a page whose listener runs in that app's
 * directory of any checkout of the project, on any loopback port, gets the
 * toolbar. A page of an app not yet allowed is recorded as a pending request,
 * with the origin and directory it came from, so the operator can find it in
 * Mandible's own interface.
 *
 * Requests are bounded by the apps that exist: a page cannot invent an app, since
 * the app is read from its listener's directory, so asking under many
 * `*.localhost` names updates one row. An unanswered request expires after a week.
 */

export const PENDING_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type EmbedAccess =
  | { ok: true; value: EmbedIdentity }
  | { ok: false; error: "origin_not_loopback" | "origin_not_registered" }
  | { ok: false; error: "origin_not_granted"; grant: EmbedGrant };

/** A grant's key: an app of a project. */
export type EmbedGrantKey = { project_id: string; app: string };

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
    const key = { project_id: identity.project.id, app: identity.app };
    if (this.get(key)?.state === "granted") {
      // Shown as the latest page served under the grant; a write only when it changed.
      this.db.prepare(
        `UPDATE interface_note_embed_grants SET origin = ?, directory = ?
         WHERE project_id = ? AND app = ? AND (origin <> ? OR directory <> ?)`,
      ).run(origin, directory, key.project_id, key.app, origin, directory);
      return { ok: true, value: identity };
    }
    this.pruneExpired(now);
    this.db.prepare(
      `INSERT INTO interface_note_embed_grants (project_id, app, state, origin, directory, requested_at, decided_at)
       VALUES (?, ?, 'pending', ?, ?, ?, NULL)
       ON CONFLICT (project_id, app) DO UPDATE SET origin = excluded.origin, directory = excluded.directory,
         requested_at = excluded.requested_at`,
    ).run(key.project_id, key.app, origin, directory, now);
    return { ok: false, error: "origin_not_granted", grant: this.get(key)! };
  }

  /** Whether notes of this app may be written through the embed. */
  isGranted(app: string): boolean {
    return this.db.prepare("SELECT 1 FROM interface_note_embed_grants WHERE app = ? AND state = 'granted'").get(app) !== undefined;
  }

  list(now: number = Date.now()): EmbedGrant[] {
    this.pruneExpired(now);
    return (this.db.prepare(`${GRANT_SELECT} ORDER BY g.state = 'granted', g.requested_at DESC`).all() as GrantRow[]).map(grantFromRow);
  }

  get(key: EmbedGrantKey): EmbedGrant | null {
    const row = this.db.prepare(`${GRANT_SELECT} WHERE g.project_id = ? AND g.app = ?`).get(key.project_id, key.app) as GrantRow | undefined;
    return row ? grantFromRow(row) : null;
  }

  allow(key: EmbedGrantKey, now: number = Date.now()): EmbedGrant | null {
    const changed = this.db.prepare(
      "UPDATE interface_note_embed_grants SET state = 'granted', decided_at = ? WHERE project_id = ? AND app = ?",
    ).run(now, key.project_id, key.app).changes;
    return changed ? this.get(key) : null;
  }

  /** Revokes a grant or dismisses a pending request; the app's pages ask afresh on their next load. */
  remove(key: EmbedGrantKey): boolean {
    return this.db.prepare("DELETE FROM interface_note_embed_grants WHERE project_id = ? AND app = ?").run(key.project_id, key.app).changes > 0;
  }

  private pruneExpired(now: number): void {
    this.db.prepare("DELETE FROM interface_note_embed_grants WHERE state = 'pending' AND requested_at < ?").run(now - PENDING_GRANT_TTL_MS);
  }
}
