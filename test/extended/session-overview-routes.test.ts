// Issue 037fa85 — Session Overview endpoints:
// GET /api/sessions/resolve (codex alias resolution, explicit zero/one/many)
// GET /api/sessions/:id/overview (aggregate payload with bounded descendants,
// ledger issue links, work units, conversations, per-section provenance).
import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb, type Db } from "../../src/db.js";
import { SessionRegistry } from "../../src/registry.js";
import { registerSessionRoutes } from "../../src/routes/sessions.js";
import { Router } from "../../src/server.js";

let db: Db;
let registry: SessionRegistry;
let router: Router;

const CODEX_UUID = "0198c0de-1111-2222-3333-444455556666";

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  registry = new SessionRegistry(db);
  router = new Router();
  registerSessionRoutes(router, registry);
});

afterEach(() => {
  db.close();
});

function insertConsoleSession(input: {
  id: string;
  provider_session_id?: string | null;
  mandible_session_id?: string | null;
  updated_at?: number;
}): void {
  db.prepare(`
    INSERT INTO console_sessions (id, label, command, provider_session_id, mandible_session_id, created_at, updated_at)
    VALUES (?, ?, 'codex', ?, ?, ?, ?)
  `).run(
    input.id,
    `label-${input.id}`,
    input.provider_session_id ?? null,
    input.mandible_session_id ?? null,
    1_700_000_000_000,
    input.updated_at ?? 1_700_000_000_000,
  );
}

function insertConversation(input: {
  id: string;
  session_id: string;
  source?: string;
  title?: string;
  started_at?: string;
  cwd?: string | null;
  branch?: string | null;
}): void {
  db.prepare(`
    INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, session_id, block_count, cwd, branch)
    VALUES (?, ?, ?, 'hash', 0, ?, ?, ?, 3, ?, ?)
  `).run(
    input.id,
    input.source ?? "codex",
    `/tmp/${input.id}.jsonl`,
    input.title ?? `conv ${input.id}`,
    input.started_at ?? "2026-08-01T10:00:00Z",
    input.session_id,
    input.cwd ?? null,
    input.branch ?? null,
  );
}

function insertLedgerIssue(input: {
  issue_id: string;
  title: string;
  status?: string;
}): void {
  db.prepare(`
    INSERT OR IGNORE INTO ledger_projects (id, display_name, created_at, updated_at)
    VALUES ('prj-test', 'Test Project', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO ledger_issues (id, short_id, project_id, title, status, created_at, updated_at)
    VALUES (?, ?, 'prj-test', ?, ?, 10, 10)
  `).run(input.issue_id, input.issue_id.slice(0, 7), input.title, input.status ?? "open");
}

function insertLedgerIssueWithLink(input: {
  issue_id: string;
  session_id: string;
  title: string;
  status?: string;
  link_type?: string;
  last_seen_at?: number | null;
}): void {
  db.prepare(`
    INSERT OR IGNORE INTO ledger_projects (id, display_name, created_at, updated_at)
    VALUES ('prj-test', 'Test Project', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO ledger_issues (id, short_id, project_id, title, status, created_at, updated_at)
    VALUES (?, ?, 'prj-test', ?, ?, 10, 10)
  `).run(input.issue_id, input.issue_id.slice(0, 7), input.title, input.status ?? "open");
  db.prepare(`
    INSERT INTO ledger_session_issue_links (session_id, issue_id, link_type, source, created_at, last_seen_at)
    VALUES (?, ?, ?, 'system', 100, ?)
  `).run(input.session_id, input.issue_id, input.link_type ?? "worked_on", input.last_seen_at ?? null);
}

function insertWorkUnit(input: {
  id: string;
  issue_id?: string;
  ledger_issue_id?: string | null;
  assigned_session_id?: string | null;
  provider?: string | null;
  provider_session_id?: string | null;
  state?: string;
}): void {
  db.prepare(`
    INSERT INTO work_units (id, issue_id, ledger_issue_id, repo_id, state, assigned_session_id, provider, provider_session_id, created_at)
    VALUES (?, ?, ?, 'mandible', ?, ?, ?, ?, 1000)
  `).run(
    input.id,
    input.issue_id ?? "abc1234",
    input.ledger_issue_id ?? null,
    input.state ?? "open",
    input.assigned_session_id ?? null,
    input.provider ?? null,
    input.provider_session_id ?? null,
  );
}

