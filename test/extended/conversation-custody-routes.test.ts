import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientAuthenticator } from "../../src/client-auth/authenticator.js";
import { ConversationCustodyStore } from "../../src/conversations/custody-store.js";
import { ConversationSourceStore } from "../../src/conversations/source-store.js";
import { migrate, openDb, setDb, type Db } from "../../src/db.js";
import { registerConversationCustodyRoutes } from "../../src/routes/conversation-custody.js";
import { Router } from "../../src/server.js";
import { setupOperator } from "../../src/users/store.js";

describe("conversation custody routes", () => {
  let root: string;
  let db: Db;
  let token: string;
  let router: Router;
  let sourcePath: string;
  let sourceStore: ConversationSourceStore;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-custody-routes-"));
    db = openDb(path.join(root, "mandible.db"));
    migrate(db);
    setDb(db);
    const auth = new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") });
    token = auth.mintApiToken(setupOperator(db, { display_name: "Operator" }).id).token;
    sourcePath = path.join(root, "home", ".claude", "projects", "project", "session.jsonl");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, `${JSON.stringify({ type: "user", sessionId: "session", message: { content: "raw secret bytes" } })}\n`);
    db.prepare(`INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at, session_id,
      starred, tags, notes, created_at, updated_at
    ) VALUES (?, 'claude_code', ?, 'hash', 1, 'Title', '2026-08-17', 'session', 1, '["keep"]', 'note', '2026-08-17', '2026-08-17')`)
      .run("conv-route", sourcePath);
    sourceStore = new ConversationSourceStore(db);
    await sourceStore.recordConversation({
      conversationId: "conv-route",
      provider: "claude_code",
      nativeSessionId: "session",
      filePath: sourcePath,
      parserFormat: "provider-jsonl",
      parserVersion: "1",
      normalizationVersion: "1",
      redactionEpoch: 0,
    });
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
    expect(captured.body).toMatchObject({
      status: { state: "sealed" },
      manifest: {
        provider: "claude_code",
        source_version_id: sourceStore.resolveConversation("conv-route")?.currentVersionId,
        source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(captured.body)).not.toContain("raw secret bytes");
    expect(JSON.stringify((captured.body as { manifest: unknown }).manifest)).not.toContain(path.join(root, "home"));

    const status = await router.invoke({ method: "GET", url: "/api/conversations/conv-route/custody" });
    expect(status).toMatchObject({ status: 200, body: { status: { conversation_id: "conv-route", state: "sealed" } } });
    expect(JSON.stringify(status.body)).not.toContain("raw secret bytes");
  });

  it("returns source_changed when selected transcript bytes no longer match the sealed version", async () => {
    fs.appendFileSync(sourcePath, "drift\n");

    const response = await router.invoke({
      method: "POST",
      url: "/api/conversations/conv-route/custody/capture",
      credential: token,
      body: {},
    });

    expect(response).toMatchObject({ status: 409, body: { code: "source_changed" } });
    const current = sourceStore.resolveConversation("conv-route")!;
    expect(sourceStore.resolveVersion(current.currentVersionId!)?.custodyState).toBe("provider");
  });

  it("re-resolves the current version and refuses to attach custody after drift", async () => {
    const original = sourceStore.resolveConversation("conv-route")!;
    const originalVersion = sourceStore.resolveVersion(original.currentVersionId!)!;
    const driftVersionId = "cver_drift_current";
    db.prepare(`
      INSERT INTO conversation_source_versions (
        id, source_id, content_sha256, byte_length, file_mtime_ms, generation,
        parser_format, parser_version, normalization_version, redaction_epoch,
        availability, custody_state, created_at
      ) VALUES (?, ?, ?, ?, ?, 'sealed_sha256', ?, ?, ?, ?, 'available', 'provider', ?)
    `).run(
      driftVersionId, original.sourceId, "b".repeat(64), originalVersion.byteLength,
      originalVersion.fileMtimeMs, originalVersion.parserFormat, originalVersion.parserVersion,
      originalVersion.normalizationVersion, originalVersion.redactionEpoch, Date.now(),
    );
    let changed = false;
    router = new Router({ clientAuth: new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") }) });
    registerConversationCustodyRoutes(router, db, new ConversationCustodyStore(path.join(root, "custody-drift"), {
      afterSourceRead(readPath) {
        if (!changed && readPath === sourcePath) {
          changed = true;
          db.prepare("UPDATE conversation_sources SET current_version_id = ? WHERE id = ?")
            .run(driftVersionId, original.sourceId);
        }
      },
    }));

    const response = await router.invoke({
      method: "POST",
      url: "/api/conversations/conv-route/custody/capture",
      credential: token,
      body: {},
    });

    expect(response).toMatchObject({ status: 409, body: { code: "source_version_mismatch" } });
    expect(sourceStore.resolveVersion(originalVersion.id)?.custodyState).toBe("provider");
    expect(sourceStore.resolveVersion(driftVersionId)?.custodyState).toBe("provider");
  });

  it("never attaches capture evidence to a legacy-hash version", async () => {
    const current = sourceStore.resolveConversation("conv-route")!;
    db.prepare("UPDATE conversation_source_versions SET generation = 'legacy_hash' WHERE id = ?")
      .run(current.currentVersionId);

    const response = await router.invoke({
      method: "POST",
      url: "/api/conversations/conv-route/custody/capture",
      credential: token,
      body: {},
    });

    expect(response).toMatchObject({ status: 409, body: { code: "source_version_mismatch" } });
    expect(sourceStore.resolveVersion(current.currentVersionId!)?.custodyState).toBe("provider");
  });
});
