import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { setDb, type Db } from "../src/db.js";
import { configureIngestionWorker, ingestBatchForWorker, triggerTargetedIngest } from "../src/ingestion.js";
import { loadOrCreatePepper } from "../src/client-auth/secret-store.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "../src/client-auth/tokens.js";
import { credentialMaskFor } from "../src/credential-leak-scan.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { addCredential, createUser } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;
let previousHome: string | undefined;
let previousConfigDir: string | undefined;

const PROVIDER_TOKEN = `${API_TOKEN_PREFIX}${"T".repeat(43)}`;

function row(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

async function writeClaudeSession(): Promise<string> {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const dir = path.join(tempDir, "home", ".claude", "projects", "-tmp-project");
  await fsp.mkdir(dir, { recursive: true });
  const sessionPath = path.join(dir, `${sessionId}.jsonl`);
  await fsp.writeFile(sessionPath, [
    row({
      uuid: "u1",
      type: "user",
      timestamp: "2026-08-16T00:00:00.000Z",
      sessionId,
      cwd: "/tmp/project",
      message: { role: "user", content: "Original prompt" },
    }),
    row({
      uuid: "a1",
      parentUuid: "u1",
      type: "assistant",
      timestamp: "2026-08-16T00:00:01.000Z",
      sessionId,
      message: { role: "assistant", model: "claude-opus", content: "Answer" },
    }),
  ].join(""), "utf8");
  return sessionPath;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-claude-title-"));
  previousHome = process.env.HOME;
  previousConfigDir = process.env.MANDIBLE_CONFIG_DIR;
  process.env.HOME = path.join(tempDir, "home");
  process.env.MANDIBLE_CONFIG_DIR = path.join(tempDir, "config");
  db = migratedMemoryDb();
  setDb(db);
});

afterEach(() => {
  configureIngestionWorker(() => {}, () => {});
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousConfigDir === undefined) delete process.env.MANDIBLE_CONFIG_DIR;
  else process.env.MANDIBLE_CONFIG_DIR = previousConfigDir;
});