async function getResolve(query: string): Promise<{ status: number; body: any }> {
  const result = await router.invoke({ method: "GET", url: `/api/sessions/resolve${query}` });
  return { status: result.status, body: result.body };
}

async function getOverview(id: string, query = ""): Promise<{ status: number; body: any }> {
  const result = await router.invoke({ method: "GET", url: `/api/sessions/${id}/overview${query}` });
  return { status: result.status, body: result.body };
}

describe("GET /api/sessions/resolve", () => {
  it("rejects a missing provider_session_id", async () => {
    expect((await getResolve("?provider=codex")).status).toBe(400);
    expect((await getResolve("")).status).toBe(400);
  });

  // Issue f59b5bd — provider is an optional narrowing filter, not a gate.
  it("resolves without a provider param", async () => {
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });

    const { status, body } = await getResolve(`?provider_session_id=${CODEX_UUID}`);
    expect(status).toBe(200);
    expect(body.provider).toBeNull();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      matched_ref: CODEX_UUID,
      provider: "codex",
      conversation_id: "conv-1",
      sources: ["conversations"],
    });
  });

  it("resolves non-codex conversation sources provider-neutrally", async () => {
    insertConversation({ id: "conv-cc", session_id: CODEX_UUID, source: "claude_code" });

    const { body } = await getResolve(`?provider_session_id=${CODEX_UUID}`);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].conversation_id).toBe("conv-cc");
    expect(body.matches[0].provider).toBe("claude");
  });

  // Review C3 — the client vocabulary `claude` maps to conversations.source
  // `claude_code`; legit Claude rows must resolve under provider=claude.
  it("maps provider=claude to conversations.source claude_code", async () => {
    insertConversation({ id: "conv-cc", session_id: CODEX_UUID, source: "claude_code" });

    const { status, body } = await getResolve(`?provider=claude&provider_session_id=${CODEX_UUID}`);
    expect(status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      matched_ref: CODEX_UUID,
      provider: "claude",
      conversation_id: "conv-cc",
    });
  });

  it("rejects an unknown provider vocabulary instead of silently matching nothing", async () => {
    const { status } = await getResolve(`?provider=cortex&provider_session_id=${CODEX_UUID}`);
    expect(status).toBe(400);
  });

  it("returns zero matches without inventing one", async () => {
    const { status, body } = await getResolve(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    expect(status).toBe(200);
    expect(body).toEqual({
      provider: "codex",
      provider_session_id: CODEX_UUID,
      truncated: false,
      matches: [],
    });
  });

  it("resolves exactly one match through console_sessions and attaches the codex conversation", async () => {
    registry.registerSession({ id: "sess-1", app: "codex" });
    insertConsoleSession({
      id: "cs-1",
      provider_session_id: CODEX_UUID,
      mandible_session_id: "sess-1",
    });
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });

    const { status, body } = await getResolve(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    expect(status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      provider: "codex",
      mandible_session_id: "sess-1",
      console_session_id: "cs-1",
      conversation_id: "conv-1",
    });
  });

  // Review C3 — the registry/console stores carry no provider provenance, so
  // a codex narrowing must NOT return a session attested to another provider
  // (or pretend those stores were provider-filtered).
  it("excludes claude-attested sessions from a codex-narrowed resolution", async () => {
    registry.registerSession({ id: "sess-1", app: "codex" });
    insertConsoleSession({
      id: "cs-1",
      provider_session_id: CODEX_UUID,
      mandible_session_id: "sess-1",
    });
    insertConversation({ id: "conv-cc", session_id: CODEX_UUID, source: "claude_code" });

    const narrowed = await getResolve(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    expect(narrowed.body.matches).toEqual([]);

    const open = await getResolve(`?provider_session_id=${CODEX_UUID}`);
    expect(open.body.matches).toHaveLength(1);
    expect(open.body.matches[0]).toMatchObject({
      provider: "claude",
      mandible_session_id: "sess-1",
      conversation_id: "conv-cc",
    });
  });

  // Review C2 — the same raw session id claimed by two providers yields one
  // match per (provider, matched_ref) identity, never a LIMIT 1 pick.
  it("keeps cross-provider claims of the same raw id distinct", async () => {
    insertConversation({ id: "conv-codex", session_id: CODEX_UUID, source: "codex" });
    insertConversation({ id: "conv-cc", session_id: CODEX_UUID, source: "claude_code" });

    const { body } = await getResolve(`?provider_session_id=${CODEX_UUID}`);
    expect(body.matches).toHaveLength(2);
    const byProvider = new Map(
      body.matches.map((m: { provider: string | null; conversation_id: string | null }) => [m.provider, m.conversation_id]),
    );
    expect(byProvider.get("codex")).toBe("conv-codex");
    expect(byProvider.get("claude")).toBe("conv-cc");

    const narrowed = await getResolve(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    expect(narrowed.body.matches).toHaveLength(1);
    expect(narrowed.body.matches[0]).toMatchObject({
      provider: "codex",
      conversation_id: "conv-codex",
    });
  });

  it("deduplicates the same mandible session found via multiple stores", async () => {
    registry.registerSession({ id: "sess-1", app: "codex", conversation_id: CODEX_UUID });
    insertConsoleSession({
      id: "cs-1",
      provider_session_id: CODEX_UUID,
      mandible_session_id: "sess-1",
    });

    const { body } = await getResolve(`?provider_session_id=${CODEX_UUID}`);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].mandible_session_id).toBe("sess-1");
    expect(body.matches[0].sources).toEqual(
      expect.arrayContaining(["console_sessions", "sessions"]),
    );
  });

  it("reports many matches instead of silently picking one", async () => {
    registry.registerSession({ id: "sess-1", app: "codex" });
    registry.registerSession({ id: "sess-2", app: "codex" });
    insertConsoleSession({
      id: "cs-1",
      provider_session_id: CODEX_UUID,
      mandible_session_id: "sess-1",
      updated_at: 2_000,
    });
    insertConsoleSession({
      id: "cs-2",
      provider_session_id: CODEX_UUID,
      mandible_session_id: "sess-2",
      updated_at: 1_000,
    });

    const { body } = await getResolve(`?provider_session_id=${CODEX_UUID}`);
    expect(body.matches).toHaveLength(2);
    const ids = body.matches.map((m: { mandible_session_id: string | null }) => m.mandible_session_id);
    expect(ids).toEqual(expect.arrayContaining(["sess-1", "sess-2"]));
  });

  it("returns a conversation-only match honestly when no session exists", async () => {
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });

    const { body } = await getResolve(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      provider: "codex",
      mandible_session_id: null,
      console_session_id: null,
      conversation_id: "conv-1",
      sources: ["conversations"],
    });
  });
});

