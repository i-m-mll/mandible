import { describe, expect, it, vi } from "vitest";
import type { Conversation, ConversationAttachState } from "../ui/src/api.js";
import {
  getConversationAttachPresentation,
  getConversationTitle,
  parseConversationTagsInput,
} from "../ui/src/views/conversations.js";

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

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
    dispose(): void {}
  },
}));

function state(kind: ConversationAttachState["kind"]): ConversationAttachState {
  return {
    kind,
    reason: kind === "live-owned"
      ? "mandible-owned"
      : kind === "live-external"
        ? "transcript-recent"
        : kind === "resumable"
          ? "provider-resumable"
          : "unsupported-provider",
    resumable: kind === "live-owned" || kind === "resumable",
    can_fork: kind !== "historical",
    provider_session_id: "provider-1",
    checked_at: 1,
  };
}

describe("conversation attach presentation", () => {
  it("maps attach states to badge and composer behavior", () => {
    expect(getConversationAttachPresentation(state("live-owned"))).toMatchObject({
      label: "Live",
      composer: "enabled",
    });
    expect(getConversationAttachPresentation(state("live-external"))).toMatchObject({
      label: "External",
      composer: "disabled",
      hint: "Live in your terminal.",
    });
    expect(getConversationAttachPresentation(state("resumable"))).toMatchObject({
      label: "Resumable",
      composer: "enabled",
      hint: "Sending will resume this session.",
    });
    expect(getConversationAttachPresentation(state("historical"))).toMatchObject({
      label: "History",
      composer: "hidden",
    });
  });

  it("uses the provider title and canonicalizes the minimal tag editor input", () => {
    const conversation = {
      title: "**Provider title**",
      label: "Legacy override must be ignored",
    } as unknown as Conversation;
    expect(getConversationTitle(conversation)).toBe("Provider title");
    expect(parseConversationTagsInput(" one,Two, one, ,two ")).toEqual(["one", "Two", "two"]);
  });
});
