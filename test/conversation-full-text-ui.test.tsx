import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "../ui/src/api.js";
import { ConversationsView } from "../ui/src/views/conversations.js";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(): void {}
    clear(): void {}
    focus(): void {}
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} dispose(): void {} } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation full-text UI request path", () => {
  it("turns the visible Full text toggle into the list API full_text contract", async () => {
    vi.useFakeTimers();
    const getConversations = vi.spyOn(api, "getConversations").mockResolvedValue({ conversations: [], total: 0 });
    render(<ConversationsView
      conversations={[]}
      consoleSessions={[]}
      workRepos={[]}
      initialConversationId={null}
      initialSessionId={null}
      onSelectSession={() => {}}
      onNewSession={() => {}}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Search and filter options" }));
    fireEvent.click(screen.getByRole("button", { name: "Full text" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Search chats" }), {
      target: { value: " body needle " },
    });
    await vi.advanceTimersByTimeAsync(350);

    expect(getConversations).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "body needle",
      full_text: true,
    }));
  });

  it("serializes full_text on the API request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ conversations: [], total: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getConversations({ search: "body needle", full_text: true });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/conversations?search=body+needle&full_text=true");
  });
});
