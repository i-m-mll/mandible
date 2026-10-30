import { describe, expect, it } from "vitest";
import {
  deriveChatUsageSummary,
  selectContextUsage,
} from "../ui/src/chat/contextUsage";
import {
  normalizeCodexTokenCount,
} from "../src/parsers/context-usage.js";

describe("chat context usage", () => {
  it("prioritizes authoritative available statusline context", () => {
    const selected = selectContextUsage([
      {
        availability: "unavailable",
        provenance: "codex_token_count",
        precision: "unavailable",
      },
      {
        availability: "available",
        provenance: "claude_statusline",
        precision: "exact",
        percent: 20,
      },
    ]);

    expect(selected?.provenance).toBe("claude_statusline");
    expect(selected?.percent).toBe(20);
  });

  it("keeps the observed Codex total as task accounting, not context occupancy", () => {
    const normalized = normalizeCodexTokenCount({
      info: {
        total_token_usage: {
          input_tokens: 54_818_521,
          cached_input_tokens: 50_000_000,
          output_tokens: 90_403,
          reasoning_output_tokens: 80_000,
          total_tokens: 54_908_924,
        },
        last_token_usage: {
          input_tokens: 3_200,
          cached_input_tokens: 2_000,
          output_tokens: 400,
          reasoning_output_tokens: 250,
          total_tokens: 3_600,
        },
        model_context_window: 258_400,
      },
    });

    expect(normalized).toMatchObject({
      currentContext: { availability: "unavailable", reason: "Not reported by Codex" },
      modelWindowTokens: 258_400,
      accounting: [
        { scope: "task_total", totalTokens: 54_908_924 },
        { scope: "latest_usage", totalTokens: 3_600 },
      ],
    });
    expect(normalized?.accounting[0]?.totalTokens).toBe(54_818_521 + 90_403);
  });

  it("does not infer Codex occupancy from a smaller post-compaction last value", () => {
    const summary = deriveChatUsageSummary({
      events: [{
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100_000, output_tokens: 5_000 },
          last_token_usage: { input_tokens: 2_000, output_tokens: 100 },
          model_context_window: 10_000,
        },
      }],
    });

    expect(summary?.context).toMatchObject({
      availability: "unavailable",
      precision: "unavailable",
      windowTokens: 10_000,
    });
    expect(summary?.accounting.map(({ scope, totalTokens }) => ({ scope, totalTokens }))).toEqual([
      { scope: "task_total", totalTokens: 105_000 },
      { scope: "latest_usage", totalTokens: 2_100 },
    ]);
  });
});
