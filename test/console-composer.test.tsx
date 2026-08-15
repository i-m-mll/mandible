import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  updateConsoleSession: vi.fn(),
  updateConsoleSessionOptions: vi.fn(),
  getConsoleSessionOptions: vi.fn(),
}));

vi.mock("../ui/src/api", () => ({
  updateConsoleSession: apiMocks.updateConsoleSession,
  updateConsoleSessionOptions: apiMocks.updateConsoleSessionOptions,
  getConsoleSessionOptions: apiMocks.getConsoleSessionOptions,
}));

import { Composer } from "../ui/src/components/console/Composer";
import { SessionControls } from "../ui/src/components/console/SessionControls";

afterEach(() => {
  cleanup();
  apiMocks.updateConsoleSession.mockReset();
  apiMocks.updateConsoleSessionOptions.mockReset();
});

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props: Parameters<typeof Composer>[0] = {
    prompt: "hello",
    disabled: false,
    streaming: false,
    queuedPrompts: [],
    transportLabel: "SDK",
    canStop: true,
    onPromptChange: vi.fn(),
    onQueuedPromptRemove: vi.fn(),
    onSubmit: vi.fn((event) => event.preventDefault()),
    onStop: vi.fn(),
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

function changeSelect(select: HTMLElement, value: string): void {
  act(() => {
    (select as HTMLSelectElement).value = value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Composer", () => {
  it("submits on Enter but not Shift+Enter or IME composition", () => {
    const props = renderComposer();
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    const form = textarea.closest("form") as HTMLFormElement;
    form.requestSubmit = vi.fn(() => fireEvent.submit(form));

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(form.requestSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(form.requestSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(form.requestSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders removable queued prompt chips while streaming", () => {
    const onQueuedPromptRemove = vi.fn();
    renderComposer({
      streaming: true,
      queuedPrompts: [{ id: "queued-1", text: "queued follow up" }],
      onQueuedPromptRemove,
    });

    expect(screen.getByText("queued follow up")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop current response" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove queued message 1" }));
    expect(onQueuedPromptRemove).toHaveBeenCalledWith("queued-1");
  });
});

describe("SessionControls", () => {
  it("saves SDK thinking effort through session options", async () => {
    apiMocks.updateConsoleSessionOptions.mockResolvedValue({});
    render(
      <SessionControls
        sessionId="sdk-1"
        runOptions={{ backendType: "sdk", command: "provider", phase: "ready", revision: 1, options: [
          { id: "model", label: "Model", category: "model", kind: "select", nullable: true, source: "backend",
            availability: "available", currentValue: "model-a", allowedValues: [{ value: "model-a", label: "Model A" }],
            enforcement: { status: "enforced", owner: "provider", effectiveFrom: "next_prompt" } },
          { id: "thinking_effort", label: "Thinking effort", category: "thought_level", kind: "select", nullable: true, source: "backend",
            availability: "available", currentValue: null, allowedValues: [{ value: "high", label: "High" }],
            enforcement: { status: "enforced", owner: "backend", effectiveFrom: "next_prompt" } },
        ] }}
        allowedTools={["Read"]}
        availableTools={["Read"]}
      />,
    );

    changeSelect(screen.getByLabelText("Thinking effort"), "high");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(apiMocks.updateConsoleSessionOptions).toHaveBeenCalledWith("sdk-1", {
      allowedTools: ["Read"],
      runOptions: { model: "model-a", thinking_effort: "high" },
    }));
  });

  it("does not render or send SDK-only thinking effort for ACP sessions", async () => {
    apiMocks.updateConsoleSessionOptions.mockResolvedValue({});
    render(
      <SessionControls
        sessionId="acp-1"
        runOptions={{ backendType: "acp", command: "provider", phase: "ready", revision: 1, options: [
          { id: "model", label: "Model", category: "model", kind: "select", nullable: false, source: "composed",
            availability: "available", currentValue: "model-a", allowedValues: [{ value: "model-a", label: "Model A" }],
            enforcement: { status: "enforced", owner: "provider", effectiveFrom: "next_prompt" } },
          { id: "reasoning_effort", label: "Reasoning effort", category: "thought_level", kind: "select", nullable: false, source: "composed",
            availability: "available", currentValue: "high", allowedValues: [{ value: "high", label: "High" }],
            enforcement: { status: "enforced", owner: "provider", effectiveFrom: "next_prompt" } },
        ] }}
        allowedTools={["Read"]}
        availableTools={["Read"]}
      />,
    );

    expect(screen.queryByLabelText("Thinking effort")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(apiMocks.updateConsoleSessionOptions).toHaveBeenCalledWith("acp-1", {
      allowedTools: ["Read"],
      runOptions: { model: "model-a", reasoning_effort: "high" },
    }));
  });
});
