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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { compressContent, decompressContent } from "../src/compression.js";
import { ingestBatchForWorker, triggerTargetedIngest } from "../src/ingestion.js";
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
  content: string;
}

function storedBlocks(): StoredBlock[] {
  return (db
    .prepare(
      `SELECT id, conversation_id, position, content, compressed
       FROM conversation_blocks ORDER BY conversation_id, position`,
    )
    .all() as Array<{
      id: string;
      conversation_id: string;
      position: number;
      content: Buffer | string;
      compressed: number;
    }>).map((row) => ({
      id: row.id,
      conversation_id: row.conversation_id,
      position: row.position,
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
