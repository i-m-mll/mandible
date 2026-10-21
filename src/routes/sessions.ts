import { getDb, resolvePrefix } from "../db.js";
import { navigateToSession } from "../navigate.js";
import {
  SessionRegistry,
  syncPinnedPanesTsv,
  type ChildSessionInput,
  type SessionInput,
  type SessionListOptions,
  type SessionUpdate,
} from "../registry.js";
import {
  getChannelRegistry,
  getChannelConnectedSessionsFromDb,
} from "../channel-registry.js";
import { linkSessionToLedgerIssue, resolveOperationalIssueRef } from "../ledger/operational-links.js";
import type { WorkScanner } from "../work-scanner.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import type { SessionStatus } from "../types.js";
import { checkSessionIdentity } from "../identity/session-mismatch.js";
import {
  CONVERSATION_SOURCE_TO_PROVIDER,
  PROVIDER_TO_CONVERSATION_SOURCE,
  ensureProviderSessionRegistered,
} from "../provider-session-ingestion.js";
import { readBody, sendJson } from "./http.js";
import { effectiveWorkerStatusSql } from "../ledger/issue-work-state.js";

export { CONVERSATION_SOURCE_TO_PROVIDER, PROVIDER_TO_CONVERSATION_SOURCE };

function linkSessionLedgerIssue(
  sessionId: string,
  issueId: string,
  repoId: string,
): string | null {
  try {
    const result = linkSessionToLedgerIssue(getDb(), {
      session_id: sessionId,
      issue_ref: issueId,
      repo_ref: repoId,
    });
    return result.ok ? result.issue_id : null;
  } catch {
    return null;
  }
}

function parseStatus(value: string | undefined): SessionStatus | undefined {
  if (value === "active" || value === "ended" || value === "dead") {
    return value;
  }
  return undefined;
}

function deriveRepoNameFromRepoId(repoId: string): string {
  const cleaned = repoId.trim().replace(/\/+$/, "");
  if (!cleaned) return repoId;
  const parts = cleaned.split("/");
  const last = parts[parts.length - 1] || cleaned;
  // Strip leading dots (e.g. '.dotfiles' → 'dotfiles')
  return last.replace(/^\.+/, "") || last;
}

function looksLikeBranchName(value: string): boolean {
  if (!value) return false;
  if (value === "main" || value === "master" || value === "develop") {
    return true;
  }
  // Slash-separated branch prefixes (e.g. feature/foo)
  if (/^(feature|fix|bugfix|hotfix|chore|release)\//.test(value)) return true;
  // Double-underscore sub-branch separator used in Mandible worktrees (e.g. feature__foo)
  // Bug: 003179f — agent-commit sends worktree dir name as repo_id
  if (/^(feature|fix|bugfix|hotfix|chore|release)__/.test(value)) return true;
  return false;
}

function normalizeRepoDisplayName(repoId: string, repoName?: string | null): string {
  const fallback = deriveRepoNameFromRepoId(repoId);
  if (!repoName) return fallback;
  const trimmed = repoName.trim();
  if (!trimmed || looksLikeBranchName(trimmed)) return fallback;
  // Normalize owner/repo to repo for compact UI display.
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/");
    if (parts.length !== 2) return fallback;
    return parts[1] || fallback;
  }
  return trimmed;
}

function resolveCanonicalRepoId(
  workScanner: WorkScanner | undefined,
  repoId: string,
  repoName?: string | null,
  _issueId?: string,
): string {
  if (!workScanner) return repoId;
  const direct = workScanner.getRepoById(repoId);
  if (direct?.exists) return direct.id;
  const byName = repoName ? workScanner.getRepoById(repoName) : null;
  if (byName?.exists) return byName.id;
  // Stripped-dot basename fallback: handles ".dotfiles" → "dotfiles"
  const stripped = repoId.replace(/^\.+/, '');
  if (stripped !== repoId) {
    const db = getDb();
    const row = db.prepare(
      "SELECT id FROM work_repos WHERE id = ? OR name = ? LIMIT 1"
    ).get(stripped, stripped) as { id: string } | undefined;
    if (row) return row.id;
  }
  return repoId;
}

function ledgerIssueStatusForSessionLink(repoId: string, issueId: string): "open" | "closed" | null {
  const db = getDb();
  const resolved = resolveOperationalIssueRef(db, issueId, repoId);
  if (!resolved.ok) return null;
  const row = db.prepare("SELECT status FROM ledger_issues WHERE id = ?").get(resolved.issue_id) as
    | { status?: string }
    | undefined;
  return row?.status === "closed" ? "closed" : row?.status === "open" ? "open" : null;
}

// Issue 037fa85 / f59b5bd — provider-neutral session alias resolution for the
// Session Overview view. One provider session UUID (a Codex thread id, a
// Claude Code session id, ...) may surface in several stores: console_sessions
// (id / provider_session_id / mandible_session_id), the sessions registry
// (id / conversation_id), and the normalized conversations index
// (conversations.session_id holds the provider-native session UUID). The
// resolver reports every distinct match with explicit zero/one/many semantics;
// it never silently picks among candidates. Refs may be full identifiers or
// short prefixes (min 8 chars); a prefix matching multiple distinct
// identities yields one match per identity, keyed by (provider, matched_ref).
export type SessionResolveMatch = {
  // The full identity string the (possibly short) ref resolved to. Clients
  // must use this — not the raw ref — for follow-up provider-scoped calls.
  matched_ref: string;
  // Provider derived from the identity's ingested conversations rows via the
  // canonical provider↔conversations.source mapping. null means no ingested
  // transcript attests a provider (or several providers claim the same ref).
  provider: string | null;
  mandible_session_id: string | null;
  console_session_id: string | null;
  conversation_id: string | null;
  sources: string[];
};

export type SessionResolveResult = {
  matches: SessionResolveMatch[];
  // True when a prefix scan hit a candidate cap: additional identities may
  // exist, so a single returned match must NOT be treated as unique.
  truncated: boolean;
};

