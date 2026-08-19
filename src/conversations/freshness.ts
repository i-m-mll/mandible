import type { Db } from "../db.js";
import { triggerExactPathIngest, type TargetedIngestResult } from "../ingestion.js";
import { ConversationSourceStore } from "./source-store.js";
import {
  observeStableSourceAlias,
  SourceObservationError,
  type StableSourceObservation,
} from "./source-observer.js";
import type { ConversationSourceAlias } from "./source-types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

interface PinnedConversationSource {
  conversationId: string;
  sourceId: string | null;
  sourcePath: string | null;
  canonicalCandidates: string[];
}

interface CurrentFacts {
  conversationId: string;
  sourceId: string;
  sourcePath: string;
  sourceAvailability: string;
  currentVersionId: string | null;
  versionAvailability: string | null;
  versionByteLength: number | null;
  versionMtimeMs: number | null;
  versionHash: string | null;
  ingestByteOffset: number | null;
  ingestTailHash: string | null;
  normalizedBlockCount: number;
  actualBlockCount: number;
}

export type ConversationFreshnessCode =
  | "not_found"
  | "ambiguous_ref"
  | "source_unavailable"
  | "source_changed"
  | "freshness_pending"
  | "freshness_error";

export class ConversationFreshnessError extends Error {
  constructor(
    readonly code: ConversationFreshnessCode,
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(message);
  }

  get status(): number {
    if (this.code === "not_found") return 404;
    if (this.code === "ambiguous_ref" || this.code === "source_unavailable" || this.code === "source_changed") return 409;
    return 503;
  }
}

export interface FreshConversationResult {
  conversationId: string;
  sourceId: string | null;
  sourcePath: string | null;
  refreshed: boolean;
}

type ExactIngest = (path: string) => Promise<TargetedIngestResult>;

const flights = new Map<string, Promise<FreshConversationResult>>();

function candidateIds(db: Db, ref: string): string[] {
  return (db.prepare(`
    SELECT id FROM conversations WHERE session_id = ?
    UNION
    SELECT conversation_id AS id FROM conversation_sources WHERE native_session_id = ?
    ORDER BY id
  `).all(ref, ref) as Array<{ id: string }>).map((row) => row.id);
}

function pinnedSource(db: Db, conversationId: string, candidates: string[]): PinnedConversationSource | null {
  const row = db.prepare(`
    SELECT c.id AS conversation_id, s.id AS source_id, alias.path AS source_path
      FROM conversations c
      JOIN conversation_sources s
        ON s.conversation_id = c.id AND s.provider = c.source
      JOIN conversation_source_versions version ON version.id = s.current_version_id
      JOIN conversation_source_aliases alias ON alias.id = (
        SELECT candidate.id FROM conversation_source_aliases candidate
         WHERE candidate.source_id = s.id AND candidate.availability = 'available'
         ORDER BY candidate.last_seen_at DESC, candidate.id
         LIMIT 1
      )
     WHERE c.id = ?
       AND s.availability = 'available'
       AND version.availability = 'available'
  `).get(conversationId) as {
    conversation_id: string;
    source_id: string;
    source_path: string;
  } | undefined;
  return row ? {
    conversationId: row.conversation_id,
    sourceId: row.source_id,
    sourcePath: row.source_path,
    canonicalCandidates: candidates,
  } : null;
}

function hasOwnedSource(db: Db, conversationId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM conversation_sources WHERE conversation_id = ? LIMIT 1").get(conversationId));
}

function legacyConversation(conversationId: string, candidates: string[]): PinnedConversationSource {
  return { conversationId, sourceId: null, sourcePath: null, canonicalCandidates: candidates };
}

