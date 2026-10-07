import type { Db } from '../db.js';
import type { RouteRegistrar } from '../server.js';

export const CONVERSATION_IDENTITY_SCHEMA_SQL = `CREATE TABLE conversation_identity_aliases (
  alias_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE RESTRICT,
  canonical_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  proof_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK(alias_id != canonical_id)
)` + `;
CREATE TRIGGER conversation_identity_aliases_immutable_update BEFORE UPDATE ON conversation_identity_aliases BEGIN
  SELECT RAISE(ABORT, 'conversation identity repair receipts are immutable'); END;
CREATE TRIGGER conversation_identity_aliases_immutable_delete BEFORE DELETE ON conversation_identity_aliases BEGIN
  SELECT RAISE(ABORT, 'conversation identity repair receipts are immutable'); END`;

/** Durable IDs remain valid after an explicitly proven creation-shell repair. */
export function resolveConversationId(db: Db, id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const alias = db.prepare('SELECT canonical_id FROM conversation_identity_aliases WHERE alias_id = ?')
      .get(current) as { canonical_id: string } | undefined;
    if (!alias) return current;
    current = alias.canonical_id;
  }
  throw new Error(`Conversation identity alias cycle: ${id}`);
}

/** One ID boundary for detail, control, metadata and custody HTTP routes. */
export function canonicalConversationRoutes(server: RouteRegistrar, db: Db): RouteRegistrar {
  return Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method,
    (route: string, handler: Parameters<RouteRegistrar['get']>[1], options: Parameters<RouteRegistrar['get']>[2]) => {
      server[method as keyof RouteRegistrar](route, (req, res) => {
        if (route.startsWith('/api/conversations/:id') && req.params.id) {
          req = { ...req, params: { ...req.params, id: resolveConversationId(db, req.params.id) } };
        }
        return handler(req, res);
      }, options);
    },
  ])) as unknown as RouteRegistrar;
}

type Row = Record<string, unknown>;

function activeController(row: Row | undefined): boolean {
  return !!row && (row.owner_kind === 'mandible' || row.owner_kind === 'external')
    && !['stopped', 'failed', 'unknown'].includes(String(row.controller_state));
}

/**
 * Historical exception: keep the already indexed transcript ID and turn the
 * empty creation shell into an auditable alias. Never infer identity by title.
 */
