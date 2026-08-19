import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConversationSearchCache } from "../src/conversations/search-cache.js";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";

let tempDir: string;
let db: Db;

interface ConversationFixture {
  id: string;
  source?: "codex" | "claude_code" | "gemini";
  title?: string;
  startedAt?: string;
  blocks?: number;
  starred?: boolean;
  projectPath?: string | null;
  cwd?: string | null;
  sourcePath?: string;
  parentId?: string | null;
}

function insertConversation(fixture: ConversationFixture): void {
  db.prepare(`INSERT INTO conversations
    (id, source, source_path, source_hash, source_mtime, title, started_at, session_id,
     block_count, starred, project_path, cwd, parent_conversation_id, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
    .run(
      fixture.id,
      fixture.source ?? "codex",
      fixture.sourcePath ?? `/tmp/${fixture.id}`,
      `hash-${fixture.id}`,
      fixture.title ?? fixture.id,
      fixture.startedAt ?? "2026-08-18T12:00:00Z",
      `session-${fixture.id}`,
      fixture.blocks ?? 1,
      fixture.starred ? 1 : 0,
      fixture.projectPath ?? null,
      fixture.cwd ?? null,
      fixture.parentId ?? null,
      fixture.startedAt ?? "2026-08-18T12:00:00Z",
      fixture.startedAt ?? "2026-08-18T12:00:00Z",
    );
}

function groupsOf(response: { body: unknown }) {
  return (response.body as {
    groups: Array<{
      key: string;
      kind: "pinned" | "chats";
      label: string;
      total: number;
      conversations: Array<{ id: string }>;
      next_cursor: string | null;
    }>;
    limit: number;
  }).groups;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-sidebar-"));
  process.env.MANDIBLE_CONVERSATION_CACHE_DB = path.join(tempDir, "search.db");
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
  setDb(db);
});

afterEach(() => {
  getConversationSearchCache(db).close();
  db.close();
  delete process.env.MANDIBLE_CONVERSATION_CACHE_DB;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation sidebar projection", () => {
  it("puts every non-pinned row in Chats and pages Pinned and Chats independently", async () => {
    insertConversation({ id: "pinned-01", starred: true, cwd: "/Users/me/Main/repo-a" });
    insertConversation({ id: "pinned-02", starred: true, projectPath: "-Users-me-Main-repo-a" });
    insertConversation({ id: "pinned-03", starred: true });
    insertConversation({ id: "repo-03", cwd: "/Users/me/Main/repo-a/packages/three" });
    insertConversation({ id: "repo-01", projectPath: "-Users-me-Main-repo-a" });
    insertConversation({ id: "repo-02", projectPath: "/Users/me/Main/repo-a/two" });
    insertConversation({ id: "fallback", projectPath: "/opt/Fallback" });
    insertConversation({ id: "chat-null" });
    insertConversation({
      id: "chat-archive",
      cwd: "/Users/me/Documents/Codex/2026-08-18/archive.jsonl",
    });
    db.exec("DROP TABLE work_repos");

    const router = new Router();
    registerConversationRoutes(router);
    const initial = await router.invoke({ method: "GET", url: "/api/conversations/sidebar?limit=2" });

    expect(initial.status).toBe(200);
    expect((initial.body as { limit: number }).limit).toBe(2);
    const groups = groupsOf(initial);
    expect(groups.map((group) => [group.kind, group.label, group.total])).toEqual([
      ["pinned", "Pinned", 3],
      ["chats", "Chats", 6],
    ]);
    expect(groups.some((group) => (group.kind as string) === "project")).toBe(false);
    expect(groups.every((group) => group.conversations.length <= 2)).toBe(true);
    const chatsGroup = groups.find((group) => group.kind === "chats")!;
    const pinnedGroup = groups.find((group) => group.kind === "pinned")!;
    expect(chatsGroup.conversations.map((row) => row.id)).toEqual(["chat-archive", "chat-null"]);
    expect(chatsGroup.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "chat-archive", cwd: "/Users/me/Documents/Codex/2026-08-18/archive.jsonl" }),
    ]));
    expect(chatsGroup.next_cursor).toEqual(expect.any(String));
    expect(pinnedGroup.next_cursor).toEqual(expect.any(String));

    const chatsFollow = await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=2&group_key=chats&cursor=${encodeURIComponent(chatsGroup.next_cursor!)}`,
    });
    expect(groupsOf(chatsFollow)).toEqual([
      expect.objectContaining({
        key: "chats",
        total: 6,
        conversations: [
          expect.objectContaining({ id: "fallback", project_path: "/opt/Fallback" }),
          expect.objectContaining({ id: "repo-01", project_path: "-Users-me-Main-repo-a" }),
        ],
      }),
    ]);

    const pinnedStillInitial = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=2&group_key=pinned",
    });
    expect(groupsOf(pinnedStillInitial)[0].conversations.map((row) => row.id))
      .toEqual(pinnedGroup.conversations.map((row) => row.id));

    const pinnedFollow = await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=2&group_key=pinned&cursor=${encodeURIComponent(pinnedGroup.next_cursor!)}`,
    });
    expect(groupsOf(pinnedFollow)[0]).toMatchObject({
      key: "pinned",
      total: 3,
      conversations: [expect.objectContaining({ id: "pinned-03" })],
      next_cursor: null,
    });
    const chatsStillInitial = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=2&group_key=chats",
    });
    expect(groupsOf(chatsStillInitial)[0].conversations.map((row) => row.id))
      .toEqual(chatsGroup.conversations.map((row) => row.id));
  });

  it("continues the selected total order across date and block-count ties", async () => {
    insertConversation({
      id: "date-a",
      title: "Zulu title",
      startedAt: "2026-08-18T12:00:00Z",
      blocks: 2,
      cwd: "/Users/me/Main/repo-a",
    });
    insertConversation({
      id: "date-b",
      title: "Alpha title",
      startedAt: "2026-08-18T12:00:00Z",
      blocks: 2,
      cwd: "/Users/me/Main/repo-a",
    });
    insertConversation({
      id: "older-high",
      startedAt: "2026-08-18T11:00:00Z",
      blocks: 5,
      cwd: "/Users/me/Main/repo-a",
    });
    const router = new Router();
    registerConversationRoutes(router);

    const initialDate = groupsOf(await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=1",
    }))[0];
    const nextDate = groupsOf(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=1&group_key=${encodeURIComponent(initialDate.key)}&cursor=${encodeURIComponent(initialDate.next_cursor!)}`,
    }))[0];
    expect([...initialDate.conversations, ...nextDate.conversations].map((row) => row.id))
      .toEqual(["date-a", "date-b"]);

    const initialBlocks = groupsOf(await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=2&sort=block_count",
    }))[0];
    const nextBlocks = groupsOf(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=2&sort=block_count&group_key=${encodeURIComponent(initialBlocks.key)}&cursor=${encodeURIComponent(initialBlocks.next_cursor!)}`,
    }))[0];
    expect([...initialBlocks.conversations, ...nextBlocks.conversations].map((row) => row.id))
      .toEqual(["older-high", "date-a", "date-b"]);
  });

  it("preserves filters, exact full-text authority, subagent exclusion, and both sorts", async () => {
    insertConversation({
      id: "alpha-high",
      title: "Needle high",
      startedAt: "2026-08-18T10:00:00Z",
      blocks: 8,
      cwd: "/Users/me/Main/repo-a",
    });
    insertConversation({
      id: "alpha-low",
      title: "Needle low",
      startedAt: "2026-08-18T12:00:00Z",
      blocks: 2,
      cwd: "/Users/me/Main/repo-a",
    });
    insertConversation({
      id: "alpha-star",
      title: "Needle starred",
      blocks: 5,
      starred: true,
      cwd: "/Users/me/Main/repo-a",
    });
    insertConversation({
      id: "claude-only",
      source: "claude_code",
      startedAt: "2026-08-18T08:00:00Z",
      cwd: "/Users/me/Main/repo-a",
    });
    insertConversation({
      id: "subagent",
      title: "You are a subagent for testing",
      blocks: 9,
      projectPath: "subagents",
      sourcePath: "/tmp/subagents/subagent.jsonl",
    });
    insertConversation({
      id: "body-only",
      title: "Unrelated title",
      startedAt: "2026-08-18T09:00:00Z",
      blocks: 3,
      cwd: "/Users/me/Main/repo-a",
    });
    db.prepare(`INSERT INTO conversation_blocks
      (id, conversation_id, type, role, content, compressed, position, metadata_json)
      VALUES ('body-block', 'body-only', 'assistant_message', 'assistant',
              'A structural body needle', 0, 0, '{}')`).run();

    const router = new Router();
    registerConversationRoutes(router);

    const byDate = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?exclude_subagents=true&group_key="
        + encodeURIComponent(groupsOf(await router.invoke({ method: "GET", url: "/api/conversations/sidebar" }))
          .find((group) => group.kind === "chats")!.key),
    });
    expect(groupsOf(byDate)[0].conversations.slice(0, 2).map((row) => row.id))
      .toEqual(["alpha-low", "alpha-high"]);

    const byBlocks = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?sort=block_count&exclude_subagents=true",
    });
    const blockChats = groupsOf(byBlocks).find((group) => group.kind === "chats")!;
    expect(blockChats.conversations.slice(0, 3).map((row) => row.id))
      .toEqual(["alpha-high", "body-only", "alpha-low"]);
    expect(groupsOf(byBlocks).find((group) => group.kind === "pinned")?.conversations.map((row) => row.id))
      .toEqual(["alpha-star"]);
    expect(groupsOf(byBlocks).flatMap((group) => group.conversations).map((row) => row.id))
      .not.toContain("subagent");

    const filtered = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?source=codex&starred=false&search=Needle&min_blocks=5&exclude_subagents=true",
    });
    expect(groupsOf(filtered)).toEqual([
      expect.objectContaining({
        kind: "chats",
        label: "Chats",
        total: 1,
        conversations: [expect.objectContaining({ id: "alpha-high" })],
      }),
    ]);

    const fullText = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?search=structural%20body%20needle&full_text=true",
    });
    expect(groupsOf(fullText)).toEqual([
      expect.objectContaining({
        label: "Chats",
        total: 1,
        conversations: [expect.objectContaining({ id: "body-only" })],
      }),
    ]);

    const legacy = await router.invoke({ method: "GET", url: "/api/conversations?limit=1" });
    expect(legacy.body).toMatchObject({ conversations: [expect.any(Object)], limit: 1, page: 1 });
  });

  it("rejects cursors that are missing a group or reused with different filters", async () => {
    insertConversation({ id: "chat-1" });
    insertConversation({ id: "chat-2" });
    const router = new Router();
    registerConversationRoutes(router);
    const initial = await router.invoke({ method: "GET", url: "/api/conversations/sidebar?limit=1" });
    const cursor = groupsOf(initial)[0].next_cursor!;

    expect(router.resolveFileRpcPolicy("GET", "/api/conversations/sidebar")).toBe(true);
    expect((await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=999",
    })).body).toMatchObject({ limit: 100 });

    expect(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?cursor=${encodeURIComponent(cursor)}`,
    })).toMatchObject({ status: 400 });
    expect(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=1&group_key=chats&source=codex&cursor=${encodeURIComponent(cursor)}`,
    })).toMatchObject({ status: 400 });
  });
});
