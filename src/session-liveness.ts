import { sessionExecutionReader } from "./session-execution.js";
import type { SessionExecutionObservation } from "./contracts.js";
/**
 * One canonical answer to two questions that used to be answered three
 * different ways (issue 5b2cdbf):
 *
 *   1. "Does this string name a session Mandible knows about, and what are its
 *      full identities?" — {@link resolveSessionAlias}.
 *   2. "Is the agent behind this string live, stopped, or unknowable right
 *      now?" — {@link sessionAliasLiveness}.
 *
 * A caller may hold any one of four aliases for the same agent: a `sessions.id`,
 * a `console_sessions.id`, a `console_sessions.mandible_session_id`, or a
 * `console_sessions.provider_session_id` (the provider's own thread id). Before
 * this module, `src/routes/issues.ts` compared `sessions.status` directly and
 * understood only the first form, so a provider thread id — the id a Codex
 * coordinator actually has — resolved to nothing and was reported as a dead
 * holder. `src/codex-thread-archive.ts` understood all four but kept its own
 * copy of the rule, and `src/ledger/graph-adapter.ts` kept a third copy of the
 * status list.
 *
 * The liveness rule here began as the archive path's predicate: that path
 * decides whether a Codex thread may be archived, and a false negative there
 * archives a live thread. It answers in three states so that a check that
 * could not complete is never mistaken for a stop (issue 8c7eb06).
 *
 * Provider-native task activity is read through a leaf adapter, so every
 * consumer shares the same answer without depending on route or UI state.
 */
import type { LivenessState } from "./contracts.js";
import { getDaemonLogger } from "./daemon-log.js";
import type { Db } from "./db.js";
import { columnExists, tableExists } from "./db-introspection.js";
import { readCodexTaskLiveness, withFreshCodexTaskLiveness } from "./codex-task-liveness.js";
import {
  resolveProviderSessionIngestions,
  type ProviderSessionIngestion,
} from "./provider-session-ingestion.js";

/**
 * The statuses that mean "an agent is still behind this session". `running` is
 * a `console_sessions` status; `active` and `idle` are used by both tables.
 */
export const LIVE_SESSION_STATUSES = ["active", "idle", "running"] as const;

export type { LivenessState } from "./contracts.js";

export function isLiveSessionStatus(value: unknown): boolean {
  return value === "active" || value === "idle" || value === "running";
}

/** Every identity Mandible holds for one resolved session alias. */
export interface SessionAliasResolution {
  /** Exactly the string the caller supplied. */
  supplied_id: string;
  /** `sessions.id`, when the alias reaches a Mandible session row. */
  mandible_session_id: string | null;
  /** `console_sessions.id`, when the alias reaches a console session row. */
  console_session_id: string | null;
  /** The provider's own session/thread id, when one is recorded. */
  provider_session_id: string | null;
  /** Provider name: `sessions.app`, else the console session's command. */
  provider: string | null;
  mandible_status: string | null;
  console_status: string | null;
  /** ISO timestamp of the Mandible session's last activity, when known. */
  last_activity: string | null;
  liveness: LivenessState;
  execution?: SessionExecutionObservation | null;
}

interface SessionRow {
  id: string;
  app?: string | null;
  status?: string | null;
  conversation_id?: string | null;
  updated_at?: string | null;
  last_active?: string | null;
}

interface ConsoleRow {
  id: string;
  command?: string | null;
  status?: string | null;
  mandible_session_id?: string | null;
  provider_session_id?: string | null;
  updated_at?: number | null;
}

export type ProviderTaskLivenessReader = (
  sourcePath: string,
  providerSessionId: string,
) => { status: "live" | "not_live" | "unavailable" };

export interface SessionLivenessOptions {
  readCodexTaskLiveness?: ProviderTaskLivenessReader;
}

export type SessionAliasResolver = (db: Db, sessionId: string) => SessionAliasResolution | null;

/**
 * A resolver for a decision that acts on liveness: its Codex answers come from
 * lock scans made for this decision, never from a display read's older scan.
 * `probe` asks the questions the decision will ask, so the scans they need
 * run, off the event loop, before the resolver is returned.
 */
