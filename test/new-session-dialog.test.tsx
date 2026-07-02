import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewSessionDialog } from "../ui/src/components/console/NewSessionDialog";

vi.mock("../ui/src/api", () => ({
  getPresets: vi.fn(async () => []),
  getDefaultPresetIds: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
  validatePresetIds: vi.fn(async () => ({ warnings: [] })),
}));

afterEach(() => {
  cleanup();
});

describe("NewSessionDialog transport lanes", () => {
  it("defaults Claude sessions to the PTY transport lane", async () => {
    const onSubmit = vi.fn();
    render(<NewSessionDialog open onClose={vi.fn()} onSubmit={onSubmit} />);

    await waitFor(() => expect(screen.getByText("Claude PTY")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Claude local" } });
    fireEvent.click(screen.getByText("Create chat"));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      label: "Claude local",
      backend: "claude",
      backend_type: "pty",
      transport_lane: "pty",
      channel_enabled: undefined,
    }));
  });

  it("submits Channel as a channel-enabled PTY lane", async () => {
    const onSubmit = vi.fn();
    render(<NewSessionDialog open onClose={vi.fn()} onSubmit={onSubmit} />);

    await waitFor(() => expect(screen.getByText("Claude Channel")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Claude channel" } });
    fireEvent.click(screen.getByText("Claude Channel"));
    fireEvent.click(screen.getByText("Create chat"));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      backend_type: "pty",
      transport_lane: "channel",
      channel_enabled: true,
    }));
  });

  it("shows ACP and PTY lanes for Codex", async () => {
    const onSubmit = vi.fn();
    render(<NewSessionDialog open onClose={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText("Codex"));

    await waitFor(() => expect(screen.getByText("Codex ACP")).toBeTruthy());
    expect(screen.getByText("Codex PTY")).toBeTruthy();
    expect(screen.queryByText("Claude SDK")).toBeNull();

    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Codex structured" } });
    fireEvent.click(screen.getByText("Create chat"));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      backend_type: "acp",
      transport_lane: "acp",
    }));
  });
});
