import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";

let tempDir = "";
let db: Db;
let token = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-metadata-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
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
  it("returns parsed tags, filters exactly, and atomically applies canonical metadata updates", async () => {
    const router = new Router({ clientAuth: new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "auth") }) });
    registerConversationRoutes(router);

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
});
