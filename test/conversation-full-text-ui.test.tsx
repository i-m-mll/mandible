// @vitest-environment jsdom
import { establishTestClientAccess } from './helpers/local-client-access';
import { cleanup, fireEvent, render, screen } from "./helpers/dom.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(async () => {
  await establishTestClientAccess();
  vi.spyOn(api, "listCanonicalProjects").mockResolvedValue([]);
  vi.spyOn(api, "getChatShownProjectsPreference").mockResolvedValue({
    version: 1, key: "chat_shown_projects", value: [], revision: 0,
  });
  vi.spyOn(api, "updateChatShownProjectsPreference").mockImplementation(async (value, revision) => ({
    version: 1, key: "chat_shown_projects", value, revision: revision + 1,
  }));
  vi.spyOn(api, "getSidebarOrderPreference").mockResolvedValue({
    version: 1, key: "sidebar_order", value: { pinnedConversationIds: null, briefingTopLevelIds: null }, revision: 0,
  });
  vi.spyOn(api, "updateSidebarOrderPreference").mockImplementation(async (value, revision) => ({
    version: 1, key: "sidebar_order", value, revision: revision + 1,
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation full-text UI request path", () => {
  it("turns the visible Full text toggle into the list API full_text contract", async () => {
    vi.useFakeTimers();
    const getConversationSidebar = vi.spyOn(api, "getConversationSidebar").mockResolvedValue({ groups: [], limit: 5 });
    render(<ConversationsView
      consoleSessions={[]}
      initialConversationId={null}
      initialSessionId={null}
      onSelectSession={() => {}}
      onNewConversation={() => {}}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Search and filter options" }));
    fireEvent.click(screen.getByRole("button", { name: "Full text" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Search chats" }), {
      target: { value: " body needle " },
    });
    await vi.advanceTimersByTimeAsync(350);

    expect(getConversationSidebar).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "body needle",
      full_text: true,
    }));
  });
});
