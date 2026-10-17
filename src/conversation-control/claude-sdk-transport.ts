import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Options, Query, SDKMessage, SDKUserMessage, WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { withMandibleInstructionsFragment } from "../instructions/fragment.js";
import { projectManagedProviderIdentity } from "../backends/mandible-transport.js";
import type { ControllerAcquisitionRequest } from "./adapter.js";
import type { ConversationRuntimeOptions, ManagedPermissionRequest } from "./types.js";

export type ClaudeSdk = Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "startup">;

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(value: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input is closed");
    this.values.push(value);
    this.wake?.();
  }
  close(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const value = this.values.shift();
      if (value) yield value;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

export class ClaudeSdkTransport {
  private readonly input = new InputQueue();
  private readonly abortController = new AbortController();
  private warm: WarmQuery | null = null;
  private query: Query | null = null;
  private closed = false;
  private recordListener?: (record: unknown) => void;
  private exitListener?: (exit: { code: number | null; signal: string | null; stderr: string }) => void;
  private readonly buffered: SDKMessage[] = [];
  private readonly permissions = new Map<string, { request: ManagedPermissionRequest; resolve: (allow: boolean) => void }>();
  private readonly allowedTools = new Set<string>();
  private nativeSessionId: string | null = null;
  private reservedId = "";
  private processId: number | undefined;
  private stderrTail = "";
  private drain: Promise<void> | null = null;

  constructor(private readonly inputRequest: ControllerAcquisitionRequest, private readonly sdk: ClaudeSdk) {
    for (const tool of inputRequest.runtime_options?.allowed_tools ?? []) this.allowedTools.add(tool);
  }

  get alive(): boolean { return !this.closed && this.query !== null; }
  get providerSessionId(): string | null { return this.nativeSessionId; }
  get reservedSessionId(): string { return this.reservedId; }
  get pid(): number | undefined { return this.processId; }

  async start(): Promise<void> {
    const request = this.inputRequest;
    const providerId = request.kind === "start" ? randomUUID() : request.provider_session_id;
    this.reservedId = providerId;
    const settings = request.runtime_options ?? {};
    const env = { ...process.env };
    projectManagedProviderIdentity(env, "claude", providerId, request.conversation_id);
    delete env.CLAUDECODE;
    delete env.MANDIBLE_TOKEN;
    env.MANDIBLE_MANAGED_CLIENT = "1";
    const bind = (id: string) => {
      if (id !== providerId) return; // The adapter rejects mismatching native init records.
      if (!this.closed) { this.nativeSessionId = id; }
    };
    const options: Options = {
      abortController: this.abortController,
      cwd: request.cwd,
      env,
      ...(request.kind === "start" ? { sessionId: providerId } : { resume: providerId }),
      ...(request.kind === "resume-message-anchor" ? { resumeSessionAt: request.message_anchor } : {}),
      model: settings.model,
      effort: settings.effort as Options["effort"],
      permissionMode: settings.permission_mode as Options["permissionMode"] ?? "default",
      allowDangerouslySkipPermissions: settings.permission_mode === "bypassPermissions",
      systemPrompt: withMandibleInstructionsFragment(settings.system_prompt),
      settingSources: settings.setting_sources ?? ["user", "project", "local"],
      allowedTools: settings.allowed_tools,
      maxTurns: settings.max_turns,
      maxBudgetUsd: settings.max_cost_usd,
      includePartialMessages: true,
      agentProgressSummaries: true,
      extraArgs: { "replay-user-messages": null },
      mcpServers: { mandible: { type: "stdio", command: process.execPath,
        args: [resolve(dirname(fileURLToPath(import.meta.url)), "../channel-server/index.js")],
        env: Object.fromEntries(Object.entries({ ...env, MANDIBLE_MANAGED_APP: "claude", MANDIBLE_SESSION_ID: providerId, MANDIBLE_SESSION_CWD: request.cwd ?? "", MANDIBLE_PROVIDER_SESSION_ID: providerId }).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      } },
      hooks: { SessionStart: [{ hooks: [async (event) => { bind(event.session_id); return {}; }] }] },
      spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
        const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        child.stderr.on("data", (chunk: Buffer) => { this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_192); });
        this.processId = child.pid;
        return child;
      },
      canUseTool: async (tool, input, context) => {
        if (this.allowedTools.has(tool)) return { behavior: "allow", updatedInput: input };
        const id = randomUUID();
        const request: ManagedPermissionRequest = {
          id, tool_name: tool, tool_input: input, created_at: Date.now(),
          expires_at: Date.now() + 120_000,
          title: context.title, description: context.description,
        };
        const allow = await new Promise<boolean>((resolve) => {
          const finish = (value: boolean) => {
            clearTimeout(timer);
            context.signal.removeEventListener("abort", aborted);
            this.permissions.delete(id);
            resolve(value);
          };
          const aborted = () => finish(false);
          const timer = setTimeout(aborted, 120_000);
          timer.unref();
          this.permissions.set(id, { request, resolve: finish });
          context.signal.addEventListener("abort", aborted, { once: true });
          if (context.signal.aborted || this.closed) aborted();
          this.recordListener?.({ type: "control_request", request_id: id, request });
        });
        return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Tool permission denied" };
      },
    };
    const cancelled = () => { void this.close(); };
    request.signal?.addEventListener("abort", cancelled, { once: true });
    try {
      if (request.signal?.aborted || this.closed) throw new Error("Claude startup cancelled");
      this.warm = await this.sdk.startup({ options, initializeTimeoutMs: 15_000 });
      if (this.closed || request.signal?.aborted) { this.warm.close(); throw new Error("Claude startup cancelled"); }
      this.query = this.warm.query(this.input);
      this.warm = null;
      this.drain = this.consume(bind);
      // Initialization makes the controller usable; native identity is emitted
      // by the SDK only when the first explicit turn begins. A resumed identity
      // is already known from the caller's durable native history.
      if (request.kind !== "start") this.nativeSessionId = providerId;
      await this.query.initializationResult();
      if (this.closed || request.signal?.aborted) throw new Error("Claude startup cancelled");
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", cancelled);
    }
  }

  private async consume(bind: (id: string) => void): Promise<void> {
    try {
      for await (const record of this.query!) {
        if (this.closed) break;
        if (record.type === "system" && record.subtype === "init") bind(record.session_id);
        if (this.recordListener) this.recordListener(record);
        else this.buffered.push(record);
      }
      if (!this.closed) {
        this.closed = true;
        this.exitListener?.({ code: 0, signal: null, stderr: "" });
      }
    } catch (error) {
      if (!this.closed) {
        this.closed = true;
        this.exitListener?.({ code: 1, signal: null, stderr: [String(error), this.stderrTail.trim()].filter(Boolean).join("\n") });
      }
    } finally {
      this.input.close();
      for (const permission of this.permissions.values()) permission.resolve(false);
      this.query?.close();
    }
  }

  write(record: SDKUserMessage): void { this.input.push(record); }
  onRecord(listener: (record: unknown) => void): void { this.recordListener = listener; for (const record of this.buffered.splice(0)) listener(record); }
  onExit(listener: NonNullable<ClaudeSdkTransport["exitListener"]>): void { this.exitListener = listener; }
  pendingPermissions(): ManagedPermissionRequest[] { return [...this.permissions.values()].map(({ request }) => request); }
  decidePermission(id: string, decision: "allow" | "deny" | "allow_always"): boolean {
    const pending = this.permissions.get(id);
    if (!pending) return false;
    if (decision === "allow_always") this.allowedTools.add(pending.request.tool_name);
    pending.resolve(decision !== "deny");
    return true;
  }
  async interrupt(): Promise<void> { if (!this.query || this.closed) throw new Error("Claude controller unavailable"); await this.query.interrupt(); }
  async configure(settings: ConversationRuntimeOptions): Promise<void> {
    if (!this.query || this.closed) throw new Error("Claude controller unavailable");
    await this.query.setModel(settings.model);
    await this.query.setPermissionMode(settings.permission_mode as NonNullable<Options["permissionMode"]> ?? "default");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.input.close();
    for (const permission of this.permissions.values()) permission.resolve(false);
    this.warm?.close();
    this.query?.close();
    await this.drain;
  }
}
