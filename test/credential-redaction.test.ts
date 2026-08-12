// Credential-leak redaction (issue b3e4a09).
//
// Two halves, both verified end to end here:
//   1. Ingest-time masking — a transcript carrying a live Mandible PAT is
//      indexed with the token already replaced, deterministically, while the
//      leak alert is still raised and the source file is left alone.
//   2. `mandible credential redact <id>` — a hash-verified sweep that masks a
//      credential that leaked before (1) existed, optionally patching the source
//      transcript so a later full re-ingest cannot resurrect the plaintext.
//
// The property that matters most is negative: after either path, the token must
// not survive anywhere in the database or in any reported output. Several tests
// assert that directly rather than only checking the block that was edited.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { compressContent, decompressContent } from "../src/compression.js";
import { conversationBlockId } from "../src/conversation-block-id.js";
import {
  configureIngestionWorker,
  ingestBatchForWorker,
  triggerTargetedIngest,
} from "../src/ingestion.js";
import { Router } from "../src/server.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { loadOrCreatePepper } from "../src/client-auth/secret-store.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "../src/client-auth/tokens.js";
import {
  addCredential,
  createUser,
  revokeCredential,
  setupOperator,
} from "../src/users/store.js";
import {
  backfillCredentialLeakScan,
  CREDENTIAL_LEAK_EVENT_TYPE,
  credentialMaskFor,
  MAX_CANDIDATES_PER_TEXT,
  resetCredentialLeakScanCache,
} from "../src/credential-leak-scan.js";
import { redactCredential } from "../src/credential-redaction.js";

const LEAKED_TOKEN = `${API_TOKEN_PREFIX}${"L".repeat(43)}`;
const OTHER_TOKEN = `${API_TOKEN_PREFIX}${"O".repeat(43)}`;
/** Matches the candidate pattern but belongs to no credential. */
const LOOKALIKE_TOKEN = `${API_TOKEN_PREFIX}${"X".repeat(43)}`;

let tempDir = "";
let configDir = "";
let db: Db;
let pepper = "";
let previousHome: string | undefined;
let previousConfigDir: string | undefined;

beforeEach(() => {
  resetCredentialLeakScanCache();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-credential-redaction-"));
  configDir = path.join(tempDir, "config");
  previousHome = process.env.HOME;
  previousConfigDir = process.env.MANDIBLE_CONFIG_DIR;
  process.env.HOME = path.join(tempDir, "home");
  // Pin the pepper location so ingestion's default client-auth directory is the
  // same one this test seeds fingerprints against.
  process.env.MANDIBLE_CONFIG_DIR = configDir;

  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
  setDb(db);
  pepper = loadOrCreatePepper(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousConfigDir === undefined) delete process.env.MANDIBLE_CONFIG_DIR;
  else process.env.MANDIBLE_CONFIG_DIR = previousConfigDir;
  resetCredentialLeakScanCache();
});

/** Register a credential for `token` exactly as minting would. */
function registerToken(userSlug: string, token: string, label = "leaked pat") {
  return addCredential(db, userSlug, {
    type: "api_token",
    fingerprint: fingerprintForToken(pepper, token),
    label,
  });
}

function makeAgent(slug = "mandible-agent-codex") {
  return createUser(db, { slug, kind: "agent", display_name: "Agent Codex" });
}

interface StoredBlock {
  id: string;
  conversation_id: string;
  position: number;
  type: string;
  timestamp: string | null;
  content: string;
}

function storedBlocks(): StoredBlock[] {
  return (db
    .prepare(
      `SELECT id, conversation_id, position, type, timestamp, content, compressed
       FROM conversation_blocks ORDER BY conversation_id, position`,
    )
    .all() as Array<{
      id: string;
      conversation_id: string;
      position: number;
      type: string;
      timestamp: string | null;
      content: Buffer | string;
      compressed: number;
    }>).map((row) => ({
      id: row.id,
      conversation_id: row.conversation_id,
      position: row.position,
      type: row.type,
      timestamp: row.timestamp,
      content: decompressContent(row.content, row.compressed === 1),
    }));
}

/**
 * Every place the token could survive: decompressed block text plus the raw
 * contents of every other table. A redaction that only fixes the block it was
 * looking at is not a redaction.
 */
function databaseMentionsToken(token: string): boolean {
  if (storedBlocks().some((block) => block.content.includes(token))) return true;
  // metadata_json is the other half of a block: the parsers duplicate tool
  // arguments and short tool results into it, so it is checked explicitly
  // rather than skipped along with the compressed content blob.
  const metadata = db
    .prepare("SELECT metadata_json FROM conversation_blocks")
    .all() as Array<{ metadata_json: string | null }>;
  if (metadata.some((row) => (row.metadata_json ?? "").includes(token))) return true;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  for (const table of tables) {
    if (table.name === "conversation_blocks") continue;
    const rows = db.prepare(`SELECT * FROM "${table.name}"`).all();
    if (JSON.stringify(rows).includes(token)) return true;
  }
  return false;
}

