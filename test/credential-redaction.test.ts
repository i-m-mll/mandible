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

import { setDb, type Db } from "../src/db.js";
import { compressContent, decompressContent } from "../src/compression.js";
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
  CREDENTIAL_LEAK_EVENT_TYPE,
  credentialMaskFor,
  MAX_CANDIDATES_PER_TEXT,
  resetCredentialLeakScanCache,
} from "../src/credential-leak-scan.js";
import { redactCredential } from "../src/credential-redaction.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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

  db = migratedMemoryDb();
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
});
