import type { ConversationControlService } from "./service.js";
import { ClaudeStreamControllerAdapter } from "./claude-controller.js";
import { CodexAppServerControllerAdapter } from "./codex-controller.js";

export function registerDefaultConversationControllers(service: ConversationControlService): void {
  service.registerAdapter(new ClaudeStreamControllerAdapter());
  service.registerAdapter(new CodexAppServerControllerAdapter());
}