// Issue f59b5bd — short-prefix resolution with explicit zero/one/many honesty
// and a minimum prefix length matching the 8-char short-ID convention.
describe("GET /api/sessions/resolve with short prefixes", () => {
  const SHORT = CODEX_UUID.slice(0, 8);

  it("resolves an unambiguous 8-char prefix to the full identity", async () => {
    registry.registerSession({ id: "sess-1", app: "codex", conversation_id: CODEX_UUID });
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });

    const { status, body } = await getResolve(`?provider_session_id=${SHORT}`);
    expect(status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      matched_ref: CODEX_UUID,
      mandible_session_id: "sess-1",
      conversation_id: "conv-1",
    });
  });

  it("resolves a mandible session id prefix through the sessions registry", async () => {
    registry.registerSession({ id: "sessionabcdef-1", app: "claude" });

    const { body } = await getResolve("?provider_session_id=sessiona");
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      matched_ref: "sessionabcdef-1",
      mandible_session_id: "sessionabcdef-1",
      sources: ["sessions"],
    });
  });

  it("returns every identity a prefix matches instead of silently picking", async () => {
    const other = `${SHORT}-9999-8888-7777-666655554444`;
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });
    insertConversation({ id: "conv-2", session_id: other, source: "codex" });

    const { body } = await getResolve(`?provider_session_id=${SHORT}`);
    expect(body.matches).toHaveLength(2);
    const refs = body.matches.map((m: { matched_ref: string }) => m.matched_ref).sort();
    expect(refs).toEqual([CODEX_UUID, other].sort());
  });

  it("keeps registry-only prefix collisions visible beside a provider identity", async () => {
    const staleRegistryId = `${SHORT}-6345-7e53-b784-b5d125520`;
    registry.registerSession({ id: CODEX_UUID, app: "codex" });
    registry.registerSession({ id: staleRegistryId, app: "codex" });
    insertConversation({ id: "conv-current", session_id: CODEX_UUID, source: "codex" });

    const { body } = await getResolve(`?provider_session_id=${SHORT}`);

    expect(body.truncated).toBe(false);
    expect(body.matches).toHaveLength(2);
    expect(body.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        matched_ref: CODEX_UUID,
        provider: "codex",
        mandible_session_id: CODEX_UUID,
        conversation_id: "conv-current",
      }),
      expect.objectContaining({
        matched_ref: staleRegistryId,
        provider: null,
        mandible_session_id: staleRegistryId,
        conversation_id: null,
      }),
    ]));
  });

  it("returns zero matches for a prefix that matches nothing", async () => {
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });

    const { body } = await getResolve("?provider_session_id=ffffffff");
    expect(body.matches).toEqual([]);
  });

  it("never expands a prefix shorter than 8 chars", async () => {
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });

    const { body } = await getResolve(`?provider_session_id=${CODEX_UUID.slice(0, 7)}`);
    expect(body.matches).toEqual([]);
  });

  it("still resolves short non-UUID identifiers by exact match", async () => {
    registry.registerSession({ id: "sess-1", app: "codex" });
    insertConsoleSession({
      id: "cs-1",
      provider_session_id: CODEX_UUID,
      mandible_session_id: "sess-1",
    });

    const { body } = await getResolve("?provider_session_id=cs-1");
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      matched_ref: "cs-1",
      console_session_id: "cs-1",
      mandible_session_id: "sess-1",
    });
  });

  it("applies the provider filter to prefix expansion over conversations", async () => {
    insertConversation({ id: "conv-cc", session_id: CODEX_UUID, source: "claude_code" });

    const narrowed = await getResolve(`?provider=codex&provider_session_id=${SHORT}`);
    expect(narrowed.body.matches).toEqual([]);

    // Review C3 — the claude vocabulary maps to source claude_code in the
    // prefix scan too.
    const claudeNarrowed = await getResolve(`?provider=claude&provider_session_id=${SHORT}`);
    expect(claudeNarrowed.body.matches).toHaveLength(1);
    expect(claudeNarrowed.body.matches[0].provider).toBe("claude");

    const open = await getResolve(`?provider_session_id=${SHORT}`);
    expect(open.body.matches).toHaveLength(1);
    expect(open.body.matches[0].conversation_id).toBe("conv-cc");
  });

  // Review C5 — full-identity detection goes by UUID shape, not length: a
  // 36-char non-UUID ref still expands as a prefix of a longer id.
  it("expands a 36-char non-UUID ref as a prefix of longer ids", async () => {
    const longId = `${"a".repeat(40)}`;
    registry.registerSession({ id: longId, app: "claude" });

    const { body } = await getResolve(`?provider_session_id=${"a".repeat(36)}`);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      matched_ref: longId,
      mandible_session_id: longId,
    });
  });

  // Review C4 — a capped candidate scan must set `truncated` so a client can
  // never treat the (possibly incomplete) result as a proven unique.
  it("flags truncation when a prefix scan hits the candidate cap", async () => {
    for (let i = 0; i < 25; i += 1) {
      const suffix = String(i).padStart(12, "0");
      insertConversation({
        id: `conv-${i}`,
        session_id: `${SHORT}-0000-0000-0000-${suffix}`,
        source: "codex",
      });
    }

    const { body } = await getResolve(`?provider_session_id=${SHORT}`);
    expect(body.truncated).toBe(true);
    expect(body.matches.length).toBeGreaterThan(1);
  });

  it("does not flag truncation for a small unambiguous scan", async () => {
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });

    const { body } = await getResolve(`?provider_session_id=${SHORT}`);
    expect(body.truncated).toBe(false);
    expect(body.matches).toHaveLength(1);
  });

  // Review C4 (named failure scenario) — many raw rows that all dedupe to ONE
  // canonical identity still hit the per-scan cap: the result must carry
  // truncated=true, because a second distinct identity could hide past the
  // cap. "One match" after truncation is never presented as a proven unique.
  it("never reports a clean unique when the scan was truncated", async () => {
    registry.registerSession({ id: "sess-x", app: "codex" });
    for (let i = 0; i < 21; i += 1) {
      insertConsoleSession({
        id: `${SHORT}-console-${String(i).padStart(2, "0")}`,
        mandible_session_id: "sess-x",
      });
    }

    const { body } = await getResolve(`?provider_session_id=${SHORT}`);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].mandible_session_id).toBe("sess-x");
    expect(body.truncated).toBe(true);
  });
});

