import { join } from "node:path";
import { accessSync, constants, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import type {
  ClientNotification,
  ModelListParams,
  GetAccountParams,
  InitializeParams,
  ThreadReadParams,
  ThreadArchiveParams,
  ThreadQueueListParams,
  ThreadUnarchiveParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "./generated/codex-app-server/index.js";
import { StructuredJsonProcess, type StructuredProcessExit, type StructuredProcessSpawner } from "./structured-process.js";

type CodexRequestParams = {
  "model/list": ModelListParams;
  initialize: InitializeParams;
  "account/read": GetAccountParams;
  "thread/start": ThreadStartParams;
  "thread/resume": ThreadResumeParams;
  "thread/read": ThreadReadParams;
  "thread/archive": ThreadArchiveParams;
  "thread/queue/list": ThreadQueueListParams;
  "thread/unarchive": ThreadUnarchiveParams;
  "turn/start": TurnStartParams;
  "turn/steer": TurnSteerParams;
  "turn/interrupt": TurnInterruptParams;
};

type PendingRequest = {
  method: keyof CodexRequestParams;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type CodexProtocolRecord = { method: string; params?: unknown; id?: string | number };

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

export function codexAppServerExecutable(options: {
  platform?: NodeJS.Platform;
  override?: string;
  checkExecutable?: (path: string) => void;
} = {}): string {
  const override = options.override ?? process.env.MANDIBLE_CODEX_APP_SERVER_BIN;
  // Desktop owns the paginated thread format; its bundled CLI tracks that protocol.
  const command = override || ((options.platform ?? platform()) === "darwin"
    ? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
    : "codex");
  if (command !== "codex") {
    try {
      (options.checkExecutable ?? ((path) => accessSync(path, constants.X_OK)))(command);
    } catch {
      throw new Error(`Codex App Server executable is unavailable: ${command}. Set MANDIBLE_CODEX_APP_SERVER_BIN to the compatible desktop runtime.`);
    }
  }
  return command;
}

export class CodexAppServerClient {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private notificationListener: ((record: CodexProtocolRecord) => void) | null = null;
  private exitListener: ((exit: StructuredProcessExit) => void) | null = null;
  private malformedListener: (() => void) | null = null;

  private constructor(private readonly processOwner: StructuredJsonProcess, private readonly observer: { directory: string; controller_instance_id: string } | null) {
    processOwner.onRecord((record) => this.accept(record));
    processOwner.onMalformed(() => this.malformedListener?.());
    processOwner.onExit((exit) => {
      if (this.observer) rmSync(this.observer.directory, { recursive: true, force: true });
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(exit.stderr || `Codex App Server exited with ${exit.code ?? exit.signal}`));
      }
      this.pending.clear();
      this.exitListener?.(exit);
    });
  }

  static async connect(options: { spawnProcess?: StructuredProcessSpawner; executable?: string; env?: NodeJS.ProcessEnv;
    executionObserver?: { controller_instance_id: string; provider_session_id: string | null } } = {}): Promise<CodexAppServerClient> {
    const command = codexAppServerExecutable({ override: options.executable });
    const observer = options.executionObserver ? {
      directory: mkdtempSync(join(tmpdir(), "mandible-execution-observer-")),
      controller_instance_id: options.executionObserver.controller_instance_id,
    } : null;
    let client: CodexAppServerClient | null = null;
    try {
      const env = { ...options.env };
      if (observer) env.MANDIBLE_EXECUTION_OBSERVER_SESSION_FILE = join(observer.directory, "session.json");
      const processOwner = await StructuredJsonProcess.start(command, ["app-server", "--listen", "stdio://"],
        { spawnProcess: options.spawnProcess, ...(options.env || observer ? { env } : {}) });
      client = new CodexAppServerClient(processOwner, observer);
      if (options.executionObserver?.provider_session_id) client.bindExecutionObserver(options.executionObserver.provider_session_id);
      await client.request("initialize", {
        clientInfo: { name: "mandible", title: "Mandible", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      const initialized: ClientNotification = { method: "initialized" };
      client.processOwner.write(initialized);
      return client;
    } catch (error) {
      if (client) await client.close();
      if (observer) rmSync(observer.directory, { recursive: true, force: true });
      throw error;
    }
  }

  bindExecutionObserver(providerSessionId: string): void {
    if (!this.observer) return;
    const staged = join(this.observer.directory, "session.tmp");
    writeFileSync(staged, JSON.stringify({ controller_instance_id: this.observer.controller_instance_id,
      provider_session_id: providerSessionId }), { mode: 0o600 });
    renameSync(staged, join(this.observer.directory, "session.json"));
  }

  get alive(): boolean {
    return this.processOwner.alive;
  }

  get pid(): number | undefined {
    return this.processOwner.pid;
  }

  request<M extends keyof CodexRequestParams>(method: M, params: CodexRequestParams[M]): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error("Codex App Server is not running"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out`));
      }, 15_000);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.processOwner.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onNotification(listener: (record: CodexProtocolRecord) => void): void {
    this.notificationListener = listener;
  }

  onMalformed(listener: () => void): void {
    this.malformedListener = listener;
  }

  onExit(listener: (exit: StructuredProcessExit) => void): void {
    this.exitListener = listener;
  }

  respond(id: string | number, result: unknown): void {
    this.processOwner.write({ id, result });
  }

  close(): Promise<StructuredProcessExit> {
    return this.processOwner.close();
  }

  private accept(value: unknown): void {
    const record = object(value);
    if (!record) {
      this.malformedListener?.();
      return;
    }
    if ((typeof record.id === "number" || typeof record.id === "string") && ("result" in record || "error" in record)) {
      const id = Number(record.id);
      const request = this.pending.get(id);
      if (!request) {
        this.malformedListener?.();
        return;
      }
      clearTimeout(request.timer);
      this.pending.delete(id);
      if ("error" in record) {
        const error = object(record.error);
        request.reject(new Error(
          typeof error?.message === "string" ? error.message : `Codex App Server ${request.method} failed`,
        ));
      } else {
        request.resolve(record.result);
      }
      return;
    }
    if (typeof record.method === "string") {
      this.notificationListener?.({
        method: record.method,
        params: record.params,
        ...(typeof record.id === "number" || typeof record.id === "string" ? { id: record.id } : {}),
      });
      return;
    }
    this.malformedListener?.();
  }
}
