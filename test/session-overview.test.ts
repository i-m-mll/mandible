// GET /api/sessions/:id/overview: one overview for any session alias of any
// provider, with or without a process attachment, children from lineage.
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb, type Db } from "../src/db.js";
import { SessionRegistry } from "../src/registry.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { Router } from "../src/server.js";

let db: Db;
let router: Router;

const PARENT = "01a15eab-2728-7403-920f-781410951a64";
const CHILD = "01a15eab-9999-7403-920f-000000000001";
const SECOND_CHILD = "02b26fbc-0000-7403-920f-000000000002";
const GRANDCHILD = "03c37acd-0000-7403-920f-000000000003";
const CLAUDE_SESSION = "4be0c2a1-6b44-4a43-9d2e-0d6f1c9a7e21";
const SUBAGENT = "a1b2c3d4e5f6a7b8c";

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  router = new Router();
  registerSessionRoutes(router, new SessionRegistry(db));
});

afterEach(() => {
  db.close();
});

function conversation(input: {
  id: string;
  session_id: string;
  source?: string;
  parent?: { row: string; session_id: string } | null;
  agent_id?: string | null;
  started_at?: string;
}): void {
  db.prepare(`
    INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, session_id,
                               parent_conversation_id, parent_source, parent_session_id, is_sidechain, agent_id)
    VALUES (?, ?, ?, 'hash', 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.source ?? "codex",
    `/tmp/${input.id}.jsonl`,
    `title ${input.id}`,
    input.started_at ?? "2026-10-01T10:00:00Z",
    input.session_id,
    input.parent?.row ?? null,
    input.parent ? input.source ?? "codex" : null,
    input.parent?.session_id ?? null,
    input.agent_id && input.parent?.session_id === input.session_id ? 1 : 0,
    input.agent_id ?? null,
  );
}

async function overview(ref: string): Promise<{ status: number; body: any }> {
  const result = await router.invoke({ method: "GET", url: `/api/sessions/${ref}/overview` });
  return { status: result.status, body: result.body };
}

describe("GET /api/sessions/:id/overview", () => {
  it("lists a Codex thread's descendants across duplicate parent rows, with no process row", async () => {
    conversation({ id: "p-row", session_id: PARENT });
    conversation({ id: "p-dup", session_id: PARENT, started_at: "2026-10-01T11:00:00Z" });
    conversation({ id: "c-row", session_id: CHILD, parent: { row: "p-row", session_id: PARENT } });
    conversation({ id: "c2-row", session_id: SECOND_CHILD, parent: { row: "p-dup", session_id: PARENT } });
    conversation({ id: "g-row", session_id: GRANDCHILD, parent: { row: "c-row", session_id: CHILD } });
    db.prepare(`
      INSERT INTO work_units (id, issue_id, repo_id, state, worker_provider_session_id, created_at)
      VALUES ('wu-child', 'abc1234', 'mandible', 'committed', ?, 1000)
    `).run(GRANDCHILD);

    const { status, body } = await overview(PARENT);

    expect(status).toBe(200);
    expect(body.session).toMatchObject({ id: PARENT, provider: "codex", process: null });
    expect(body.children.items.map((child: any) => [child.id, child.parent_id, child.depth])).toEqual([
      [CHILD, PARENT, 1],
      [SECOND_CHILD, PARENT, 1],
      [GRANDCHILD, CHILD, 2],
    ]);
    for (const child of body.children.items) expect(["live", "stopped", "unknown"]).toContain(child.liveness);
    expect(body.work_units.items.map((unit: any) => unit.id)).toEqual(["wu-child"]);
    expect(JSON.stringify(body)).not.toContain("available");
  });

  it("serves a wrap-registered Claude session with its process and subagents, each subagent its own overview", async () => {
    db.prepare("INSERT INTO sessions (id, app, status, pid, conversation_id) VALUES ('wrap-1', 'claude', 'active', 4242, ?)")
      .run(CLAUDE_SESSION);
    conversation({ id: "main-row", session_id: CLAUDE_SESSION, source: "claude_code" });
    conversation({
      id: "sub-row",
      session_id: CLAUDE_SESSION,
      source: "claude_code",
      agent_id: SUBAGENT,
      parent: { row: "main-row", session_id: CLAUDE_SESSION },
    });

    const parent = await overview("wrap-1");
    expect(parent.body.session).toMatchObject({
      id: CLAUDE_SESSION,
      provider: "claude",
      liveness: "live",
      conversation_id: "main-row",
      process: { id: "wrap-1", pid: 4242 },
    });
    expect(parent.body.children.items).toMatchObject([{ id: SUBAGENT, provider: "claude", depth: 1 }]);
    expect(parent.body.conversations.items.map((row: any) => row.id)).toEqual(["main-row"]);

    const child = await overview(SUBAGENT);
    expect(child.status).toBe(200);
    expect(child.body.session).toMatchObject({ id: SUBAGENT, conversation_id: "sub-row", process: null });
    expect(child.body.children.items).toEqual([]);
  });

  it("resolves a unique prefix, lists the sessions an ambiguous prefix names, and 404s an unknown ref", async () => {
    conversation({ id: "p-row", session_id: PARENT });
    conversation({ id: "c-row", session_id: CHILD });

    const ambiguous = await overview(PARENT.slice(0, 9));
    expect(ambiguous.body.status).toBe("ambiguous");
    expect(ambiguous.body.candidates.map((c: any) => c.id).sort()).toEqual([CHILD, PARENT].sort());
    expect((await overview(PARENT.slice(0, 13))).body.session).toMatchObject({ id: PARENT });
    expect((await overview("ffffffff-0000")).status).toBe(404);
  });
});