describe("GET /api/sessions/:id/overview", () => {
  it("returns 404 for an unknown session", async () => {
    const { status } = await getOverview("does-not-exist");
    expect(status).toBe(404);
  });

  it("returns the aggregate shape with as_of and per-section provenance", async () => {
    registry.registerSession({ id: "root-1", app: "claude", branch: "feature/x", cwd: "/tmp/repo" });

    const { status, body } = await getOverview("root-1");
    expect(status).toBe(200);
    expect(typeof body.as_of).toBe("number");
    expect(body.session.id).toBe("root-1");
    expect(body.children).toMatchObject({ available: true, items: [], truncated: false });
    expect(body.children.depth_limit).toBeGreaterThan(0);
    expect(body.children.count_limit).toBeGreaterThan(0);
    expect(body.linked_issues).toMatchObject({
      available: true,
      source: "ledger_session_issue_links",
      items: [],
    });
    expect(body.work_units).toMatchObject({ available: true, includes_descendants: true, items: [] });
    expect(body.conversations).toMatchObject({ available: true, items: [] });
  });

  it("marks the children section unavailable for a codex session without children", async () => {
    registry.registerSession({ id: "codex-1", app: "codex" });

    const { body } = await getOverview("codex-1");
    expect(body.children.available).toBe(false);
    expect(body.children.reason).toBe("codex child sessions not populated");
    expect(body.children.items).toEqual([]);
  });

  it("bounds the descendant walk by depth and reports truncation", async () => {
    registry.registerSession({ id: "root-1", app: "claude" });
    let parent = "root-1";
    for (let i = 1; i <= 7; i += 1) {
      registry.registerSession({ id: `child-${i}`, app: "claude", parent_id: parent });
      parent = `child-${i}`;
    }

    const { body } = await getOverview("root-1");
    const ids = body.children.items.map((c: { id: string }) => c.id);
    expect(ids).toEqual(["child-1", "child-2", "child-3", "child-4", "child-5"]);
    expect(body.children.items[4].depth).toBe(5);
    expect(body.children.truncated).toBe(true);
  });

  it("survives a parent_id cycle without looping", async () => {
    registry.registerSession({ id: "a", app: "claude" });
    registry.registerSession({ id: "b", app: "claude", parent_id: "a" });
    db.prepare("UPDATE sessions SET parent_id = 'b' WHERE id = 'a'").run();

    const { status, body } = await getOverview("a");
    expect(status).toBe(200);
    expect(body.children.items.map((c: { id: string }) => c.id)).toEqual(["b"]);
  });

  it("joins ledger session issue links to ledger_issues", async () => {
    registry.registerSession({ id: "root-1", app: "claude" });
    insertLedgerIssueWithLink({
      issue_id: "issueaa11",
      session_id: "root-1",
      title: "Fix the flux capacitor",
      status: "open",
      link_type: "worked_on",
      last_seen_at: 4_242,
    });

    const { body } = await getOverview("root-1");
    expect(body.linked_issues.items).toHaveLength(1);
    expect(body.linked_issues.items[0]).toMatchObject({
      issue_id: "issueaa11",
      short_id: "issueaa",
      title: "Fix the flux capacitor",
      status: "open",
      link_type: "worked_on",
      last_seen_at: 4_242,
    });
  });

  it("does not include linked issues from descendant sessions", async () => {
    registry.registerSession({ id: "root-1", app: "claude" });
    registry.registerSession({ id: "child-1", app: "claude", parent_id: "root-1" });
    insertLedgerIssueWithLink({
      issue_id: "issuebb22",
      session_id: "child-1",
      title: "Child-linked issue",
    });

    const { body } = await getOverview("root-1");
    expect(body.linked_issues.items).toEqual([]);
  });

  it("includes work units assigned to the session or any listed descendant", async () => {
    registry.registerSession({ id: "root-1", app: "claude" });
    registry.registerSession({ id: "child-1", app: "claude", parent_id: "root-1" });
    insertWorkUnit({ id: "wu-root", assigned_session_id: "root-1" });
    insertWorkUnit({ id: "wu-child", assigned_session_id: "child-1" });
    insertWorkUnit({ id: "wu-other", assigned_session_id: "unrelated" });

    const { body } = await getOverview("root-1");
    const ids = body.work_units.items.map((w: { id: string }) => w.id);
    expect(ids).toEqual(expect.arrayContaining(["wu-root", "wu-child"]));
    expect(ids).not.toContain("wu-other");
  });

  it("matches work units by codex provider alias only when the binding param is passed", async () => {
    registry.registerSession({ id: "root-1", app: "codex" });
    insertWorkUnit({
      id: "wu-codex",
      provider: "codex",
      provider_session_id: CODEX_UUID,
    });

    const without = await getOverview("root-1");
    expect(without.body.work_units.items).toEqual([]);

    const withParam = await getOverview("root-1", `?provider_session_id=${CODEX_UUID}`);
    const ids = withParam.body.work_units.items.map((w: { id: string }) => w.id);
    expect(ids).toContain("wu-codex");
    expect(withParam.body.work_units.matched_provider_aliases).toContain(CODEX_UUID);
  });

  it("lists recent conversations for the session and the codex binding", async () => {
    registry.registerSession({ id: "root-1", app: "claude", conversation_id: "prov-uuid-1" });
    insertConversation({
      id: "conv-direct",
      session_id: "root-1",
      source: "claude_code",
      started_at: "2026-08-02T10:00:00Z",
    });
    insertConversation({
      id: "conv-provider",
      session_id: "prov-uuid-1",
      source: "claude_code",
      started_at: "2026-08-01T10:00:00Z",
    });
    insertConversation({
      id: "conv-codex",
      session_id: CODEX_UUID,
      source: "codex",
      started_at: "2026-08-03T10:00:00Z",
    });
    insertConversation({
      id: "conv-unrelated",
      session_id: "someone-else",
      source: "codex",
      started_at: "2026-08-03T11:00:00Z",
    });

    const without = await getOverview("root-1");
    const withoutIds = without.body.conversations.items.map((c: { id: string }) => c.id);
    expect(withoutIds).toEqual(["conv-direct", "conv-provider"]);

    const withParam = await getOverview("root-1", `?provider_session_id=${CODEX_UUID}`);
    const withIds = withParam.body.conversations.items.map((c: { id: string }) => c.id);
    expect(withIds).toEqual(["conv-codex", "conv-direct", "conv-provider"]);
  });
});