// Issue f59b5bd (review C2/C3) — the one canonical provider↔conversations.source
// vocabulary mapping. `provider` is the client-facing vocabulary (codex,
// claude, gemini); conversations.source is the ingestion vocabulary
// (codex, claude_code, gemini). Every store narrowing and every provider
// derivation goes through this mapping.
// Minimum prefix length for expansion, matching the 8-char short-ID
// convention. Shorter refs still resolve by exact match (console session ids
// can legitimately be short strings) but are never expanded, so a degenerate
// 1-char "prefix" cannot fan out across the whole identity space.
export const AGENT_SESSION_MIN_PREFIX_LENGTH = 8;
const PREFIX_CANDIDATE_LIMIT = 20;
// Review C5 — full-identity detection goes by UUID shape, not length: a
// 36-char ref that is not a UUID can still be a prefix of a longer id.
const FULL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Expand a short ref into the full identity strings it prefixes across the
// identity spaces. Indexed prefix range scans: conversations.session_id
// (idx_conv_session), sessions.id (PK), sessions.conversation_id
// (idx_sessions_conversation_id), console_sessions.id (PK). The two console
// alias columns are unindexed, matching the existing exact-match predicate on
// that small table (same access pattern src/routes/hooks.ts already uses).
// Review C4 — every scan fetches one row past the candidate cap; hitting the
// cap sets `truncated`, so a capped scan can never masquerade as exhaustive
// and hide a second distinct identity behind a false unique.
function expandAgentSessionRefPrefix(
  ref: string,
  provider?: string,
): { candidates: string[]; truncated: boolean } {
  if (ref.length < AGENT_SESSION_MIN_PREFIX_LENGTH || FULL_UUID_RE.test(ref)) {
    return { candidates: [], truncated: false };
  }
  const db = getDb();
  const like = `${escapeLikePrefix(ref)}%`;
  const fetchLimit = PREFIX_CANDIDATE_LIMIT + 1;
  const candidates = new Set<string>();
  let truncated = false;
  const collect = (rows: Array<Record<string, unknown>>, column: string): void => {
    if (rows.length > PREFIX_CANDIDATE_LIMIT) truncated = true;
    for (const row of rows) {
      const value = row[column];
      if (typeof value === "string" && value && value !== ref) candidates.add(value);
    }
  };

  const source = provider ? PROVIDER_TO_CONVERSATION_SOURCE[provider] : undefined;
  if (provider) {
    // Review C3 — narrowing uses the canonical source vocabulary; an unmapped
    // provider matches nothing rather than silently matching everything.
    collect(source
      ? db.prepare(`
          SELECT DISTINCT session_id FROM conversations
          WHERE session_id LIKE ? ESCAPE '\\' AND source = ?
          LIMIT ${fetchLimit}
        `).all(like, source) as Array<Record<string, unknown>>
      : [], "session_id");
  } else {
    collect(db.prepare(`
      SELECT DISTINCT session_id FROM conversations
      WHERE session_id LIKE ? ESCAPE '\\'
      LIMIT ${fetchLimit}
    `).all(like) as Array<Record<string, unknown>>, "session_id");
  }
  collect(db.prepare(`
    SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' LIMIT ${fetchLimit}
  `).all(like) as Array<Record<string, unknown>>, "id");
  collect(db.prepare(`
    SELECT DISTINCT conversation_id FROM sessions
    WHERE conversation_id LIKE ? ESCAPE '\\'
    LIMIT ${fetchLimit}
  `).all(like) as Array<Record<string, unknown>>, "conversation_id");
  const consoleRows = db.prepare(`
    SELECT id, provider_session_id, mandible_session_id
    FROM console_sessions
    WHERE id LIKE ? ESCAPE '\\'
       OR provider_session_id LIKE ? ESCAPE '\\'
       OR mandible_session_id LIKE ? ESCAPE '\\'
    LIMIT ${fetchLimit}
  `).all(like, like, like) as Array<{
    id: string;
    provider_session_id: string | null;
    mandible_session_id: string | null;
  }>;
  if (consoleRows.length > PREFIX_CANDIDATE_LIMIT) truncated = true;
  for (const row of consoleRows) {
    for (const value of [row.id, row.provider_session_id, row.mandible_session_id]) {
      if (value && value !== ref && value.startsWith(ref)) candidates.add(value);
    }
  }

  return { candidates: Array.from(candidates), truncated };
}

