import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { AgenticBackend, ConfigurableBackend, PermissionAwareBackend, PermissionDecision, PermissionRequest, UsageAwareBackend } from "../agentic-backend.js";
import type { ConsoleSession, ConsoleStreamEvent, Logger } from "../types.js";
import { SessionRegistry } from "../registry.js";
type UsageRow = Record<string, unknown>;
interface SubagentInfo {
    agent_id: string;
    agent_type: string;
    started_at: number;
}
export interface SDKBackendOptions {
    model?: string;
    systemPrompt?: string;
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
    allowedTools?: string[];
    maxTurns?: number;
    maxCostUsd?: number;
    /** Bug: 61bee4e — Preset IDs to compute union system prompt from */
    presetIds?: string[];
    /** Bug: 61bee4e — Override settingSources based on active preset sources */
    settingSourcesOverride?: string[];
}
export declare class SDKBackend extends EventEmitter implements AgenticBackend, PermissionAwareBackend, ConfigurableBackend<SDKBackendOptions>, UsageAwareBackend<UsageRow> {
    readonly id: string;
    meta: ConsoleSession;
    private logger;
    private sessionRegistry?;
    private wsClients;
    private eventLog;
    private usageLog;
    private options;
    private autoAllowedTools;
    private pendingPermissions;
    private subagentTree;
    private promptQueue;
    private processing;
    private activeQuery;
    private abortController;
    private destroyed;
    /** Bug: 790433d — Message index counter for parameter snapshots */
    private messageIndex;
    /** Bug: 81c9d85 — expose processing state for is_processing on ConsoleSession */
    get isProcessing(): boolean;
    constructor(meta: ConsoleSession, logger: Logger, sessionRegistry?: SessionRegistry);
    start(): void;
    stop(_signal?: string): void;
    destroy(): void;
    clear(): void;
    sendPrompt(text: string): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    addWsClient(ws: WebSocket): void;
    removeWsClient(ws: WebSocket): void;
    getBufferSnapshot(): Buffer;
    getStreamEvents(): ConsoleStreamEvent[];
    ingestStructuredEvent(event: ConsoleStreamEvent): void;
    ingestText(data: string): void;
    updateOptions(options: SDKBackendOptions): void;
    getPendingPermissions(): PermissionRequest[];
    resolvePermission(requestId: string, decision: PermissionDecision): boolean;
    getUsage(): UsageRow[];
    getActiveSubagents(): SubagentInfo[];
    private processPromptQueue;
    private runPrompt;
    private buildQueryOptions;
    /**
     * Bug: a432b63 — Build MCP server configs for the Mandible channel server.
     *
     * The channel server provides inside-out integration: the agent can query
     * Mandible for inbox items, work units, issues, and submit auth requests.
     * This is complementary to SDK hooks which provide outside-in control
     * (permissions, abort, cost tracking).
     *
     * The channel server is spawned as a stdio subprocess by the SDK. It reads
     * MANDIBLE_SESSION_ID from env to link itself to the existing SDK session.
     * The ChannelRegistry uses upsert semantics, so double-registration from
     * both the SDK hook (ensureMandibleSession) and the channel server startup
     * is safe — the channel server's registration becomes a no-op update.
     */
    private buildChannelMcpServers;
    private buildHooks;
    private handleToolPermission;
    private normalizeSDKEvent;
    private normalizeSystemMessage;
    private normalizeAssistantMessage;
    private normalizeUserMessage;
    private normalizeResultMessage;
    private normalizeToolProgressMessage;
    private normalizeToolUseSummaryMessage;
    private normalizePartialAssistantMessage;
    private normalizeContentBlocks;
    private normalizeUserBlocks;
    private normalizeToolResultContent;
    private normalizeUsage;
    private normalizeRawUsage;
    private storeAndBroadcast;
    private buildUsageRow;
    private cancelActiveQuery;
    /**
     * Bug: 790433d — Snapshot the effective config for the current message index.
     * Uses a keyframe/delta model: only writes a row when the parameters differ
     * from the last snapshot (or on the first prompt).
     */
    private snapshotMessageParams;
    private resolveAllPendingPermissions;
    private emitMetaUpdate;
    private emitStatus;
    private ensureMandibleSession;
    private extractModel;
    private asRecord;
    private readNumber;
}
export {};