function leakAlerts(): Array<{ id: string; data_json: string }> {
  return db
    .prepare("SELECT id, data_json FROM webhook_events WHERE event_type = ?")
    .all(CREDENTIAL_LEAK_EVENT_TYPE) as Array<{ id: string; data_json: string }>;
}

// --- Ingest-time masking -----------------------------------------------------

function codexRow(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function codexTranscript(userText: string, assistantText: string): string {
  return [
    codexRow({
      type: "session_meta",
      timestamp: "2026-08-12T00:00:00.000Z",
      payload: { id: "leaktest", cwd: "/tmp/project", model_provider: "openai" },
    }),
    codexRow({
      type: "response_item",
      timestamp: "2026-08-12T00:00:01.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    }),
    codexRow({
      type: "response_item",
      timestamp: "2026-08-12T00:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: assistantText }],
      },
    }),
  ].join("");
}

async function writeCodexTranscript(content: string): Promise<string> {
  const dir = path.join(tempDir, "home", ".codex", "sessions", "2026", "08", "12");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "rollout-2026-08-12T00-00-00-leaktest.jsonl");
  await fsp.writeFile(file, content, "utf8");
  return file;
}

describe("ingest-time credential redaction", () => {
  it("indexes a leaked token as a mask and never stores the plaintext", async () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(
      codexTranscript(`export MANDIBLE_TOKEN=${LEAKED_TOKEN}`, `ok, also ${LEAKED_TOKEN} again`),
    );

    expect(await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 }))
      .toMatchObject({ status: "ingested" });

    const mask = credentialMaskFor(credential.id);
    const blocks = storedBlocks();
    expect(blocks.map((block) => block.content)).toEqual([
      `export MANDIBLE_TOKEN=${mask}`,
      `ok, also ${mask} again`,
    ]);
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);

    // The source transcript is the user's record and is never touched by ingest.
    expect(fs.readFileSync(transcript, "utf8")).toContain(LEAKED_TOKEN);
  });

  it("masks the token in tool metadata and in the SSE append payload", async () => {
    // Review finding 1: the parsers copy tool arguments into block.metadata, so
    // masking only block.content left a working token in metadata_json and in
    // the append event pushed to every connected client.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(codexTranscript("hello", "on it"));
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });

    const events: unknown[] = [];
    configureIngestionWorker(() => {}, (event, data) => events.push({ event, data }));
    try {
      await fsp.appendFile(
        transcript,
        codexRow({
          type: "response_item",
          timestamp: "2026-08-12T00:00:03.000Z",
          payload: {
            type: "function_call",
            name: "shell",
            call_id: "call-1",
            arguments: JSON.stringify({
              command: ["bash", "-lc", `curl -H "Authorization: Bearer ${LEAKED_TOKEN}"`],
            }),
          },
        }),
      );
      // Ingestion skips files whose mtime moved less than 100ms, which an
      // immediate append in a test always does.
      const future = new Date(Date.now() + 5_000);
      fs.utimesSync(transcript, future, future);
      await triggerTargetedIngest({ transcriptPath: transcript, now: 10_000_000 });
    } finally {
      configureIngestionWorker(() => {}, () => {});
    }

    const mask = credentialMaskFor(credential.id);
    const toolBlock = db
      .prepare("SELECT metadata_json FROM conversation_blocks WHERE type = 'tool_use'")
      .get() as { metadata_json: string };
    expect(toolBlock.metadata_json).not.toContain(LEAKED_TOKEN);
    expect(toolBlock.metadata_json).toContain(mask);
    // The metadata object is still structured JSON, not a mangled string.
    expect(JSON.parse(toolBlock.metadata_json)).toMatchObject({
      tool_name: "shell",
      tool_input: { command: ["bash", "-lc", `curl -H "Authorization: Bearer ${mask}"`] },
    });

    const broadcast = JSON.stringify(events);
    expect(broadcast).not.toContain(LEAKED_TOKEN);
    expect(broadcast).toContain(mask);
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("masks the conversation title derived from the leaking message", async () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(
      codexTranscript(`token: ${LEAKED_TOKEN}`, "acknowledged"),
    );

    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });

    const conversation = db
      .prepare("SELECT title FROM conversations WHERE source_path = ?")
      .get(transcript) as { title: string };
    expect(conversation.title).toBe(`token: ${credentialMaskFor(credential.id)}`);
  });

  it("still raises the leak alert for the masked credential", async () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(
      codexTranscript(`token: ${LEAKED_TOKEN}`, "acknowledged"),
    );

    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });

    const alerts = leakAlerts();
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0].data_json)).toMatchObject({
      credential_id: credential.id,
      auto_revoked: false,
    });
    expect(alerts[0].data_json).not.toContain(LEAKED_TOKEN);
  });

  it("produces identical block ids and content on a full re-ingest", async () => {
    makeAgent();
    registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(
      codexTranscript(`token: ${LEAKED_TOKEN}`, "acknowledged"),
    );

    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });
    const first = storedBlocks();
    expect(first).toHaveLength(2);

    // Force the full re-ingest path over the untouched source. Block ids are
    // derived from the content, so identical masked text must reproduce
    // identical ids: masking is a pure function of the credential table and
    // cannot make ingestion churn ids or content on every pass.
    await ingestBatchForWorker([transcript], true);

    expect(storedBlocks()).toEqual(first);
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("masks a credential pasted into the Codex thread name", async () => {
    // Re-review finding 1: the unchanged-mtime path syncs the thread name from
    // Codex's session index straight into the conversations row and the SSE
    // payload. It never went through the masker, so a PAT in a thread name was
    // stored and broadcast in the clear.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(codexTranscript("hello", "on it"));
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });

    await fsp.writeFile(
      path.join(tempDir, "home", ".codex", "session_index.jsonl"),
      `${JSON.stringify({ id: "leaktest", thread_name: `deploy ${LEAKED_TOKEN}` })}\n`,
      "utf8",
    );

    const events: unknown[] = [];
    configureIngestionWorker(() => {}, (event, data) => events.push({ event, data }));
    try {
      // Same bytes, same mtime: the title-sync path, not a re-parse.
      await triggerTargetedIngest({ transcriptPath: transcript, now: 2_000 });
    } finally {
      configureIngestionWorker(() => {}, () => {});
    }

    const mask = credentialMaskFor(credential.id);
    const conversation = db
      .prepare("SELECT title FROM conversations WHERE source_path = ?")
      .get(transcript) as { title: string };
    expect(conversation.title).toBe(`deploy ${mask}`);
    expect(JSON.stringify(events)).not.toContain(LEAKED_TOKEN);
    expect(JSON.stringify(events)).toContain(mask);
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("masks derived text on the identical-source-hash update path", async () => {
    // Re-review finding 1: when a re-parse produces the same source hash,
    // ingestion still rewrites and broadcasts the title and summary — and did
    // so from the raw parse. A credential that became known after the first
    // ingest was therefore written back in the clear on the next touch.
    makeAgent();
    const transcript = await writeCodexTranscript(
      codexTranscript(`token: ${LEAKED_TOKEN}`, "acknowledged"),
    );
    // Ingested before the credential exists, so nothing can be matched yet.
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });
    expect(
      (db.prepare("SELECT title FROM conversations WHERE source_path = ?")
        .get(transcript) as { title: string }).title,
    ).toContain(LEAKED_TOKEN);

    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    // Touched, not modified: the mtime moves, the parse hashes identically.
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(transcript, future, future);

    const events: unknown[] = [];
    configureIngestionWorker(() => {}, (event, data) => events.push({ event, data }));
    try {
      await ingestBatchForWorker([transcript], true);
    } finally {
      configureIngestionWorker(() => {}, () => {});
    }

    const mask = credentialMaskFor(credential.id);
    expect(
      (db.prepare("SELECT title FROM conversations WHERE source_path = ?")
        .get(transcript) as { title: string }).title,
    ).toBe(`token: ${mask}`);
    expect(JSON.stringify(events)).not.toContain(LEAKED_TOKEN);
    // The already-indexed blocks are untouched by this path by design; clearing
    // those is what `mandible credential redact` is for.
  });

  it("never deletes another conversation's block while recovering from an id clash", async () => {
    // Re-review finding 2, the data-loss half: unique-conflict recovery deleted
    // every row whose id matched one of the incoming ids, with no conversation
    // scope. A block id collision across conversations therefore destroyed an
    // unrelated conversation's block. Recovery must purge only this
    // conversation and let the insert fail loudly otherwise.
    makeAgent();
    const transcript = await writeCodexTranscript(codexTranscript("hello", "on it"));
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });
    const indexed = storedBlocks();
    expect(indexed).toHaveLength(2);
    const collidingId = indexed[1].id;

    // Free the id and hand it to an unrelated conversation. This stands in for
    // the truncated-hash collision that is the only way a foreign row can hold
    // an id this file will derive.
    db.prepare("DELETE FROM conversation_blocks WHERE id = ?").run(collidingId);
    seedConversation("conv-bystander", { blocks: ["someone else's work"] });
    db.prepare("UPDATE conversation_blocks SET id = ? WHERE id = 'conv-bystander-b0'")
      .run(collidingId);

    // Grow the transcript so the re-parse is a real full re-ingest rather than
    // the identical-source-hash update, then force the full path. Positions 0
    // and 1 re-derive the same ids, so position 1 collides.
    await fsp.appendFile(
      transcript,
      codexRow({
        type: "response_item",
        timestamp: "2026-08-12T00:00:03.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "one more" }],
        },
      }),
    );
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(transcript, future, future);
    const logs: string[] = [];
    configureIngestionWorker((_level, event) => logs.push(event), () => {});
    try {
      await ingestBatchForWorker([transcript], true);
    } finally {
      configureIngestionWorker(() => {}, () => {});
    }
    const survivor = db
      .prepare("SELECT conversation_id, content, compressed FROM conversation_blocks WHERE id = ?")
      .get(collidingId) as
        { conversation_id: string; content: Buffer | string; compressed: number } | undefined;
    expect(survivor).toBeDefined();
    expect(survivor?.conversation_id).toBe("conv-bystander");
    expect(decompressContent(survivor!.content, survivor!.compressed === 1))
      .toBe("someone else's work");
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id = 'conv-bystander'").get())
      .toEqual({ n: 1 });

    // The clash really did drive the unique-conflict recovery path, and that
    // path refused to resolve it by deleting a row it does not own.
    expect(logs).toContain("ingestion_block_id_collision_foreign");
    expect(logs).toContain("ingestion_db_error");
  });

  it("leaves text that only looks like a token alone", async () => {
    makeAgent();
    registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(
      codexTranscript(`not a real token: ${LOOKALIKE_TOKEN}`, "acknowledged"),
    );

    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });

    expect(storedBlocks()[0].content).toBe(`not a real token: ${LOOKALIKE_TOKEN}`);
    expect(leakAlerts()).toHaveLength(0);
  });

  it("keeps conversation search on masked text, with no separate index to update", () => {
    // Conversation search reads conversation_blocks.content directly (see
    // src/routes/conversations.ts); there is no FTS shadow table that could
    // retain the plaintext after the block is masked. Assert that structural
    // fact so a future FTS index cannot be added without revisiting redaction.
    const virtualTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'")
      .all() as Array<{ name: string }>;
    expect(virtualTables).toEqual([]);
  });
});