export function resolveExactConversation(db: Db, ref: string): PinnedConversationSource {
  const exact = db.prepare("SELECT id FROM conversations WHERE id = ?").get(ref) as { id: string } | undefined;
  if (exact) {
    const pinned = pinnedSource(db, exact.id, [exact.id]);
    if (!pinned && !hasOwnedSource(db, exact.id)) return legacyConversation(exact.id, [exact.id]);
    if (!pinned) throw new ConversationFreshnessError("source_unavailable", "conversation source is unavailable", [exact.id]);
    return pinned;
  }
  const candidates = candidateIds(db, ref);
  if (candidates.length === 0) {
    throw new ConversationFreshnessError("not_found", "conversation was not found");
  }
  const owners = candidates
    .map((conversationId) => pinnedSource(db, conversationId, candidates))
    .filter((value): value is PinnedConversationSource => value !== null);
  if (owners.length === 1) return owners[0];
  if (candidates.length === 1) {
    if (!hasOwnedSource(db, candidates[0])) return legacyConversation(candidates[0], candidates);
    throw new ConversationFreshnessError("source_unavailable", "conversation source is unavailable", candidates);
  }
  throw new ConversationFreshnessError(
    "ambiguous_ref",
    "conversation reference has no unique available source owner",
    candidates,
  );
}

function currentFacts(db: Db, pinned: PinnedConversationSource, sourcePath: string): CurrentFacts {
  if (!pinned.sourceId) {
    throw new ConversationFreshnessError("freshness_error", "legacy conversation has no source freshness facts");
  }
  const row = db.prepare(`
    SELECT c.id AS conversation_id, c.block_count AS normalized_block_count,
           s.id AS source_id, s.availability AS source_availability,
           s.current_version_id, v.availability AS version_availability,
           v.byte_length AS version_byte_length, v.file_mtime_ms AS version_mtime_ms,
           v.content_sha256 AS version_hash,
           state.byte_offset AS ingest_byte_offset, state.tail_hash AS ingest_tail_hash,
           (SELECT COUNT(*) FROM conversation_blocks block WHERE block.conversation_id = c.id) AS actual_block_count
      FROM conversations c
      JOIN conversation_sources s ON s.conversation_id = c.id AND s.id = ?
      LEFT JOIN conversation_source_versions v ON v.id = s.current_version_id
      LEFT JOIN conversation_ingest_state state ON state.file_path = ?
     WHERE c.id = ?
  `).get(pinned.sourceId, sourcePath, pinned.conversationId) as Record<string, unknown> | undefined;
  if (!row) throw new ConversationFreshnessError("source_changed", "pinned conversation source identity changed");
  return {
    conversationId: String(row.conversation_id),
    sourceId: String(row.source_id),
    sourcePath,
    sourceAvailability: String(row.source_availability),
    currentVersionId: row.current_version_id == null ? null : String(row.current_version_id),
    versionAvailability: row.version_availability == null ? null : String(row.version_availability),
    versionByteLength: row.version_byte_length == null ? null : Number(row.version_byte_length),
    versionMtimeMs: row.version_mtime_ms == null ? null : Number(row.version_mtime_ms),
    versionHash: row.version_hash == null ? null : String(row.version_hash),
    ingestByteOffset: row.ingest_byte_offset == null ? null : Number(row.ingest_byte_offset),
    ingestTailHash: row.ingest_tail_hash == null ? null : String(row.ingest_tail_hash),
    normalizedBlockCount: Number(row.normalized_block_count),
    actualBlockCount: Number(row.actual_block_count),
  };
}

function matchesIndexed(facts: CurrentFacts, observed: StableSourceObservation): boolean {
  return facts.sourceAvailability === "available"
    && facts.versionAvailability === "available"
    && facts.currentVersionId !== null
    && facts.versionByteLength === observed.byteLength
    && facts.versionMtimeMs === observed.fileMtimeMs
    && facts.versionHash === observed.contentSha256
    && facts.ingestByteOffset === observed.byteLength
    && facts.ingestTailHash === observed.tailHash
    && facts.normalizedBlockCount === facts.actualBlockCount;
}

function sameObservation(a: StableSourceObservation, b: StableSourceObservation): boolean {
  return a.path === b.path && a.byteLength === b.byteLength && a.fileMtimeMs === b.fileMtimeMs
    && a.contentSha256 === b.contentSha256 && a.tailHash === b.tailHash;
}

