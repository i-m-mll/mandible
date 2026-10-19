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
import { ConversationSourceReader } from "../src/conversations/source-reader.js";

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

async function indexedBlocks(maskCredentials = true): Promise<StoredBlock[]> {
  const reader = new ConversationSourceReader(db, { maskCredentials });
  const conversations = db
    .prepare("SELECT id FROM conversations ORDER BY id")
    .all() as Array<{ id: string }>;
  const blocks: StoredBlock[] = [];
  for (const conversation of conversations) {
    const result = await reader.readAll(conversation.id);
    if (result.status !== "source" && result.status !== "legacy") continue;
    blocks.push(...result.value.map((block) => ({
      id: block.id,
      conversation_id: block.conversation_id,
      position: block.position,
      type: block.type,
      timestamp: block.timestamp,
      content: block.content,
    })));
  }
  return blocks.sort((left, right) =>
    left.conversation_id.localeCompare(right.conversation_id) || left.position - right.position);
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

/** A transcript of assistant messages sharing one timestamp, one per block. */
function codexAssistantTranscript(texts: readonly string[]): string {
  return [
    codexRow({
      type: "session_meta",
      timestamp: "2026-08-12T00:00:00.000Z",
      payload: { id: "leaktest", cwd: "/tmp/project", model_provider: "openai" },
    }),
    ...texts.map((text) => codexRow({
      type: "response_item",
      timestamp: "2026-08-12T00:00:01.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    })),
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
    const blocks = await indexedBlocks();
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
    const conversationId = (db.prepare("SELECT id FROM conversations WHERE source_path = ?")
      .get(transcript) as { id: string }).id;
    const sourceResult = await new ConversationSourceReader(db).readAll(conversationId);
    expect(sourceResult.status).toBe("source");
    const toolBlock = sourceResult.status === "source"
      ? sourceResult.value.find((block) => block.type === "tool_use")!
      : undefined!;
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
    const first = await indexedBlocks();
    expect(first).toHaveLength(2);

    // Force the full re-ingest path over the untouched source. Sparse identities
    // are positional, and masking remains a pure read-time function of the
    // credential table, so neither ids nor visible content should churn.
    await ingestBatchForWorker([transcript], true);

    expect(await indexedBlocks()).toEqual(first);
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

  it("never deletes a legacy block whose id matches a sparse source-backed id", async () => {
    makeAgent();
    const transcript = await writeCodexTranscript(codexTranscript("hello", "on it"));
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });
    const indexed = await indexedBlocks();
    expect(indexed).toHaveLength(2);
    const collidingId = indexed[1].id;

    // The sparse cache and the legacy compatibility table are independent
    // namespaces. A stale legacy id must not be touched during source refresh.
    seedConversation("conv-bystander", {
      blocks: ["someone else's work"],
      sourcePath: transcript,
    });
    db.prepare("UPDATE conversation_blocks SET id = ? WHERE id = 'conv-bystander-b0'")
      .run(collidingId);

    // Grow the transcript so the re-parse takes the real full path.
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
    await ingestBatchForWorker([transcript], true);
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
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE source_path = ?").get(transcript))
      .toEqual({ n: 2 });
    const sourceConversation = db.prepare(
      "SELECT id FROM conversations WHERE source_path = ? AND id != 'conv-bystander'",
    ).get(transcript) as { id: string };
    const refreshed = await new ConversationSourceReader(db).readAll(sourceConversation.id);
    expect(refreshed.status).toBe("source");
    if (refreshed.status === "source") expect(refreshed.value).toHaveLength(3);
  });

  it("leaves text that only looks like a token alone", async () => {
    makeAgent();
    registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const transcript = await writeCodexTranscript(
      codexTranscript(`not a real token: ${LOOKALIKE_TOKEN}`, "acknowledged"),
    );

    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });

    expect((await indexedBlocks(false))[0].content).toBe(`not a real token: ${LOOKALIKE_TOKEN}`);
    expect(leakAlerts()).toHaveLength(0);
  });

  it("keeps conversation search on masked text, with no separate index to update", () => {
    // Conversation search reads conversation_blocks.content directly (see
    // src/routes/conversations.ts); there is no FTS shadow table that could
    // retain the plaintext after the block is masked. Assert that structural
    // fact so a future FTS index cannot be added without revisiting redaction.
    // The only index is over issue text, which is never masked in place.
    const virtualTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'")
      .all() as Array<{ name: string }>;
    expect(virtualTables).toEqual([{ name: "issue_search" }]);
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

  it("keeps a source-backed positional identity stable without retaining history", async () => {
    makeAgent();
    const transcript = await writeCodexTranscript(
      codexTranscript(`token: ${LEAKED_TOKEN}`, "acknowledged"),
    );
    // Ingested before the credential is known, so ingest-time masking has
    // nothing to match and the plaintext lands in the index.
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });
    const before = await indexedBlocks(false);
    expect(before[0].content).toBe(`token: ${LEAKED_TOKEN}`);

    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const report = redactCredential(db, credential.id, { patchSources: true });

    expect(report).toMatchObject({
      renumbered_blocks: 0,
      id_conflicts: 0,
      sources: { patched_files: 1 },
    });

    // Re-ingestion refreshes the exact source identity. The source-backed id is
    // positional, and no retired copy is retained in the durable database.
    await ingestBatchForWorker([transcript], true);
    const after = await indexedBlocks();
    expect(after[0].id).toBe(before[0].id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_structural_blocks").get())
      .toEqual({ count: 0 });
    expect(after[0].content).toBe(`token: ${credentialMaskFor(credential.id)}`);
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

  it("keeps source-backed identities unique through a content-id collision", async () => {
    // Third-pass finding 3. The previous round argued the conflict branch was
    // unreachable because `UNIQUE(conversation_id, position)` guarantees two
    // rows differ in a hashed input. That argument is wrong: the derivation
    // concatenates its inputs unframed, so differing inputs can still produce
    // identical bytes. Assert the ambiguity itself with the reviewer's values
    // before relying on it — no hash collision is involved.
    const shared = { conversation_id: "conv-a", type: "text", timestamp: "2026-08-12T00:00:01Z" };
    expect(conversationBlockId({ ...shared, content: "payload1", position: 2 }))
      .toBe(conversationBlockId({ ...shared, content: "payload", position: 12 }));

    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    // Revoked, so ingest-time masking does not fire and the plaintext lands in
    // the index — the state retroactive redaction exists for.
    revokeCredential(db, credential.id);
    const mask = credentialMaskFor(credential.id);
    const texts = Array.from({ length: 13 }, (_, index) => `filler ${index}`);
    // Same conversation, same type, same timestamp: after the mask rewrites
    // position 12's content to `payload<mask>`, it serializes to exactly what
    // position 2 already serializes to.
    texts[2] = `payload${mask}1`;
    texts[12] = `payload${LEAKED_TOKEN}`;
    const transcript = await writeCodexTranscript(codexAssistantTranscript(texts));
    await triggerTargetedIngest({ transcriptPath: transcript, now: 1_000 });
    expect(await indexedBlocks(false)).toHaveLength(13);

    const report = redactCredential(db, credential.id, { patchSources: true });

    // Source-backed payloads are refreshed from the patched provider file;
    // there is intentionally no transcript body in the DB to inspect here.
    await ingestBatchForWorker([transcript], true);
    const after = await indexedBlocks();
    expect(after[12].content).toBe(`payload${mask}`);
    expect(new Set(after.map((block) => block.id)).size).toBe(13);
    // Source-backed ids are structural identities, so the old unframed content
    // hash collision cannot make either block disappear or steal the other id.
    expect(report).toMatchObject({
      id_conflicts: 0,
      unresolved_id_conflicts: 0,
      sources: { patched_files: 1 },
    });

    // A second forced ingest is idempotent.
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(transcript, future, future);
    await ingestBatchForWorker([transcript], true);

    expect(await indexedBlocks()).toEqual(after);
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
 * Run `onOpen` each time the redaction creates its temp replacement file — the
 * point where the snapshot has been read but nothing has been renamed yet.
 * That is the window a live transcript writer appends into.
 *
 * Matched on the exclusive-create flag, not just the path: the temp file is
 * created exactly once per attempt and never reopened, so one match is one
 * attempt.
 */
function spyOnTempFileOpen(onOpen: () => void) {
  const realOpenSync = fs.openSync.bind(fs);
  return vi.spyOn(fs, "openSync").mockImplementation(((
    target: Parameters<typeof fs.openSync>[0],
    ...rest: unknown[]
  ) => {
    if (typeof target === "string" && target.includes("mandible-redact") && rest[0] === "ax") {
      onOpen();
    }
    return (realOpenSync as (...args: unknown[]) => number)(target, ...rest);
  }) as typeof fs.openSync);
}

/**
 * Spy that identifies the descriptor tail recovery appends through: the one
 * descriptor the temp replacement is created with and kept on until the patch
 * is complete.
 */
function spyOnRecoveryAppendFd(): { spy: ReturnType<typeof vi.spyOn>; fd: () => number | null } {
  const realOpenSync = fs.openSync.bind(fs);
  let recoveryFd: number | null = null;
  const spy = vi.spyOn(fs, "openSync").mockImplementation(((
    target: Parameters<typeof fs.openSync>[0],
    ...rest: unknown[]
  ) => {
    const fd = (realOpenSync as (...args: unknown[]) => number)(target, ...rest);
    if (typeof target === "string" && target.includes("mandible-redact") && rest[0] === "ax") {
      recoveryFd = fd;
    }
    return fd;
  }) as typeof fs.openSync);
  return { spy, fd: () => recoveryFd };
}

/**
 * Spy that identifies the read-only descriptor the redaction holds on the
 * source file — the one that still refers to the inode the rename unlinks, and
 * therefore the only handle the tail accounting can measure against.
 */
function spyOnSourceReadFd(file: string): {
  spy: ReturnType<typeof vi.spyOn>;
  fd: () => number | null;
} {
  const realOpenSync = fs.openSync.bind(fs);
  let sourceFd: number | null = null;
  const spy = vi.spyOn(fs, "openSync").mockImplementation(((
    target: Parameters<typeof fs.openSync>[0],
    ...rest: unknown[]
  ) => {
    const fd = (realOpenSync as (...args: unknown[]) => number)(target, ...rest);
    if (target === file && rest[0] === "r") sourceFd = fd;
    return fd;
  }) as typeof fs.openSync);
  return { spy, fd: () => sourceFd };
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
    let renamed = false;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(((
      from: Parameters<typeof fs.renameSync>[0],
      to: Parameters<typeof fs.renameSync>[1],
    ) => {
      if (to === file) {
        burst();
        renamed = true;
      }
      return realRenameSync(from, to);
    }) as typeof fs.renameSync);
    // Every recovery append provokes another write into the old inode. The
    // append goes through the descriptor the redaction holds on the replacement,
    // so the burst hangs off writes to that descriptor — but only after the
    // rename: that same descriptor carries the pre-rename write of the
    // replacement itself, and bursting there would just be the ordinary
    // changed-source race the pre-rename check already refuses.
    const recovery = spyOnRecoveryAppendFd();
    const realWriteSync = fs.writeSync.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      ...rest: unknown[]
    ) => {
      if (renamed && recovery.fd() !== null && fd === recovery.fd()) burst();
      return (realWriteSync as (...args: unknown[]) => number)(fd, ...rest);
    }) as typeof fs.writeSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      renameSpy.mockRestore();
      recovery.spy.mockRestore();
      writeSpy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(report.sources?.patched_files).toBe(1);
    expect(report.sources?.recovered_tail_bytes ?? 0).toBeGreaterThan(0);
    expect(report.sources?.abandoned_tail_bytes ?? 0).toBeGreaterThan(0);
    // Whatever was recovered is masked; the abandoned remainder never reached
    // the patched file at all.
    expect(fs.readFileSync(file).toString("latin1")).not.toContain(LEAKED_TOKEN);
  });

  /**
   * Append `appended` to `file` from inside renameSync, i.e. onto the inode the
   * rename is about to unlink. That is the only window where the tail exists
   * nowhere but behind the redaction's own descriptor.
   */
  function injectDuringRename(file: string, appended: Buffer, writerFd?: number) {
    const realRenameSync = fs.renameSync.bind(fs);
    let injected = false;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((
      from: Parameters<typeof fs.renameSync>[0],
      to: Parameters<typeof fs.renameSync>[1],
    ) => {
      if (!injected && to === file) {
        injected = true;
        // A descriptor the writer already held, when one is supplied: that is
        // the only way to append to a source whose mode now forbids it, and it
        // is what a running agent actually has.
        if (writerFd === undefined) fs.appendFileSync(file, appended);
        else fs.writeSync(writerFd, appended);
      }
      return realRenameSync(from, to);
    }) as typeof fs.renameSync);
    return { spy, injected: () => injected };
  }

  /**
   * Interfere with the writes tail recovery makes. `mode` truncates the first
   * matching write in half (a short write), fails every matching write
   * outright, or does both in sequence: a partial first write followed by a
   * failing second one, which is the state a rewind has to undo.
   */
  function spyOnTailWrite(
    marker: string,
    mode: "short" | "fail" | "short-then-fail",
    exemptFd: number,
  ) {
    const realWriteSync = fs.writeSync.bind(fs);
    let hits = 0;
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      ...rest: unknown[]
    ) => {
      const offset = typeof rest[0] === "number" ? rest[0] : 0;
      const fullLength = Buffer.isBuffer(buffer) ? buffer.length : 0;
      const length = typeof rest[1] === "number" ? rest[1] : fullLength - offset;
      // The simulated agent's own append carries the marker too; only the
      // redaction's recovery writes are interfered with.
      const isTail = fd !== exemptFd && Buffer.isBuffer(buffer) && buffer.includes(marker);
      if (isTail) {
        hits += 1;
        if (mode === "fail") throw Object.assign(new Error("EIO"), { code: "EIO" });
        if (mode === "short-then-fail" && hits > 1) {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        }
        if (hits === 1) {
          return realWriteSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)));
        }
      }
      return realWriteSync(fd, buffer, offset, length);
    }) as typeof fs.writeSync);
    return { spy, hits: () => hits };
  }

  it("recovers the tail even when the source is read-only", () => {
    // Third-pass finding 1: a 0400 source in a writable directory made the
    // whole recovery path a silent no-op. The replacement inherited 0400, so
    // reopening it to append failed, the loop broke, and the report said
    // recovered=0, abandoned=0 while the old inode's tail went with the
    // unlinked file. The replacement is this code's own file, so it is created
    // owner-writable and the append descriptor is taken before the rename; the
    // original mode is restored once recovery is done.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-readonly.jsonl", original);
    // The writer opened the transcript before it was locked down, exactly as a
    // running agent does; the mode change only stops *new* openers.
    const writerFd = fs.openSync(file, "a");
    fs.chmodSync(file, 0o400);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `{"text":"appended to a read-only source ${LEAKED_TOKEN}"}\n`,
      "latin1",
    );

    const rename = injectDuringRename(file, appended, writerFd);
    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(rename.injected()).toBe(true);
    expect(report.sources).toMatchObject({
      patched_files: 1,
      failed_files: 0,
      recovered_tail_bytes: appended.length,
      abandoned_tail_bytes: 0,
    });
    const mask = credentialMaskFor(credential.id);
    expect(fs.readFileSync(file).toString("latin1")).toBe(
      Buffer.concat([original, appended]).toString("latin1").split(LEAKED_TOKEN).join(mask),
    );
    // The permissive mode existed only for the append; the file the operator
    // gets back is the mode the file had.
    expect(fs.statSync(file).mode & 0o777).toBe(0o400);
  });

  it("finishes a short write instead of counting the remainder as recovered", () => {
    // Third-pass finding 1, second half: writeSync may write fewer bytes than
    // it was given. A single unchecked call left the tail truncated on disk
    // while the report claimed every byte of it was carried over.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-short-write.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `{"text":"short-write-marker padded out so the halves differ ${LEAKED_TOKEN}"}\n`,
      "latin1",
    );

    const writerFd = fs.openSync(file, "a");
    const rename = injectDuringRename(file, appended, writerFd);
    const write = spyOnTailWrite("short-write-marker", "short", writerFd);
    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
      write.spy.mockRestore();
      fs.closeSync(writerFd);
    }

    const mask = credentialMaskFor(credential.id);
    // Every byte of the tail is on disk, not just the first half.
    expect(fs.readFileSync(file).toString("latin1")).toBe(
      Buffer.concat([original, appended]).toString("latin1").split(LEAKED_TOKEN).join(mask),
    );
    // The remainder was written by a second call, not assumed away.
    expect(write.hits()).toBeGreaterThan(1);
    expect(report.sources).toMatchObject({
      patched_files: 1,
      recovered_tail_bytes: appended.length,
      abandoned_tail_bytes: 0,
    });
  });

  it("reports a tail it could not write as abandoned, not as a clean zero", () => {
    // The accounting half of third-pass finding 1: the read offset used to
    // advance before the append was proven, so a failed append reported
    // recovered=0 and abandoned=0 — an operator-visible "nothing to do" over
    // bytes that had just been lost with the unlinked inode.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-write-fail.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `{"text":"drain-marker never lands ${LEAKED_TOKEN}"}\n`,
      "latin1",
    );

    const writerFd = fs.openSync(file, "a");
    const rename = injectDuringRename(file, appended, writerFd);
    const write = spyOnTailWrite("drain-marker", "fail", writerFd);
    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
      write.spy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(rename.injected()).toBe(true);
    expect(write.hits()).toBeGreaterThan(0);
    expect(report.sources).toMatchObject({
      patched_files: 1,
      recovered_tail_bytes: 0,
      abandoned_tail_bytes: appended.length,
    });
    // The patched snapshot is intact and still carries no plaintext; only the
    // tail is missing, and the report says so.
    const mask = credentialMaskFor(credential.id);
    expect(fs.readFileSync(file).toString("latin1")).toBe(
      original.toString("latin1").split(LEAKED_TOKEN).join(mask),
    );
  });

  it("masks a token split across the snapshot and the recovered tail", () => {
    // Third-pass finding 2: the snapshot and the tail were scanned as separate
    // texts. A transcript that ends mid-record with the first characters of a
    // token, plus an appended tail carrying the rest, matched the candidate
    // pattern in neither half — and the byte-faithful join put the working
    // credential back together in the file the redaction had just cleaned.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const head = LEAKED_TOKEN.slice(0, 20);
    const rest = LEAKED_TOKEN.slice(20);
    // No trailing newline: the last record is open, exactly the state of a
    // transcript a writer is in the middle of a line on.
    const original = Buffer.from(
      `{"text":"first ${LEAKED_TOKEN}"}\n{"text":"split ${head}`,
      "latin1",
    );
    const file = writeSourceFile("rollout-seam.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(`${rest}"}\n`, "latin1");

    const rename = injectDuringRename(file, appended);
    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
    }

    expect(rename.injected()).toBe(true);
    const mask = credentialMaskFor(credential.id);
    const patched = fs.readFileSync(file).toString("latin1");
    // The join must not put the credential back together in the clear.
    expect(patched).not.toContain(LEAKED_TOKEN);
    // Nothing is inserted at the seam: the appended bytes continue the open
    // record exactly as they do on the inode the writer still holds.
    expect(patched).toBe(`{"text":"first ${mask}"}\n{"text":"split ${mask}"}\n`);
    expect(report.sources).toMatchObject({
      patched_files: 1,
      failed_files: 0,
      // One span in the snapshot, one reassembled across the seam.
      patched_spans: 2,
      recovered_tail_bytes: appended.length,
      abandoned_tail_bytes: 0,
    });
  });

  it("costs nothing when the seam splice itself fails", () => {
    // Masking across the seam means briefly truncating the snapshot's open
    // final line off the replacement so the joined region can be rewritten. A
    // write that fails after that point must not turn a race into the loss of
    // bytes that were already safely patched: the line goes back exactly as it
    // was, and only the unreachable tail is reported abandoned.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const head = LEAKED_TOKEN.slice(0, 20);
    const rest = LEAKED_TOKEN.slice(20);
    const original = Buffer.from(
      `{"text":"first ${LEAKED_TOKEN}"}\n{"text":"split ${head}`,
      "latin1",
    );
    const file = writeSourceFile("rollout-seam-fail.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(`${rest}","note":"restore-marker"}\n`, "latin1");

    const writerFd = fs.openSync(file, "a");
    const rename = injectDuringRename(file, appended, writerFd);
    const write = spyOnTailWrite("restore-marker", "fail", writerFd);
    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
      write.spy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(write.hits()).toBeGreaterThan(0);
    const mask = credentialMaskFor(credential.id);
    // Exactly the patched snapshot: the open final line survived the attempt.
    expect(fs.readFileSync(file).toString("latin1")).toBe(
      original.toString("latin1").split(LEAKED_TOKEN).join(mask),
    );
    expect(report.sources).toMatchObject({
      patched_files: 1,
      recovered_tail_bytes: 0,
      abandoned_tail_bytes: appended.length,
    });
  });

  it("rewinds a partially written append instead of publishing the fragment", () => {
    // Fourth-pass item 2. `writeAll` can put part of a chunk on disk and then
    // throw — a short write followed by a failing one is exactly that. The old
    // code left the fragment in the published file while reporting the whole
    // chunk abandoned, so the operator's transcript grew a truncated record
    // that no writer ever wrote. Each append is now checkpointed and rewound.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-partial.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `{"text":"partial-marker padded out so the halves differ ${LEAKED_TOKEN}"}\n`,
      "latin1",
    );

    const writerFd = fs.openSync(file, "a");
    const rename = injectDuringRename(file, appended, writerFd);
    const write = spyOnTailWrite("partial-marker", "short-then-fail", writerFd);
    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
      write.spy.mockRestore();
      fs.closeSync(writerFd);
    }

    // Both halves of the interference actually happened.
    expect(write.hits()).toBeGreaterThan(1);
    const mask = credentialMaskFor(credential.id);
    // Byte-verbatim the patched snapshot: no fragment of the failed append.
    expect(fs.readFileSync(file).toString("latin1")).toBe(
      original.toString("latin1").split(LEAKED_TOKEN).join(mask),
    );
    expect(report.sources).toMatchObject({
      patched_files: 1,
      recovered_tail_bytes: 0,
      abandoned_tail_bytes: appended.length,
    });
  });

  it("rewinds a partially written seam splice without duplicating the open line", () => {
    // Fourth-pass item 3, the seam half of the same defect. The splice
    // truncates the snapshot's open final line off the replacement and
    // rewrites it as the head of the joined chunk. When that write failed
    // half-way, the old failure handler appended the saved open line *after*
    // the fragment it never removed, publishing a duplicated, corrupted line.
    // The rewind restores the checkpoint first, so there is nothing to
    // duplicate.
    //
    // This is the restoration-*succeeds* case, deliberately: the marker the
    // fault keys on lives only in the writer's appended bytes, so the saved
    // seam is written back through an undisturbed descriptor. The splice write
    // is faulted after its truncate has already removed the open final line, so
    // finding that line whole in the file at the end is what proves restoration
    // ran rather than proving nothing was ever touched. The two tests below
    // fault the restoration itself.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const head = LEAKED_TOKEN.slice(0, 20);
    const rest = LEAKED_TOKEN.slice(20);
    const original = Buffer.from(
      `{"text":"first ${LEAKED_TOKEN}"}\n{"text":"split ${head}`,
      "latin1",
    );
    const file = writeSourceFile("rollout-seam-partial.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `${rest}","note":"seam-partial-marker padded out so the halves differ"}\n`,
      "latin1",
    );

    const writerFd = fs.openSync(file, "a");
    const rename = injectDuringRename(file, appended, writerFd);
    const write = spyOnTailWrite("seam-partial-marker", "short-then-fail", writerFd);
    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
      write.spy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(write.hits()).toBeGreaterThan(1);
    const mask = credentialMaskFor(credential.id);
    const patched = fs.readFileSync(file).toString("latin1");
    // Exactly the patched snapshot: the open final line appears once, whole.
    expect(patched).toBe(original.toString("latin1").split(LEAKED_TOKEN).join(mask));
    expect(patched.split(`{"text":"split `).length - 1).toBe(1);
    expect(patched).not.toContain(LEAKED_TOKEN);
    expect(report.sources).toMatchObject({
      patched_files: 1,
      recovered_tail_bytes: 0,
      abandoned_tail_bytes: appended.length,
    });
  });

  /**
   * Fault the two writes a failing seam splice makes, told apart by which
   * marker their payload carries.
   *
   * `tailMarker` lives only in the writer's appended bytes, so it identifies
   * the joined chunk the splice writes. `seamMarker` lives in the snapshot's
   * open final line, so it identifies the saved seam the failure path writes
   * back — the payload the fourth-pass seam test never touched, which is why
   * restoration failure went untested. The joined chunk carries both markers
   * and is matched first.
   *
   * `armed` gates everything: the pre-rename write of the replacement contains
   * the whole masked snapshot and therefore both markers, and faulting that
   * would abort the patch long before there is a seam to restore.
   */
  function spyOnSeamWrites(options: {
    tailMarker: string;
    seamMarker: string;
    exemptFd: number;
    armed: () => boolean;
    restore: "short-then-fail" | "pass";
  }) {
    const realWriteSync = fs.writeSync.bind(fs);
    let spliceHits = 0;
    let restoreHits = 0;
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      ...rest: unknown[]
    ) => {
      const offset = typeof rest[0] === "number" ? rest[0] : 0;
      const fullLength = Buffer.isBuffer(buffer) ? buffer.length : 0;
      const length = typeof rest[1] === "number" ? rest[1] : fullLength - offset;
      if (options.armed() && fd !== options.exemptFd && Buffer.isBuffer(buffer)) {
        if (buffer.includes(options.tailMarker)) {
          spliceHits += 1;
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        }
        if (buffer.includes(options.seamMarker)) {
          restoreHits += 1;
          if (options.restore === "short-then-fail") {
            if (restoreHits > 1) throw Object.assign(new Error("EIO"), { code: "EIO" });
            return realWriteSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)));
          }
        }
      }
      return realWriteSync(fd, buffer, offset, length);
    }) as typeof fs.writeSync);
    return { spy, spliceHits: () => spliceHits, restoreHits: () => restoreHits };
  }

  /** A snapshot whose open final line carries `marker` and half a token. */
  function seamFixture(marker: string): { body: Buffer; seam: string; rest: string } {
    const head = LEAKED_TOKEN.slice(0, 20);
    const seam = `{"text":"${marker} split ${head}`;
    return {
      body: Buffer.from(`{"text":"first ${LEAKED_TOKEN}"}\n${seam}`, "latin1"),
      seam,
      rest: LEAKED_TOKEN.slice(20),
    };
  }

  it("publishes no fragment when the seam restoration itself writes partially", () => {
    // Fifth-pass item 1. Restoration used to be a bespoke `writeAll` inside the
    // splice's failure handler, and a partial write there threw into a catch
    // that swallowed it: the replacement kept whichever half of the open final
    // line had landed, and the file was still reported patched. Both writes now
    // go through the same checkpointed primitive, so a restoration that cannot
    // complete leaves the file exactly at the rewind point instead.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const fixture = seamFixture("seam-restore-marker");
    const file = writeSourceFile("rollout-seam-restore-partial.jsonl", fixture.body);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(`${fixture.rest}","note":"tail-write-marker"}\n`, "latin1");

    const writerFd = fs.openSync(file, "a");
    const rename = injectDuringRename(file, appended, writerFd);
    const write = spyOnSeamWrites({
      tailMarker: "tail-write-marker",
      seamMarker: "seam-restore-marker",
      exemptFd: writerFd,
      armed: rename.injected,
      restore: "short-then-fail",
    });
    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
      write.spy.mockRestore();
      fs.closeSync(writerFd);
    }

    // The splice failed and the restoration then wrote half and threw: both
    // halves of the scenario actually happened.
    expect(write.spliceHits()).toBeGreaterThan(0);
    expect(write.restoreHits()).toBeGreaterThan(1);
    const mask = credentialMaskFor(credential.id);
    const patched = fs.readFileSync(file).toString("latin1");
    // Byte-verbatim the checkpoint the restoration started from: the completed
    // records, and not one byte of the seam it could not put back.
    expect(patched).toBe(`{"text":"first ${mask}"}\n`);
    expect(patched).not.toContain(LEAKED_TOKEN);
    expect(patched).not.toContain("seam-restore-marker");
    // Honest accounting: the seam is no longer on the replacement, so it is
    // counted with the tail as bytes that live only in the unlinked inode.
    expect(report.sources).toMatchObject({
      patched_files: 1,
      recovered_tail_bytes: 0,
      abandoned_tail_bytes: appended.length + fixture.seam.length,
    });
  });

  it("counts a seam whose restoration fsync failed as abandoned, not as committed", () => {
    // Fifth-pass item 1, the accounting half: the old handler advanced
    // `committed` back over the seam as soon as the restoration write returned,
    // before its fsync. An fsync that then failed left the file reported as
    // holding bytes nothing had made durable, so the abandoned count came out
    // short by exactly the open final line. Offsets now move only after the
    // primitive's fsync returns.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const fixture = seamFixture("seam-fsync-marker");
    const file = writeSourceFile("rollout-seam-restore-fsync.jsonl", fixture.body);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(`${fixture.rest}","note":"tail-fsync-marker"}\n`, "latin1");

    const writerFd = fs.openSync(file, "a");
    const rename = injectDuringRename(file, appended, writerFd);
    const write = spyOnSeamWrites({
      tailMarker: "tail-fsync-marker",
      seamMarker: "seam-fsync-marker",
      exemptFd: writerFd,
      armed: rename.injected,
      restore: "pass",
    });
    // Armed by the splice failure, so the only fsyncs it sees are the ones the
    // rollback and the restoration make.
    const realFsyncSync = fs.fsyncSync.bind(fs);
    let fsyncFailures = 0;
    const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      if (write.spliceHits() > 0) {
        fsyncFailures += 1;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return realFsyncSync(fd);
    }) as typeof fs.fsyncSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      rename.spy.mockRestore();
      write.spy.mockRestore();
      fsyncSpy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(write.restoreHits()).toBe(1);
    expect(fsyncFailures).toBeGreaterThan(0);
    // The seam is counted with the tail, not written off as committed on the
    // strength of a write whose fsync never returned.
    expect(report.sources).toMatchObject({
      patched_files: 1,
      recovered_tail_bytes: 0,
      abandoned_tail_bytes: appended.length + fixture.seam.length,
    });
    // The write landed but was never made durable, so it is rolled back like
    // any other failed append rather than kept and called committed.
    const mask = credentialMaskFor(credential.id);
    expect(fs.readFileSync(file).toString("latin1")).toBe(`{"text":"first ${mask}"}\n`);
  });

  it("leaves the seam alone when the splice never removed it", () => {
    // Sixth-pass item 1, first half. A checkpointed append starts by sizing the
    // replacement, and that fstat can fail on its own — an EIO on the
    // descriptor, nothing to do with the payload. The fifth-pass primitive
    // answered that with the same `false` it used for a failed-and-rewound
    // write, so the caller ran its seam restoration over a file whose seam had
    // never been taken off: the open final line was written a second time and
    // the duplicate was published as a patched file. The primitive now says
    // `unchanged`, which is a different instruction: there is nothing to
    // restore.
    //
    // The failure is deliberately transient — exactly one fstat on the
    // replacement's descriptor fails — so the restoration's own checkpoint
    // would succeed. That is what makes the duplicate reachable at all, and
    // what keeps this test from passing for the wrong reason.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const fixture = seamFixture("seam-intact-marker");
    const file = writeSourceFile("rollout-seam-checkpoint.jsonl", fixture.body);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(`${fixture.rest}","note":"tail-intact-marker"}\n`, "latin1");

    const writerFd = fs.openSync(file, "a");
    const recovery = spyOnRecoveryAppendFd();
    const rename = injectDuringRename(file, appended, writerFd);
    const realFstatSync = fs.fstatSync.bind(fs);
    let checkpointFailures = 0;
    const fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation(((
      fd: number,
      ...rest: unknown[]
    ) => {
      // Only the replacement's descriptor, only after the rename, and only
      // once: the splice's checkpoint, and nothing else.
      if (rename.injected() && fd === recovery.fd() && checkpointFailures === 0) {
        checkpointFailures += 1;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return (realFstatSync as (...args: unknown[]) => fs.Stats)(fd, ...rest);
    }) as typeof fs.fstatSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      recovery.spy.mockRestore();
      rename.spy.mockRestore();
      fstatSpy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(rename.injected()).toBe(true);
    expect(checkpointFailures).toBe(1);
    const mask = credentialMaskFor(credential.id);
    const patched = fs.readFileSync(file).toString("latin1");
    // Byte-verbatim the patched snapshot: the file was never changed by the
    // append that could not take its checkpoint.
    expect(patched).toBe(fixture.body.toString("latin1").split(LEAKED_TOKEN).join(mask));
    // The open final line appears exactly once — the duplicate is the defect.
    expect(patched.split("seam-intact-marker").length - 1).toBe(1);
    expect(patched).not.toContain(LEAKED_TOKEN);
    // A file with no fragment and no duplicate is honestly patched; the tail
    // that never made it across is the only loss, and it is reported.
    expect(report.sources).toMatchObject({
      patched_files: 1,
      indeterminate_files: 0,
      recovered_tail_bytes: 0,
      abandoned_tail_bytes: appended.length,
    });
  });

  it("reports a file whose rollback failed as indeterminate rather than patched", () => {
    // Sixth-pass item 1, second half. When a splice writes part of its payload
    // and then throws, the rollback truncate is what puts the file back at the
    // checkpoint — and that truncate can fail too. The fifth-pass primitive
    // returned the same `false` there as for a clean rewind, so the caller
    // restored the seam on top of the surviving fragment and the file was
    // reported patched. The state is genuinely unknown, so it is now reported
    // as such: no restoration, no `patched`, and a bucket that tells the
    // operator to look at the file.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const fixture = seamFixture("seam-rollback-marker");
    const file = writeSourceFile("rollout-seam-rollback.jsonl", fixture.body);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `${fixture.rest}","note":"tail-rollback-marker padded out so the halves differ"}\n`,
      "latin1",
    );

    const writerFd = fs.openSync(file, "a");
    const recovery = spyOnRecoveryAppendFd();
    const rename = injectDuringRename(file, appended, writerFd);
    // A partial write followed by a failing one: the state a rollback exists to
    // undo.
    const write = spyOnTailWrite("tail-rollback-marker", "short-then-fail", writerFd);
    const realFtruncateSync = fs.ftruncateSync.bind(fs);
    let truncates = 0;
    const truncateSpy = vi.spyOn(fs, "ftruncateSync").mockImplementation(((
      fd: number,
      length?: number,
    ) => {
      if (fd === recovery.fd()) {
        truncates += 1;
        // The first truncate is the splice's own rewind, which must succeed or
        // there is no fragment to be uncertain about. The second is the
        // rollback, and it is the one that fails.
        if (truncates > 1) throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return realFtruncateSync(fd, length);
    }) as typeof fs.ftruncateSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      recovery.spy.mockRestore();
      rename.spy.mockRestore();
      write.spy.mockRestore();
      truncateSpy.mockRestore();
      fs.closeSync(writerFd);
    }

    // Every step of the scenario really happened: a partial write, a failing
    // second write, and a rollback that could not undo the first.
    expect(write.hits()).toBeGreaterThan(1);
    expect(truncates).toBeGreaterThan(1);
    expect(report.sources).toMatchObject({
      patched_files: 0,
      indeterminate_files: 1,
      failed_files: 0,
      patched_spans: 0,
    });
    const mask = credentialMaskFor(credential.id);
    const onDisk = fs.readFileSync(file).toString("latin1");
    // The file really is in neither state a report may claim: not the original,
    // and not the cleanly patched snapshot. Calling it patched would be false.
    expect(onDisk).not.toBe(fixture.body.toString("latin1"));
    expect(onDisk).not.toBe(fixture.body.toString("latin1").split(LEAKED_TOKEN).join(mask));
    expect(onDisk.startsWith(`{"text":"first ${mask}"}\n`)).toBe(true);
    // Whatever the fragment is, it is masked bytes: an uncertain file is still
    // never a file this command put plaintext back into.
    expect(onDisk).not.toContain(LEAKED_TOKEN);
  });

  it("reports a tail it could not measure as unknown rather than as zero", () => {
    // Sixth-pass item 2. Recovery ends when the old inode cannot be sized, and
    // the settlement then measured "how much never made it across" against the
    // same unreachable stat. Its catch produced 0, so a persistent EIO over a
    // writer that had appended bytes rendered as `abandoned: 0` — a clean
    // "nothing to do" over bytes that went with the unlinked inode. Unknown is
    // now reported as unknown.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-tail-unknown.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `{"text":"a tail nobody can measure ${LEAKED_TOKEN}"}\n`,
      "latin1",
    );

    const writerFd = fs.openSync(file, "a");
    const source = spyOnSourceReadFd(file);
    const rename = injectDuringRename(file, appended, writerFd);
    // Persistent, on the descriptor that is the only remaining handle on the
    // replaced inode: neither the recovery loop nor the settlement can size it.
    const realFstatSync = fs.fstatSync.bind(fs);
    let statFailures = 0;
    const fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation(((
      fd: number,
      ...rest: unknown[]
    ) => {
      if (rename.injected() && fd === source.fd()) {
        statFailures += 1;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return (realFstatSync as (...args: unknown[]) => fs.Stats)(fd, ...rest);
    }) as typeof fs.fstatSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      source.spy.mockRestore();
      rename.spy.mockRestore();
      fstatSpy.mockRestore();
      fs.closeSync(writerFd);
    }

    expect(rename.injected()).toBe(true);
    // Both the loop's stat and the settlement's stat failed.
    expect(statFailures).toBeGreaterThan(1);
    expect(report.sources).toMatchObject({
      patched_files: 1,
      recovered_tail_bytes: 0,
      // Not a claim that nothing was left behind: a claim that it is unknown.
      unknown_tail_files: 1,
      abandoned_tail_bytes: 0,
    });
    // The snapshot itself is patched and intact; only the tail is unaccounted.
    const mask = credentialMaskFor(credential.id);
    expect(fs.readFileSync(file).toString("latin1")).toBe(
      original.toString("latin1").split(LEAKED_TOKEN).join(mask),
    );
  });

  it("still closes the replacement and accounts for the tail when the old inode read fails", () => {
    // Fifth-pass item 2. `readExactly` lets `fs.readSync` throw, and tail
    // recovery calls it after the rename. An EIO there used to travel straight
    // out of the command: past the mode restore, past the close of the
    // descriptor the replacement was created with, and past every line of the
    // report — so the operator got a stack trace while a published file sat
    // there with its creation mode, a leaked descriptor, and no statement about
    // the bytes that never made it across. One outer try/finally owns the
    // descriptor from the open to the close, and the recovery accounting lives
    // with the caller so it settles into a report either way.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-tail-eio.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });
    const appended = Buffer.from(
      `{"text":"tail nobody can read ${LEAKED_TOKEN}"}\n`,
      "latin1",
    );

    const writerFd = fs.openSync(file, "a");
    const recovery = spyOnRecoveryAppendFd();
    const rename = injectDuringRename(file, appended, writerFd);
    // Armed by the rename, so the snapshot read and the pre-rename
    // re-verification are untouched and the only read left is recovery's.
    const realReadSync = fs.readSync.bind(fs);
    let failedReads = 0;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      ...rest: unknown[]
    ) => {
      if (rename.injected() && failedReads === 0) {
        failedReads += 1;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return (realReadSync as (...args: unknown[]) => number)(fd, ...rest);
    }) as typeof fs.readSync);
    const realFchmodSync = fs.fchmodSync.bind(fs);
    let modeAttempts = 0;
    const fchmodSpy = vi.spyOn(fs, "fchmodSync").mockImplementation(((
      fd: number,
      mode: Parameters<typeof fs.fchmodSync>[1],
    ) => {
      modeAttempts += 1;
      return realFchmodSync(fd, mode);
    }) as typeof fs.fchmodSync);
    const realCloseSync = fs.closeSync.bind(fs);
    const closed: number[] = [];
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
      closed.push(fd);
      return realCloseSync(fd);
    }) as typeof fs.closeSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      recovery.spy.mockRestore();
      rename.spy.mockRestore();
      readSpy.mockRestore();
      fchmodSpy.mockRestore();
      closeSpy.mockRestore();
      fs.closeSync(writerFd);
    }

    // The read really did fail, and the command still returned a report.
    expect(failedReads).toBe(1);
    // The descriptor the replacement was created with is closed, and the mode
    // restore was attempted rather than skipped.
    expect(recovery.fd()).not.toBeNull();
    expect(closed).toContain(recovery.fd());
    expect(modeAttempts).toBe(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Structured accounting instead of a bare throw: nothing was recovered, and
    // the tail is reported as still living only in the unlinked inode.
    expect(report.sources).toMatchObject({
      patched_files: 1,
      failed_files: 0,
      recovered_tail_bytes: 0,
      abandoned_tail_bytes: appended.length,
    });
    // No partial garbage: byte-verbatim the patched snapshot.
    const mask = credentialMaskFor(credential.id);
    expect(fs.readFileSync(file).toString("latin1")).toBe(
      original.toString("latin1").split(LEAKED_TOKEN).join(mask),
    );
  });

  it("never publishes an empty file when the temp path is unlinked under it", () => {
    // Fourth-pass item 1, behaviourally. The replacement used to be closed
    // after it was written and reopened by path in append mode; the mode was
    // set by path in between. Anything that unlinked the temp path in that
    // window — a stray cleaner, another process in a shared directory — made
    // the reopen *create* an empty file, which the rename then published over
    // the operator's transcript. The unlink is injected at the mode step,
    // which is the last path operation before the rename in the old shape and
    // a descriptor operation after it in this one.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-unlinked-temp.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });

    let unlinked = 0;
    const dropTemp = (): void => {
      for (const entry of fs.readdirSync(tempDir)) {
        if (!entry.includes("mandible-redact")) continue;
        try {
          fs.unlinkSync(path.join(tempDir, entry));
          unlinked += 1;
        } catch {
          // Already gone; nothing to take away.
        }
      }
    };
    const realChmodSync = fs.chmodSync.bind(fs);
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(((
      target: Parameters<typeof fs.chmodSync>[0],
      mode: Parameters<typeof fs.chmodSync>[1],
    ) => {
      const result = realChmodSync(target, mode);
      if (typeof target === "string" && target.includes("mandible-redact")) dropTemp();
      return result;
    }) as typeof fs.chmodSync);
    const realFchmodSync = fs.fchmodSync.bind(fs);
    const fchmodSpy = vi.spyOn(fs, "fchmodSync").mockImplementation(((
      fd: number,
      mode: Parameters<typeof fs.fchmodSync>[1],
    ) => {
      const result = realFchmodSync(fd, mode);
      dropTemp();
      return result;
    }) as typeof fs.fchmodSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      chmodSpy.mockRestore();
      fchmodSpy.mockRestore();
    }

    const mask = credentialMaskFor(credential.id);
    const onDisk = fs.readFileSync(file).toString("latin1");
    // Either outcome is honest — the patch landed, or it did not and the
    // original is still there. An empty file is neither.
    expect([
      original.toString("latin1"),
      original.toString("latin1").split(LEAKED_TOKEN).join(mask),
    ]).toContain(onDisk);
    expect(onDisk.length).toBeGreaterThan(0);
    expect(report.sources?.candidate_files).toBe(1);
  });

  it("keeps one descriptor on the replacement instead of reopening it by path", () => {
    // The structural half of fourth-pass item 1: the reason the behaviour
    // above holds is that nothing in this module reopens a file it already
    // holds. A future edit that adds a reopen would restore the window
    // silently, so the file's own open/chmod surface is asserted here — a
    // deliberately brittle check, because every entry on it needs review.
    const modulePath = path.join(process.cwd(), "src", "credential-redaction.ts");
    expect(fs.existsSync(modulePath)).toBe(true);
    const source = fs.readFileSync(modulePath, "utf8");
    expect(source.match(/fs\.openSync\([^)]*\)/g)).toEqual([
      // The source, opened once and held across the whole cycle.
      'fs.openSync(filePath, "r")',
      // The replacement, created once and held through rename, tail appends,
      // and the mode restore.
      'fs.openSync(tempPath, "ax", finalMode)',
      // Bounded discovery uses its own read-only descriptor and closes it
      // before any candidate file enters the rewrite cycle.
      'fs.openSync(filePath, "r")',
    ]);
    // Mode changes go through the held descriptor, never through a path that
    // may name a different file by then.
    expect(source).not.toMatch(/fs\.chmodSync\(/);
    expect(source).toMatch(/fs\.fchmodSync\(outFd, finalMode\)/);
  });

  it("reports a mode it could not restore instead of swallowing the failure", () => {
    // Fourth-pass item 1, third clause: the original permissions used to be
    // restored inside a bare try/catch, so a file left owner-writable by a
    // security command was reported as cleanly patched. The bytes are still
    // the right outcome, so the file stays patched — but the operator is told.
    makeAgent();
    const credential = registerToken("mandible-agent-codex", LEAKED_TOKEN);
    const original = transcriptBytes(LEAKED_TOKEN);
    const file = writeSourceFile("rollout-mode-fail.jsonl", original);
    seedConversation("conv-a", { sourcePath: file, blocks: [`in db: ${LEAKED_TOKEN}`] });

    let attempts = 0;
    const fchmodSpy = vi.spyOn(fs, "fchmodSync").mockImplementation((() => {
      attempts += 1;
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }) as typeof fs.fchmodSync);

    let report;
    try {
      report = redactCredential(db, credential.id, { patchSources: true });
    } finally {
      fchmodSpy.mockRestore();
    }

    expect(attempts).toBe(1);
    expect(report.sources).toMatchObject({
      patched_files: 1,
      failed_files: 0,
      mode_restore_failed_files: 1,
    });
    const mask = credentialMaskFor(credential.id);
    expect(fs.readFileSync(file).toString("latin1")).toBe(
      original.toString("latin1").split(LEAKED_TOKEN).join(mask),
    );
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
    expect((await indexedBlocks())[0].content).toBe(`token: ${credentialMaskFor(credential.id)}`);
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
