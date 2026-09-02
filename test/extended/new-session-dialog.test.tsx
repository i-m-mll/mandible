import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewSessionDialog } from "../../ui/src/components/console/NewSessionDialog";

// Issue 8aadf70 — the dialog asks the daemon which Claude lanes this install
// ships. The default answer is "SDK only"; the terminal-driving lanes appear
// only when the daemon reports them enabled.
const getConsoleLanePolicy = vi.fn(async () => ({
  claude_default_backend_type: "sdk" as const,
  claude_pty_lane_enabled: false,
}));
const getConsoleRunOptions = vi.fn(async () => ({
  backendType: 'sdk' as const,
  command: 'claude',
  phase: 'ready' as const,
  revision: 1,
  options: [],
}));

vi.mock("../../ui/src/api", () => ({
  getSettings: vi.fn(async () => ({})),
  getConsoleLanePolicy: (...args: []) => getConsoleLanePolicy(...args),
  getConsoleRunOptions: (..._args: unknown[]) => getConsoleRunOptions(),
}));

beforeEach(() => {
  getConsoleLanePolicy.mockResolvedValue({
    claude_default_backend_type: "sdk",
    claude_pty_lane_enabled: false,
  });
  getConsoleRunOptions.mockResolvedValue({
    backendType: 'sdk',
    command: 'claude',
    phase: 'ready',
    revision: 1,
    options: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NewSessionDialog transport lanes", () => {
  it('keeps ordinary run options compact and places limits and overrides under Advanced', async () => {
    getConsoleRunOptions.mockResolvedValue({
      backendType: 'sdk',
      command: 'claude',
      phase: 'ready',
      revision: 1,
      options: [
        { id: 'model', label: 'Model', category: 'model', kind: 'text', nullable: true, source: 'backend', availability: 'available', currentValue: null, allowedValues: null, enforcement: { status: 'enforced', owner: 'backend', effectiveFrom: 'next_prompt' } },
        { id: 'max_turns', label: 'Maximum turns', category: 'limit', kind: 'integer', nullable: true, source: 'backend', availability: 'available', currentValue: null, allowedValues: null, enforcement: { status: 'enforced', owner: 'backend', effectiveFrom: 'next_prompt' } },
        { id: 'max_cost_usd', label: 'Maximum cost (USD)', category: 'limit', kind: 'number', nullable: true, source: 'backend', availability: 'available', currentValue: null, allowedValues: null, enforcement: { status: 'enforced', owner: 'backend', effectiveFrom: 'next_prompt' } },
        { id: 'system_prompt', label: 'System prompt', category: 'prompt', kind: 'text', nullable: true, source: 'backend', availability: 'available', currentValue: null, allowedValues: null, enforcement: { status: 'enforced', owner: 'backend', effectiveFrom: 'next_prompt' } },
        { id: 'setting_sources', label: 'Setting sources', category: 'settings', kind: 'text', nullable: true, source: 'backend', availability: 'available', currentValue: null, allowedValues: null, enforcement: { status: 'enforced', owner: 'backend', effectiveFrom: 'next_prompt' } },
      ],
    });

    render(<NewSessionDialog open onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(await screen.findByText('Model')).toBeTruthy();
    expect(screen.queryByText('Maximum turns')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByText('Maximum turns')).toBeTruthy();
    expect(screen.getByText('Maximum cost (USD)')).toBeTruthy();
    expect(screen.getByText('System prompt')).toBeTruthy();
    expect(screen.getByText('Setting sources')).toBeTruthy();
    expect(document.querySelector('.new-session-dialog-overlay')?.parentElement).toBe(document.body);
  });

  it("defaults Claude sessions to the SDK transport lane", async () => {
    const onSubmit = vi.fn();
    render(<NewSessionDialog open onClose={vi.fn()} onSubmit={onSubmit} />);

    await waitFor(() => expect(screen.getByText("Claude SDK")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Claude local" } });
    fireEvent.click(screen.getByText("Create chat"));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      label: "Claude local",
      backend: "claude",
      backend_type: "sdk",
      transport_lane: "sdk",
      channel_enabled: undefined,
    }));
  });

  it("threads an exact scoped cwd and omits it for unscoped creation", async () => {
    const scopedSubmit = vi.fn();
    render(<NewSessionDialog open cwd="/registered/project" onClose={vi.fn()} onSubmit={scopedSubmit} />);
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Scoped" } });
    fireEvent.click(screen.getByText("Create chat"));
    expect(scopedSubmit).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/registered/project" }));

    cleanup();
    const unscopedSubmit = vi.fn();
    render(<NewSessionDialog open onClose={vi.fn()} onSubmit={unscopedSubmit} />);
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Unscoped" } });
    fireEvent.click(screen.getByText("Create chat"));
    expect(unscopedSubmit).toHaveBeenCalledWith(expect.objectContaining({ cwd: undefined }));
  });

  it("hides the Claude PTY and Channel lanes when the daemon does not ship them", async () => {
    render(<NewSessionDialog open onClose={vi.fn()} onSubmit={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Claude SDK")).toBeTruthy());
    expect(screen.queryByText(/Claude PTY/)).toBeNull();
    expect(screen.queryByText(/Claude Channel/)).toBeNull();
  });

  it("offers Channel as a channel-enabled PTY lane once the daemon enables it", async () => {
    getConsoleLanePolicy.mockResolvedValue({
      claude_default_backend_type: "sdk",
      claude_pty_lane_enabled: true,
    });
    const onSubmit = vi.fn();
    render(<NewSessionDialog open onClose={vi.fn()} onSubmit={onSubmit} />);

    const channel = await screen.findByText("Claude Channel (local only)");
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Claude channel" } });
    fireEvent.click(channel);
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
