import SqliteDatabase from "../src/sqlite.ts";
import { describe, expect, it, vi } from "vitest";
import {
  codexTaskDeepLink,
  executeConversationExternalNavigation,
  projectConversationExternalNavigation,
} from "../src/conversation-external-navigation.js";
import { SessionRegistry } from "../src/registry.js";

function fixture(): { db: InstanceType<typeof SqliteDatabase>; registry: SessionRegistry } {
  const db = new SqliteDatabase(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  return { db, registry: new SessionRegistry(db) };
}

describe("conversation external navigation", () => {
  it("projects the installed Codex task deep link from the exact provider task id", () => {
    const { db } = fixture();
    const providerSessionId = "01a0699f-9091-7ea1-91da-264cc4794dd7";
    const capabilities = projectConversationExternalNavigation(db, [{
      id: "conversation-codex",
      source: "codex",
      session_id: providerSessionId,
    }], { codexDesktopAvailable: true });

    expect(capabilities.get("conversation-codex")).toEqual({
      kind: "codex-desktop-task",
      provider_session_id: providerSessionId,
      label: "Open in Codex",
    });
    expect(codexTaskDeepLink(providerSessionId)).toBe(`codex://threads/${providerSessionId}`);
  });

  it("focuses the exact existing Codex task without a replacement launch", () => {
    const { db, registry } = fixture();
    const openCodexTask = vi.fn();
    const conversation = { id: "conversation-codex", source: "codex", session_id: "codex-task-id" };

    expect(executeConversationExternalNavigation(db, registry, conversation, {
      codexDesktopAvailable: true,
      openCodexTask,
    }))
      .toMatchObject({ ok: true, capability: { kind: "codex-desktop-task" } });
    expect(openCodexTask).toHaveBeenCalledOnce();
    expect(openCodexTask).toHaveBeenCalledWith("codex-task-id");
  });

  it("omits Codex navigation when the installed desktop bridge is unavailable", () => {
    const { db } = fixture();
    expect(projectConversationExternalNavigation(db, [{
      id: "conversation-codex",
      source: "codex",
      session_id: "codex-task-id",
    }], { codexDesktopAvailable: false }).size).toBe(0);
  });

  it("projects Claude terminal focus only for one live native iTerm background session", () => {
    const { db, registry } = fixture();
    registry.registerSession({
      id: "native-background-id",
      app: "claude",
      status: "active",
      terminal: "iterm",
      nav_extra: { iterm_session_id: "w0t1p0:EXACT" },
      conversation_id: "claude-provider-id",
    });
    registry.registerSession({
      id: "ended-background-id",
      app: "claude",
      status: "ended",
      terminal: "iterm",
      nav_extra: { iterm_session_id: "w0t1p0:STALE" },
      conversation_id: "ended-provider-id",
    });
    // What the channel server registers for a Console SDK session: a live
    // Claude row with no terminal attachment.
    registry.registerSession({
      id: "channel-id",
      app: "claude",
      status: "active",
      conversation_id: "channel-provider-id",
    });

    const capabilities = projectConversationExternalNavigation(db, [
      { id: "native", source: "claude_code", session_id: "claude-provider-id" },
      { id: "ended", source: "claude_code", session_id: "ended-provider-id" },
      { id: "channel", source: "claude_code", session_id: "channel-provider-id" },
    ]);
    expect(capabilities.get("native")).toEqual({
      kind: "claude-native-background",
      provider_session_id: "claude-provider-id",
      session_id: "native-background-id",
      terminal: "iterm",
      label: "Go to terminal",
    });
    expect(capabilities.has("ended")).toBe(false);
    expect(capabilities.has("channel")).toBe(false);
  });

  it("fails closed when Claude terminal custody is ambiguous and navigates only the projected id", () => {
    const { db, registry } = fixture();
    for (const id of ["background-a", "background-b"]) {
      registry.registerSession({
        id,
        app: "claude",
        status: "active",
        terminal: "iterm",
        nav_extra: { iterm_session_id: `w0t1p0:${id}` },
        conversation_id: "ambiguous-provider-id",
      });
    }
    registry.registerSession({
      id: "exact-background",
      app: "claude",
      status: "idle",
      terminal: "iterm2",
      nav_extra: { iterm_session_id: "w0t1p0:EXACT" },
      conversation_id: "exact-provider-id",
    });
    const navigateSession = vi.fn(() => ({ ok: true }));

    expect(executeConversationExternalNavigation(db, registry, {
      id: "ambiguous",
      source: "claude_code",
      session_id: "ambiguous-provider-id",
    }, { navigateSession })).toEqual({ ok: false, message: "No exact external destination is available" });
    expect(executeConversationExternalNavigation(db, registry, {
      id: "exact",
      source: "claude_code",
      session_id: "exact-provider-id",
    }, { navigateSession })).toMatchObject({
      ok: true,
      capability: { kind: "claude-native-background", session_id: "exact-background" },
    });
    expect(navigateSession).toHaveBeenCalledOnce();
    expect(navigateSession).toHaveBeenCalledWith("exact-background");
  });
});
