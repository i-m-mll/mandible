import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getConsoleSessionOptions: vi.fn(), updateConsoleSessionOptions: vi.fn() }));
vi.mock("../ui/src/api", () => api);
import { SessionControls } from "../ui/src/components/console/SessionControls";
import type { SessionRunOptionsSnapshot } from "../ui/src/api";

afterEach(() => { cleanup(); api.getConsoleSessionOptions.mockReset(); api.updateConsoleSessionOptions.mockReset(); });

function acpSnapshot(): SessionRunOptionsSnapshot {
  return { backendType: "acp", command: "provider", phase: "ready", revision: 1, options: [
    { id: "reasoning_effort", label: "Reasoning effort", category: "thought_level", kind: "select", nullable: false,
      source: "composed", availability: "available", currentValue: "high", allowedValues: [{ value: "high", label: "High" }],
      enforcement: { status: "enforced", owner: "provider", effectiveFrom: "next_prompt" } },
    { id: "mode", label: "Mode", category: "mode", kind: "select", nullable: false,
      source: "composed", availability: "available", currentValue: "agent", allowedValues: [
        { value: "read-only", label: "Read only" }, { value: "agent", label: "Agent" },
        { value: "agent-full-access", label: "Agent full access" },
      ], enforcement: { status: "enforced", owner: "provider", effectiveFrom: "next_prompt" } },
    { id: "max_turns", label: "Maximum turns", category: "limit", kind: "integer", nullable: true,
      source: "backend", availability: "available", currentValue: null, allowedValues: null,
      enforcement: { status: "unsupported", reason: "not enforceable" } },
  ] };
}

describe("capability-driven console session options", () => {
  it("renders ACP effort and native mode labels while omitting unsupported limits", () => {
    render(<SessionControls sessionId="s1" runOptions={acpSnapshot()} />);
    expect(screen.getByLabelText("Reasoning effort")).toBeTruthy();
    expect(screen.getByLabelText("Mode")).toBeTruthy();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.queryByText("Accept edits")).toBeNull();
    expect(screen.queryByText("Maximum turns")).toBeNull();
  });

  it("renders awaiting-provider state as disabled without inventing choices", () => {
    const snapshot = acpSnapshot();
    snapshot.phase = "discovering";
    snapshot.options = [{ ...snapshot.options[0]!, availability: "awaiting_provider", allowedValues: null,
      currentValue: null, enforcement: { status: "awaiting_provider", owner: "provider", effectiveFrom: "next_prompt" } }];
    render(<SessionControls sessionId="s2" runOptions={snapshot} />);
    expect(screen.getByText("Waiting for provider…")).toBeTruthy();
    expect((screen.getByLabelText("Reasoning effort") as HTMLSelectElement).disabled).toBe(true);
  });
});