async function observePinned(db: Db, pinned: PinnedConversationSource): Promise<StableSourceObservation> {
  if (!pinned.sourceId) {
    throw new ConversationFreshnessError("freshness_error", "legacy conversation has no source to observe");
  }
  const store = new ConversationSourceStore(db);
  const source = db.prepare(`
    SELECT availability FROM conversation_sources WHERE id = ? AND conversation_id = ?
  `).get(pinned.sourceId, pinned.conversationId) as { availability: string } | undefined;
  if (!source || source.availability !== "available") {
    throw new ConversationFreshnessError("source_unavailable", "pinned conversation source is unavailable");
  }
  const aliases = store.listAliases(pinned.sourceId).filter((alias) => alias.availability === "available");
  let lastError: unknown;
  for (const alias of aliases) {
    try {
      return await observeStableSourceAlias(alias);
    } catch (error) {
      lastError = error;
      if (error instanceof SourceObservationError && error.kind === "changed") {
        throw new ConversationFreshnessError("source_changed", error.message);
      }
    }
  }
  throw new ConversationFreshnessError(
    "source_unavailable",
    lastError instanceof Error ? lastError.message : "conversation source is unavailable",
  );
}

async function converge(
  db: Db,
  pinned: PinnedConversationSource,
  ingest: ExactIngest,
): Promise<FreshConversationResult> {
  if (!pinned.sourceId || !pinned.sourcePath) {
    return { conversationId: pinned.conversationId, sourceId: null, sourcePath: null, refreshed: false };
  }
  let refreshed = false;
  for (let pass = 0; pass < 2; pass += 1) {
    let before: StableSourceObservation;
    try {
      before = await observePinned(db, pinned);
    } catch (error) {
      if (error instanceof ConversationFreshnessError && error.code === "source_changed" && pass === 0) continue;
      throw error;
    }
    if (matchesIndexed(currentFacts(db, pinned, before.path), before)) {
      return { conversationId: pinned.conversationId, sourceId: pinned.sourceId, sourcePath: before.path, refreshed };
    }
    const result = await ingest(before.path);
    if (result.status === "unsupported" || result.status === "no_target") {
      throw new ConversationFreshnessError("source_unavailable", "conversation source parser is unavailable");
    }
    refreshed = true;
    let after: StableSourceObservation;
    try {
      after = await observePinned(db, pinned);
    } catch (error) {
      if (error instanceof ConversationFreshnessError && error.code === "source_changed" && pass === 0) continue;
      throw error;
    }
    if (matchesIndexed(currentFacts(db, pinned, after.path), after)) {
      return { conversationId: pinned.conversationId, sourceId: pinned.sourceId, sourcePath: after.path, refreshed };
    }
    if (!sameObservation(before, after)) {
      if (pass === 0) continue;
      throw new ConversationFreshnessError("source_changed", "conversation source changed during both freshness passes");
    }
    throw new ConversationFreshnessError("freshness_error", "conversation ingestion did not converge to the observed source");
  }
  throw new ConversationFreshnessError("source_changed", "conversation source did not stabilize");
}

export async function ensureExactConversationFresh(
  db: Db,
  ref: string,
  options: { timeoutMs?: number; ingest?: ExactIngest } = {},
): Promise<FreshConversationResult> {
  let pinned: PinnedConversationSource;
  try {
    pinned = resolveExactConversation(db, ref);
  } catch (error) {
    if (error instanceof ConversationFreshnessError) throw error;
    throw new ConversationFreshnessError("freshness_error", error instanceof Error ? error.message : String(error));
  }
  if (!pinned.sourceId) {
    return { conversationId: pinned.conversationId, sourceId: null, sourcePath: null, refreshed: false };
  }
  const sourceId = pinned.sourceId;
  let flight = flights.get(sourceId);
  if (!flight) {
    flight = converge(db, pinned, options.ingest ?? triggerExactPathIngest)
      .catch((error: unknown) => {
        if (error instanceof ConversationFreshnessError) throw error;
        throw new ConversationFreshnessError("freshness_error", error instanceof Error ? error.message : String(error));
      })
      .finally(() => flights.delete(sourceId));
    flights.set(sourceId, flight);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      flight,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ConversationFreshnessError(
          "freshness_pending",
          "conversation freshness is still pending",
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
