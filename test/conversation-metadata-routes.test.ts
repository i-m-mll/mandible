import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setDb, type Db } from "../src/db.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { ConversationSpawnService } from "../src/conversation-spawn/service.js";
import { CONVERSATION_SPAWN_REQUEST_SCHEMA } from "../src/conversation-spawn/types.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;
let token = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-metadata-"));
  db = migratedMemoryDb();
  setDb(db);
  const authenticator = new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "auth") });
  token = authenticator.mintApiToken(setupOperator(db, { display_name: "Operator" }).id).token;
  db.prepare(`INSERT INTO conversations (
    id, source, source_path, source_hash, source_mtime, title, started_at, session_id,
    starred, tags, notes, created_at, updated_at
  ) VALUES (?, ?, ?, 'hash', 1, ?, '2026-08-16', ?, 0, ?, ?, '2026-08-16', '2026-08-16')`)
    .run("conv-1", "codex", "/tmp/conv-1", "Provider title", "thread-1", '["keep"]', "first note");
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation metadata routes", () => {
  it("resolves Chat canonical, short and session aliases without choosing an ambiguous conversation", async () => {
    const router = new Router({ clientAuth: new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "auth") }) });
    registerConversationRoutes(router, inlineLedgerReader());
    const canonical = "abcdef01-0000-4000-8000-000000000001";
    db.prepare("UPDATE conversations SET id = ?, session_id = ? WHERE id = 'conv-1'").run(canonical, "provider-session-1");
    db.prepare(`INSERT INTO sessions (id, app, status, conversation_id, created_at)
      VALUES ('mandible-session-1', 'codex', 'ended', 'provider-session-1', '2026-08-16')`).run();
    db.prepare(`INSERT INTO console_sessions (id, label, command, status, provider_session_id, mandible_session_id, created_at, updated_at)
      VALUES ('console-session-1', 'Chat', 'codex', 'stopped', 'provider-session-1', 'mandible-session-1', 1, 1)`).run();
    const resolve = async (kind: string, ref: string) => (await router.invoke({
      method: "GET", url: `/api/conversations/resolve-target?${kind}=${encodeURIComponent(ref)}`,
    })).body;
    for (const ref of [canonical, "abcdef01", "provider-session-1"]) {
      expect(await resolve("conversation", ref)).toEqual({ status: "resolved", selection: { type: "conversation", id: canonical } });
    }
    for (const ref of ["provider-session-1", "provider-session", "mandible-session-1", "mandible-session", "console-session-1", "console-session"]) {
      expect(await resolve("session", ref)).toEqual({ status: "resolved", selection: { type: "conversation", id: canonical } });
    }
    expect(await resolve("session", "no-such-session")).toEqual({ status: "not_found" });
    expect(await resolve("conversation", "no-such-conversation")).toEqual({ status: "not_found" });
    db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title,
      session_id, started_at, created_at, updated_at) VALUES (?, 'codex', '/tmp/second', 'hash2', 1, 'Second', ?, '2026-08-16', '2026-08-16', '2026-08-16')`)
      .run("abcdef01-0000-4000-8000-000000000002", "provider-session-1");
    expect(await resolve("session", "mandible-session-1")).toEqual({ status: "ambiguous" });
    expect(await resolve("conversation", "abcdef01")).toEqual({ status: "ambiguous" });
    expect(await resolve("conversation", canonical)).toEqual({ status: "resolved", selection: { type: "conversation", id: canonical } });
    db.prepare("UPDATE conversations SET session_id = 'provider-session-2' WHERE source_path = '/tmp/second'").run();
    expect(await resolve("session", "provider-session")).toEqual({ status: "ambiguous" });
  });

  it("returns parsed tags, filters exactly, and atomically applies canonical metadata updates", async () => {
    const router = new Router({ clientAuth: new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "auth") }) });
    registerConversationRoutes(router, inlineLedgerReader());

    const listed = await router.invoke({ method: "GET", url: "/api/conversations?tag=keep" });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ conversations: [{ id: "conv-1", title: "Provider title", tags: ["keep"] }] });
    expect((listed.body as { conversations: Array<Record<string, unknown>> }).conversations[0]).not.toHaveProperty("label");
    const caseMismatch = await router.invoke({ method: "GET", url: "/api/conversations?tag=Keep" });
    expect(caseMismatch.body).toMatchObject({ conversations: [], total: 0 });

    const shown = await router.invoke({ method: "GET", url: "/api/conversations/conv-1" });
    expect(shown.body).toMatchObject({ conversation: { id: "conv-1", tags: ["keep"] } });
    const searched = await router.invoke({ method: "GET", url: "/api/conversations/search?q=Provider&title=true" });
    expect(searched.body).toMatchObject({ results: [{ conversation: { id: "conv-1", tags: ["keep"] } }] });
    const exported = await router.invoke({
      method: "POST",
      url: "/api/conversations/conv-1/export",
      credential: token,
      body: { format: "json" },
    });
    expect(JSON.parse((exported.body as { content: string }).content)).toMatchObject({
      conversation: { id: "conv-1", tags: ["keep"] },
    });

    const updated = await router.invoke({
      method: "PATCH",
      url: "/api/conversations/conv-1",
      credential: token,
      body: {
        starred: true,
        tags_add: [" new ", "keep", "New"],
        tags_remove: ["keep"],
        notes_append: " second note ",
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: "conv-1",
      title: "Provider title",
      starred: true,
      tags: ["new", "New"],
      notes: "first note\n\nsecond note",
    });
    expect((db.prepare("SELECT tags, notes FROM conversations WHERE id = 'conv-1'").get()))
      .toEqual({ tags: '["new","New"]', notes: "first note\n\nsecond note" });

    const invalid = await router.invoke({
      method: "PATCH",
      url: "/api/conversations/conv-1",
      credential: token,
      body: { tags_add: "not-an-array" },
    });
    expect(invalid.status).toBe(400);
  });

  it("persists one archive marker for materialized conversations and accepted reservations", async () => {
    const reservationId = "10000000-0000-4000-8000-000000000001";
    const spawns = new ConversationSpawnService(db, () => 1_000);
    expect(spawns.reserve({
      schema: CONVERSATION_SPAWN_REQUEST_SCHEMA,
      idempotency_key: reservationId,
      provider: "codex",
      placement: { kind: "projectless" },
    })).toMatchObject({ ok: true });
    const router = new Router({ clientAuth: new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "auth") }) });
    registerConversationRoutes(router, inlineLedgerReader());

    for (const id of ["conv-1", reservationId]) {
      const archived = await router.invoke({
        method: "PATCH",
        url: `/api/conversations/${id}`,
        credential: token,
        ambient_identity: { provider: "codex", provider_session_id: "archive-author" },
        body: { archived: true },
      });
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ id, archived_at: expect.any(Number) });
    }

    expect(db.prepare("SELECT conversation_id FROM conversation_archive_states ORDER BY conversation_id").all())
      .toEqual([{ conversation_id: reservationId }, { conversation_id: "conv-1" }]);
    const active = await router.invoke({ method: "GET", url: "/api/conversations/sidebar?lifecycle=active&limit=20" });
    expect((active.body as { groups: Array<{ conversations: Array<{ id: string }> }> }).groups
      .flatMap((group) => group.conversations.map((row) => row.id))).toEqual([]);
    const archived = await router.invoke({ method: "GET", url: "/api/conversations/sidebar?lifecycle=archived&limit=20" });
    expect((archived.body as { groups: Array<{ conversations: Array<{ id: string }> }> }).groups
      .flatMap((group) => group.conversations.map((row) => row.id)).sort())
      .toEqual(["conv-1", reservationId].sort());

    const restored = await router.invoke({
      method: "PATCH",
      url: `/api/conversations/${reservationId}`,
      credential: token,
      body: { archived: false },
    });
    const archiveHistory = db.prepare("SELECT event_type,payload_json FROM ledger_events WHERE entity_type='conversation_metadata' AND entity_id=? ORDER BY rowid").all(reservationId) as Array<{event_type:string;payload_json:string}>;
    expect(archiveHistory.map(row=>({event_type:row.event_type,origin:JSON.parse(row.payload_json).request_origin}))).toEqual([
      {event_type:"conversation_metadata.created",origin:{provider:"codex",provider_session_id:"archive-author"}},
      {event_type:"conversation_metadata.deleted",origin:null},
    ]);
    expect(restored.body).toEqual({ id: reservationId, archived_at: null });
    expect(db.prepare("SELECT conversation_id FROM conversation_archive_states WHERE conversation_id = ?").get(reservationId))
      .toBeUndefined();
  });
});
