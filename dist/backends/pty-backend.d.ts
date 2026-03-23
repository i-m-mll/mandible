import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { AgenticBackend } from "../agentic-backend.js";
import type { ConsoleSession, ConsoleStreamEvent, Logger } from "../types.js";
export declare class PTYBackend extends EventEmitter implements AgenticBackend {
    readonly id: string;
    meta: ConsoleSession;
    private ptyProc;
    private ringBuffer;
    private streamEvents;
    private wsClients;
    private lineBuffer;
    private onDataDisposable;
    private onExitDisposable;
    private restartAttempts;
    private logger;
    /** Bug: 790433d — Preset IDs for PTY sessions, applied at launch via --append-system-prompt */
    private presetIds;
    constructor(meta: ConsoleSession, logger: Logger);
    /** Bug: 790433d — Set preset IDs before start(). PTY presets are locked for session lifetime. */
    setPresetIds(ids: string[]): void;
    start(): void;
    stop(signal?: string): void;
    destroy(): void;
    resize(cols: number, rows: number): void;
    write(data: string): void;
    clear(): void;
    sendPrompt(text: string): void;
    addWsClient(ws: WebSocket): void;
    removeWsClient(ws: WebSocket): void;
    getBufferSnapshot(): Buffer;
    getStreamEvents(): ConsoleStreamEvent[];
    ingestStructuredEvent(event: ConsoleStreamEvent): void;
    ingestText(data: string): void;
    private handleData;
    private feedLineParser;
    private parseStreamJsonLine;
    private storeStructuredEvent;
    private handleExit;
    private broadcastWsStatus;
    private emitMetaUpdate;
    private emitStatus;
    private extractModel;
    private stripArgValue;
    private buildLaunchArgs;
    private buildPtyEnv;
    private makeUserEvent;
    private buildPromptInvocation;
}