export function reconcileConversationIdentities(db: Db): number {
  const shells = db.prepare(`SELECT shell.* FROM conversations shell
    JOIN conversation_spawn_requests spawn ON spawn.id = shell.id
      AND spawn.schema_version = 'mandible-conversation-spawn-request@3'
      AND spawn.provider = shell.source
      AND (spawn.provider_session_id IS NULL OR spawn.provider_session_id = shell.session_id)
    WHERE shell.source_path = 'mandible://chat/' || shell.id
      AND shell.session_id IS NOT NULL AND shell.session_id != ''
      AND shell.is_sidechain = 0 AND shell.parent_conversation_id IS NULL AND shell.agent_id IS NULL
      AND shell.block_count = 0
      AND NOT EXISTS (SELECT 1 FROM conversation_blocks WHERE conversation_id = shell.id)
      AND NOT EXISTS (SELECT 1 FROM conversation_sources WHERE conversation_id = shell.id)
      AND NOT EXISTS (SELECT 1 FROM conversation_identity_aliases WHERE alias_id = shell.id)`)
    .all() as Row[];
  let repaired = 0;
  for (const shell of shells) {
    const matches = db.prepare(`SELECT * FROM conversations c
      WHERE source = ? AND session_id = ? AND id != ? AND block_count > 0
        AND is_sidechain = 0 AND parent_conversation_id IS NULL AND agent_id IS NULL
        AND LOWER(source_path) NOT LIKE '%/subagents/%'
        AND EXISTS (SELECT 1 FROM conversation_sources source WHERE source.conversation_id = c.id
          AND source.provider = c.source AND source.native_session_id = c.session_id)
        AND NOT EXISTS (SELECT 1 FROM conversation_identity_aliases WHERE alias_id = c.id)`)
      .all(shell.source, shell.session_id, shell.id) as Row[];
    if (matches.length === 0) continue;
    if (matches.length !== 1) throw new Error(`Ambiguous native Chat identity for creation shell ${shell.id}`);
    const canonical = matches[0];
    const aliasId = String(shell.id);
    const canonicalId = String(canonical.id);
    db.transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      const references: { table: string; column: string; rows: Row[] }[] = [];
      for (const { name } of tables) {
        // Reviewed auth records and other documentary references retain their
        // original identity bytes; the alias resolver keeps them usable.
        if (name === 'conversation_identity_aliases') continue;
        const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
        const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string }[];
        for (const column of columns) {
          if (!['conversation_id', 'parent_conversation_id', 'topology_target_conversation_id'].includes(column.name)
              && !foreignKeys.some((key) => key.table === 'conversations' && key.from === column.name)) continue;
          const rows = db.prepare(`SELECT * FROM "${name}" WHERE "${column.name}" = ?`).all(aliasId) as Row[];
          if (rows.length) references.push({ table: name, column: column.name, rows });
        }
      }
      const shellControl = db.prepare('SELECT * FROM conversation_control_state WHERE conversation_id = ?').get(aliasId) as Row | undefined;
      const canonicalControl = db.prepare('SELECT * FROM conversation_control_state WHERE conversation_id = ?').get(canonicalId) as Row | undefined;
      if (activeController(shellControl) && activeController(canonicalControl)) {
        throw new Error(`Conflicting active controllers for Chat identities ${aliasId} and ${canonicalId}`);
      }
      const active = activeController(shellControl) ? shellControl : activeController(canonicalControl) ? canonicalControl : undefined;
      const inactive = active === shellControl ? canonicalControl : shellControl;
      if (active && inactive && Number(inactive.generation) >= Number(active.generation)) {
        throw new Error(`Overlapping historical controller fences for ${aliasId} and ${canonicalId}`);
      }
      const collisions: { table: string; rows: Row[] }[] = [];
      const singletons = ['conversation_control_state', 'conversation_runtime_settings', 'conversation_archive_states'];
      for (const table of singletons) {
        const from = db.prepare(`SELECT * FROM ${table} WHERE conversation_id = ?`).get(aliasId) as Row | undefined;
        const to = db.prepare(`SELECT * FROM ${table} WHERE conversation_id = ?`).get(canonicalId) as Row | undefined;
        if (!from || !to) continue;
        collisions.push({ table, rows: [from, to] });
        // Preserve the original reservation's controller unless the transcript
        // has the only active controller. Explicit settings use the latest update;
        // archive markers retain their canonical state and both original receipts.
        let keepShell = table === 'conversation_control_state' && !activeController(to);
        if (table === 'conversation_runtime_settings') {
          const fromTime = Number(from.updated_at);
          const toTime = Number(to.updated_at);
          if (fromTime === toTime && from.options_json !== to.options_json) {
            throw new Error(`Ambiguous explicit Chat settings for ${aliasId} and ${canonicalId}`);
          }
          keepShell = fromTime > toTime;
        }
        db.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`).run(keepShell ? canonicalId : aliasId);
      }
      for (const ref of references) {
        if (ref.table === 'auth_requests' || ref.table === 'conversation_control_journal') continue;
        db.prepare(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE "${ref.column}" = ?`).run(canonicalId, aliasId);
      }
      const maxRevision = (db.prepare('SELECT MAX(revision) AS revision FROM conversation_control_journal WHERE conversation_id IN (?, ?)')
        .get(aliasId, canonicalId) as { revision: number | null }).revision ?? 0;
      db.prepare('UPDATE conversation_control_state SET revision = MAX(revision, ?) WHERE conversation_id = ?').run(maxRevision, canonicalId);
      if (!active && (shellControl || canonicalControl)) {
        const generation = Math.max(Number(shellControl?.generation ?? 0), Number(canonicalControl?.generation ?? 0)) + 1;
        db.prepare('UPDATE conversation_control_state SET generation = ? WHERE conversation_id = ?').run(generation, canonicalId);
        db.prepare("UPDATE conversation_control_outbox SET state = 'uncertain' WHERE conversation_id = ? AND state IN ('pending','delivering')").run(canonicalId);
      }
      const tags = [...new Set([...JSON.parse(String(canonical.tags ?? '[]')), ...JSON.parse(String(shell.tags ?? '[]'))])];
      const notes = [...new Set([canonical.notes, shell.notes].filter((note) => typeof note === 'string' && note.length))].join('\n\n');
      db.prepare('UPDATE conversations SET starred = ?, tags = ?, notes = ? WHERE id = ?')
        .run(canonical.starred || shell.starred ? 1 : 0, JSON.stringify(tags), notes || null, canonicalId);
      db.prepare('UPDATE conversation_spawn_requests SET provider_session_id = ? WHERE id = ? AND provider_session_id IS NULL')
        .run(shell.session_id, aliasId);
      db.prepare('INSERT INTO conversation_identity_aliases (alias_id, canonical_id, proof_json, created_at) VALUES (?, ?, ?, ?)')
        .run(aliasId, canonicalId, JSON.stringify({ schema: 'mandible-chat-identity-repair@1', shell, canonical, references, collisions }), Date.now());
    })();
    repaired++;
  }
  return repaired;
}
