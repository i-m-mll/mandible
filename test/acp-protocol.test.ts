import { describe, expect, it } from "vitest";
import {
  acpPermissionOutcome,
  createAcpMapperState,
  normalizeAcpIncoming,
  parseAcpNdjsonLine,
} from "../src/backends/acp-protocol.js";
import {
  isAcpIngestSuppressed,
  suppressAcpIngestForSession,
} from "../src/ingestion.js";

describe("ACP protocol mapper", () => {
  it("parses NDJSON JSON-RPC lines", () => {
    expect(parseAcpNdjsonLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update" })))
      .toMatchObject({ method: "session/update" });
    expect(parseAcpNdjsonLine("not json")).toBeNull();
  });

  it("normalizes plan updates as assistant plan content blocks", () => {
    const state = createAcpMapperState({ sessionId: "s1", model: "gemini-3" });
    const result = normalizeAcpIncoming({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { type: "plan", plan: "1. Inspect\n2. Patch" },
      },
    }, state, "console-1");

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "assistant",
      session_id: "s1",
      message: {
        role: "assistant",
        model: "gemini-3",
        content: [{ type: "plan", text: "1. Inspect\n2. Patch" }],
      },
    });
  });

  it("stitches tool_call and tool_call_update into terminal tool events", () => {
    const state = createAcpMapperState({ sessionId: "s1" });

    const first = normalizeAcpIncoming({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          type: "tool_call",
          toolCallId: "tc1",
          name: "read_file",
          input: { path: "README.md" },
          status: "running",
        },
      },
    }, state, "console-1");
    expect(first.events).toEqual([]);

    const second = normalizeAcpIncoming({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          type: "tool_call_update",
          toolCallId: "tc1",
          output: "contents",
          status: "completed",
        },
      },
    }, state, "console-1");

    expect(second.events.map((event) => event.type)).toEqual(["tool_use", "tool_result"]);
    expect(second.events[0]).toMatchObject({
      tool_use_id: "tc1",
      name: "read_file",
      input: { path: "README.md" },
    });
    expect(second.events[1]).toMatchObject({
      tool_use_id: "tc1",
      content: "contents",
      is_error: false,
    });
  });

  it("captures permission requests and maps decisions to ACP outcomes", () => {
    const state = createAcpMapperState();
    const result = normalizeAcpIncoming({
      jsonrpc: "2.0",
      id: 7,
      method: "requestPermission",
      params: {
        tool: { name: "write_file", input: { path: "x" } },
        title: "Write file?",
      },
    }, state, "console-1", 1000);

    expect(result.permission?.responseId).toBe(7);
    expect(result.permission?.request).toMatchObject({
      session_id: "console-1",
      tool_name: "write_file",
      title: "Write file?",
      created_at: 1000,
    });
    expect(acpPermissionOutcome("allow")).toBe("allow_once");
    expect(acpPermissionOutcome("allow_always")).toBe("allow_always");
    expect(acpPermissionOutcome("deny")).toBe("reject_once");
    expect(acpPermissionOutcome("reject_always")).toBe("reject_always");
  });

  it("keeps cumulative usage in mapper state and emits it on completion", () => {
    const state = createAcpMapperState({ sessionId: "s1" });
    normalizeAcpIncoming({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { type: "usage_update", usage: { inputTokens: 10, outputTokens: 3 } },
      },
    }, state, "console-1");

    const result = normalizeAcpIncoming({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { type: "completed" } },
    }, state, "console-1");

    expect(result.events[0]).toMatchObject({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, output_tokens: 3 },
    });
  });

  it("suppresses ACP-originated file-mirror ingestion by provider session id", () => {
    suppressAcpIngestForSession("gemini", "session-1");

    expect(isAcpIngestSuppressed("gemini", "session-1")).toBe(true);
    expect(isAcpIngestSuppressed("codex", "session-1")).toBe(false);
    expect(isAcpIngestSuppressed("gemini", "session-1", Date.now() + 25 * 60 * 60 * 1000))
      .toBe(false);
  });
});