describe("Claude provider title ingestion", () => {
  it("preserves durable conversation metadata across a forced full re-ingest", async () => {
    const sessionPath = await writeClaudeSession();
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    db.prepare(`UPDATE conversations
      SET starred = 1, tags = '["research","KeepCase"]', notes = 'durable note'
      WHERE source_path = ?`).run(sessionPath);

    await ingestBatchForWorker([sessionPath], true);

    expect(db.prepare(
      "SELECT starred, tags, notes FROM conversations WHERE source_path = ?",
    ).get(sessionPath)).toEqual({
      starred: 1,
      tags: '["research","KeepCase"]',
      notes: "durable note",
    });
  });

  it("masks, persists, and broadcasts an appended custom-title without changing blocks", async () => {
    const sessionPath = await writeClaudeSession();
    createUser(db, { slug: "claude-code", kind: "agent", display_name: "Claude Code" });
    const credential = addCredential(db, "claude-code", {
      type: "api_token",
      fingerprint: fingerprintForToken(loadOrCreatePepper(db), PROVIDER_TOKEN),
      label: "provider title test token",
    });
    const initialMtime = new Date(1_800_000_000_000);
    await fsp.utimes(sessionPath, initialMtime, initialMtime);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    const before = db.prepare(
      "SELECT id, title, block_count FROM conversations WHERE source_path = ?",
    ).get(sessionPath) as { id: string; title: string; block_count: number };
    expect(before).toMatchObject({ title: "Original prompt", block_count: 2 });

    await fsp.appendFile(
      sessionPath,
      row({ type: "custom-title", customTitle: `Provider renamed ${PROVIDER_TOKEN}` }),
      "utf8",
    );
    const renamedMtime = new Date(1_800_000_005_000);
    await fsp.utimes(sessionPath, renamedMtime, renamedMtime);

    const events: Array<{ event: string; data: unknown }> = [];
    configureIngestionWorker(() => {}, (event, data) => events.push({ event, data }));
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    const after = db.prepare(
      "SELECT id, title, block_count FROM conversations WHERE source_path = ?",
    ).get(sessionPath) as { id: string; title: string; block_count: number };
    const maskedTitle = `Provider renamed ${credentialMaskFor(credential.id)}`;
    expect(after).toEqual({ ...before, title: maskedTitle });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?")
        .get(before.id),
    ).toMatchObject({ count: 0 });
    expect(events).toContainEqual({
      event: "conversation:updated",
      data: expect.objectContaining({
        id: before.id,
        source: "claude_code",
        title: maskedTitle,
        block_count: 2,
      }),
    });
  });

  it("replaces a continued-session fallback with an appended Claude ai-title without changing blocks", async () => {
    const sessionPath = await writeClaudeSession();
    const initialMtime = new Date(1_800_000_000_000);
    await fsp.utimes(sessionPath, initialMtime, initialMtime);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    const before = db.prepare(
      "SELECT id, block_count FROM conversations WHERE source_path = ?",
    ).get(sessionPath) as { id: string; block_count: number };
    db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(
      "This session is being continued from a previous conversation that ran out of context.",
      before.id,
    );

    await fsp.appendFile(sessionPath, row({
      type: "ai-title",
      aiTitle: "Review and take over QA successor briefing task",
      sessionId: "11111111-1111-4111-8111-111111111111",
    }), "utf8");
    const titledMtime = new Date(1_800_000_005_000);
    await fsp.utimes(sessionPath, titledMtime, titledMtime);

    const events: Array<{ event: string; data: unknown }> = [];
    configureIngestionWorker(() => {}, (event, data) => events.push({ event, data }));
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(db.prepare(
      "SELECT title, block_count FROM conversations WHERE id = ?",
    ).get(before.id)).toEqual({
      title: "Review and take over QA successor briefing task",
      block_count: before.block_count,
    });
    expect(events).toContainEqual({
      event: "conversation:updated",
      data: expect.objectContaining({
        id: before.id,
        source: "claude_code",
        title: "Review and take over QA successor briefing task",
        block_count: before.block_count,
      }),
    });
  });

  it("repairs an EOF-checkpointed legacy title for both sidebar and detail projection", async () => {
    const sessionPath = await writeClaudeSession();
    const initialMtime = new Date(1_800_000_000_000);
    await fsp.utimes(sessionPath, initialMtime, initialMtime);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    await fsp.appendFile(sessionPath, row({
      type: "ai-title",
      aiTitle: "Review and take over QA successor briefing task",
      sessionId: "11111111-1111-4111-8111-111111111111",
    }), "utf8");
    const titledMtime = new Date(1_800_000_005_000);
    await fsp.utimes(sessionPath, titledMtime, titledMtime);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    const indexed = db.prepare(
      "SELECT id, source_mtime, block_count FROM conversations WHERE source_path = ?",
    ).get(sessionPath) as { id: string; source_mtime: number; block_count: number };
    expect(db.prepare(
      "SELECT byte_offset FROM conversation_ingest_state WHERE file_path = ?",
    ).get(sessionPath)).toEqual({ byte_offset: fs.statSync(sessionPath).size });

    // Reproduce the live copied-database shape: an older parser advanced the
    // append checkpoint past the real ai-title record while leaving the
    // conversation row's fallback title and source metadata stale.
    const legacyTitle = "This session is being continued from a previous conversation that ran out of context. The summary be";
    db.prepare(`UPDATE conversations
      SET title = ?, starred = 1, source_hash = ?, source_mtime = ?
      WHERE id = ?`).run(
      legacyTitle,
      "append:legacy-title-parser",
      indexed.source_mtime - 5_000,
      indexed.id,
    );

    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 3_000 });

    const authoritativeTitle = "Review and take over QA successor briefing task";
    expect(db.prepare(
      "SELECT title, source_mtime, block_count FROM conversations WHERE id = ?",
    ).get(indexed.id)).toEqual({
      title: authoritativeTitle,
      source_mtime: fs.statSync(sessionPath).mtimeMs,
      block_count: indexed.block_count,
    });

    const router = new Router({ instance: resolveInstanceInfo({ env: {} }) });
    registerConversationRoutes(router, inlineLedgerReader());
    const sidebar = await router.invoke({
      method: "GET",
      url: "/api/conversations/sidebar?limit=10",
    });
    expect(sidebar.status).toBe(200);
    expect(sidebar.body).toEqual(expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({
          kind: "pinned",
          conversations: expect.arrayContaining([
            expect.objectContaining({ id: indexed.id, title: authoritativeTitle }),
          ]),
        }),
      ]),
    }));

    const detail = await router.invoke({
      method: "GET",
      url: `/api/conversations/${indexed.id}`,
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(expect.objectContaining({
      conversation: expect.objectContaining({ id: indexed.id, title: authoritativeTitle }),
    }));
  });

  it("preserves an earlier explicit custom-title when ai-title arrives in a later append", async () => {
    const sessionPath = await writeClaudeSession();
    const initialMtime = new Date(1_800_000_000_000);
    await fsp.utimes(sessionPath, initialMtime, initialMtime);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    await fsp.appendFile(sessionPath, row({
      type: "custom-title",
      customTitle: "Explicit operator title",
      sessionId: "11111111-1111-4111-8111-111111111111",
    }), "utf8");
    const renamedMtime = new Date(1_800_000_005_000);
    await fsp.utimes(sessionPath, renamedMtime, renamedMtime);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    const renamed = db.prepare(
      "SELECT id, title, block_count FROM conversations WHERE source_path = ?",
    ).get(sessionPath) as { id: string; title: string; block_count: number };
    expect(renamed).toMatchObject({ title: "Explicit operator title", block_count: 2 });

    await fsp.appendFile(sessionPath, row({
      type: "ai-title",
      aiTitle: "Later generated title",
      sessionId: "11111111-1111-4111-8111-111111111111",
    }), "utf8");
    const generatedMtime = new Date(1_800_000_010_000);
    await fsp.utimes(sessionPath, generatedMtime, generatedMtime);

    const events: Array<{ event: string; data: unknown }> = [];
    configureIngestionWorker(() => {}, (event, data) => events.push({ event, data }));
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 3_000 });

    expect(db.prepare(
      "SELECT id, title, block_count FROM conversations WHERE source_path = ?",
    ).get(sessionPath)).toEqual(renamed);
    expect(events).not.toContainEqual({
      event: "conversation:updated",
      data: expect.objectContaining({ title: "Later generated title" }),
    });
  });
});
