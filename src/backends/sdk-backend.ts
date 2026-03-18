import type { PermissionDecision, PermissionRequest } from "../agentic-backend.js";
import { PTYBackend } from "./pty-backend.js";
import type { ConsoleSession, Logger } from "../types.js";

export interface SDKBackendOptions {
  model?: string;
  systemPrompt?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  allowedTools?: string[];
  maxTurns?: number;
  maxCostUsd?: number;
}

export class SDKBackend extends PTYBackend {
  private options: SDKBackendOptions = {};

  constructor(meta: ConsoleSession, logger: Logger) {
    super(meta, logger);
    this.options = {
      allowedTools: meta.allowed_tools ?? undefined,
    };
  }

  updateOptions(options: SDKBackendOptions): void {
    this.options = {
      ...this.options,
      ...options,
      ...(options.allowedTools !== undefined ? { allowedTools: [...options.allowedTools] } : {}),
    };
  }

  getPendingPermissions(): PermissionRequest[] {
    return [];
  }

  resolvePermission(_requestId: string, _decision: PermissionDecision): boolean {
    return false;
  }

  getUsage(): Array<Record<string, unknown>> {
    return [];
  }
}
