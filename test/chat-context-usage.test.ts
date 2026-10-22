import { h } from "preact";
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveChatUsageSummary,
  getContextSeverity,
  selectContextUsage,
} from "../../ui/src/chat/contextUsage";
import {
  normalizeClaudeStatusline,
  normalizeCodexTokenCount,
} from "../../src/parsers/context-usage.js";
import { UsageModal } from "../../ui/src/chat/UsageModal.js";

afterEach(cleanup);

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

  it("uses semantic thresholds for context severity", () => {
    expect(getContextSeverity(69.9)).toBe("info");
    expect(getContextSeverity(70)).toBe("warning");
    expect(getContextSeverity(90)).toBe("danger");
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
    expect(summary?.accounting.map(({ label, totalTokens }) => ({ label, totalTokens }))).toEqual([
      { label: "Task total", totalTokens: 105_000 },
      { label: "Latest reported usage", totalTokens: 2_100 },
    ]);
  });

  it("keeps compaction totals cumulative while accepting a new task total as a reset scope", () => {
    const compacted = deriveChatUsageSummary({
      events: [
        { type: "token_count", info: { total_token_usage: { total_tokens: 100_000 } } },
        { type: "context_compacted" } as never,
        { type: "token_count", info: { total_token_usage: { total_tokens: 105_000 } } },
      ],
    });
    const newTask = deriveChatUsageSummary({
      events: [
        { type: "token_count", info: { total_token_usage: { total_tokens: 105_000 } } },
        { type: "task_started" } as never,
        { type: "token_count", info: { total_token_usage: { total_tokens: 500 } } },
      ],
    });

    expect(compacted?.accounting[0]?.totalTokens).toBe(105_000);
    expect(newTask?.accounting[0]?.totalTokens).toBe(500);
    expect(compacted?.context.availability).toBe("unavailable");
    expect(newTask?.context.availability).toBe("unavailable");
  });

  it("uses exact Claude statusline occupancy and retains current usage fields", () => {
    const normalized = normalizeClaudeStatusline({
      model: { display_name: "Sonnet 4.5" },
      context_window: {
        total_input_tokens: 72_000,
        total_output_tokens: 8_000,
        used_percentage: 36,
        context_window_size: 200_000,
        current_usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    });

    expect(normalized).toMatchObject({
      provenance: "claude_statusline",
      currentContext: {
        availability: "available",
        precision: "exact",
        percent: 36,
        usedTokens: 72_000,
      },
      modelWindowTokens: 200_000,
      currentUsage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 300,
        totalTokens: 1_600,
      },
    });
  });

  it.each([undefined, null])("renders Claude occupancy unavailable when percentage is %s", (usedPercentage) => {
    const summary = deriveChatUsageSummary({
      telemetry: {
        model: "Claude",
        context_window: {
          total_input_tokens: 12_000,
          used_percentage: usedPercentage,
          context_window_size: 200_000,
        },
      },
    });

    expect(summary?.context).toMatchObject({
      availability: "unavailable",
      precision: "unavailable",
    });
    expect(summary?.context.percent).toBeUndefined();
  });

  it("keeps subscription rate limits separate from current context", () => {
    const summary = deriveChatUsageSummary({
      telemetry: {
        context_window: { used_percentage: null },
        rate_limits: { five_hour: { used_percentage: 80 } },
      },
    });

    expect(summary?.context.availability).toBe("unavailable");
    expect(summary?.rateLimits).toEqual([{ label: "5-hour", usedPercent: 80, resetsAt: null }]);
  });

  it("renders unavailable occupancy distinctly from authoritative Claude occupancy", () => {
    const unavailable = deriveChatUsageSummary({
      events: [{
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 54_908_924 },
          model_context_window: 258_400,
        },
      }],
    });
    const view = render(h(UsageModal, {
      usage: unavailable,
      titleId: "usage-title",
      onClose: () => undefined,
    }));

    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("Occupancy unknown")).toBeTruthy();
    expect(screen.getByText("Not reported by Codex")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    const close = screen.getByRole("button", { name: "Close usage" });
    expect(close.className).toBe("overlay-close-button");
    expect(close.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(close.textContent).toBe("");

    view.rerender(h(UsageModal, {
      usage: deriveChatUsageSummary({
        telemetry: {
          context_window: {
            total_input_tokens: 72_000,
            used_percentage: 36,
            context_window_size: 200_000,
          },
        },
      }),
      titleId: "usage-title",
      onClose: () => undefined,
    }));

    expect(screen.getByText("36%")).toBeTruthy();
    expect(screen.getByText("Exact")).toBeTruthy();
  });
});
