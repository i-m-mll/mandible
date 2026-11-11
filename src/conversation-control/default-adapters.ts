import type { ConversationControlService } from "./service.js";
import { ClaudeSdkControllerAdapter } from "./claude-controller.js";
import { CodexAppServerControllerAdapter } from "./codex-controller.js";
import type { TurnNotices } from "./claude-sdk-transport.js";

export function registerDefaultConversationControllers(service: ConversationControlService, notices: TurnNotices): void {
  service.registerAdapter(new ClaudeSdkControllerAdapter({ notices }));
  service.registerAdapter(new CodexAppServerControllerAdapter());
}