function resolveExactAgentSessionMatches(ref: string, provider?: string): SessionResolveMatch[] {
  const db = getDb();

  // conversations.session_id holds the provider-native session UUID. All rows
  // are read (no LIMIT 1 — review C2): the same raw id can be claimed by
  // multiple providers, and each source keeps its own latest conversation.
  const source = provider ? PROVIDER_TO_CONVERSATION_SOURCE[provider] : undefined;
  if (provider && !source) return [];
  const conversationRows = (source
    ? db.prepare(`
        SELECT id, source
        FROM conversations
        WHERE session_id = ? AND source = ?
        ORDER BY updated_at DESC
      `).all(ref, source)
    : db.prepare(`
        SELECT id, source
        FROM conversations
        WHERE session_id = ?
        ORDER BY updated_at DESC
      `).all(ref)) as Array<{ id: string; source: string }>;
  const conversationBySource = new Map<string, string>();
  for (const row of conversationRows) {
    if (!conversationBySource.has(row.source)) conversationBySource.set(row.source, row.id);
  }
  // Provider/conversation attach to alias-store matches only when exactly one
  // source attests this ref; a multi-provider claim is surfaced as null
  // (unknown) rather than a silent pick.
  const soleSource = conversationBySource.size === 1
    ? Array.from(conversationBySource.keys())[0]
    : null;
  const soleProvider = soleSource ? (CONVERSATION_SOURCE_TO_PROVIDER[soleSource] ?? null) : null;
  const soleConversationId = soleSource ? conversationBySource.get(soleSource) ?? null : null;

  // Review C3 — the registry and console stores carry no provider provenance
  // of their own. Under provider narrowing, their rows qualify only when an
  // ingested conversation attests the requested provider for this ref;
  // otherwise presenting them as provider-filtered would be dishonest.
  const attested = !provider || conversationBySource.size > 0;

  const matches = new Map<string, SessionResolveMatch>();
  const add = (
    mandibleSessionId: string | null,
    consoleSessionId: string | null,
    source_: string,
  ): void => {
    const key = mandibleSessionId ?? (consoleSessionId ? `console:${consoleSessionId}` : "conversation");
    const existing = matches.get(key);
    if (existing) {
      if (!existing.console_session_id && consoleSessionId) {
        existing.console_session_id = consoleSessionId;
      }
      if (!existing.sources.includes(source_)) existing.sources.push(source_);
      return;
    }
    matches.set(key, {
      matched_ref: ref,
      provider: soleProvider,
      mandible_session_id: mandibleSessionId,
      console_session_id: consoleSessionId,
      conversation_id: soleConversationId,
      sources: [source_],
    });
  };

  if (attested) {
    // Same alias predicate the hook telemetry path uses (src/routes/hooks.ts),
    // but without LIMIT 1: many-match honesty is the point here.
    const consoleRows = db.prepare(`
      SELECT id, provider_session_id, mandible_session_id
      FROM console_sessions
      WHERE id = ? OR provider_session_id = ? OR mandible_session_id = ?
      ORDER BY updated_at DESC
    `).all(ref, ref, ref) as Array<{
      id: string;
      provider_session_id: string | null;
      mandible_session_id: string | null;
    }>;
    for (const row of consoleRows) {
      add(row.mandible_session_id, row.id, "console_sessions");
    }

    const registryRows = db.prepare(`
      SELECT id
      FROM sessions
      WHERE id = ? OR conversation_id = ?
      ORDER BY updated_at DESC
    `).all(ref, ref) as Array<{ id: string }>;
    for (const row of registryRows) {
      add(row.id, null, "sessions");
    }
  }

  // Conversation-only hits are still honest (unbindable) matches: the client
  // can link to the transcript even though no registry session exists. One
  // match per attesting source keeps cross-provider claims distinct (C2).
  if (matches.size === 0) {
    for (const [convSource, conversationId] of conversationBySource) {
      const convProvider = CONVERSATION_SOURCE_TO_PROVIDER[convSource] ?? null;
      matches.set(`conversation:${convProvider ?? convSource}`, {
        matched_ref: ref,
        provider: convProvider,
        mandible_session_id: null,
        console_session_id: null,
        conversation_id: conversationId,
        sources: ["conversations"],
      });
    }
  }

  return Array.from(matches.values());
}

export function resolveAgentSessionMatches(ref: string, provider?: string): SessionResolveResult {
  const merged = new Map<string, SessionResolveMatch>();
  const mergeAll = (candidateRef: string): void => {
    for (const match of resolveExactAgentSessionMatches(candidateRef, provider)) {
      const key = match.mandible_session_id
        ?? (match.console_session_id
          ? `console:${match.console_session_id}`
          : `conversation:${match.provider ?? "unknown"}:${match.matched_ref}`);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, match);
        continue;
      }
      if (!existing.console_session_id && match.console_session_id) {
        existing.console_session_id = match.console_session_id;
      }
      if (!existing.conversation_id && match.conversation_id) {
        existing.conversation_id = match.conversation_id;
      }
      if (!existing.provider && match.provider) {
        existing.provider = match.provider;
      }
      for (const source of match.sources) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
      }
    }
  };

  mergeAll(ref);
  const expansion = expandAgentSessionRefPrefix(ref, provider);
  for (const candidate of expansion.candidates) {
    mergeAll(candidate);
  }
  return { matches: Array.from(merged.values()), truncated: expansion.truncated };
}

// Issue 037fa85 — bounded, cycle-safe descendant walk over sessions.parent_id.
// registry.getSessionTree loads the whole sessions table; this walks only the
// requested subtree with explicit depth and count caps.
const OVERVIEW_DESCENDANT_DEPTH_LIMIT = 5;
const OVERVIEW_DESCENDANT_COUNT_LIMIT = 200;
const OVERVIEW_CONVERSATIONS_LIMIT = 20;

type OverviewDescendantRow = {
  id: string;
  parent_id: string | null;
  app: string;
  status: string;
  branch: string | null;
  cwd: string | null;
  task: string | null;
  agent_type: string | null;
  created_at: string;
  ended_at: string | null;
  last_active: string | null;
  conversation_id: string | null;
};

