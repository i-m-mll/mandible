import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import { spawnTerminal, type TerminalProcess } from "./bun-terminal.js";
import type { WebSocket } from "ws";
import type { TerminalBackend, BackendMetaUpdate, BackendStatusEvent } from "../agentic-backend.js";
import type { ConsoleSession, ConsoleStreamEvent, Logger } from "../types.js";
import { RingBuffer } from "../ring-buffer.js";
import { projectManagedProviderIdentity } from "./mandible-transport.js";

export class PTYBackend extends EventEmitter implements TerminalBackend {
  readonly id: string;
  meta: ConsoleSession;
  private process: TerminalProcess | null = null;
  private readonly buffer = new RingBuffer();
  private readonly clients = new Set<WebSocket>();
  private destroyed = false;
  private decoder = new StringDecoder("utf8");

  constructor(meta: ConsoleSession, private readonly logger: Logger) {
    super(); this.id = meta.id; this.meta = meta;
  }

  start(): void {
    if (this.destroyed) throw new Error("Terminal has been destroyed");
    if (this.process) throw new Error("Terminal is already running");
    const env = { ...process.env, ...this.meta.env };
    projectManagedProviderIdentity(env, "shell");
    delete env.MANDIBLE_TOKEN;
    delete env.CLAUDECODE;
    delete env.GIT_CONFIG_COUNT;
    for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete env[key];
    this.decoder = new StringDecoder("utf8");
    let owned: TerminalProcess;
    try {
      owned = spawnTerminal([this.meta.command, ...this.meta.args], {
        cwd: this.meta.cwd ?? process.env.HOME ?? "/tmp", env: { ...env, TERM: "xterm-256color" },
        terminal: { name: "xterm-256color", cols: this.meta.cols, rows: this.meta.rows,
          data: (_terminal, bytes) => { this.buffer.append(this.decoder.write(Buffer.from(bytes))); for (const client of this.clients) if (client.readyState === 1) client.send(bytes); },
        },
      });
    } catch (error) {
      this.update({ status: "crashed", pid: null, stopped_at: Date.now(), updated_at: Date.now() });
      this.logger("error", "terminal_spawn_failed", { id: this.id, error: String(error) });
      throw error;
    }
    this.process = owned;
    this.update({ status: "running", pid: owned.pid, started_at: Date.now(), stopped_at: null, exit_code: null, updated_at: Date.now() });
    this.emit("status", { kind: "started", status: "running", started_at: this.meta.started_at } satisfies BackendStatusEvent);
    void owned.exited.then(exitCode => {
      if (this.process !== owned) return;
      this.process = null;
      this.buffer.append(this.decoder.end());
      owned.terminal.close();
      this.update({ status: exitCode === 0 ? "stopped" : "crashed", pid: null, exit_code: exitCode, stopped_at: Date.now(), updated_at: Date.now() });
      this.emit("status", { kind: "exit", status: this.meta.status, exitCode, signal: null, stopped_at: this.meta.stopped_at } satisfies BackendStatusEvent);
    }).catch(error => {
      this.logger("error", "terminal_exit_failed", { id: this.id, error: String(error) });
      if (this.process === owned) {
        this.process = null; owned.terminal.close();
        this.update({ status: "crashed", pid: null, stopped_at: Date.now(), updated_at: Date.now() });
      }
    });
  }

  stop(signal = "SIGTERM"): void { if (!this.process) throw new Error("Terminal is not running"); this.process.kill(signal); }
  destroy(): void {
    this.destroyed = true;
    this.process?.kill();
    this.process?.terminal.close();
    this.process = null;
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.removeAllListeners();
  }
  clear(): void { this.buffer.clear(); }
  write(data: string): void { if (!this.process) throw new Error("Terminal is not running"); this.process.terminal.write(data); }
  resize(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) throw new Error("Invalid terminal size");
    this.process?.terminal.resize(cols, rows);
    this.update({ cols, rows, updated_at: Date.now() });
  }
  addWsClient(ws: WebSocket): void {
    this.clients.add(ws);
    const snapshot = this.buffer.snapshot(); if (snapshot.length) ws.send(snapshot);
    ws.on("message", (data, binary) => {
      try {
        if (binary) { this.write(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)); return; }
        let message: { type?: string; data?: string; cols?: number; rows?: number };
        try { message = JSON.parse(String(data)); } catch { this.write(String(data)); return; }
        if (message.type === "resize" && message.cols && message.rows) this.resize(message.cols, message.rows);
        else if (message.type === "input" && typeof message.data === "string") this.write(message.data);
      } catch (error) {
        this.logger("warn", "terminal_input_rejected", { id: this.id, error: String(error) });
        ws.close(1008, "Terminal input is unavailable");
      }
    });
    ws.on("close", () => this.removeWsClient(ws));
  }
  removeWsClient(ws: WebSocket): void { this.clients.delete(ws); }
  getBufferSnapshot(): Buffer { return this.buffer.snapshot(); }
  getStreamEvents(): ConsoleStreamEvent[] { return []; }

  private update(fields: BackendMetaUpdate): void { this.meta = { ...this.meta, ...fields }; this.emit("meta_update", fields); }
}
