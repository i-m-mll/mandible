import { describe, expect, it } from "vitest";
import { CodexNativeArchiveAdapter, type CodexNativeArchiveClient } from "../src/conversation-control/codex-native-archive.js";

const threadId = "01a17935-2e1a-77c0-b8ba-6f011db56615";

function fixture(options: {
  archived?: boolean; archiveError?: string; ignoreArchive?: boolean;
  restoredId?: string; queue?: unknown; queueError?: string;
} = {}) {
  let archived = options.archived ?? false;
  let closed = 0;
  const calls: string[] = [];
  const client: CodexNativeArchiveClient = {
    request: async (method, params) => {
      expect((params as { threadId: string }).threadId).toBe(threadId);
      calls.push(method);
      if (method === "thread/read") return { thread: { id: threadId,
        path: `/native/${archived ? "archived_sessions" : "sessions"}/fixture.jsonl` } };
      if (method === "thread/archive") {
        if (options.archiveError) throw new Error(options.archiveError);
        if (!options.ignoreArchive) archived = true;
        return {};
      }
      if (method === "thread/unarchive") {
        archived = false;
        return { thread: { id: options.restoredId ?? threadId } };
      }
      if (method === "thread/queue/list") {
        if (options.queueError) throw new Error(options.queueError);
        return options.queue ?? { data: [], nextCursor: null };
      }
      throw new Error(`Unexpected native operation ${method}`);
    },
    close: async () => { closed++; return { code: 0, signal: null, stderr: "" }; },
  };
  return { adapter: new CodexNativeArchiveAdapter(async () => client), calls, closed: () => closed };
}

describe("Codex native visibility effects", () => {
  it("verifies archive effects and makes repeated archive requests idempotent", async () => {
    const native = fixture();
    expect(await native.adapter.archive(threadId)).toEqual({ status: "archived" });
    expect(await native.adapter.archive(threadId)).toEqual({ status: "already_archived" });
    expect(native.calls.filter(method => method === "thread/archive")).toHaveLength(1);
    expect(native.closed()).toBe(2);
    expect(await fixture({ ignoreArchive: true }).adapter.archive(threadId))
      .toEqual({ status: "failed", reason: "native_archive_effect_unverified" });
  });

  it("defers only the exact target writer rejection and reports other failures", async () => {
    const native = fixture({ archiveError: `thread ${threadId} already has an active writer` });
    expect(await native.adapter.archive(threadId)).toEqual({ status: "deferred", reason: "desktop_writer_owned" });
    expect(native.closed()).toBe(1);
    expect(await fixture({ archiveError: "thread other already has an active writer" }).adapter.archive(threadId))
      .toEqual({ status: "failed", reason: "thread other already has an active writer" });
  });

  it("restores the original identity before input and refuses an identity mismatch", async () => {
    const native = fixture({ archived: true });
    expect(await native.adapter.restore(threadId)).toEqual({ status: "restored" });
    expect(native.calls).toEqual(["thread/read", "thread/unarchive", "thread/read"]);
    expect(await native.adapter.restore(threadId)).toEqual({ status: "already_restored" });
    expect(await fixture({ archived: true, restoredId: "other" }).adapter.restore(threadId))
      .toEqual({ status: "failed", reason: "native_thread_identity_mismatch" });
  });

  it("distinguishes pending input, confirmed empty queues and unknown queue state", async () => {
    expect(await fixture({ queue: { data: [{ id: "pending" }], nextCursor: null } }).adapter.queue(threadId))
      .toEqual({ status: "known", pending: true });
    expect(await fixture().adapter.queue(threadId)).toEqual({ status: "known", pending: false });
    expect(await fixture({ queue: { data: [], nextCursor: "more" } }).adapter.queue(threadId))
      .toEqual({ status: "unknown", reason: "native_queue_page_incomplete" });
    expect(await fixture({ queueError: "native queue unavailable" }).adapter.queue(threadId))
      .toEqual({ status: "unknown", reason: "native queue unavailable" });
  });
});
