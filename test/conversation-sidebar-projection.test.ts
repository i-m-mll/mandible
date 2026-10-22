import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConversationSearchCache } from "../src/conversations/search-cache.js";
import { setDb, type Db } from "../src/db.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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
      project_id?: string;
      project_key?: string;
      total: number;
      conversations: Array<{
        id: string;
        canonical_project_id: string | null;
        canonical_project_key: string | null;
        [key: string]: unknown;
      }>;
      next_cursor: string | null;
    }>;
    limit: number;
  }).groups;
}

function registerProject(key: string, label: string, root: string) {
  const project = addProject(db, { project_key: key, display_name: label });
  addOrUpdateCheckout(db, project.id, { root });
  return project;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-sidebar-"));
  process.env.MANDIBLE_CONVERSATION_CACHE_DB = path.join(tempDir, "search.db");
  db = migratedMemoryDb();
  setDb(db);
});

afterEach(() => {
  getConversationSearchCache(db).close();
  db.close();
  delete process.env.MANDIBLE_CONVERSATION_CACHE_DB;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation sidebar projection", () => {

  it("fails closed when equally specific stored roots resolve to different projects", async () => {
    const alpha = registerProject("alpha", "Alpha", "/workspace/alpha");
    registerProject("beta", "Beta", "/workspace/beta");
    insertConversation({
      id: "ambiguous",
      cwd: "/workspace/alpha/package",
      projectPath: "/workspace/beta/package",
    });

    const router = new Router();
    registerConversationRoutes(router);
    const groups = groupsOf(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?project_ids=${alpha.id}`,
    }));

    expect(groups.find((group) => group.kind === "project")).toMatchObject({ total: 0 });
    expect(groups.find((group) => group.kind === "chats")?.conversations).toEqual([
      expect.objectContaining({
        id: "ambiguous",
        canonical_project_id: null,
        canonical_project_key: null,
      }),
    ]);
  });

  it("uses path boundaries and the most-specific registered checkout root", async () => {
    registerProject("parent", "Parent", "/workspace/repo");
    const nested = registerProject("nested", "Nested", "/workspace/repo/packages/nested");
    insertConversation({ id: "nested-row", cwd: "/workspace/repo/packages/nested/src" });
    insertConversation({ id: "prefix-only", cwd: "/workspace/repository" });

    const router = new Router();
    registerConversationRoutes(router);
    const groups = groupsOf(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?project_ids=${nested.id}`,
    }));

    expect(groups.find((group) => group.kind === "project")?.conversations).toEqual([
      expect.objectContaining({
        id: "nested-row",
        canonical_project_id: nested.id,
        canonical_project_key: "nested",
      }),
    ]);
    expect(groups.find((group) => group.kind === "chats")?.conversations).toEqual([
      expect.objectContaining({ id: "prefix-only", canonical_project_id: null }),
    ]);
  });

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

  it("paginates Pinned in the exact saved order instead of recent-first order", async () => {
    insertConversation({ id: "recent", startedAt: "2026-08-18T13:00:00Z" });
    insertConversation({ id: "middle", startedAt: "2026-08-18T12:00:00Z" });
    insertConversation({ id: "old", startedAt: "2026-08-18T11:00:00Z" });
    const router = new Router();
    registerConversationRoutes(router);
    const order = "old,recent,middle";

    const first = groupsOf(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=2&pinned_ids=${order}`,
    })).find((group) => group.kind === "pinned")!;
    expect(first.conversations.map((row) => row.id)).toEqual(["old", "recent"]);
    const second = groupsOf(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=2&pinned_ids=${order}&group_key=pinned&cursor=${encodeURIComponent(first.next_cursor!)}`,
    })).find((group) => group.kind === "pinned")!;
    expect(second.conversations.map((row) => row.id)).toEqual(["middle"]);
    expect(second.next_cursor).toBeNull();
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

  it("places projected conversations from their canonical star fact, not a similarly identified console session pin", async () => {
    insertConversation({
      id: "continued-starred",
      source: "claude_code",
      sourcePath: "/tmp/provider-session-starred.jsonl",
      title: "Review and take over QA successor briefing task",
      starred: true,
    });
    insertConversation({
      id: "ordinary-unstarred",
      source: "claude_code",
      sourcePath: "/tmp/provider-session-unstarred.jsonl",
      title: "Ordinary unstarred conversation",
      starred: false,
    });
    db.prepare("INSERT INTO sessions (id, app, pinned, status) VALUES (?, 'claude', 0, 'dead')")
      .run("session-continued-starred");
    db.prepare("INSERT INTO sessions (id, app, pinned, status) VALUES (?, 'claude', 1, 'dead')")
      .run("session-ordinary-unstarred");

    const router = new Router();
    registerConversationRoutes(router);
    const groups = groupsOf(await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=10",
    }));

    expect(groups.find((group) => group.kind === "pinned")?.conversations).toEqual([
      expect.objectContaining({
        id: "continued-starred",
        source: "claude_code",
        source_path: "/tmp/provider-session-starred.jsonl",
        session_id: "session-continued-starred",
        title: "Review and take over QA successor briefing task",
        starred: true,
      }),
    ]);
    expect(groups.find((group) => group.kind === "chats")?.conversations).toEqual([
      expect.objectContaining({
        id: "ordinary-unstarred",
        session_id: "session-ordinary-unstarred",
        starred: false,
      }),
    ]);
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
    expect(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=1&pinned_ids=&group_key=chats&cursor=${encodeURIComponent(cursor)}`,
    })).toMatchObject({ status: 400 });
  });

  it("rejects unknown, non-canonical, empty, and over-bounded project id requests", async () => {
    const alpha = registerProject("alpha", "Alpha", "/workspace/alpha");
    const router = new Router();
    registerConversationRoutes(router);

    expect(await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?project_ids=alpha",
    })).toMatchObject({ status: 400, body: { error: "Unknown canonical project id", project_ids: ["alpha"] } });
    expect(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?project_ids=${alpha.id},`,
    })).toMatchObject({ status: 400 });
    const tooMany = Array.from({ length: 501 }, (_, index) => `${alpha.id}-${index}`).join(",");
    expect(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?project_ids=${tooMany}`,
    })).toMatchObject({ status: 400 });
  });
});
