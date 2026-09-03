import { execFileSync } from "node:child_process";
import type { ConversationExternalNavigation } from "./contracts.js";
import type { Db } from "./db.js";
import { navigateToSession, type NavigateResult } from "./navigate.js";
import type { SessionRegistry } from "./registry.js";

export type ExternalNavigationConversation = {
  id: string;
  source: string;
  session_id: string;
};

type SessionNavigationRow = {
  id: string;
  app: string;
  status: string;
  terminal: string | null;
  nav_extra: string | null;
  conversation_id: string | null;
};

let codexDesktopAvailability: boolean | null = null;

export function codexDesktopBridgeAvailable(): boolean {
  if (codexDesktopAvailability !== null) return codexDesktopAvailability;
  if (process.platform !== "darwin") return false;
  try {
    const bundleId = execFileSync("/usr/bin/osascript", [
      "-e",
      'id of application "Codex"',
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    codexDesktopAvailability = bundleId === "com.openai.codex";
  } catch {
    codexDesktopAvailability = false;
  }
  return codexDesktopAvailability;
}

function hasExactItermTarget(row: SessionNavigationRow): boolean {
  if (row.app !== "claude" || (row.status !== "active" && row.status !== "idle")) return false;
  if (row.terminal !== "iterm" && row.terminal !== "iterm2") return false;
  try {
    const extra = JSON.parse(row.nav_extra ?? "{}") as Record<string, unknown>;
    return typeof extra.iterm_session_id === "string" && Boolean(extra.iterm_session_id.trim());
  } catch {
    return false;
  }
}

/**
 * Project only actions whose exact destination is present in authoritative
 * provider/session state. A Claude SDK row is not a terminal attachment and
 * never produces an external-navigation capability here.
 */
export function projectConversationExternalNavigation(
  db: Db,
  conversations: readonly ExternalNavigationConversation[],
  options: { codexDesktopAvailable?: boolean } = {},
): Map<string, ConversationExternalNavigation> {
  const projected = new Map<string, ConversationExternalNavigation>();
  const claude = conversations.filter((conversation) => (
    conversation.source === "claude_code" && conversation.session_id.trim()
  ));

  for (const conversation of conversations) {
    const providerSessionId = conversation.session_id.trim();
    const codexAvailable = options.codexDesktopAvailable ?? codexDesktopBridgeAvailable();
    if (conversation.source === "codex" && providerSessionId && codexAvailable) {
      projected.set(conversation.id, {
        kind: "codex-desktop-task",
        provider_session_id: providerSessionId,
        label: "Open in Codex",
      });
    }
  }

  if (claude.length === 0) return projected;
  const providerIds = [...new Set(claude.map((conversation) => conversation.session_id.trim()))];
  const placeholders = providerIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, app, status, terminal, nav_extra, conversation_id
      FROM sessions
     WHERE conversation_id IN (${placeholders})
  `).all(...providerIds) as SessionNavigationRow[];

  const rowsByProviderId = new Map<string, SessionNavigationRow[]>();
  for (const row of rows) {
    if (!row.conversation_id || !hasExactItermTarget(row)) continue;
    const current = rowsByProviderId.get(row.conversation_id) ?? [];
    current.push(row);
    rowsByProviderId.set(row.conversation_id, current);
  }
  for (const conversation of claude) {
    const providerSessionId = conversation.session_id.trim();
    const candidates = rowsByProviderId.get(providerSessionId) ?? [];
    if (candidates.length !== 1) continue;
    projected.set(conversation.id, {
      kind: "claude-native-background",
      provider_session_id: providerSessionId,
      session_id: candidates[0].id,
      terminal: "iterm",
      label: "Go to terminal",
    });
  }
  return projected;
}

export type ExternalNavigationDependencies = {
  codexDesktopAvailable?: boolean;
  openCodexTask?: (providerSessionId: string) => void;
  navigateSession?: (sessionId: string) => NavigateResult;
};

export function codexTaskDeepLink(providerSessionId: string): string {
  return `codex://threads/${encodeURIComponent(providerSessionId)}`;
}

export function executeConversationExternalNavigation(
  db: Db,
  registry: SessionRegistry,
  conversation: ExternalNavigationConversation,
  dependencies: ExternalNavigationDependencies = {},
): { ok: true; capability: ConversationExternalNavigation } | { ok: false; message: string } {
  const capability = projectConversationExternalNavigation(db, [conversation], {
    codexDesktopAvailable: dependencies.codexDesktopAvailable,
  }).get(conversation.id);
  if (!capability) return { ok: false, message: "No exact external destination is available" };

  if (capability.kind === "codex-desktop-task") {
    const openCodexTask = dependencies.openCodexTask ?? ((providerSessionId: string) => {
      execFileSync("/usr/bin/open", [
        "-b",
        "com.openai.codex",
        codexTaskDeepLink(providerSessionId),
      ], { stdio: "ignore" });
    });
    try {
      openCodexTask(capability.provider_session_id);
      return { ok: true, capability };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Codex focus failed" };
    }
  }

  const session = registry.getSession(capability.session_id);
  if (!session || session.conversation_id !== capability.provider_session_id) {
    return { ok: false, message: "The exact background session is no longer available" };
  }
  const result = dependencies.navigateSession
    ? dependencies.navigateSession(session.id)
    : navigateToSession(session);
  return result.ok
    ? { ok: true, capability }
    : { ok: false, message: result.message ?? "Terminal focus failed" };
}