export function freshSessionAliasResolver(
  probe: (resolve: SessionAliasResolver) => unknown,
): Promise<SessionAliasResolver> {
  return withFreshCodexTaskLiveness((read) => {
    const resolve: SessionAliasResolver = (db, id) => resolveSessionAlias(db, id, { readCodexTaskLiveness: read });
    probe(resolve);
    return resolve;
  });
}

/**
 * Resolve any known alias for a session to its full identity, or `null` when
 * Mandible has no record of it.
 *
 * `null` is the signal a caller needs to refuse an unverifiable id. It is not
 * the same as "resolved but not live": a resolved-and-dead session is a real
 * session whose agent has stopped, while `null` means nothing in this Mandible
 * instance has ever claimed that string.
 */
export function resolveSessionAlias(
  db: Db,
  suppliedId: string,
  options: SessionLivenessOptions = {},
): SessionAliasResolution | null {
  const id = suppliedId.trim();
  if (!id) return null;
  return new SessionAliasIndex(db, [id], options).resolve(id);
}

/**
 * {@link resolveSessionAlias} for every alias in `suppliedIds`, reading the
 * rows they reach in a fixed number of queries rather than a dozen per alias.
 * The returned resolver answers only for those aliases.
 */
export function sessionAliasResolverFor(
  db: Db,
  suppliedIds: Iterable<string>,
  options: SessionLivenessOptions = {},
): SessionAliasResolver {
  const ids = [...suppliedIds].map((id) => id.trim()).filter(Boolean);
  const index = new SessionAliasIndex(db, ids, options);
  return (_db, id) => {
    const trimmed = id.trim();
    return trimmed ? index.resolve(trimmed) : null;
  };
}

/**
 * The id a session-to-issue link is keyed on: the provider session id when one
 * is known, else the console or session row id that is the session's only
 * identity. Linking never creates a `sessions` row.
 */
export function sessionLinkKey(resolution: SessionAliasResolution): string {
  return resolution.provider_session_id
    ?? resolution.console_session_id
    ?? resolution.mandible_session_id
    ?? resolution.supplied_id;
}