// --- Retroactive redaction ---------------------------------------------------

interface SeedOptions {
  sourcePath?: string;
  blocks: string[];
}

function seedConversation(conversationId: string, options: SeedOptions): void {
  db.prepare(
    `INSERT INTO conversations
       (id, source, source_path, source_hash, source_mtime, title, summary,
        started_at, ended_at, block_count, session_id, created_at, updated_at)
     VALUES (?, 'codex', ?, 'hash', 0, 'Seeded transcript', NULL,
             '2026-08-12T00:00:00Z', '2026-08-12T01:00:00Z', ?, ?,
             datetime('now'), datetime('now'))`,
  ).run(
    conversationId,
    options.sourcePath ?? `/nonexistent/${conversationId}.jsonl`,
    options.blocks.length,
    `session-${conversationId}`,
  );
  options.blocks.forEach((content, position) => {
    db.prepare(
      `INSERT INTO conversation_blocks
         (id, conversation_id, type, role, content, position, timestamp,
          parent_id, metadata_json, compressed)
       VALUES (?, ?, 'text', 'assistant', ?, ?, NULL, NULL, '{}', 1)`,
    ).run(`${conversationId}-b${position}`, conversationId, compressContent(content), position);
  });
}

describe("mandible credential redact", () => {
  it("masks every occurrence across conversations and reports counts only", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", {
      blocks: [`here: ${LEAKED_TOKEN}`, `and again ${LEAKED_TOKEN} plus ${LEAKED_TOKEN}`, "clean"],
    });
    seedConversation("conv-b", { blocks: [`elsewhere ${LEAKED_TOKEN}`] });

    const report = redactCredential(db, credential.id);

    expect(report).toMatchObject({
      credential_id: credential.id,
      credential_status: "active",
      scanned_blocks: 4,
      redacted_blocks: 3,
      redacted_spans: 4,
      redacted_conversations: 2,
      sources: null,
    });
    const mask = credentialMaskFor(credential.id);
    expect(storedBlocks().map((block) => block.content)).toEqual([
      `here: ${mask}`,
      `and again ${mask} plus ${mask}`,
      "clean",
      `elsewhere ${mask}`,
    ]);
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
    expect(JSON.stringify(report)).not.toContain(LEAKED_TOKEN);
  });

  it("masks conversation titles and summaries as well as block text", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", { blocks: [`here: ${LEAKED_TOKEN}`] });
    db.prepare("UPDATE conversations SET title = ?, summary = ? WHERE id = 'conv-a'")
      .run(`title with ${LEAKED_TOKEN}`, `summary with ${LEAKED_TOKEN}`);

    const report = redactCredential(db, credential.id);

    const mask = credentialMaskFor(credential.id);
    expect(report).toMatchObject({ redacted_metadata_fields: 2, redacted_spans: 3 });
    expect(db.prepare("SELECT title, summary FROM conversations WHERE id = 'conv-a'").get())
      .toEqual({ title: `title with ${mask}`, summary: `summary with ${mask}` });
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("redacts a credential that was already revoked by rotation", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    revokeCredential(db, credential.id);
    seedConversation("conv-a", { blocks: [`rotated but still here: ${LEAKED_TOKEN}`] });

    const report = redactCredential(db, credential.id);

    expect(report).toMatchObject({ credential_status: "revoked", redacted_spans: 1 });
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("touches only the requested credential", () => {
    makeAgent();
    const other = makeAgent("mandible-agent-claude");
    const target = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    registerToken(other.slug, OTHER_TOKEN, "other pat");
    seedConversation("conv-a", {
      blocks: [`mine ${LEAKED_TOKEN}`, `theirs ${OTHER_TOKEN}`, `fake ${LOOKALIKE_TOKEN}`],
    });

    const report = redactCredential(db, target.id);

    expect(report).toMatchObject({ redacted_blocks: 1, redacted_spans: 1 });
    expect(storedBlocks().map((block) => block.content)).toEqual([
      `mine ${credentialMaskFor(target.id)}`,
      `theirs ${OTHER_TOKEN}`,
      `fake ${LOOKALIKE_TOKEN}`,
    ]);
  });

  it("accepts an unambiguous id prefix and refuses an ambiguous or unknown one", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", { blocks: [`here: ${LEAKED_TOKEN}`] });

    expect(redactCredential(db, credential.id.slice(0, 10))).toMatchObject({
      credential_id: credential.id,
      redacted_spans: 1,
    });
    expect(() => redactCredential(db, "NOPE-NO-SUCH-ID")).toThrow(/No credential/);
    // ULIDs share a timestamp prefix, so a very short prefix is ambiguous.
    registerToken("mandible-agent-codex", OTHER_TOKEN, "second pat");
    expect(() => redactCredential(db, credential.id.slice(0, 4))).toThrow(/ambiguous/);
  });

  it("refuses a credential type whose material cannot appear in transcript text", () => {
    const user = makeAgent();
    const credential = addCredential(db, user.slug, {
      type: "ssh_key",
      fingerprint: "SHA256:3VQfDpKQEwYnMz3TrhpTr6vzxvKQTdcYQlmr7RaTuAg",
      label: "signing key",
    });
    expect(() => redactCredential(db, credential.id)).toThrow(/not an api_token/);
  });

  it("masks the token inside block metadata_json", () => {
    // Review finding 1: the retroactive sweep selected only `content`, so a
    // token that leaked through a tool argument survived the redaction it was
    // supposed to remove.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", { blocks: ["Bash(curl …)", "clean"] });
    db.prepare("UPDATE conversation_blocks SET metadata_json = ? WHERE id = 'conv-a-b0'")
      .run(JSON.stringify({ tool_name: "shell", tool_input: { token: LEAKED_TOKEN } }));

    const report = redactCredential(db, credential.id);

    const mask = credentialMaskFor(credential.id);
    expect(report).toMatchObject({ redacted_blocks: 1, redacted_spans: 1 });
    const metadata = db
      .prepare("SELECT metadata_json FROM conversation_blocks WHERE id = 'conv-a-b0'")
      .get() as { metadata_json: string };
    expect(JSON.parse(metadata.metadata_json)).toEqual({
      tool_name: "shell",
      tool_input: { token: mask },
    });
    // Metadata-only edits leave the id alone: the id is derived from content.
    expect(report.renumbered_blocks).toBe(0);
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("recomputes a redacted block's id to the value a re-ingest will derive", async () => {
    // Review finding 7: the redacted block kept its plaintext-derived id, so a
    // deep link captured after the redaction broke silently at the next full
    // re-ingest. Recomputing moves that change to redaction time.
    makeAgent();
    const transcript = await writeCodexTranscript(
      codexTranscript(`token: ${LEAKED_TOKEN}`, "acknowledged"),
    );
    // Ingested before the credential is known, so ingest-time masking has
    // nothing to match and the plaintext lands in the index.
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });
    const before = storedBlocks();
    expect(before[0].content).toBe(`token: ${LEAKED_TOKEN}`);
    expect(before[0].id).toBe(conversationBlockId({
      conversation_id: before[0].conversation_id,
      type: before[0].type,
      timestamp: before[0].timestamp,
      content: before[0].content,
      position: before[0].position,
    }));

    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const report = redactCredential(db, credential.id, { patchSources: true });

    expect(report).toMatchObject({ renumbered_blocks: 1, id_conflicts: 0 });
    const after = storedBlocks();
    expect(after[0].id).not.toBe(before[0].id);
    expect(after[0].content).toBe(`token: ${credentialMaskFor(credential.id)}`);

    // The id the redaction chose is the id the next full ingest derives, so the
    // link handed to the operator after redaction keeps working.
    await ingestBatchForWorker([transcript], true);
    expect(storedBlocks()).toEqual(after);
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("repoints an existing leak alert at the renumbered block", () => {
    // Re-review finding 2: the alert payload deep-links the block a credential
    // was found in, and renumbering left every alert pointing at an id that no
    // longer existed — a dead link on the one record an operator opens because
    // of the leak.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", { blocks: [`token: ${LEAKED_TOKEN}`] });
    backfillCredentialLeakScan(db);
    const before = leakAlerts();
    expect(before).toHaveLength(1);
    expect(JSON.parse(before[0].data_json)).toMatchObject({ block_id: "conv-a-b0" });

    const report = redactCredential(db, credential.id);

    expect(report).toMatchObject({ renumbered_blocks: 1, remapped_leak_alerts: 1 });
    const after = leakAlerts();
    expect(after).toHaveLength(1);
    const blockId = JSON.parse(after[0].data_json).block_id as string;
    expect(blockId).toBe(storedBlocks()[0].id);
    expect(blockId).not.toBe("conv-a-b0");
    // The alert now resolves to a row that is actually there.
    expect(db.prepare("SELECT 1 FROM conversation_blocks WHERE id = ?").get(blockId))
      .toBeTruthy();
    // Everything else about the historical detection is untouched.
    expect(JSON.parse(after[0].data_json)).toMatchObject({
      credential_id: credential.id,
      conversation_id: "conv-a",
    });
  });

  it("renumbers identical blocks without a conflict, because ids hash position", () => {
    // Re-review residual on finding 7: "on conflict the old id is kept" is a
    // branch that cannot fire for two well-formed rows. conversation_blocks
    // carries UNIQUE(conversation_id, position) and conversationBlockId hashes
    // both fields — the same disambiguation ingestion itself relies on (bug
    // 7b47c6c) — so distinct rows always differ in a hashed input. Assert the
    // schema fact and the behaviour that rests on it.
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("conversation_blocks") as { sql: string };
    expect(ddl.sql.replace(/\s+/g, " ")).toContain("UNIQUE(conversation_id, position)");

    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const identical = `token: ${LEAKED_TOKEN}`;
    // Byte-identical content, same type and timestamp, in one conversation and
    // repeated in another: the only differences are position and conversation.
    seedConversation("conv-a", { blocks: [identical, identical, identical] });
    seedConversation("conv-b", { blocks: [identical] });

    const report = redactCredential(db, credential.id);

    expect(report).toMatchObject({ renumbered_blocks: 4, id_conflicts: 0 });
    const blocks = storedBlocks();
    expect(new Set(blocks.map((block) => block.id)).size).toBe(4);
    for (const block of blocks) {
      expect(block.id).toBe(conversationBlockId({
        conversation_id: block.conversation_id,
        type: block.type,
        timestamp: block.timestamp,
        content: block.content,
        position: block.position,
      }));
    }
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("keeps the id when the redacted span is past the hashed content prefix", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const padding = "x".repeat(200);
    seedConversation("conv-a", { blocks: [`${padding} ${LEAKED_TOKEN}`] });

    const report = redactCredential(db, credential.id);

    expect(report).toMatchObject({ redacted_spans: 1, renumbered_blocks: 0 });
    expect(storedBlocks()[0].id).toBe("conv-a-b0");
  });

  it("is a no-op that still reports when nothing leaked", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", { blocks: ["nothing to see"] });

    expect(redactCredential(db, credential.id)).toMatchObject({
      scanned_blocks: 1,
      redacted_blocks: 0,
      redacted_spans: 0,
      redacted_conversations: 0,
    });
  });
});

// --- Source patching ---------------------------------------------------------

/**
 * Run `onOpen` each time the redaction opens its temp replacement file — the
 * point where the snapshot has been read but nothing has been renamed yet.
 * That is the window a live transcript writer appends into.
 */
function spyOnTempFileOpen(onOpen: () => void) {
  const realOpenSync = fs.openSync.bind(fs);
  return vi.spyOn(fs, "openSync").mockImplementation(((
    target: Parameters<typeof fs.openSync>[0],
    ...rest: unknown[]
  ) => {
    if (typeof target === "string" && target.includes("mandible-redact")) onOpen();
    return (realOpenSync as (...args: unknown[]) => number)(target, ...rest);
  }) as typeof fs.openSync);
}

describe("credential redact --patch-sources", () => {
  function writeSourceFile(name: string, body: Buffer): string {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o600);
    return file;
  }

  /** Includes a byte that is not valid UTF-8, to prove the rewrite is byte-exact. */
  function transcriptBytes(token: string): Buffer {
    return Buffer.concat([
      Buffer.from(`{"text":"prefix `, "latin1"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(` ${token} suffix"}\n{"text":"second line ${token}"}\n`, "latin1"),
    ]);
  }

  it("rewrites only the verified spans and leaves every other byte identical", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-a.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });

    const report = redactCredential(db, credential.id, { patchSources: true });

    const mask = credentialMaskFor(credential.id);
    expect(report.sources).toMatchObject({
      candidate_files: 1,
      patched_files: 1,
      unchanged_files: 0,
      missing_files: 0,
      failed_files: 0,
      patched_spans: 2,
    });
    const expected = Buffer.from(
      original.toString("latin1").split(LEAKED_TOKEN).join(mask),
      "latin1",
    );
    expect(fs.readFileSync(file).equals(expected)).toBe(true);
    // Byte-for-byte outside the spans, including the invalid-UTF-8 bytes.
    expect(fs.readFileSync(file).subarray(0, 18).equals(original.subarray(0, 18))).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // temp-plus-rename leaves nothing behind.
    expect(fs.readdirSync(tempDir).filter((entry) => entry.includes("mandible-redact"))).toEqual([]);
  });

  it("reports a source file that is gone instead of failing", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", {
      sourcePath: path.join(tempDir, "vanished.jsonl"),
      blocks: [`in db: ${LEAKED_TOKEN}`],
    });

    const report = redactCredential(db, credential.id, { patchSources: true });

    expect(report).toMatchObject({ redacted_spans: 1 });
    expect(report.sources).toMatchObject({
      candidate_files: 1,
      patched_files: 0,
      missing_files: 1,
      failed_files: 0,
    });
  });

  it("leaves the source untouched when --patch-sources is not requested", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-b.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });

    const report = redactCredential(db, credential.id);

    expect(report.sources).toBeNull();
    expect(fs.readFileSync(file).equals(original)).toBe(true);
  });

  it("keeps bytes appended while the rewrite was being prepared", () => {
    // Review finding 4: the rewrite renamed a file built from a stale snapshot
    // over the live transcript, dropping anything appended in between.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-race.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `{"text":"written after the snapshot ${LEAKED_TOKEN}"}\n`,
      "latin1",
    );

    // Simulate the agent appending an event while the replacement is being
    // written: the source grows after its snapshot was taken and before the
    // rename, which the pre-rename re-verification must catch.
    let injected = false;
    const spy = spyOnTempFileOpen(() => {
      if (injected) return;
      injected = true;
      fs.appendFileSync(file, appended);
    });

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      spy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(report.sources).toMatchObject({ patched_files: 1, refused_files: 0, failed_files: 0 });
    const mask = credentialMaskFor(credential.id);
    const expected = Buffer.concat([original, appended])
      .toString("latin1")
      .split(LEAKED_TOKEN)
      .join(mask);
    expect(fs.readFileSync(file).toString("latin1")).toBe(expected);
    expect(fs.readdirSync(tempDir).filter((entry) => entry.includes("mandible-redact"))).toEqual([]);
  });

  it("recovers bytes appended to the replaced inode during the rename", () => {
    // Re-review residual on finding 4: the pre-rename check closed the stale-
    // snapshot hole, but the descriptor was released before renameSync, so a
    // writer appending inside that window wrote into a file the rename then
    // unlinked. Those bytes were reachable only through the descriptor the
    // redaction had just closed. It now holds the descriptor across the rename
    // and copies the tail onto the patched file.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-tail.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `{"text":"written inside the rename window ${LEAKED_TOKEN}"}\n`,
      "latin1",
    );

    const realRenameSync = fs.renameSync.bind(fs);
    let injected = false;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((
      from: Parameters<typeof fs.renameSync>[0],
      to: Parameters<typeof fs.renameSync>[1],
    ) => {
      // Still the pre-rename inode at this instant, so this lands exactly where
      // the old code lost it: in the file the next statement unlinks.
      if (!injected && to === file) {
        injected = true;
        fs.appendFileSync(file, appended);
      }
      return realRenameSync(from, to);
    }) as typeof fs.renameSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      spy.mockRestore();
    }

    expect(injected).toBe(true);
    const mask = credentialMaskFor(credential.id);
    expect(report.sources).toMatchObject({
      patched_files: 1,
      failed_files: 0,
      // Two spans in the snapshot plus the one in the recovered tail.
      patched_spans: 3,
      recovered_tail_bytes: appended.length,
      abandoned_tail_bytes: 0,
    });
    const expected = Buffer.concat([original, appended])
      .toString("latin1")
      .split(LEAKED_TOKEN)
      .join(mask);
    // Nothing dropped, and the recovered tail is masked rather than copied
    // verbatim — it was never scanned before it was written.
    expect(fs.readFileSync(file).toString("latin1")).toBe(expected);
    expect(fs.readFileSync(file).toString("latin1")).not.toContain(LEAKED_TOKEN);
  });

  it("reports the bytes it could not drain from a writer that never stops", () => {
    // Tail recovery is bounded, and the bound is reported rather than hidden:
    // a writer appending faster than the loop drains leaves bytes in the
    // unlinked inode, and the operator is told to re-run once it exits.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-flood.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });

    // A descriptor opened before the rename keeps writing to the old inode
    // afterwards — exactly what a running agent's transcript writer does.
    const writerFd = fs.openSync(file, "a");
    let written = 0;
    const burst = (): void => {
      written += 1;
      fs.writeSync(writerFd, Buffer.from(`{"burst":${written},"t":"${LEAKED_TOKEN}"}\n`, "latin1"));
    };

    const realRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(((
      from: Parameters<typeof fs.renameSync>[0],
      to: Parameters<typeof fs.renameSync>[1],
    ) => {
      if (to === file) burst();
      return realRenameSync(from, to);
    }) as typeof fs.renameSync);
    // Every recovery append provokes another write into the old inode.
    const openSpy = (() => {
      const realOpenSync = fs.openSync.bind(fs);
      return vi.spyOn(fs, "openSync").mockImplementation(((
        target: Parameters<typeof fs.openSync>[0],
        ...rest: unknown[]
      ) => {
        if (target === file && rest[0] === "a") burst();
        return (realOpenSync as (...args: unknown[]) => number)(target, ...rest);
      }) as typeof fs.openSync);
    })();

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      renameSpy.mockRestore();
      openSpy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(report.sources?.patched_files).toBe(1);
    expect(report.sources?.recovered_tail_bytes ?? 0).toBeGreaterThan(0);
    expect(report.sources?.abandoned_tail_bytes ?? 0).toBeGreaterThan(0);
    // Whatever was recovered is masked; the abandoned remainder never reached
    // the patched file at all.
    expect(fs.readFileSync(file).toString("latin1")).not.toContain(LEAKED_TOKEN);
  });

  it("refuses a source that never stops changing", () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-busy.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });

    let appends = 0;
    const spy = spyOnTempFileOpen(() => {
      appends += 1;
      fs.appendFileSync(file, Buffer.from(`{"n":${appends}}\n`, "latin1"));
    });

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      spy.mockRestore();
    }

    // Refused, not silently rewritten from a stale snapshot — and reported.
    expect(report.sources).toMatchObject({ patched_files: 0, refused_files: 1, patched_spans: 0 });
    expect(appends).toBe(3);
    expect(fs.readFileSync(file).toString("latin1")).toContain(LEAKED_TOKEN);
    expect(fs.readdirSync(tempDir).filter((entry) => entry.includes("mandible-redact"))).toEqual([]);
  });

  it("refuses a source whose scan could not check every candidate", () => {
    // Fail-closed the other way (review finding 2): an incomplete scan must not
    // authorize a destructive partial rewrite of the operator's transcript.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const decoys = Array.from(
      { length: MAX_CANDIDATES_PER_TEXT },
      (_, index) => `${API_TOKEN_PREFIX}${index.toString(36).padStart(43, "0")}`,
    );
    const body = Buffer.from(`${decoys.join(" ")} ${LEAKED_TOKEN}\n`, "latin1");
    const file = writeSourceFile("rollout-overflow.jsonl", body);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });

    const report = redactCredential(db, credential.id, { patchSources: true });

    expect(report.sources).toMatchObject({ patched_files: 0, refused_files: 1 });
    expect(fs.readFileSync(file).equals(body)).toBe(true);
  });

  it("makes the redaction survive a full re-ingest of the patched source", async () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(
      codexTranscript(`token: ${LEAKED_TOKEN}`, "acknowledged"),
    );
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });

    // Rotate first, exactly as the alert recommends: once revoked, ingest-time
    // masking no longer applies, so only a patched source keeps the plaintext
    // out of the index.
    revokeCredential(db, credential.id);
    const report = redactCredential(db, credential.id, { patchSources: true });
    expect(report.sources).toMatchObject({ patched_files: 1, patched_spans: 1 });

    await ingestBatchForWorker([transcript], true);

    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
    expect(storedBlocks()[0].content).toBe(`token: ${credentialMaskFor(credential.id)}`);
  });
});

