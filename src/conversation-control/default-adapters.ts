import type { ConversationControlService } from "./service.js";
import { ClaudeSdkControllerAdapter } from "./claude-controller.js";
import { CodexAppServerControllerAdapter } from "./codex-controller.js";

export function registerDefaultConversationControllers(service: ConversationControlService): void {
  service.registerAdapter(new ClaudeSdkControllerAdapter());
  service.registerAdapter(new CodexAppServerControllerAdapter());
}
