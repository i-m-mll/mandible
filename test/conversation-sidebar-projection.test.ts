import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConversationSearchCache } from "../src/conversations/search-cache.js";
import { ConversationSpawnService } from "../src/conversation-spawn/service.js";
import { CONVERSATION_SPAWN_REQUEST_SCHEMA } from "../src/conversation-spawn/types.js";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
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
  it("projects one ready empty conversation row while retaining its native spawn receipt", async () => {
    const conversationId = "10000000-0000-4000-8000-000000000001";
    const spawn = new ConversationSpawnService(db, () => 1_000);
    expect(spawn.reserve({
      schema: CONVERSATION_SPAWN_REQUEST_SCHEMA,
      idempotency_key: conversationId,
      provider: "codex",
      placement: { kind: "projectless" },
    })).toMatchObject({ ok: true });
    expect(spawn.begin(conversationId)).toMatchObject({ ok: true });
    expect(spawn.assignRuntime(conversationId, 1, "codex-controller-1")).toMatchObject({ ok: true });
    spawn.materializeConversationShell(conversationId, 1, "/workspace", "codex-thread-1");
    expect(spawn.ready(conversationId, 1, "codex-controller-1", "codex-thread-1", {
      kind: "native-conversation-controller-ready",
    })).toMatchObject({ ok: true });

    const router = new Router();
    registerConversationRoutes(router);
    const response = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=20&min_blocks=1",
    });

    expect(response.status).toBe(200);
    const rows = groupsOf(response).flatMap((group) => group.conversations);
    expect(rows).toEqual([
      expect.objectContaining({
        id: conversationId,
        block_count: 0,
        spawn: expect.objectContaining({
          state: "ready",
          native_session_id: "codex-controller-1",
          provider_session_id: "codex-thread-1",
        }),
      }),
    ]);
  });

  it("projects already-indexed provider rows into requested canonical groups without ingestion", async () => {
    const alpha = registerProject("alpha", "Alpha Project", "/workspace/alpha");
    const empty = registerProject("empty", "Empty Project", "/workspace/empty");
    insertConversation({ id: "codex-alpha", source: "codex", cwd: "/workspace/alpha/packages/app" });
    insertConversation({
      id: "claude-alpha",
      source: "claude_code",
      cwd: "-workspace-alpha",
      projectPath: "/workspace/alpha",
    });
    insertConversation({ id: "gemini-alpha", source: "gemini", cwd: "/workspace/alpha" });
    insertConversation({ id: "pinned-alpha", starred: true, cwd: "/workspace/alpha" });
    insertConversation({
      id: "opaque-legacy",
      source: "claude_code",
      projectPath: "-workspace-alpha",
      sourcePath: "/workspace/alpha/provider-custody.jsonl",
    });

    const router = new Router();
    registerConversationRoutes(router);
    const response = await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?project_ids=${alpha.id},${empty.id}&limit=20`,
    });

    expect(response.status).toBe(200);
    const groups = groupsOf(response);
    expect(groups.map((group) => [group.kind, group.label, group.total])).toEqual([
      ["pinned", "Pinned", 1],
      ["project", "Alpha Project", 3],
      ["project", "Empty Project", 0],
      ["chats", "Chats", 1],
    ]);
    const alphaGroup = groups.find((group) => group.project_id === alpha.id)!;
    expect(alphaGroup).toMatchObject({
      project_key: "alpha",
      key: expect.stringMatching(/^project-/),
    });
    expect(alphaGroup.conversations.map((row) => row.id).sort()).toEqual([
      "claude-alpha",
      "codex-alpha",
      "gemini-alpha",
    ]);
    expect(alphaGroup.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonical_project_id: alpha.id,
        canonical_project_key: "alpha",
      }),
    ]));
    expect(groups.find((group) => group.kind === "pinned")?.conversations).toEqual([
      expect.objectContaining({
        id: "pinned-alpha",
        canonical_project_id: alpha.id,
        canonical_project_key: "alpha",
      }),
    ]);
    expect(groups.find((group) => group.kind === "chats")?.conversations).toEqual([
      expect.objectContaining({
        id: "opaque-legacy",
        canonical_project_id: null,
        canonical_project_key: null,
      }),
    ]);
    expect(groups.some((group) => group.label === "-workspace-alpha")).toBe(false);
  });

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

  it("projects preview-local pins into the bounded Pinned group without mutating the row", async () => {
    insertConversation({ id: "local-pin", starred: false });
    insertConversation({ id: "ordinary", starred: false });
    const router = new Router();
    registerConversationRoutes(router);

    const result = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=1&pinned_ids=local-pin",
    });

    expect(groupsOf(result).find((group) => group.kind === "pinned")?.conversations).toEqual([
      expect.objectContaining({ id: "local-pin", starred: false }),
    ]);
    expect(db.prepare("SELECT starred FROM conversations WHERE id = 'local-pin'").get()).toEqual({ starred: 0 });
  });

  it("treats an explicit empty pin order as authoritative and keeps legacy stars in Chats", async () => {
    insertConversation({ id: "legacy-star", starred: true });
    const router = new Router();
    registerConversationRoutes(router);

    const result = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=20&pinned_ids=",
    });

    expect(groupsOf(result).find((group) => group.kind === "pinned")).toBeUndefined();
    expect(groupsOf(result).find((group) => group.kind === "chats")?.conversations)
      .toEqual([expect.objectContaining({ id: "legacy-star", starred: true })]);
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
        conversations: [expect.objectContaining({
          id: "body-only",
          search_target: { block: "body-block" },
        })],
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
    expect(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?limit=1&pinned_ids=&group_key=chats&cursor=${encodeURIComponent(cursor)}`,
    })).toMatchObject({ status: 400 });
  });

  it("pages Pinned, a canonical project, and Chats independently and binds cursors to the project set", async () => {
    const alpha = registerProject("alpha", "Alpha", "/workspace/alpha");
    const beta = registerProject("beta", "Beta", "/workspace/beta");
    insertConversation({ id: "pin-new", starred: true, cwd: "/workspace/alpha", startedAt: "2026-08-18T14:00:00Z" });
    insertConversation({ id: "pin-old", starred: true, cwd: "/workspace/alpha", startedAt: "2026-08-18T13:00:00Z" });
    insertConversation({ id: "alpha-high", cwd: "/workspace/alpha", blocks: 9 });
    insertConversation({ id: "alpha-low", cwd: "/workspace/alpha", blocks: 3 });
    insertConversation({ id: "beta-high", cwd: "/workspace/beta", blocks: 8 });
    insertConversation({ id: "unscoped-low", blocks: 2 });

    const router = new Router();
    registerConversationRoutes(router);
    const baseUrl = `/api/conversations/sidebar?project_ids=${alpha.id}&sort=block_count&limit=1`;
    const initialGroups = groupsOf(await router.invoke({ method: "GET", url: baseUrl }));
    expect(initialGroups.map((group) => [group.kind, group.total])).toEqual([
      ["pinned", 2],
      ["project", 2],
      ["chats", 2],
    ]);

    for (const group of initialGroups) {
      expect(group.next_cursor).toEqual(expect.any(String));
      const follow = groupsOf(await router.invoke({
        method: "GET",
        url: `${baseUrl}&group_key=${encodeURIComponent(group.key)}&cursor=${encodeURIComponent(group.next_cursor!)}`,
      }));
      expect(follow).toHaveLength(1);
      expect(follow[0]).toMatchObject({ key: group.key, total: 2, next_cursor: null });
      expect(follow[0].conversations[0].id).not.toBe(group.conversations[0].id);
    }

    const projectGroup = initialGroups.find((group) => group.kind === "project")!;
    expect(await router.invoke({
      method: "GET",
      url: `/api/conversations/sidebar?project_ids=${alpha.id},${beta.id}&sort=block_count&limit=1`
        + `&group_key=${encodeURIComponent(projectGroup.key)}`
        + `&cursor=${encodeURIComponent(projectGroup.next_cursor!)}`,
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
