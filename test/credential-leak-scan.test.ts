// Transcript credential scanning (issue 71a287e).
//
// Covers the four things that make the feature trustworthy: a pattern match
// alone is not a detection, a real active credential is, the matched plaintext
// is never persisted, and the revocation policy only auto-revokes a hypothetical
// future persisted session-scoped shape. Current wrap-session tokens are
// in-memory and deliberately invisible here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db } from "../src/db.js";
import { compressContent } from "../src/compression.js";
import { addCredential, createUser, listCredentials } from "../src/users/store.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "../src/client-auth/tokens.js";
import { loadOrCreatePepper } from "../src/client-auth/secret-store.js";
import {
  backfillCredentialLeakScan,
  CREDENTIAL_LEAK_EVENT_TYPE,
  credentialMaskFor,
  extractTokenCandidates,
  MAX_CANDIDATES_PER_TEXT,
  matchActiveCredential,
  redactCredentialLeaksInBlocks,
  resetCredentialLeakScanCache,
  scanBlocksForCredentialLeaks,
  unverifiedCredentialMask,
} from "../src/credential-leak-scan.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;
let pepper = "";

const REAL_TOKEN = `${API_TOKEN_PREFIX}${"R".repeat(43)}`;
const FAKE_TOKEN = `${API_TOKEN_PREFIX}${"F".repeat(43)}`;

beforeEach(() => {
  resetCredentialLeakScanCache();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-leak-scan-"));
  db = migratedMemoryDb();
  pepper = loadOrCreatePepper(db, path.join(tempDir, "client-auth"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  resetCredentialLeakScanCache();
});

function makeUser(slug = "mandible-agent-claude") {
  return createUser(db, { slug, kind: "agent", display_name: "Agent Claude" });
}

/** Register a credential for `token` exactly as minting would. */
function registerToken(
  userSlug: string,
  token: string,
  opts: { label?: string; metadata?: Record<string, unknown> } = {},
) {
  return addCredential(db, userSlug, {
    type: "api_token",
    fingerprint: fingerprintForToken(pepper, token),
    label: opts.label ?? "agent pat",
    metadata: opts.metadata,
  });
}

function webhookRows() {
  return db
    .prepare("SELECT * FROM webhook_events WHERE event_type = ?")
    .all(CREDENTIAL_LEAK_EVENT_TYPE) as Array<{
      id: string;
      title: string | null;
      data_json: string;
      priority: string;
      status: string;
    }>;
}

function seedConversation(
  conversationId: string,
  blocks: Array<{ content: string; position: number }>,
  meta: { sessionId?: string; title?: string } = {},
) {
  db.prepare(
    `INSERT INTO conversations
       (id, source, source_path, source_hash, source_mtime, title, summary,
        started_at, ended_at, block_count, session_id, created_at, updated_at)
     VALUES (?, 'claude_code', ?, 'hash', 0, ?, NULL,
             '2026-07-25T00:00:00Z', '2026-07-25T01:00:00Z', ?, ?,
             datetime('now'), datetime('now'))`,
  ).run(
    conversationId,
    `/tmp/${conversationId}.jsonl`,
    meta.title ?? "Seeded transcript",
    blocks.length,
    meta.sessionId ?? `session-${conversationId}`,
  );
  for (const block of blocks) {
    db.prepare(
      `INSERT INTO conversation_blocks
         (id, conversation_id, type, role, content, position, timestamp,
          parent_id, metadata_json, compressed)
       VALUES (?, ?, 'text', 'assistant', ?, ?, NULL, NULL, '{}', 1)`,
    ).run(
      `${conversationId}-b${block.position}`,
      conversationId,
      compressContent(block.content),
      block.position,
    );
  }
}

describe("candidate extraction", () => {

  it("extracts the exact token prefix even when more base64url text follows", () => {
    expect(extractTokenCandidates(`${REAL_TOKEN}A`)).toEqual([REAL_TOKEN]);
  });
});

describe("hash verification", () => {

  it("rejects a revoked credential's token", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN);
    db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(credential.id);
    expect(matchActiveCredential(db, pepper, REAL_TOKEN)).toBeNull();
  });
});

