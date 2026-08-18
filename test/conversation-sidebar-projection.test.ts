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
      kind: "pinned" | "project" | "chats";
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
  db.prepare(`INSERT INTO work_repos
    (id, root, name, default_branch, dir_exists, excluded, created_at, updated_at)
    VALUES ('repo-a', '/Users/me/Main/repo-a', 'Repo A', 'main', 1, 0, datetime('now'), datetime('now'))`)
    .run();
});

afterEach(() => {
  getConversationSearchCache(db).close();
  db.close();
  delete process.env.MANDIBLE_CONVERSATION_CACHE_DB;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation sidebar projection", () => {
  it("caps every logical group independently and advances only the requested opaque group", async () => {
    insertConversation({ id: "pinned", starred: true, cwd: "/Users/me/Main/repo-a" });
    insertConversation({ id: "repo-03", cwd: "/Users/me/Main/repo-a/packages/three" });
    insertConversation({ id: "repo-01", projectPath: "-Users-me-Main-repo-a" });
    insertConversation({ id: "repo-02", projectPath: "/Users/me/Main/repo-a/two" });
    insertConversation({ id: "fallback", projectPath: "/opt/Fallback" });
    insertConversation({ id: "chat-null" });
    insertConversation({
      id: "chat-archive",
      cwd: "/Users/me/Documents/Codex/2026-08-18/archive.jsonl",
    });

    const router = new Router();
    registerConversationRoutes(router);
    const initial = await router.invoke({ method: "GET", url: "/api/conversations/sidebar?limit=2" });

    expect(initial.status).toBe(200);
    expect((initial.body as { limit: number }).limit).toBe(2);
    const groups = groupsOf(initial);
    expect(groups.map((group) => [group.kind, group.label, group.total])).toEqual([
      ["pinned", "Pinned", 1],
      ["project", "Fallback", 1],
      ["project", "Repo A", 3],
      ["chats", "Chats", 2],
    ]);
    expect(groups.every((group) => group.conversations.length <= 2)).toBe(true);
    expect(groups.find((group) => group.label === "Repo A")?.conversations.map((row) => row.id))
      .toEqual(["repo-01", "repo-02"]);
    expect(groups.find((group) => group.label === "Repo A")?.conversations).not.toContainEqual(
      expect.objectContaining({ id: "pinned" }),
    );

    const repoGroup = groups.find((group) => group.label === "Repo A")!;
    expect(repoGroup.key).toMatch(/^project:[A-Za-z0-9_-]+$/);
    expect(repoGroup.next_cursor).toEqual(expect.any(String));
    const follow = await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=2&group_key=${encodeURIComponent(repoGroup.key)}&cursor=${encodeURIComponent(repoGroup.next_cursor!)}`,
    });
    expect(groupsOf(follow)).toEqual([
      expect.objectContaining({
        key: repoGroup.key,
        total: 3,
        conversations: [expect.objectContaining({ id: "repo-03" })],
        next_cursor: null,
      }),
    ]);
    const seen = [...repoGroup.conversations, ...groupsOf(follow)[0].conversations].map((row) => row.id);
    expect(seen).toEqual(["repo-01", "repo-02", "repo-03"]);
    expect(new Set(seen).size).toBe(3);

    const siblingStillInitial = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=2&group_key=chats",
    });
    expect(groupsOf(siblingStillInitial)[0].conversations.map((row) => row.id))
      .toEqual(groups.find((group) => group.kind === "chats")!.conversations.map((row) => row.id));
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
      url: "/api/conversations/sidebar?group_key="
        + encodeURIComponent(groupsOf(await router.invoke({ method: "GET", url: "/api/conversations/sidebar" }))
          .find((group) => group.label === "Repo A")!.key),
    });
    expect(groupsOf(byDate)[0].conversations.slice(0, 2).map((row) => row.id))
      .toEqual(["alpha-low", "alpha-high"]);

    const byBlocks = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?sort=block_count&exclude_subagents=true",
    });
    const blockProject = groupsOf(byBlocks).find((group) => group.label === "Repo A")!;
    expect(blockProject.conversations.slice(0, 3).map((row) => row.id))
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
        kind: "project",
        label: "Repo A",
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
        label: "Repo A",
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
