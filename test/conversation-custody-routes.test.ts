import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { ConversationCustodyStore } from "../src/conversations/custody-store.js";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { registerConversationCustodyRoutes } from "../src/routes/conversation-custody.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";

describe("conversation custody routes", () => {
  let root: string;
  let db: Db;
  let token: string;
  let router: Router;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-custody-routes-"));
    db = openDb(path.join(root, "mandible.db"));
    migrate(db);
    setDb(db);
    const auth = new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") });
    token = auth.mintApiToken(setupOperator(db, { display_name: "Operator" }).id).token;
    const source = path.join(root, "home", ".claude", "projects", "project", "session.jsonl");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, `${JSON.stringify({ type: "user", sessionId: "session", message: { content: "raw secret bytes" } })}\n`);
    db.prepare(`INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at, session_id,
      starred, tags, notes, created_at, updated_at
    ) VALUES (?, 'claude_code', ?, 'hash', 1, 'Title', '2026-08-17', 'session', 1, '["keep"]', 'note', '2026-08-17', '2026-08-17')`)
      .run("conv-route", source);
    router = new Router({ clientAuth: auth });
    registerConversationCustodyRoutes(router, db, new ConversationCustodyStore(path.join(root, "custody")));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("requires the operator for capture and exposes status without raw bytes", async () => {
    const denied = await router.invoke({ method: "POST", url: "/api/conversations/conv-route/custody/capture", body: {} });
    expect(denied.status).toBe(401);
    const captured = await router.invoke({ method: "POST", url: "/api/conversations/conv-route/custody/capture", credential: token, body: {} });
    expect(captured.status).toBe(201);
    expect(captured.body).toMatchObject({ status: { state: "sealed" }, manifest: { provider: "claude_code" } });
    expect(JSON.stringify(captured.body)).not.toContain("raw secret bytes");
    expect(JSON.stringify((captured.body as { manifest: unknown }).manifest)).not.toContain(path.join(root, "home"));

    const status = await router.invoke({ method: "GET", url: "/api/conversations/conv-route/custody" });
    expect(status).toMatchObject({ status: 200, body: { status: { conversation_id: "conv-route", state: "sealed" } } });
    expect(JSON.stringify(status.body)).not.toContain("raw secret bytes");
  });
});

