import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveConversationAttachState, type ConversationAttachRow } from "../../src/conversation-attach-state.js";
import { migrate, openDb, type Db } from "../../src/db.js";

let tempDir = "";
let db: Db;

const baseRow: ConversationAttachRow = {
  id: "conv-1",
  source: "claude_code",
  source_path: null,
  source_mtime: 0,
  session_id: "provider-1",
  parent_conversation_id: null,
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-attach-state-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation attach state", () => {
  it("derives live-owned from current Mandible console sessions", () => {
    const manager = {
      getAll: () => [{
        meta: {
          id: "console-1",
          provider_session_id: "provider-1",
          status: "running",
        },
      }],
    };

    expect(deriveConversationAttachState(baseRow, db, manager as never, { now: 1_000 }).kind)
      .toBe("live-owned");
  });

  it("derives live-external from fresh transcript writes", () => {
    const transcriptPath = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(transcriptPath, "{}\n");
    fs.utimesSync(transcriptPath, new Date(10), new Date(10));

    const state = deriveConversationAttachState(
      { ...baseRow, source_path: transcriptPath },
      db,
      undefined,
      { now: 10_000, transcriptFreshMs: 20_000 },
    );

    expect(state).toMatchObject({ kind: "live-external", reason: "transcript-recent" });
  });

  it("derives provider-session resume without a message anchor for Codex", () => {
    const state = deriveConversationAttachState(
      { ...baseRow, source: "codex" }, db, undefined, { now: 1_000_000 },
    );

    expect(state).toMatchObject({
      kind: "resumable",
      reason: "provider-resumable",
      continuation: { kind: "provider-session-resume", provider_session_id: "provider-1" },
    });
  });

  it("derives historical for subagent conversations", () => {
    const state = deriveConversationAttachState(
      { ...baseRow, parent_conversation_id: "parent-1" },
      db,
      undefined,
      { now: 1_000_000 },
    );

    expect(state).toMatchObject({
      kind: "historical",
      reason: "subagent",
      continuation: { kind: "hidden", reason: "unavailable" },
    });
  });
});
