// Transcript credential scanning (issue 71a287e).
//
// Covers the four things that make the feature trustworthy: a pattern match
// alone is not a detection, a real active credential is, the matched plaintext
// is never persisted, and the revocation policy only auto-revokes session-scoped
// ephemeral credentials.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { compressContent } from "../src/compression.js";
import { addCredential, createUser, listCredentials } from "../src/users/store.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "../src/client-auth/tokens.js";
import { loadOrCreatePepper } from "../src/client-auth/secret-store.js";
import {
  backfillCredentialLeakScan,
  CREDENTIAL_LEAK_EVENT_TYPE,
  extractTokenCandidates,
  isSessionScopedCredential,
  matchActiveCredential,
  recordCredentialLeak,
  remediationFor,
  resetCredentialLeakScanCache,
  scanBlocksForCredentialLeaks,
} from "../src/credential-leak-scan.js";

let tempDir = "";
let db: Db;
let pepper = "";

const REAL_TOKEN = `${API_TOKEN_PREFIX}rEaLtOkEn-value_0123456789`;
const FAKE_TOKEN = `${API_TOKEN_PREFIX}notAnActualCredential_9876`;

beforeEach(() => {
  resetCredentialLeakScanCache();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-leak-scan-"));
  db = openDb(path.join(tempDir, "mandible.db"));
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
  it("finds prefixed candidates and de-duplicates them", () => {
    const text = `here is ${REAL_TOKEN} and again ${REAL_TOKEN} plus ${FAKE_TOKEN}`;
    expect(extractTokenCandidates(text).sort()).toEqual([FAKE_TOKEN, REAL_TOKEN].sort());
  });

  it("ignores text without the prefix", () => {
    expect(extractTokenCandidates("no secrets here")).toEqual([]);
    expect(extractTokenCandidates(null)).toEqual([]);
  });
});

describe("hash verification", () => {
  it("confirms a candidate that matches an active credential", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN, { label: "agent pat" });

    const match = matchActiveCredential(db, pepper, REAL_TOKEN);
    expect(match).not.toBeNull();
    expect(match?.credential_id).toBe(credential.id);
    expect(match?.user_slug).toBe("mandible-agent-claude");
    expect(match?.label).toBe("agent pat");
    expect(match?.session_scoped).toBe(false);
  });

  it("rejects a well-formed token that matches no credential", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);
    expect(matchActiveCredential(db, pepper, FAKE_TOKEN)).toBeNull();
  });

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

    const detections = scanBlocksForCredentialLeaks(
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

    const detections = scanBlocksForCredentialLeaks(
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

    expect(second).toHaveLength(1);
    expect(second[0].new_event).toBe(false);
    expect(webhookRows()).toHaveLength(1);
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
  it("auto-revokes a session-scoped ephemeral credential", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN, {
      label: "session token",
      metadata: { scope: "session", session_id: "sess-42" },
    });

    const detections = scanBlocksForCredentialLeaks(
      db,
      [{ content: REAL_TOKEN, position: 0 }],
      { conversation_id: "conv-1" },
      { pepper },
    );

    expect(detections[0].credential.session_scoped).toBe(true);
    expect(detections[0].revoked).toBe(true);
    const stored = listCredentials(db, "mandible-agent-claude", { includeRevoked: true })
      .find((row) => row.id === credential.id);
    expect(stored?.status).toBe("revoked");
    expect(JSON.parse(webhookRows()[0].data_json).auto_revoked).toBe(true);
  });

  it("alerts but never revokes a long-lived PAT", () => {
    makeUser();
    const credential = registerToken("mandible-agent-claude", REAL_TOKEN, { label: "agent pat" });

    const detections = scanBlocksForCredentialLeaks(
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

  it("treats an unmarked credential as long-lived (TODO issue 0b989d1 default)", () => {
    expect(isSessionScopedCredential({ type: "api_token", metadata: {} })).toBe(false);
    expect(isSessionScopedCredential({ type: "api_token", metadata: { ephemeral: true } })).toBe(true);
    expect(isSessionScopedCredential({ type: "api_token", metadata: { scope: "session" } })).toBe(true);
  });

  it("surfaces the same remediation commands the alert stores", () => {
    expect(
      remediationFor({
        credential_id: "cred-1",
        user_id: "user-1",
        user_slug: "agent",
        label: null,
        session_scoped: false,
      }),
    ).toEqual({
      mint: "mandible user token mint agent --store",
      revoke: "mandible user token revoke cred-1",
    });
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

  it("scans nothing when the install has no active api tokens", () => {
    seedConversation("conv-old", [{ content: REAL_TOKEN, position: 0 }]);
    const result = backfillCredentialLeakScan(db, { pepper });
    expect(result.skipped).toBe("no_active_api_tokens");
    expect(result.scanned_blocks).toBe(0);
  });

  it("respects a conversation filter and a block limit", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN);
    seedConversation("conv-a", [{ content: REAL_TOKEN, position: 0 }]);
    seedConversation("conv-b", [{ content: REAL_TOKEN, position: 0 }]);

    const scoped = backfillCredentialLeakScan(db, {
      pepper,
      conversationId: "conv-b",
      record: false,
    });
    expect(scoped.scanned_blocks).toBe(1);
    expect(scoped.detections[0].location.conversation_id).toBe("conv-b");

    const limited = backfillCredentialLeakScan(db, { pepper, limit: 1, record: false });
    expect(limited.scanned_blocks).toBe(1);
  });
});

describe("alert record shape", () => {
  it("queues a high-priority pending webhook event the inbox can render", () => {
    makeUser();
    registerToken("mandible-agent-claude", REAL_TOKEN, { label: "agent pat" });
    recordCredentialLeak(
      db,
      matchActiveCredential(db, pepper, REAL_TOKEN)!,
      { conversation_id: "conv-1", session_id: "sess-1", branch: "feature/x" },
      1_700_000_000_000,
    );

    const row = webhookRows()[0];
    expect(row.priority).toBe("high");
    expect(row.status).toBe("pending");
    expect(row.title).toContain("agent pat");
    const payload = JSON.parse(row.data_json);
    expect(payload.detected_at).toBe(1_700_000_000_000);
    expect(payload.session_id).toBe("sess-1");
  });
});
