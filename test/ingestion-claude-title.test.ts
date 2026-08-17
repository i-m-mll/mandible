import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { configureIngestionWorker, triggerTargetedIngest } from "../src/ingestion.js";
import { loadOrCreatePepper } from "../src/client-auth/secret-store.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "../src/client-auth/tokens.js";
import { credentialMaskFor } from "../src/credential-leak-scan.js";
import { addCredential, createUser } from "../src/users/store.js";

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
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
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
    ).toMatchObject({ count: 2 });
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
});