describe("block scanning", () => {
  it("records exactly one alert for a real leaked credential", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN, { label: "agent pat" });

    const { detections } = scanBlocksForCredentialLeaks(
      db,
      [
        { content: "harmless", position: 0 },
        { content: `oops: ${REAL_TOKEN}`, position: 1 },
        { content: `again: ${REAL_TOKEN}`, position: 2 },
      ],
      { conversation_id: "conv-1", session_id: "sess-1", source: "claude_code" },
      { pepper },
    );

    expect(detections).toHaveLength(1);
    expect(detections[0].credential.credential_id).toBe(credential.id);
    expect(detections[0].location.block_position).toBe(1);
    expect(detections[0].new_event).toBe(true);
    expect(webhookRows()).toHaveLength(1);
  });

  it("produces no event for a pattern match that is not a credential", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);

    const { detections } = scanBlocksForCredentialLeaks(
      db,
      [{ content: `example token ${FAKE_TOKEN}`, position: 0 }],
      { conversation_id: "conv-1" },
      { pepper },
    );

    expect(detections).toEqual([]);
    expect(webhookRows()).toEqual([]);
  });

  it("does not duplicate the alert when the same transcript is re-scanned", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);
    const args = [
      db,
      [{ content: REAL_TOKEN, position: 0 }],
      { conversation_id: "conv-1" },
      { pepper },
    ] as const;

    scanBlocksForCredentialLeaks(...args);
    const second = scanBlocksForCredentialLeaks(...args);

    expect(second.detections).toHaveLength(1);
    expect(second.detections[0].new_event).toBe(false);
    expect(webhookRows()).toHaveLength(1);
  });

  it("finds a real token after more than 64 distinct decoys", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);
    const decoys = Array.from(
      { length: 65 },
      (_, index) => `${API_TOKEN_PREFIX}${index.toString(36).padStart(43, "0")}`,
    );
    const result = scanBlocksForCredentialLeaks(
      db,
      [{ content: `${decoys.join(" ")} ${REAL_TOKEN}`, position: 0 }],
      { conversation_id: "conv-decoys" },
      { pepper },
    );

    expect(result.truncated).toBe(false);
    expect(result.detections).toHaveLength(1);
  });

  it("reports truncation after the 4096-distinct-candidate bound", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);
    const decoys = Array.from(
      { length: MAX_CANDIDATES_PER_TEXT + 1 },
      (_, index) => `${API_TOKEN_PREFIX}${index.toString(36).padStart(43, "0")}`,
    );
    const result = scanBlocksForCredentialLeaks(
      db,
      [{ content: decoys.join(" "), position: 0 }],
      { conversation_id: "conv-pathological" },
      { pepper },
    );

    expect(result.truncated).toBe(true);
    expect(result.detections).toEqual([]);
  });
});

describe("no plaintext is persisted", () => {
  it("keeps the token out of the event row, its payload, and the credential table", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);

    scanBlocksForCredentialLeaks(
      db,
      [{ content: `leaked ${REAL_TOKEN}`, position: 3 }],
      { conversation_id: "conv-1", session_id: "sess-1", conversation_title: "A chat" },
      { pepper },
    );

    const rows = webhookRows();
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(REAL_TOKEN);
    expect(serialized).not.toContain(REAL_TOKEN.slice(API_TOKEN_PREFIX.length));

    const payload = JSON.parse(rows[0].data_json) as Record<string, unknown>;
    expect(Object.values(payload).some((value) => String(value).includes(REAL_TOKEN))).toBe(false);
    expect(payload.conversation_id).toBe("conv-1");
    expect(payload.block_position).toBe(3);

    // Nothing anywhere else in the DB gained the plaintext either.
    const credentialDump = JSON.stringify(
      db.prepare("SELECT * FROM user_credentials").all(),
    );
    expect(credentialDump).not.toContain(REAL_TOKEN);
  });
});

describe("revocation policy", () => {

  it("alerts but never revokes a long-lived PAT", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN, { label: "agent pat" });

    const { detections } = scanBlocksForCredentialLeaks(
      db,
      [{ content: REAL_TOKEN, position: 0 }],
      { conversation_id: "conv-1" },
      { pepper },
    );

    expect(detections[0].credential.session_scoped).toBe(false);
    expect(detections[0].revoked).toBe(false);
    const stored = listCredentials(db, "mandible-agent-claude").find((r) => r.id === credential.id);
    expect(stored?.status).toBe("active");

    const payload = JSON.parse(webhookRows()[0].data_json);
    expect(payload.auto_revoked).toBe(false);
    expect(payload.policy).toBe("long_lived_pat_alert_only");
    expect(payload.remediation.mint).toBe("mandible user token mint mandible-agent-claude --store");
    expect(payload.remediation.revoke).toBe(`mandible user token revoke ${credential.id}`);
  });
});

describe("backfill over the existing index", () => {
  it("finds a live PAT sitting in an already-indexed transcript", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN, { label: "agent pat" });
    seedConversation("conv-old", [
      { content: "ordinary message", position: 0 },
      { content: `here it is: ${REAL_TOKEN}`, position: 1 },
    ], { sessionId: "sess-old", title: "Old transcript" });
    seedConversation("conv-clean", [{ content: `decoy ${FAKE_TOKEN}`, position: 0 }]);

    const result = backfillCredentialLeakScan(db, { pepper });

    expect(result.scanned_blocks).toBe(3);
    expect(result.scanned_conversations).toBe(2);
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].credential.credential_id).toBe(credential.id);
    expect(result.detections[0].location.conversation_id).toBe("conv-old");
    expect(result.detections[0].location.conversation_title).toBe("Old transcript");
    expect(result.detections[0].location.session_id).toBe("sess-old");
    expect(result.detections[0].location.block_position).toBe(1);
    expect(webhookRows()).toHaveLength(1);
    expect(JSON.stringify(webhookRows())).not.toContain(REAL_TOKEN);
  });

  it("honours dry-run: reports without recording or revoking", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN, {
      metadata: { scope: "session" },
    });
    seedConversation("conv-old", [{ content: REAL_TOKEN, position: 0 }]);

    const result = backfillCredentialLeakScan(db, { pepper, record: false });

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].revoked).toBe(false);
    expect(webhookRows()).toEqual([]);
    const stored = listCredentials(db, "mandible-agent-claude").find((r) => r.id === credential.id);
    expect(stored?.status).toBe("active");
  });
});