function collectBoundedDescendants(rootId: string): {
  descendants: Array<OverviewDescendantRow & { depth: number }>;
  truncated: boolean;
} {
  const db = getDb();
  const seen = new Set<string>([rootId]);
  const descendants: Array<OverviewDescendantRow & { depth: number }> = [];
  let frontier: string[] = [rootId];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0 && depth < OVERVIEW_DESCENDANT_DEPTH_LIMIT) {
    const placeholders = frontier.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT id, parent_id, app, status, branch, cwd, task, agent_type,
             created_at, ended_at, last_active, conversation_id
      FROM sessions
      WHERE parent_id IN (${placeholders})
      ORDER BY created_at ASC
    `).all(...frontier) as OverviewDescendantRow[];

    const next: string[] = [];
    for (const row of rows) {
      // Cycle safety: a row whose id already appeared upstream is skipped.
      if (seen.has(row.id)) continue;
      if (descendants.length >= OVERVIEW_DESCENDANT_COUNT_LIMIT) {
        truncated = true;
        break;
      }
      seen.add(row.id);
      descendants.push({ ...row, depth: depth + 1 });
      next.push(row.id);
    }
    if (truncated) break;
    frontier = next;
    depth += 1;
  }

  // Depth cap reached with live frontier: report truncation only if a deeper
  // level actually exists.
  if (!truncated && frontier.length > 0 && depth >= OVERVIEW_DESCENDANT_DEPTH_LIMIT) {
    const placeholders = frontier.map(() => "?").join(", ");
    const deeper = db.prepare(
      `SELECT 1 FROM sessions WHERE parent_id IN (${placeholders}) LIMIT 1`,
    ).get(...frontier);
    if (deeper) truncated = true;
  }

  return { descendants, truncated };
}

// Bug: caa157e — resolve session ID prefix, returning resolved ID or sending error response
function resolveSessionId(id: string, res: ResponseLike): string | null {
  const resolved = resolvePrefix(getDb(), "sessions", "id", id);
  if (resolved.ok) {
    return resolved.id;
  }
  if (resolved.error === "ambiguous") {
    sendJson(res, 409, {
      error: `Ambiguous prefix '${id}' — matches ${resolved.count} sessions. Use a longer prefix.`
    });
  } else {
    sendJson(res, 404, { error: "Session not found" });
  }
  return null;
}

const PROVIDER_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a link target, materializing an already-ingested provider identity when needed. */
function resolveSessionIdForIssueLink(
  id: string,
  registry: SessionRegistry,
  res: ResponseLike,
): string | null {
  const resolved = resolvePrefix(getDb(), "sessions", "id", id);
  if (resolved.ok) return resolved.id;
  if (resolved.error === "ambiguous") {
    sendJson(res, 409, {
      error: `Ambiguous prefix '${id}' — matches ${resolved.count} sessions. Use a longer prefix.`,
      code: "session_ref_ambiguous",
    });
    return null;
  }
  if (!PROVIDER_SESSION_UUID.test(id)) {
    sendJson(res, 404, { error: "Session not found", code: "session_not_found" });
    return null;
  }

  const registration = ensureProviderSessionRegistered(getDb(), registry, id);
  if (registration.status === "registered") return registration.session.id;
  if (registration.status === "not_yet_ingested") {
    sendJson(res, 409, {
      error: "Provider session is known only to the caller and has not yet reached Mandible's normalized conversation index.",
      code: "provider_session_not_ingested",
      status: registration.status,
      provider_session_id: id,
      retryable: true,
    });
    return null;
  }
  if (registration.status === "ambiguous") {
    sendJson(res, 409, {
      error: "Provider session id is claimed by multiple providers.",
      code: "provider_session_ambiguous",
      provider_session_id: id,
      sources: registration.sources,
    });
    return null;
  }
  sendJson(res, 422, {
    error: `No provider mapping for conversation source '${registration.source}'`,
    code: "provider_session_unsupported",
    provider_session_id: id,
  });
  return null;
}

export function registerSessionRoutes(
  server: RouteRegistrar,
  registry: SessionRegistry = new SessionRegistry(getDb()),
  workScanner?: WorkScanner,
): void {
  server.post("/api/sessions/register", (req, res) => {
    const payload = readBody<SessionInput>(req);
    if (!payload.id || !payload.app) {
      sendJson(res, 400, { error: "Missing id or app" });
      return;
    }
    const session = registry.registerSession(payload);
    // Issue 499c148 — the row now exists, so its bindings can be compared with
    // the authenticated client. The warning rides the registration response so
    // the connecting agent learns about a misconfigured token immediately
    // instead of at end-of-day auth submission.
    const identityWarning = checkSessionIdentity(getDb(), session.id, req.client_identity);
    sendJson(res, 200, { ...session, identity_warning: identityWarning });
  }, { operation: { id: "post:/api/sessions/register", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "allow" });

  // Issue f59b5bd (review S1) — deliberate, user-initiated registration of a
  // provider-known session as a Mandible session row. The client supplies ONLY
  // the full provider session id it received from the resolver; provider, cwd,
  // and branch are derived server-side from the validated conversations
  // row(s), so a forgeable page binding can never steer the registered
  // identity's provider. Identities with no ingested conversation are
  // rejected outright.
  server.post("/api/sessions/register-provider", (req, res) => {
    const payload = readBody<{ provider_session_id?: string }>(req);
    const providerSessionId = (payload.provider_session_id ?? "").trim();
    if (!providerSessionId) {
      sendJson(res, 400, { error: "Missing provider_session_id" });
      return;
    }
    const result = ensureProviderSessionRegistered(getDb(), registry, providerSessionId);
    if (result.status === "not_yet_ingested") {
      sendJson(res, 409, {
        error: "Provider session is not yet present in the normalized conversation index.",
        code: "provider_session_not_ingested",
        status: result.status,
        provider_session_id: providerSessionId,
        retryable: true,
      });
      return;
    }
    if (result.status === "ambiguous") {
      sendJson(res, 409, {
        error: "Provider session id is claimed by multiple providers.",
        code: "provider_session_ambiguous",
        provider_session_id: providerSessionId,
        sources: result.sources,
      });
      return;
    }
    if (result.status === "unsupported") {
      sendJson(res, 422, {
        error: `No provider mapping for conversation source '${result.source}'`,
        code: "provider_session_unsupported",
        provider_session_id: providerSessionId,
      });
      return;
    }
    sendJson(res, 200, { ...result.session, provider: result.provider });
  }, { operation: { id: "post:/api/sessions/register-provider", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  server.patch("/api/sessions/:id", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const payload = readBody<SessionUpdate & { pinned?: number }>(req);
    const updated = registry.updateSession(id, payload);
    if (!updated) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    // Bug: 568eca7 — sync pinned-panes.tsv for backward compat with reaper
    if (payload.pinned !== undefined && updated.nav_pane_id) {
      syncPinnedPanesTsv(updated.nav_pane_id, Boolean(payload.pinned));
    }
    sendJson(res, 200, updated);
  }, { operation: { id: "patch:/api/sessions/:id", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "allow" });

  server.patch("/api/sessions/:id/end", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const payload = readBody<{ status?: SessionStatus }>(req);
    const status = payload.status ?? "ended";
    const ended = registry.endSession(id, status);
    if (!ended) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, ended);
  }, { operation: { id: "patch:/api/sessions/:id/end", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "allow" });

  server.post("/api/sessions/:id/children", (req, res) => {
    const parentId = req.params.id;
    if (!parentId) {
      sendJson(res, 400, { error: "Missing parent id" });
      return;
    }
    const payload = readBody<ChildSessionInput>(req);
    const child = registry.registerChildSession(parentId, payload);
    if (!child) {
      sendJson(res, 404, { error: "Parent not found" });
      return;
    }
    sendJson(res, 200, child);
  }, { operation: { id: "post:/api/sessions/:id/children", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  server.patch("/api/sessions/:id/children/:childId", (req, res) => {
    const parentId = req.params.id;
    const childId = req.params.childId;
    if (!parentId || !childId) {
      sendJson(res, 400, { error: "Missing parent or child id" });
      return;
    }
    const payload = readBody<{ status?: SessionStatus }>(req);
    const status = payload.status ?? "ended";
    const updated = registry.updateChildStatus(parentId, childId, status);
    if (!updated) {
      sendJson(res, 404, { error: "Child not found" });
      return;
    }
    sendJson(res, 200, updated);
  }, { operation: { id: "patch:/api/sessions/:id/children/:childId", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  server.get("/api/sessions", (req, res) => {
    const query = req.query ?? {};
    const options: SessionListOptions = {
      status: parseStatus(query.status),
      app: query.app,
    };
    if (query.parent_id === "null") {
      options.parent_id = null;
    } else if (query.parent_id) {
      options.parent_id = query.parent_id;
    }
    // Bounded default with explicit history escape hatch (issue 21502ff).
    if (query.scope === "all" || query.all === "1" || query.all === "true") {
      options.scope = "all";
    }
    if (query.cursor) {
      options.cursor = query.cursor;
    }
    if (query.limit !== undefined) {
      const parsedLimit = Number(query.limit);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        options.limit = Math.floor(parsedLimit);
      }
    }

    // Bounded/paginated listing (issue 21502ff). listSessionsPage → mapWithLiveness
    // → toSession already populates each session's user-attribution `owner`
    // (main), so no separate owner remap is needed here.
    const page = registry.listSessionsPage(options);
    const sessions = page.sessions;
    const meta = {
      total: page.total,
      returned: page.returned,
      nextCursor: page.nextCursor,
      scope: page.scope,
      limit: page.limit,
    };

    if (query.include === "issues" || query.include === "all_issues") {
      const showAll = query.include === "all_issues";
      const db = getDb();
      const allLinks = db.prepare(
        `SELECT session_id, issue_id, repo_id, created_at FROM session_issues`
      ).all() as Array<{ session_id: string; issue_id: string; repo_id: string; created_at: number }>;

      const linkMap = new Map<string, Array<{ issue_id: string; repo_id: string; created_at: number }>>();
      for (const link of allLinks) {
        // Filter to open issues by default (treat unknown as open — safe default)
        if (!showAll) {
          const status = ledgerIssueStatusForSessionLink(link.repo_id, link.issue_id);
          if (status === "closed") {
            continue;
          }
        }
        const existing = linkMap.get(link.session_id) ?? [];
        existing.push({ issue_id: link.issue_id, repo_id: link.repo_id, created_at: link.created_at });
        linkMap.set(link.session_id, existing);
      }

      // Load sticky project associations
      const allProjects = db.prepare(
        `SELECT session_id, repo_id, repo_name, created_at FROM session_projects`
      ).all() as Array<{ session_id: string; repo_id: string; repo_name: string; created_at: number }>;

      const projectMap = new Map<string, Array<{ repo_id: string; repo_name: string }>>();
      for (const proj of allProjects) {
        const existing = projectMap.get(proj.session_id) ?? [];
        const normalizedName = normalizeRepoDisplayName(proj.repo_id, proj.repo_name);
        if (!existing.some((p) => p.repo_id === proj.repo_id)) {
          existing.push({ repo_id: proj.repo_id, repo_name: normalizedName });
        }
        projectMap.set(proj.session_id, existing);
      }

      const enriched = sessions.map((s) => ({
        ...s,
        issues: linkMap.get(s.id) ?? [],
        projects: projectMap.get(s.id) ?? [],
      }));
      sendJson(res, 200, { sessions: enriched, ...meta });
      return;
    }

    sendJson(res, 200, { sessions, ...meta });
  }, { operation: { id: "get:/api/sessions", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Bug: 568eca7 — lightweight endpoint returning just pinned session IDs
  server.get("/api/sessions/pinned", (_req, res) => {
    const ids = registry.getPinnedSessionIds();
    sendJson(res, 200, { ids });
  }, { operation: { id: "get:/api/sessions/pinned", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Bug: 0b454df — list channel-connected sessions
  server.get("/api/sessions/channel-connected", (_req, res) => {
    const channelRegistry = getChannelRegistry();
    const inMemory = channelRegistry.getAll();

    // Merge in-memory state with DB-persisted state for resilience
    const dbSessions = getChannelConnectedSessionsFromDb();

    const combined = dbSessions.map((dbRow) => {
      const live = inMemory.find((s) => s.session_id === dbRow.id);
      return {
        ...dbRow,
        is_alive: live ? channelRegistry.isAlive(dbRow.id) : false,
        tools_called: live?.tools_called ?? [],
        last_tool_call_in_memory: live?.last_tool_call ?? null,
      };
    });

    // Add any in-memory sessions not yet in DB (transient race)
    for (const live of inMemory) {
      if (!dbSessions.some((d) => d.id === live.session_id)) {
        combined.push({
          id: live.session_id,
          app: "claude",
          status: "active",
          branch: live.branch,
          cwd: live.cwd,
          channel_connected_at: live.connected_at,
          channel_last_tool_call: live.last_tool_call,
          is_alive: channelRegistry.isAlive(live.session_id),
          tools_called: live.tools_called,
          last_tool_call_in_memory: live.last_tool_call,
          identity_mismatch: null,
        });
      }
    }

    sendJson(res, 200, { sessions: combined });
  }, { operation: { id: "get:/api/sessions/channel-connected", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Bug: 0b454df — record a channel tool call for liveness tracking
  server.post("/api/sessions/:id/channel-tool-call", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;

    // Bug: 7ab2f3e — Accept optional tool_input/tool_output for event bridge
    const body = readBody<{ tool_name?: string; tool_input?: unknown; tool_output?: unknown }>(req);
    const toolName = body.tool_name ?? "unknown";

    const channelRegistry = getChannelRegistry();

    // Get current session branch/cwd from DB
    const session = registry.getSession(id);
    channelRegistry.register(id, session?.cwd ?? null, session?.branch ?? null);
    channelRegistry.recordToolCall(id, toolName, body.tool_input, body.tool_output);

    // Issue 499c148 — channel sessions reach the daemon here on every tool call,
    // so a token swapped mid-session is caught without waiting for a re-register.
    const identityWarning = checkSessionIdentity(getDb(), id, req.client_identity);
    sendJson(res, 200, { ok: true, identity_warning: identityWarning });
  }, { operation: { id: "post:/api/sessions/:id/channel-tool-call", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  // Issue 037fa85 / f59b5bd — provider-neutral session alias resolution with
  // explicit zero/one/many semantics. Registered before /api/sessions/:id so
  // the static segment wins route matching. `provider` is an optional
  // narrowing filter; `provider_session_id` accepts a full id or a short
  // prefix (min 8 chars for expansion). Read-only: the binding a client
  // derives from this endpoint is display/navigation-only and must never gate
  // mutations.
  server.get("/api/sessions/resolve", (req, res) => {
    const query = req.query ?? {};
    const provider = (query.provider ?? "").trim();
    const providerSessionId = (query.provider_session_id ?? "").trim();
    if (!providerSessionId) {
      sendJson(res, 400, { error: "Missing provider_session_id" });
      return;
    }
    if (provider && !PROVIDER_TO_CONVERSATION_SOURCE[provider]) {
      sendJson(res, 400, {
        error: `Unknown provider '${provider}' — expected one of: ${Object.keys(PROVIDER_TO_CONVERSATION_SOURCE).join(", ")}`,
      });
      return;
    }
    const { matches, truncated } = resolveAgentSessionMatches(providerSessionId, provider || undefined);
    sendJson(res, 200, {
      provider: provider || null,
      provider_session_id: providerSessionId,
      truncated,
      matches,
    });
  }, { operation: { id: "get:/api/sessions/resolve", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Issue 037fa85 (follow-up) — provider-scoped overview for a Codex session
  // Mandible knows only through ingestion (a conversations row keyed on the
  // provider UUID) with no sessions row. Mirrors the /:id/overview shape so the
  // UI can render the same sections; session-row-dependent sections are marked
  // unavailable with explicit reasons. Read-only: rendering this view never
  // creates a session row — registration is a separate deliberate POST.
  server.get("/api/sessions/overview/by-provider", (req, res) => {
    const query = req.query ?? {};
    const provider = (query.provider ?? "").trim();
    const providerSessionId = (query.provider_session_id ?? "").trim();
    if (provider !== "codex") {
      sendJson(res, 400, { error: "Unsupported provider — expected provider=codex" });
      return;
    }
    if (!providerSessionId) {
      sendJson(res, 400, { error: "Missing provider_session_id" });
      return;
    }

    const db = getDb();
    const asOf = Date.now();

    // Same alias set the resolver and the bound overview use: the provider
    // UUID itself plus any console-session ids that alias it. (A bindable
    // mandible session id would normally route the client to /:id/overview
    // instead, but including it keeps this endpoint honest either way.)
    const aliases = new Set<string>([providerSessionId]);
    for (const match of resolveAgentSessionMatches(providerSessionId).matches) {
      aliases.add(match.matched_ref);
      if (match.console_session_id) aliases.add(match.console_session_id);
      if (match.mandible_session_id) aliases.add(match.mandible_session_id);
    }
    const aliasList = Array.from(aliases);
    const aliasPlaceholders = aliasList.map(() => "?").join(", ");

    const workUnits = db.prepare(`
      SELECT id, issue_id, ledger_issue_id, repo_id, branch, parent_branch, kind,
             state, assigned_session_id, provider, provider_session_id,
             created_at, activated_at, last_commit_at, resolved_at, auth_request_id
      FROM work_units
      WHERE provider_session_id IN (${aliasPlaceholders})
         OR assigned_session_id IN (${aliasPlaceholders})
      ORDER BY created_at DESC
    `).all(...aliasList, ...aliasList) as Array<
      { id: string; issue_id: string; ledger_issue_id: string | null; repo_id: string } & Record<string, unknown>
    >;

    // Linked issues derived from the matched work units' issue refs. Without a
    // session row there are no ledger_session_issue_links, so this derivation
    // (and its provenance note) is the honest best available.
    const issueWorkUnits = new Map<string, string[]>();
    for (const unit of workUnits) {
      let ledgerId = unit.ledger_issue_id;
      if (!ledgerId && unit.issue_id) {
        try {
          const resolved = resolveOperationalIssueRef(db, unit.issue_id, unit.repo_id);
          if (resolved.ok) ledgerId = resolved.issue_id;
        } catch {
          // Derivation convenience only — an unresolvable ref just drops out.
        }
      }
      if (!ledgerId) continue;
      const list = issueWorkUnits.get(ledgerId) ?? [];
      list.push(unit.id);
      issueWorkUnits.set(ledgerId, list);
    }
    let linkedIssueItems: Array<Record<string, unknown>> = [];
    if (issueWorkUnits.size > 0) {
      const issueIds = Array.from(issueWorkUnits.keys());
      const issuePlaceholders = issueIds.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT id, short_id, title, status, ${effectiveWorkerStatusSql("ledger_issues")} AS worker_status, kind, updated_at
        FROM ledger_issues
        WHERE id IN (${issuePlaceholders})
        ORDER BY updated_at DESC
      `).all(...issueIds) as Array<Record<string, unknown>>;
      linkedIssueItems = rows.map((row) => ({
        issue_id: row.id,
        short_id: row.short_id,
        title: row.title,
        status: row.status,
        worker_status: row.worker_status,
        kind: row.kind,
        work_unit_ids: issueWorkUnits.get(String(row.id)) ?? [],
      }));
    }

    const conversations = db.prepare(`
      SELECT id, source, title, session_id, started_at, ended_at, block_count,
             model, branch, cwd, updated_at
      FROM conversations
      WHERE session_id IN (${aliasPlaceholders})
      ORDER BY started_at DESC
      LIMIT ${OVERVIEW_CONVERSATIONS_LIMIT}
    `).all(...aliasList) as Array<Record<string, unknown>>;

    sendJson(res, 200, {
      as_of: asOf,
      binding: {
        kind: "provider-scoped",
        provider: "codex",
        provider_session_id: providerSessionId,
      },
      session: {
        available: false,
        reason: "no Mandible session row for this provider session id",
      },
      children: {
        available: false,
        reason: "child-session tracking requires a Mandible session row",
        items: [],
        truncated: false,
        depth_limit: OVERVIEW_DESCENDANT_DEPTH_LIMIT,
        count_limit: OVERVIEW_DESCENDANT_COUNT_LIMIT,
      },
      linked_issues: {
        available: true,
        source: "work_units",
        note: "derived from provider-matched work units; ledger_session_issue_links requires a Mandible session row",
        items: linkedIssueItems,
      },
      work_units: {
        available: true,
        includes_descendants: false,
        matched_provider_aliases: aliasList,
        items: workUnits,
      },
      conversations: {
        available: true,
        limit: OVERVIEW_CONVERSATIONS_LIMIT,
        items: conversations,
      },
    });
  }, { operation: { id: "get:/api/sessions/overview/by-provider", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/sessions/by-pid/:pid", (req, res) => {
    const pidStr = req.params.pid;
    const pid = Number(pidStr);
    if (!pidStr || !Number.isInteger(pid) || pid <= 0) {
      sendJson(res, 400, { error: "Invalid PID" });
      return;
    }
    const session = registry.getSessionByPid(pid);
    if (!session) {
      sendJson(res, 404, { error: "No active session for PID" });
      return;
    }
    sendJson(res, 200, session);
  }, { operation: { id: "get:/api/sessions/by-pid/:pid", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/sessions/:id", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const session = registry.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, session);
  }, { operation: { id: "get:/api/sessions/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/sessions/:id/tree", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const tree = registry.getSessionTree(id);
    if (!tree) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, tree);
  }, { operation: { id: "get:/api/sessions/:id/tree", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Issue 037fa85 — aggregate Session Overview payload: session row, bounded
  // descendant list, ledger-linked issues, work units, recent conversations.
  // Every section carries provenance/completeness fields so the UI can render
  // honest empty states instead of guessing.
  server.get("/api/sessions/:id/overview", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const session = registry.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    const db = getDb();
    const asOf = Date.now();
    const { descendants, truncated } = collectBoundedDescendants(id);
    const descendantIds = descendants.map((row) => row.id);
    const sessionIds = [id, ...descendantIds];
    const idPlaceholders = sessionIds.map(() => "?").join(", ");

    // Linked issues: explicit ledger links for this session (not the legacy
    // session_issues table, and deliberately not "every issue this session
    // ever touched").
    const linkedIssues = db.prepare(`
      SELECT l.issue_id, l.link_type, l.source, l.created_at, l.last_seen_at,
             i.short_id, i.title, i.status, ${effectiveWorkerStatusSql("i")} AS worker_status, i.kind
      FROM ledger_session_issue_links l
      JOIN ledger_issues i ON i.id = l.issue_id
      WHERE l.session_id = ?
      ORDER BY COALESCE(l.last_seen_at, l.created_at) DESC
    `).all(id) as Array<Record<string, unknown>>;

    // Work units handled by the session or any listed descendant. When the
    // caller supplies the page-level Codex binding, expand provider-session
    // aliases through the same resolver the /resolve endpoint uses. The alias
    // only widens this read; it never influences work-unit state.
    const providerSessionId = (req.query?.provider_session_id ?? "").trim();
    const providerAliases = new Set<string>();
    if (providerSessionId) {
      providerAliases.add(providerSessionId);
      for (const match of resolveAgentSessionMatches(providerSessionId).matches) {
        providerAliases.add(match.matched_ref);
        if (match.console_session_id) providerAliases.add(match.console_session_id);
        if (match.mandible_session_id) providerAliases.add(match.mandible_session_id);
      }
    }
    const providerIds = [...sessionIds, ...providerAliases];
    const providerPlaceholders = providerIds.map(() => "?").join(", ");
    const workUnits = db.prepare(`
      SELECT id, issue_id, ledger_issue_id, repo_id, branch, parent_branch, kind,
             state, assigned_session_id, provider, provider_session_id,
             created_at, activated_at, last_commit_at, resolved_at, auth_request_id
      FROM work_units
      WHERE assigned_session_id IN (${idPlaceholders})
         OR provider_session_id IN (${providerPlaceholders})
      ORDER BY created_at DESC
    `).all(...sessionIds, ...providerIds) as Array<Record<string, unknown>>;

    // Recent conversation metadata. conversations.session_id may hold the
    // registry session id, the provider session UUID recorded on
    // sessions.conversation_id, or (with a page binding) the Codex rollout UUID.
    const conversationKeys = new Set<string>(sessionIds);
    if (session.conversation_id) conversationKeys.add(session.conversation_id);
    for (const row of descendants) {
      if (row.conversation_id) conversationKeys.add(row.conversation_id);
    }
    for (const alias of providerAliases) conversationKeys.add(alias);
    const conversationKeyList = Array.from(conversationKeys);
    const conversationPlaceholders = conversationKeyList.map(() => "?").join(", ");
    const conversations = db.prepare(`
      SELECT id, source, title, session_id, started_at, ended_at, block_count,
             model, branch, cwd, updated_at
      FROM conversations
      WHERE session_id IN (${conversationPlaceholders})
      ORDER BY started_at DESC
      LIMIT ${OVERVIEW_CONVERSATIONS_LIMIT}
    `).all(...conversationKeyList) as Array<Record<string, unknown>>;

    // Honest children section: codex child sessions are not populated today
    // (child hooks are Claude-oriented; the codex parser emits
    // is_sidechain: false), so an empty list for a codex-tier session is an
    // availability gap, not "no children".
    const isCodexTier = (session.app ?? "").toLowerCase().includes("codex");
    const children = descendants.length === 0 && isCodexTier
      ? {
          available: false,
          reason: "codex child sessions not populated",
          items: [],
          truncated: false,
          depth_limit: OVERVIEW_DESCENDANT_DEPTH_LIMIT,
          count_limit: OVERVIEW_DESCENDANT_COUNT_LIMIT,
        }
      : {
          available: true,
          items: descendants,
          truncated,
          depth_limit: OVERVIEW_DESCENDANT_DEPTH_LIMIT,
          count_limit: OVERVIEW_DESCENDANT_COUNT_LIMIT,
        };

    sendJson(res, 200, {
      as_of: asOf,
      session,
      children,
      linked_issues: {
        available: true,
        source: "ledger_session_issue_links",
        items: linkedIssues,
      },
      work_units: {
        available: true,
        includes_descendants: true,
        matched_provider_aliases: Array.from(providerAliases),
        items: workUnits,
      },
      conversations: {
        available: true,
        limit: OVERVIEW_CONVERSATIONS_LIMIT,
        items: conversations,
      },
    });
  }, { operation: { id: "get:/api/sessions/:id/overview", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.post("/api/sessions/:id/navigate", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const session = registry.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    const result = navigateToSession(session);
    sendJson(res, result.ok ? 200 : 500, result);
  }, { operation: { id: "post:/api/sessions/:id/navigate", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  // Bug: 14e1e63 — write Reaper Notice before killing so it appears before pane-loop restarts
  server.post("/api/sessions/:id/kill", (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const id = resolveSessionId(rawId, res);
    if (!id) return;
    const session = registry.getSession(id);
    if (!session || !session.pid) {
      sendJson(res, 404, { error: "Session not found or missing pid" });
      return;
    }

    // Write Reaper Notice before killing so it appears before pane-loop restarts
    const pid = session.pid;
    const app = session.app || "claude";
    try {
      const { execFileSync, spawnSync } = require("child_process") as typeof import("child_process");
      const tty = execFileSync("ps", ["-p", String(pid), "-o", "tty="], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
      if (tty && tty !== "?") {
        const reapNotice = process.env.HOME
          ? `${process.env.HOME}/.dotfiles/bin/reap-notice`
          : "reap-notice";
        spawnSync(reapNotice, [
          "--app", app,
          "--pid", String(pid),
          "--tty", tty,
          "--source", "mandible",
        ], { timeout: 2000 });
      }
    } catch {
      // Non-fatal: notice failure should not block the kill
    }

    const ok = registry.killSession(id);
    if (!ok) {
      sendJson(res, 404, { error: "Session not found or missing pid" });
      return;
    }
    sendJson(res, 200, { ok: true });
  }, { operation: { id: "post:/api/sessions/:id/kill", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "deny" });

  // POST /api/sessions/:id/issues — link a session to an issue
  server.post("/api/sessions/:id/issues", (req, res) => {
    const rawSessionId = req.params.id;
    if (!rawSessionId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const sessionId = resolveSessionIdForIssueLink(rawSessionId, registry, res);
    if (!sessionId) return;
    const body = readBody<{ issue_id?: string; repo_id?: string; repo_name?: string }>(req);
    if (!body.issue_id || !body.repo_id) {
      sendJson(res, 400, { error: "Missing issue_id or repo_id" });
      return;
    }
    const canonicalRepoId = resolveCanonicalRepoId(workScanner, body.repo_id, body.repo_name, body.issue_id);
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO session_issues (session_id, issue_id, repo_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    ).run(sessionId, body.issue_id, canonicalRepoId, now);

    // Persist project association (sticky — survives issue closure)
    let repoName = body.repo_name;
    if (!repoName || repoName.includes("/") || looksLikeBranchName(repoName)) {
      const repo = workScanner?.getRepoById(canonicalRepoId);
      if (repo) {
        repoName = repo.name;
      }
    }
    repoName = normalizeRepoDisplayName(canonicalRepoId, repoName);
    db.prepare(
      `INSERT INTO session_projects (session_id, repo_id, repo_name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    ).run(sessionId, canonicalRepoId, repoName, now);

    const ledgerIssueId = linkSessionLedgerIssue(sessionId, body.issue_id, canonicalRepoId);

    // Issue 499c148 — linking a session to an issue is an authenticated client
    // claiming that session's work, so it is a natural second checkpoint.
    const identityWarning = checkSessionIdentity(db, sessionId, req.client_identity);

    sendJson(res, 200, {
      session_id: sessionId,
      issue_id: body.issue_id,
      repo_id: canonicalRepoId,
      created_at: now,
      ledger_issue_id: ledgerIssueId,
      identity_warning: identityWarning,
    });
  }, { operation: { id: "post:/api/sessions/:id/issues", effects: ["process:external"], requestSchema: null, reportingCategory: "sessions" }, fileRpc: "allow" });

  // GET /api/sessions/:id/issues — get linked issues for a session
  server.get("/api/sessions/:id/issues", (req, res) => {
    const rawSessionId = req.params.id;
    if (!rawSessionId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }
    const sessionId = resolveSessionId(rawSessionId, res);
    if (!sessionId) return;
    const db = getDb();
    const links = db.prepare(
      `SELECT session_id, issue_id, repo_id, created_at
       FROM session_issues
       WHERE session_id = ?
       ORDER BY created_at ASC`
    ).all(sessionId);
    sendJson(res, 200, links);
  }, { operation: { id: "get:/api/sessions/:id/issues", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

}