// --- Route authorization -----------------------------------------------------

describe("POST /api/users/credentials/:id/redact", () => {
  function makeRouter(): { router: Router; authenticator: ClientAuthenticator } {
    const authenticator = new ClientAuthenticator(db, {
      secretsDir: path.join(configDir, "client-auth"),
    });
    const router = new Router({ clientAuth: authenticator });
    registerUserRoutes(router, authenticator);
    return { router, authenticator };
  }

  it("rejects anonymous and non-operator callers", async () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", { blocks: [`here: ${LEAKED_TOKEN}`] });
    const { router, authenticator } = makeRouter();
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const agentToken = authenticator.mintApiToken(
      (db.prepare("SELECT id FROM users WHERE slug = ?").get("mandible-agent-codex") as { id: string }).id,
      { label: "agent" },
    ).token;

    const url = `/api/users/credentials/${credential.id}/redact`;
    const anonymous = await router.invoke({ method: "POST", url, body: {}, transport: "http" });
    expect(anonymous.status).toBe(401);

    const asAgent = await router.invoke({
      method: "POST",
      url,
      body: {},
      credential: agentToken,
      transport: "http",
    });
    expect(asAgent.status).toBe(403);
    expect(asAgent.body).toMatchObject({ code: "operator_required" });

    // Nothing was redacted by a rejected call.
    expect(storedBlocks()[0].content).toBe(`here: ${LEAKED_TOKEN}`);
  });

  it("redacts for the operator and returns counts without any token material", async () => {
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    seedConversation("conv-a", { blocks: [`here: ${LEAKED_TOKEN}`, "clean"] });
    const { router, authenticator } = makeRouter();
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const operatorToken = authenticator.mintApiToken(operator.id, { label: "op" }).token;

    const response = await router.invoke({
      method: "POST",
      url: `/api/users/credentials/${credential.id}/redact`,
      body: {},
      credential: operatorToken,
      transport: "http",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      credential_id: credential.id,
      scanned_blocks: 2,
      redacted_blocks: 1,
      redacted_spans: 1,
      sources: null,
    });
    expect(JSON.stringify(response.body)).not.toContain(LEAKED_TOKEN);
    expect(databaseMentionsToken(LEAKED_TOKEN)).toBe(false);
  });

  it("returns 404 for an unknown credential", async () => {
    const { router, authenticator } = makeRouter();
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const operatorToken = authenticator.mintApiToken(operator.id, { label: "op" }).token;

    const response = await router.invoke({
      method: "POST",
      url: "/api/users/credentials/NOSUCHCREDENTIAL/redact",
      body: {},
      credential: operatorToken,
      transport: "http",
    });
    expect(response.status).toBe(404);
  });
});
