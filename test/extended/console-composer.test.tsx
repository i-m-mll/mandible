import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  updateConsoleSession: vi.fn(),
  updateConsoleSessionOptions: vi.fn(),
  getConsoleSessionOptions: vi.fn(),
}));

vi.mock("../../ui/src/api", () => ({
  updateConsoleSession: apiMocks.updateConsoleSession,
  updateConsoleSessionOptions: apiMocks.updateConsoleSessionOptions,
  getConsoleSessionOptions: apiMocks.getConsoleSessionOptions,
}));

import { Composer } from "../../ui/src/components/console/Composer";

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
