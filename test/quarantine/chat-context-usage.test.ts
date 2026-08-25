// Quarantined: 3229da2 — the effective input token sum is one short.
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

});