// Issue 037fa85 (follow-up) — provider-scoped overview for a Codex session
// with an ingested transcript but no sessions row.
describe("GET /api/sessions/overview/by-provider", () => {
  async function getByProvider(query: string): Promise<{ status: number; body: any }> {
    const result = await router.invoke({
      method: "GET",
      url: `/api/sessions/overview/by-provider${query}`,
    });
    return { status: result.status, body: result.body };
  }

  it("rejects unsupported providers and missing provider_session_id", async () => {
    expect((await getByProvider(`?provider_session_id=${CODEX_UUID}`)).status).toBe(400);
    expect((await getByProvider(`?provider=claude&provider_session_id=${CODEX_UUID}`)).status).toBe(400);
    expect((await getByProvider("?provider=codex")).status).toBe(400);
  });

  it("returns the provider-scoped shape with unavailable session/children sections", async () => {
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });

    const { status, body } = await getByProvider(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    expect(status).toBe(200);
    expect(typeof body.as_of).toBe("number");
    expect(body.binding).toEqual({
      kind: "provider-scoped",
      provider: "codex",
      provider_session_id: CODEX_UUID,
    });
    expect(body.session.available).toBe(false);
    expect(body.session.reason).toContain("no Mandible session row");
    expect(body.children.available).toBe(false);
    expect(body.children.reason).toContain("session row");
    expect(body.children.items).toEqual([]);
    expect(body.linked_issues).toMatchObject({ available: true, source: "ledger_session_issue_links", items: [] });
    expect(body.work_units).toMatchObject({ available: true, items: [] });
    expect(body.work_units.matched_provider_aliases).toContain(CODEX_UUID);
    expect(body.conversations.available).toBe(true);
    expect(body.conversations.items.map((c: { id: string }) => c.id)).toEqual(["conv-1"]);
  });

  it("matches work units on provider id and console aliases and derives linked issues", async () => {
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });
    // Console session aliasing the codex UUID, without a mandible session.
    insertConsoleSession({ id: "cs-alias", provider_session_id: CODEX_UUID });
    insertLedgerIssue({ issue_id: "ledgerissue001", title: "Provider-scoped issue" });
    insertWorkUnit({
      id: "wu-provider",
      provider: "codex",
      provider_session_id: CODEX_UUID,
      ledger_issue_id: "ledgerissue001",
    });
    insertWorkUnit({ id: "wu-console-alias", assigned_session_id: "cs-alias" });
    insertWorkUnit({ id: "wu-unrelated", assigned_session_id: "someone-else" });

    const { body } = await getByProvider(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    const ids = body.work_units.items.map((w: { id: string }) => w.id);
    expect(ids).toEqual(expect.arrayContaining(["wu-provider", "wu-console-alias"]));
    expect(ids).not.toContain("wu-unrelated");
    expect(body.work_units.matched_provider_aliases).toEqual(
      expect.arrayContaining([CODEX_UUID, "cs-alias"]),
    );

    const issueIds = body.linked_issues.items.map((i: { issue_id: string }) => i.issue_id);
    expect(issueIds).toContain("ledgerissue001");
    const derived = body.linked_issues.items.find(
      (i: { issue_id: string }) => i.issue_id === "ledgerissue001",
    );
    expect(derived).toMatchObject({
      short_id: "ledgeri",
      title: "Provider-scoped issue",
      status: "open",
      work_unit_ids: ["wu-provider"],
    });
  });

  it("derives linked issues through issue-ref resolution when ledger_issue_id is unset", async () => {
    insertLedgerIssue({ issue_id: "deadbeef1234", title: "Ref-resolved issue" });
    insertWorkUnit({
      id: "wu-ref",
      issue_id: "deadbee",
      provider: "codex",
      provider_session_id: CODEX_UUID,
    });

    const { body } = await getByProvider(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    const issueIds = body.linked_issues.items.map((i: { issue_id: string }) => i.issue_id);
    expect(issueIds).toContain("deadbeef1234");
  });

  it("is read-only: it never creates a session row", async () => {
    insertConversation({ id: "conv-1", session_id: CODEX_UUID, source: "codex" });
    await getByProvider(`?provider=codex&provider_session_id=${CODEX_UUID}`);
    const count = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