// --- Metadata surfaces (issue b3e4a09, review finding 1) ---------------------

describe("block metadata masking", () => {
  it("masks the token in metadata as well as content", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN);
    // Shaped like what the parsers actually emit: a tool call whose arguments
    // and short output are duplicated out of the text and into metadata.
    const blocks = [{
      content: `curl -H "Authorization: Bearer ${REAL_TOKEN}"`,
      position: 0,
      metadata: {
        tool_name: "Bash",
        tool_input: { command: `curl -H "Authorization: Bearer ${REAL_TOKEN}"` },
        tool_output: `nope, ${FAKE_TOKEN} is not real`,
      },
    }];

    const result = redactCredentialLeaksInBlocks(
      db,
      blocks,
      { conversation_id: "conv-meta" },
      { pepper },
    );

    const mask = credentialMaskFor(credential.id);
    expect(result.redacted_spans).toBe(2);
    expect(result.redacted_blocks).toBe(1);
    expect(blocks[0].content).toBe(`curl -H "Authorization: Bearer ${mask}"`);
    const metadata = JSON.stringify(blocks[0].metadata);
    expect(metadata).not.toContain(REAL_TOKEN);
    expect(metadata).toContain(mask);
    // A lookalike elsewhere in the same metadata object is left alone.
    expect(metadata).toContain(FAKE_TOKEN);
    expect(result.detections).toHaveLength(1);
  });
});

// --- Fail-closed masking (issue b3e4a09, review findings 2 and 3) -------------

/** A database whose `prepare` throws for one statement, exactly as SQLITE_BUSY would. */
function dbFailingOn(sqlFragment: string): Db {
  return {
    prepare(sql: string) {
      if (sql.includes(sqlFragment)) {
        const error = new Error("SQLITE_BUSY: database is locked");
        (error as Error & { code?: string }).code = "SQLITE_BUSY";
        throw error;
      }
      return db.prepare(sql);
    },
  } as unknown as Db;
}

function decoyTokens(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${API_TOKEN_PREFIX}${index.toString(36).padStart(43, "0")}`,
  );
}

describe("fail-closed masking", () => {
  it("masks the unverified overflow instead of letting it through the budget", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);
    // The bypass the review described: fill the verification budget with
    // lookalikes, then hide a live PAT behind them.
    const decoys = decoyTokens(MAX_CANDIDATES_PER_TEXT);
    const blocks = [{ content: `${decoys.join(" ")} ${REAL_TOKEN}`, position: 0 }];

    const result = redactCredentialLeaksInBlocks(
      db,
      blocks,
      { conversation_id: "conv-overflow" },
      { pepper },
    );

    expect(result.truncated).toBe(true);
    expect(result.unverified_spans).toBe(1);
    expect(blocks[0].content).not.toContain(REAL_TOKEN);
    expect(blocks[0].content).toBe(`${decoys.join(" ")} ${unverifiedCredentialMask(1)}`);
    // Honest limitation: the overflow span was never verified, so it is masked
    // but cannot be attributed to a credential and raises no alert.
    expect(result.detections).toEqual([]);
  });

  it("masks conservatively when candidate verification throws", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);
    const blocks = [{
      content: `oops ${REAL_TOKEN}`,
      position: 0,
      metadata: { tool_input: REAL_TOKEN },
    }];

    const result = redactCredentialLeaksInBlocks(
      dbFailingOn("fingerprint = ?"),
      blocks,
      { conversation_id: "conv-verify-fail" },
      { pepper },
    );

    expect(result.verification_failed).toBe(true);
    expect(result.unverified_spans).toBe(2);
    expect(blocks[0].content).toBe(`oops ${unverifiedCredentialMask(1)}`);
    expect(JSON.stringify(blocks[0].metadata))
      .toBe(JSON.stringify({ tool_input: unverifiedCredentialMask(1) }));
    expect(webhookRows()).toEqual([]);
  });

  it("still masks when the alert insert fails, and reports the lost alert", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN);
    const blocks = [{ content: `oops ${REAL_TOKEN}`, position: 0 }];

    const result = redactCredentialLeaksInBlocks(
      dbFailingOn("INSERT OR IGNORE INTO webhook_events"),
      blocks,
      { conversation_id: "conv-alert-fail" },
      { pepper },
    );

    // Masking is not conditional on the alert landing: the block is clean, the
    // alert is counted as lost, and the backfill sweep can re-detect it.
    expect(blocks[0].content).toBe(`oops ${credentialMaskFor(credential.id)}`);
    expect(result.alert_failures).toBe(1);
    expect(result.detections).toEqual([]);
    expect(result.verification_failed).toBe(false);
    expect(webhookRows()).toEqual([]);
  });
});