/** Every id the resolved session is known by, for reads keyed on any of them. */
export function sessionAliasIds(resolution: SessionAliasResolution): string[] {
  return [...new Set(
    [
      resolution.supplied_id,
      resolution.mandible_session_id,
      resolution.console_session_id,
      resolution.provider_session_id,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  )];
}

/**
 * Whether the agent behind this alias is live, stopped, or of unknown liveness.
 *
 * Every row reachable from the alias contributes evidence, and the strongest
 * wins: one live row is enough to leave the agent alone, a check that could
 * not complete makes the answer `unknown` unless another row proves the agent
 * live, and only when every check completed without finding a live agent is it
 * `stopped`. An alias that carries no liveness signal at all — an unknown id,
 * or a transcript with no process row — is `stopped`.
 *
 * `unknown` is never "not live": a Codex thread whose writer-lock scan failed
 * may be working right now, so no caller may clear, archive, or take over
 * behind it.
 */
export function sessionAliasLiveness(
  db: Db,
  suppliedId: string,
  options: SessionLivenessOptions = {},
): LivenessState {
  return new SessionAliasIndex(db, [suppliedId], options).liveness(suppliedId);
}

function statusLiveness(status: unknown): LivenessState {
  return isLiveSessionStatus(status) ? "live" : "stopped";
}

/**
 * Every row the alias rules read for a set of aliases, loaded up front by
 * set-based queries. `SELECT *` on `sessions` because its display columns
 * (`app`, `last_active`, `updated_at`) are optional, and a missing one must
 * read as "unknown", never as an error.
 */
class SessionAliasIndex {
  private readonly ids: Set<string>;
  private readonly hasSessions: boolean;
  private readonly hasConversationId: boolean;
  private readonly hasConsole: boolean;
  private readonly sessionsById = new Map<string, SessionRow>();
  private readonly sessionsByConversation = new Map<string, SessionRow[]>();
  private readonly consoleByAlias = new Map<string, ConsoleRow[]>();
  private readonly ingestions: Map<string, ProviderSessionIngestion> | Error | null;
  private resolutions: Map<string, SessionAliasResolution | null> | null = null;

  constructor(private readonly db: Db, suppliedIds: Iterable<string>, private readonly options: SessionLivenessOptions) {
    this.ids = new Set(suppliedIds);
    const ids = JSON.stringify([...this.ids]);
    this.hasSessions = tableExists(db, "sessions");
    this.hasConversationId = this.hasSessions && columnExists(db, "sessions", "conversation_id");
    this.hasConsole = tableExists(db, "console_sessions");

    const consoleRows = new Map<string, ConsoleRow>();
    if (this.hasConsole) {
      for (const column of ["id", "mandible_session_id", "provider_session_id"]) {
        for (const row of db.prepare(`SELECT * FROM console_sessions WHERE ${column} IN (SELECT value FROM json_each(?))`).all(ids) as ConsoleRow[]) {
          consoleRows.set(row.id, row);
        }
      }
      for (const row of consoleRows.values()) {
        for (const alias of new Set([row.id, row.mandible_session_id, row.provider_session_id])) {
          if (typeof alias !== "string" || !this.ids.has(alias)) continue;
          const rows = this.consoleByAlias.get(alias);
          if (rows) rows.push(row);
          else this.consoleByAlias.set(alias, [row]);
        }
      }
    }

    if (this.hasSessions) {
      const sessionIds = new Set(this.ids);
      for (const row of consoleRows.values()) if (row.mandible_session_id) sessionIds.add(row.mandible_session_id);
      for (const row of db.prepare("SELECT * FROM sessions WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...sessionIds])) as SessionRow[]) {
        this.sessionsById.set(row.id, row);
      }
      if (this.hasConversationId) {
        for (const row of db.prepare(
          `SELECT * FROM sessions
           WHERE conversation_id IN (SELECT value FROM json_each(?))
           ORDER BY updated_at DESC, id ASC`,
        ).all(ids) as SessionRow[]) {
          const rows = this.sessionsByConversation.get(row.conversation_id!);
          if (rows) rows.push(row);
          else this.sessionsByConversation.set(row.conversation_id!, [row]);
        }
      }
    }

    if (!tableExists(db, "conversations")) this.ingestions = null;
    else {
      try {
        this.ingestions = resolveProviderSessionIngestions(db, [...this.ids].map((id) => id.trim()));
      } catch (error) {
        this.ingestions = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  resolve(id: string): SessionAliasResolution | null {
    this.resolutions ??= this.resolveAll();
    if (!this.resolutions.has(id)) throw new Error(`Session alias was not indexed: ${id}`);
    return this.resolutions.get(id)!;
  }

  /** The strongest liveness evidence any row reachable from the alias gives. */
  liveness(id: string): LivenessState {
    let answer: LivenessState = "stopped";
    for (const evidence of this.livenessEvidence(id)) {
      if (evidence === "live") return "live";
      if (evidence === "unknown") answer = "unknown";
    }
    return answer;
  }

  private resolveAll(): Map<string, SessionAliasResolution | null> {
    const resolutions = new Map([...this.ids].map((id) => [id, this.resolveIdentity(id)]));
    const execution = sessionExecutionReader(this.db, [...resolutions.values()].flatMap((resolution) =>
      resolution?.provider_session_id ? [resolution.provider_session_id] : []));
    for (const resolution of resolutions.values()) {
      if (resolution) resolution.execution = execution(resolution.provider, resolution.provider_session_id);
    }
    return resolutions;
  }

  private resolveIdentity(id: string): SessionAliasResolution | null {
    const directSession = this.session(id) ?? this.sessionsByConversation.get(id)?.[0] ?? null;
    const consoleRow = this.pickConsoleRow(this.consoleByAlias.get(id) ?? []);
    const ingestion = this.ingestion(id);
    const providerIngestion = ingestion instanceof Error || ingestion?.status !== "ingested" ? null : ingestion;
    if (!directSession && !consoleRow && !providerIngestion) return null;

    // A console row that names a Mandible session carries the richer identity:
    // status and last activity live on `sessions`, not on `console_sessions`.
    const linkedSession = directSession
      ?? (consoleRow?.mandible_session_id ? this.session(consoleRow.mandible_session_id) : null);

    const provider = linkedSession?.app?.trim() || consoleRow?.command?.trim() || providerIngestion?.provider || null;
    const providerId = consoleRow?.provider_session_id?.trim() || linkedSession?.conversation_id?.trim() || providerIngestion?.provider_session_id || null;
    return {
      execution: null,
      supplied_id: id,
      mandible_session_id: linkedSession?.id ?? null,
      console_session_id: consoleRow?.id ?? null,
      provider_session_id: providerId,
      provider,
      mandible_status: linkedSession?.status ?? null,
      console_status: consoleRow?.status ?? null,
      last_activity: linkedSession?.last_active
        ?? linkedSession?.updated_at
        ?? providerIngestion?.last_activity
        ?? null,
      liveness: this.liveness(id),
    };
  }

  private session(id: string): SessionRow | null {
    return this.sessionsById.get(id) ?? null;
  }

  private ingestion(id: string): ProviderSessionIngestion | Error | null {
    return this.ingestions instanceof Map ? this.ingestions.get(id.trim()) ?? null : this.ingestions;
  }

  /**
   * Liveness evidence from each row the alias reaches, lazily, so a live row
   * short-circuits the Codex lock read. `null` is a row that says nothing.
   */
  private *livenessEvidence(id: string): Generator<LivenessState | null> {
    const direct = this.session(id);
    if (direct) yield statusLiveness(direct.status);
    for (const row of this.sessionsByConversation.get(id) ?? []) {
      if (row.id !== id) yield statusLiveness(row.status);
    }
    for (const row of this.consoleByAlias.get(id) ?? []) {
      yield statusLiveness(row.status);
      const linked = this.hasSessions ? this.session(row.mandible_session_id ?? id) : null;
      if (linked) yield statusLiveness(linked.status);
    }
    yield this.codexTaskLiveness(id);
  }

  /**
   * The Codex writer-lock answer for a provider thread id: `null` when the id
   * is not an indexed Codex thread, `unknown` when the lookup or the scan could
   * not complete.
   */
  private codexTaskLiveness(id: string): LivenessState | null {
    const ingestion = this.ingestion(id);
    if (ingestion instanceof Error) {
      getDaemonLogger()("error", "session_liveness_lookup_failed", {
        provider_session_id: id,
        error: ingestion.message,
      });
      return "unknown";
    }
    if (ingestion?.status !== "ingested" || ingestion.provider !== "codex") return null;
    const read = this.options.readCodexTaskLiveness ?? readCodexTaskLiveness;
    const scan = read(ingestion.source_path, ingestion.provider_session_id).status;
    return scan === "live" ? "live" : scan === "not_live" ? "stopped" : "unknown";
  }

  /**
   * Choose the one console row whose identity best represents the alias: a
   * live row first, then the most recently updated, then by id so the answer
   * is deterministic when timestamps tie.
   */
  private pickConsoleRow(rows: ConsoleRow[]): ConsoleRow | null {
    if (rows.length === 0) return null;
    const ranked = rows.map((row) => ({ row, live: this.consoleRowIsLive(row) }));
    ranked.sort((a, b) =>
      Number(b.live) - Number(a.live)
      || Number(b.row.updated_at ?? 0) - Number(a.row.updated_at ?? 0)
      || String(a.row.id).localeCompare(String(b.row.id))
    );
    return ranked[0]?.row ?? null;
  }

  private consoleRowIsLive(row: ConsoleRow): boolean {
    if (isLiveSessionStatus(row.status)) return true;
    return row.mandible_session_id ? isLiveSessionStatus(this.session(row.mandible_session_id)?.status) : false;
  }
}
