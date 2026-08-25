import { describe, expect, it } from "vitest";
import {
  deriveChatUsageSummary,
  effectiveClaudeInputTokens,
  getContextSeverity,
  selectContextUsage,
} from "../../ui/src/chat/contextUsage";

describe("chat context usage", () => {
  it("sums Claude effective input tokens including cache fields", () => {
    expect(effectiveClaudeInputTokens({
      input_tokens: 100,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 10,
    })).toBe(151);
  });

  it("prioritizes statusline over exact and approximate mirrors", () => {
    const selected = selectContextUsage([
      { source: "mirror_approx", percent: 80, approximate: true },
      { source: "mirror_exact", percent: 40, approximate: false },
      { source: "statusline", percent: 20, approximate: false },
    ]);

    expect(selected?.source).toBe("statusline");
    expect(selected?.percent).toBe(20);
  });

  it("uses semantic thresholds for context severity", () => {
    expect(getContextSeverity(69.9)).toBe("info");
    expect(getContextSeverity(70)).toBe("warning");
    expect(getContextSeverity(90)).toBe("danger");
  });

  it("derives exact Codex mirror context from token_count events", () => {
    const summary = deriveChatUsageSummary({
      events: [{
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 500, output_tokens: 500 },
          model_context_window: 10_000,
        },
      }],
    });

    expect(summary?.context).toMatchObject({
      source: "mirror_exact",
      percent: 10,
      totalTokens: 1000,
      windowTokens: 10_000,
      approximate: false,
    });
  });

  it("derives exact context from a persisted hidden token_count block", () => {
    const summary = deriveChatUsageSummary({
      blocks: [{
        id: "token-count-1",
        conversation_id: "conversation-1",
        type: "event",
        role: "system",
        content: "token_count",
        position: 1,
        timestamp: "2026-01-01T00:00:00Z",
        parent_id: null,
        metadata_json: JSON.stringify({
          source_event_type: "token_count",
          visibility: "default_hidden",
          context_usage: {
            source: "mirror_exact",
            used_tokens: 2_000,
            total_tokens: 2_000,
            window_tokens: 10_000,
            percent: 20,
            approximate: false,
          },
        }),
      }],
    });

    expect(summary?.context).toMatchObject({
      source: "mirror_exact",
      percent: 20,
      totalTokens: 2_000,
      windowTokens: 10_000,
      approximate: false,
    });
  });
});
