import { DOMAIN_EVENTS, type MandibleEventType } from "./contracts.js";
import { isSqliteBusy } from "./sqlite.js";
// Ingestion service: watches filesystem for conversation files and maintains
// the conversations/conversation_blocks tables in sync.

import chokidar from "chokidar";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import SqliteDatabase from "./sqlite.js";
import { getDb, type Db } from "./db.js";
import { resolveConversationId } from './conversations/identity.js';
import { broadcast } from "./sse.js";
import { compressContentAsync } from "./compression.js";
import { getParserForFile } from "./parsers/index.js";
import {
  codexRelocationCandidates,
  getCodexSessionIndexPath,
  isCodexRolloutPath,
  locateCodexRollout,
  loadCodexNativeSessionId,
  loadCodexSessionIndexTitle,
} from "./parsers/codex.js";
import { lineageGapSeverity, linkIngestedConversation } from "./conversation-lineage.js";
import { inferGeminiProjectIdentity } from "./parsers/gemini.js";
import { clearHookNotificationAttention } from "./claude-hook-attention.js";
import {
  maskActiveCredentialsInText,
  maskAllCandidatesInBlocks,
  maskUnverifiedCandidates,
  redactCredentialLeaksInBlocks,
} from "./credential-leak-scan.js";
import { assignConversationBlockIds, conversationBlockId } from "./conversation-block-id.js";
import {
  ingestClaudeWorkflowArtifact,
  isClaudeWorkflowJournalPath,
  isClaudeWorkflowSummaryPath,
  isClaudeWorkflowTranscriptPath,
  workflowSummaryPathForArtifact,
} from "./workflows.js";
import type { Logger } from "./types.js";
import type {
  AppendParserSourceSnapshot,
  ConversationBlock,
  ParseResult,
} from "./parsers/types.js";
import { canUseDefaultIngestionWorker, IngestionActor } from "./ingestion-actor.js";
import { ConversationSourceChangedError, ConversationSourceStore } from "./conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "./conversations/source-types.js";
import { parseJsonObjectStrict } from "./row-coerce.js";
import { backfillConversationLineageOnce } from "./conversations/lineage-backfill.js";
import { getConversationStructureCache } from "./conversations/structure-cache.js";

// --- Watch configuration ---

const WATCH_CONFIGS = [
  { base: path.join(os.homedir(), ".claude", "projects"), glob: "**/*.jsonl" },
  { base: path.join(os.homedir(), ".claude", "projects"), glob: "**/workflows/wf_*.json" },
  { base: path.join(os.homedir(), ".codex", "sessions"), glob: "**/*.jsonl" },
  // `codex archive` (which Mandible itself triggers on merge/resume) moves
  // rollout files here. Watching the archive root keeps those conversations
  // ingestable instead of looking like deleted sources.
  { base: path.join(os.homedir(), ".codex", "archived_sessions"), glob: "**/*.jsonl" },
  { base: path.join(os.homedir(), ".gemini", "tmp"), glob: "**/chats/*.json" },
  { base: path.join(os.homedir(), ".gemini", "tmp"), glob: "**/chats/*.jsonl" },
];

const DEBOUNCE_MS = 200;
/** Floor between reconciles triggered by path-less watch events. */
const UNNAMED_EVENT_RECONCILE_MIN_INTERVAL_MS = 60_000;
export const RECONCILE_INTERVAL_MS = 60 * 60_000;
export const DIRTY_INGEST_BATCH_SIZE = 16;
export const MAX_DIRTY_INGEST_PATHS = 4096;
const INGEST_TAIL_HASH_BYTES = 4096;
/** Keep every native fs.read length well below Node's signed-32-bit boundary. */
export const INGEST_RANGE_READ_CHUNK_BYTES = 1024 * 1024;
/** The existing incremental parser accepts one string, so bound that materialization. */
export const MAX_BUFFERED_APPEND_BYTES = 16 * 1024 * 1024;
// The observed production rollout contains a 49,328,891-byte JSONL record.
// Permit that one record while keeping every incremental parse independent of
// the total append extent; a larger unterminated record is left checkpointed
// for a visible retry instead of falling back to an unbounded whole-file parse.
export const MAX_BUFFERED_APPEND_RECORD_BYTES = 64 * 1024 * 1024;
export const INGEST_COMPRESSION_CONCURRENCY = 4;

/** One recursive watch root: every glob that shares a base directory. */
export interface WatchRoot {
  base: string;
  globs: string[];
}

/**
 * Collapse watch configs that share a base directory into a single watch root.
 *
 * Bug: 4f7e45e — chokidar v4 dropped FSEvents, so watching these bases opened
 * one `fs.watch` fd per matched file (11,675 fds against the real corpus) and
 * pushed the daemon past its fd limit, making every subsequent spawn fail with
 * EMFILE. Watch cost is now O(number of roots) instead of O(number of files),
 * and grouping keeps it O(roots) rather than O(configs).
 */
export function groupWatchConfigs(
  configs: ReadonlyArray<{ base: string; glob: string }>,
): WatchRoot[] {
  const roots = new Map<string, WatchRoot>();
  for (const config of configs) {
    const existing = roots.get(config.base);
    if (!existing) {
      roots.set(config.base, { base: config.base, globs: [config.glob] });
      continue;
    }
    if (!existing.globs.includes(config.glob)) {
      existing.globs.push(config.glob);
    }
  }
  return Array.from(roots.values());
}

/** True when an absolute path under `base` matches any of the root's globs. */
export function makeWatchRootMatcher(
  base: string,
  globs: readonly string[],
): (filePath: string) => boolean {
  const matchers = globs.map((glob) => makeWatchFileMatcher(base, glob));
  return (filePath: string) => matchers.some((match) => match(filePath));
}

/**
 * Resolve the absolute path carried by a recursive `fs.watch` event.
 *
 * Node reports `filename` relative to the watched base using "/" separators,
 * including on macOS where the FSEvents backend strips the watched prefix even
 * when the base itself resolves through a symlink. The watched directory emits
 * its own basename for self-events; that never matches a file glob, so the
 * caller's matcher filters it. Returns null when the platform omits the name.
 */
export function resolveWatchEventPath(base: string, filename: unknown): string | null {
  const name = typeof filename === "string"
    ? filename
    : Buffer.isBuffer(filename)
      ? filename.toString("utf8")
      : null;
  if (!name) return null;
  if (path.isAbsolute(name)) return path.normalize(name);
  return path.join(base, ...name.split("/"));
}

/**
 * How a watch root is currently delivering (or failing to deliver) events.
 *
 * `recursive` and `per-file` are the two live event-driven modes. `reattaching`
 * and `degraded-poll` both mean "no live watcher, events are being missed":
 * the first is the bounded retry gap after a watcher failed, the second is the
 * platform fallback the ladder ends in.
 *
 * Bug: 4f7e45e (re-review nit) — `reattaching` exists because a runtime error
 * closes the watcher but the root kept reporting `recursive` for the whole
 * retry interval, so `rootCount` claimed a live watcher that no longer existed
 * exactly while events were being lost.
 */
export type WatchRootMode = "recursive" | "per-file" | "reattaching" | "degraded-poll";

/** True for the modes that actually have a watcher delivering events. */
export function isLiveWatchMode(mode: WatchRootMode): boolean {
  return mode === "recursive" || mode === "per-file";
}

/**
 * Bounded retry ladder for a root whose recursive watch failed at startup or
 * died at runtime. Exhausting the ladder moves the root to its platform
 * fallback; the ladder is per-root and resets on every successful attach.
 */
export const WATCH_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];

/**
 * Cadence for a root that has degraded to reconcile-only ingestion. Each tick
 * costs one re-attach attempt plus at most one throttled reconcile — bounded
 * work that never scales with the number of conversation files, and 12x more
 * responsive than waiting for the hourly reconcile.
 */
export const DEGRADED_ROOT_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Whether this platform may fall back to per-file watching.
 *
 * Bug: 4f7e45e — chokidar v4 dropped FSEvents, so on darwin its fallback opens
 * roughly one descriptor per matched file (11,675 against the real corpus). A
 * daemon holding more than 10,240 descriptors cannot spawn *any* subprocess:
 * macOS `posix_spawn` rejects stdio descriptor numbers >= OPEN_MAX regardless
 * of rlimit, which broke every protected-branch merge approval. Darwin
 * therefore never falls back to per-file watching, at startup or at runtime;
 * it degrades to bounded polling instead. Other platforms keep chokidar, where
 * it watches directories through inotify rather than one fd per file.
 */
export function allowsPerFileFallback(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "darwin";
}

/** Injection seam: constructs one recursive watcher for a root. */
export type RecursiveWatchFactory = (
  base: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => fs.FSWatcher;

export interface PerFileWatcher {
  close(): Promise<void>;
}

/** Injection seam: constructs the per-file fallback watcher for one glob. */
export type PerFileWatchFactory = (
  base: string,
  glob: string,
  handlers: { onFile: (filePath: string) => void; onError: (error: unknown) => void },
) => PerFileWatcher;

export interface ConversationWatchHandle {
  /** Roots with a live event-driven watcher — the fd budget of the watcher. */
  readonly rootCount: number;
  /**
   * Roots with no live watcher: polling, or inside the retry gap after a
   * watcher error. Both are windows where events are missed and the caller is
   * asked to reconcile, so both are counted here rather than as live roots.
   */
  readonly degradedRootCount: number;
  /** Current delivery mode per watched base. */
  readonly rootModes: ReadonlyMap<string, WatchRootMode>;
  close(): Promise<void>;
}

export interface ConversationWatchOptions {
  configs?: ReadonlyArray<{ base: string; glob: string }>;
  /** Called with the absolute path of every event on a glob-matching file. */
  onFile: (filePath: string) => void;
  /** Called when a platform delivers an event without a path (events may be lost). */
  onUnnamedEvent?: (base: string) => void;
  /**
   * Called when a root cannot deliver reliable events — its watcher failed, is
   * being re-established, or the root is polling. The caller is expected to
   * reconcile (throttled), because events for that root are being missed.
   */
  onDegraded?: (base: string, reason: string) => void;
  log?: Logger;
  /** Platform override; tests use it to pin the darwin fallback policy. */
  platform?: NodeJS.Platform;
  /** Recursive watch constructor override (tests inject failures). */
  watchFactory?: RecursiveWatchFactory;
  /** Per-file fallback constructor override (tests assert it is never called). */
  perFileWatchFactory?: PerFileWatchFactory;
  retryDelaysMs?: readonly number[];
  degradedPollIntervalMs?: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

function defaultRecursiveWatchFactory(
  base: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
): fs.FSWatcher {
  return fs.watch(base, { recursive: true, persistent: true }, listener);
}

/**
 * The per-file fallback, and the only chokidar construction in the watcher.
 * `allowsPerFileFallback` gates every call site, so darwin can never reach it.
 */
function createChokidarPerFileWatcher(
  base: string,
  glob: string,
  handlers: { onFile: (filePath: string) => void; onError: (error: unknown) => void },
): PerFileWatcher {
  const matchesGlob = makeWatchFileMatcher(base, glob);
  const fallback = chokidar.watch(base, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ignored: (watchedPath, stats) => {
      if (!stats?.isFile()) {
        return false;
      }
      return !matchesGlob(watchedPath);
    },
  });
  const onWatchedFileEvent = (filePath: string) => {
    if (matchesGlob(filePath)) {
      handlers.onFile(filePath);
    }
  };
  fallback.on("add", onWatchedFileEvent);
  fallback.on("change", onWatchedFileEvent);
  fallback.on("unlink", onWatchedFileEvent);
  fallback.on("error", handlers.onError);
  return { close: () => fallback.close() };
}

interface WatchSupervisorContext {
  log: Logger;
  platform: NodeJS.Platform;
  perFileFallbackAllowed: boolean;
  onFile: (filePath: string) => void;
  onUnnamedEvent: (base: string) => void;
  onDegraded: (base: string, reason: string) => void;
  watchFactory: RecursiveWatchFactory;
  perFileWatchFactory: PerFileWatchFactory;
  retryDelaysMs: readonly number[];
  degradedPollIntervalMs: number;
}

interface RootSupervisor {
  readonly mode: WatchRootMode;
  close(): Promise<void>;
}

/**
 * Keep one watch root alive.
 *
 * Node documents an `FSWatcher` that emitted `error` as no longer usable, so a
 * runtime failure closes the watcher, asks the caller to reconcile (events
 * during the gap are lost), and re-attaches on a bounded retry ladder. When the
 * ladder is exhausted the root takes its platform fallback: per-file watching
 * off darwin, bounded polling on darwin. A polling root keeps making one cheap
 * re-attach attempt per tick, so a transient FSEvents failure self-heals back
 * to low-latency ingestion instead of waiting for a daemon restart.
 */
function superviseWatchRoot(root: WatchRoot, ctx: WatchSupervisorContext): RootSupervisor {
  const matches = makeWatchRootMatcher(root.base, root.globs);
  // Until the startup attach below resolves, the root has no watcher and no
  // poll timer; every attach/fallback path overwrites this.
  let mode: WatchRootMode = "reattaching";
  let watcher: fs.FSWatcher | null = null;
  let perFileWatchers: PerFileWatcher[] = [];
  let retryIndex = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** False only during the initial attach, so later attaches log as recoveries. */
  let startupAttachDone = false;
  let closed = false;

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const handleRuntimeError = (source: fs.FSWatcher, error: unknown) => {
    try {
      source.close();
    } catch {
      // An errored FSWatcher may already be torn down; closing is best effort.
    }
    if (closed || watcher !== source) return;
    watcher = null;
    // Bug: 4f7e45e — the root has no watcher from here until a retry attaches
    // one (or the ladder ends in a fallback). Reporting `recursive` through
    // that window overstated the live-root count precisely when events were
    // being lost.
    mode = "reattaching";
    ctx.log("warn", "ingestion_watcher_error", {
      base: root.base,
      error: describeError(error),
      action: "restart",
    });
    // Events between the failure and re-establishment are lost.
    ctx.onDegraded(root.base, "watcher_error");
    scheduleRetryOrFallback();
  };

  const attach = (): boolean => {
    if (closed) return false;
    let active: fs.FSWatcher;
    try {
      active = ctx.watchFactory(root.base, (_eventType, filename) => {
        const filePath = resolveWatchEventPath(root.base, filename);
        if (!filePath) {
          ctx.onUnnamedEvent(root.base);
          return;
        }
        if (matches(filePath)) {
          ctx.onFile(filePath);
        }
      });
    } catch (error) {
      ctx.log("warn", "ingestion_watcher_recursive_unavailable", {
        base: root.base,
        error: describeError(error),
      });
      return false;
    }
    active.on("error", (error: unknown) => handleRuntimeError(active, error));
    watcher = active;
    mode = "recursive";
    retryIndex = 0;
    clearRetry();
    stopPolling();
    ctx.log("info", startupAttachDone ? "ingestion_watcher_recovered" : "ingestion_watcher_started", {
      base: root.base,
      globs: root.globs,
      mode: "recursive",
    });
    return true;
  };

  const startPerFileFallback = (reason: string): boolean => {
    const started: PerFileWatcher[] = [];
    try {
      for (const glob of root.globs) {
        started.push(
          ctx.perFileWatchFactory(root.base, glob, {
            onFile: ctx.onFile,
            onError: (error) => {
              ctx.log("warn", "ingestion_watcher_error", {
                base: root.base,
                glob,
                error: describeError(error),
                mode: "per-file",
              });
            },
          }),
        );
      }
    } catch (error) {
      void Promise.allSettled(started.map((entry) => entry.close()));
      ctx.log("warn", "ingestion_watcher_per_file_unavailable", {
        base: root.base,
        error: describeError(error),
      });
      return false;
    }
    perFileWatchers = started;
    mode = "per-file";
    stopPolling();
    ctx.log("warn", "ingestion_watcher_started", {
      base: root.base,
      globs: root.globs,
      mode: "per-file",
      reason,
    });
    return true;
  };

  const degradeToPolling = (reason: string) => {
    if (closed || pollTimer) return;
    mode = "degraded-poll";
    ctx.log("error", "ingestion_watcher_degraded", {
      base: root.base,
      reason,
      mode: "degraded-poll",
      poll_interval_ms: ctx.degradedPollIntervalMs,
      platform: ctx.platform,
    });
    ctx.onDegraded(root.base, reason);
    pollTimer = setInterval(() => {
      if (closed) return;
      // One cheap re-attach attempt per tick; if it fails, keep ingestion alive
      // at a bounded cadence by asking the caller to reconcile.
      if (attach()) return;
      ctx.onDegraded(root.base, "degraded_poll");
    }, ctx.degradedPollIntervalMs);
    unrefTimer(pollTimer);
  };

  const takeFallback = (reason: string) => {
    if (closed) return;
    if (ctx.perFileFallbackAllowed) {
      if (startPerFileFallback(reason)) return;
    } else {
      ctx.log("warn", "ingestion_watcher_per_file_fallback_refused", {
        base: root.base,
        reason,
        platform: ctx.platform,
      });
    }
    degradeToPolling(reason);
  };

  function scheduleRetryOrFallback(): void {
    if (closed) return;
    if (retryIndex >= ctx.retryDelaysMs.length) {
      takeFallback("retries_exhausted");
      return;
    }
    const delay = ctx.retryDelaysMs[retryIndex];
    retryIndex += 1;
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (closed) return;
      if (!attach()) scheduleRetryOrFallback();
    }, delay);
    unrefTimer(retryTimer);
  }

  const attachedAtStartup = attach();
  startupAttachDone = true;
  if (!attachedAtStartup) {
    takeFallback("recursive_unavailable");
  }

  return {
    get mode() {
      return mode;
    },
    async close(): Promise<void> {
      closed = true;
      clearRetry();
      stopPolling();
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Best effort: a watcher that already failed may throw on close.
        }
        watcher = null;
      }
      const pending = perFileWatchers;
      perFileWatchers = [];
      await Promise.allSettled(pending.map((entry) => entry.close()));
    },
  };
}

/**
 * Watch every conversation-source root recursively.
 *
 * Semantics match the previous chokidar wiring exactly: create, modify, and
 * delete of a glob-matching file all funnel into the same `onFile` callback
 * (the old code bound `add`, `change`, and `unlink` to one handler), so no
 * event-type classification or existence stat is needed. Downstream ingestion
 * already distinguishes present from missing sources, including the Codex
 * archive relocation probe.
 *
 * Each root is supervised: a startup failure or a runtime `error` retries on a
 * bounded ladder and then takes the platform fallback — per-glob chokidar
 * watchers off darwin, bounded polling reconciles on darwin, where per-file
 * watching is the descriptor explosion this watcher exists to prevent.
 */
export function watchConversationRoots(options: ConversationWatchOptions): ConversationWatchHandle {
  const log = options.log ?? (() => {});
  const configs = options.configs ?? WATCH_CONFIGS;
  const platform = options.platform ?? process.platform;
  const ctx: WatchSupervisorContext = {
    log,
    platform,
    perFileFallbackAllowed: allowsPerFileFallback(platform),
    onFile: options.onFile,
    onUnnamedEvent: (base) => options.onUnnamedEvent?.(base),
    onDegraded: (base, reason) => options.onDegraded?.(base, reason),
    watchFactory: options.watchFactory ?? defaultRecursiveWatchFactory,
    perFileWatchFactory: options.perFileWatchFactory ?? createChokidarPerFileWatcher,
    retryDelaysMs: options.retryDelaysMs ?? WATCH_RETRY_DELAYS_MS,
    degradedPollIntervalMs: options.degradedPollIntervalMs ?? DEGRADED_ROOT_POLL_INTERVAL_MS,
  };

  const supervisors = new Map<string, RootSupervisor>();
  for (const root of groupWatchConfigs(configs)) {
    if (!fs.existsSync(root.base)) {
      log("debug", "ingestion_skip_missing_dir", { path: root.base });
      continue;
    }
    supervisors.set(root.base, superviseWatchRoot(root, ctx));
  }

  const countModes = (predicate: (mode: WatchRootMode) => boolean): number => {
    let total = 0;
    for (const supervisor of supervisors.values()) {
      if (predicate(supervisor.mode)) total += 1;
    }
    return total;
  };

  return {
    get rootCount() {
      return countModes(isLiveWatchMode);
    },
    get degradedRootCount() {
      return countModes((mode) => !isLiveWatchMode(mode));
    },
    get rootModes() {
      const modes = new Map<string, WatchRootMode>();
      for (const [base, supervisor] of supervisors) {
        modes.set(base, supervisor.mode);
      }
      return modes;
    },
    async close(): Promise<void> {
      await Promise.allSettled(Array.from(supervisors.values(), (supervisor) => supervisor.close()));
      supervisors.clear();
    },
  };
}

interface StagedCompressedContents {
  readonly length: number;
  read(index: number): Buffer;
  dispose(): Promise<void>;
}

interface StagedContentRef {
  offset: number;
  length: number;
}

async function writeBufferAt(handle: fs.promises.FileHandle, buffer: Buffer, offset: number): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, offset + written);
    written += result.bytesWritten;
  }
}

/**
 * Compress in small ordered batches and spool results outside V8's retained heap.
 * The final SQLite transaction reads one staged buffer at a time, so a full
 * re-ingest never keeps every compressed block Buffer alive concurrently.
 */
export async function stageCompressedBlockContents(
  contents: readonly string[],
  compressor: (content: string) => Promise<Buffer> = compressContentAsync,
): Promise<StagedCompressedContents> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mandible-ingest-compression-"));
  const spoolPath = path.join(dir, "blocks.gzpack");
  const handle = await fs.promises.open(spoolPath, "w+");
  const refs: StagedContentRef[] = [];
  let offset = 0;
  let disposed = false;

  try {
    for (let start = 0; start < contents.length; start += INGEST_COMPRESSION_CONCURRENCY) {
      const batch = await Promise.all(
        contents
          .slice(start, start + INGEST_COMPRESSION_CONCURRENCY)
          .map((content) => compressor(content)),
      );
      for (const compressed of batch) {
        await writeBufferAt(handle, compressed, offset);
        refs.push({ offset, length: compressed.length });
        offset += compressed.length;
      }
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    length: refs.length,
    read(index: number): Buffer {
      const ref = refs[index];
      if (!ref) throw new RangeError(`missing staged compressed content at index ${index}`);
      const buffer = Buffer.allocUnsafe(ref.length);
      let read = 0;
      while (read < buffer.length) {
        const bytesRead = fs.readSync(handle.fd, buffer, read, buffer.length - read, ref.offset + read);
        if (bytesRead === 0) throw new Error(`short read for staged compressed content at index ${index}`);
        read += bytesRead;
      }
      return buffer;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await handle.close().catch(() => undefined);
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  };
}

// --- State ---

let conversationWatch: ConversationWatchHandle | null = null;
let lastUnnamedEventReconcileAt = 0;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let logger: Logger = () => {};
let eventPublisher: (event: MandibleEventType, data: unknown) => void = broadcast;
let ingestionActive = false;
let ingestionRunToken = 0;
let backgroundIngestionEnabled = true;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let ingestionActor: IngestionActor | null = null;
let backgroundBackoffMs: () => number = () => 0;

export class BoundedDirtyPathSet {
  private readonly paths = new Set<string>();

  constructor(private readonly maxPaths = MAX_DIRTY_INGEST_PATHS) {}

  get size(): number {
    return this.paths.size;
  }

  add(filePath: string): { added: boolean; replacedPath?: string } {
    if (this.paths.has(filePath)) return { added: false };
    let replacedPath: string | undefined;
    if (this.paths.size >= this.maxPaths) {
      replacedPath = this.paths.values().next().value as string | undefined;
      if (replacedPath) this.paths.delete(replacedPath);
    }
    this.paths.add(filePath);
    return { added: true, replacedPath };
  }

  take(limit: number): string[] {
    const batch = Array.from(this.paths).slice(0, limit);
    for (const filePath of batch) this.paths.delete(filePath);
    return batch;
  }

  delete(filePath: string): boolean {
    return this.paths.delete(filePath);
  }

  clear(): void {
    this.paths.clear();
  }
}

const queuedIngestPaths = new BoundedDirtyPathSet();
let ingestDrainRunning = false;
let ingestDrainPromise: Promise<void> | null = null;
let reconcileRequiredAfterBackpressure = false;
const codexSessionIndexSyncMtimes = new Map<string, number>();
const targetedIngestLastRun = new Map<string, number>();
const TARGETED_INGEST_MIN_INTERVAL_MS = 250;
const acpSuppressedSessions = new Map<string, number>();
const ACP_SUPPRESSION_TTL_MS = 24 * 60 * 60 * 1000;

type ExistingConversationRow = {
  id: string;
  source: string;
  source_hash: string;
  source_mtime: number;
  session_id: string;
  title: string;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  block_count: number;
  project_path: string | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  cli_version: string | null;
  distinct_identity_projection_detached: number;
  actual_count: number;
};

type IngestAppendState = {
  file_path: string;
  byte_offset: number;
  line_count: number;
  tail_hash: string;
  partial_line: string;
  empty_source_mtime: number | null;
  empty_source_size: number | null;
};

type WorkflowIngestState = {
  file_path: string;
  source_mtime: number;
  summary_path: string;
  workflow_id: string | null;
};

type IngestMode = "full" | "append";

type AppendReadResult =
  | {
      kind: "append";
      raw: string;
      completeLineCount: number;
      appendedBytes: number;
      nextPartialLine: string;
      sourceHash: string;
      tailHash: string;
      byteOffset: number;
      sourceSnapshot: AppendParserSourceSnapshot;
      hasMore: boolean;
    }
  | {
      kind: "buffered";
      appendedBytes: number;
      nextPartialLine: string;
      tailHash: string;
      byteOffset: number;
      hasMore: boolean;
    }
  | { kind: "blocked"; reason: string }
  | { kind: "fallback"; reason: string };

type AppendParserSourceRange = AppendParserSourceSnapshot["appendRanges"][number];

interface PendingAppendProof {
  filesystemDevice: string | null;
  filesystemInode: string | null;
  ranges: AppendParserSourceRange[];
}

// --- Public API ---

export interface StartIngestionOptions {
  dbPath?: string;
  getBackgroundBackoffMs?: () => number;
  /** Start the exact-path actor without watchers or startup reconciliation. */
  background?: boolean;
}

/**
 * Ingest without a path: either the platform coalesced or dropped the event
 * name, or a root lost its watcher and is polling. In both cases the changed
 * file is unknown, so ingestion falls back to a throttled full reconcile rather
 * than silently skipping the change.
 */
function requestWatchFallbackReconcile(base: string, reason: string): void {
  const now = Date.now();
  if (now - lastUnnamedEventReconcileAt < UNNAMED_EVENT_RECONCILE_MIN_INTERVAL_MS) {
    return;
  }
  lastUnnamedEventReconcileAt = now;
  logger("debug", "ingestion_watch_reconcile_fallback", { base, reason });
  scheduleReconcile();
}

export function startIngestion(log: Logger, options: StartIngestionOptions = {}): void {
  logger = log;
  requestedReparseFailures.clear();
  eventPublisher = broadcast;
  backgroundBackoffMs = options.getBackgroundBackoffMs ?? (() => 0);
  backgroundIngestionEnabled = options.background !== false;
  ingestionActive = true;
  ingestionRunToken++;
  if (options.dbPath && canUseDefaultIngestionWorker()) {
    ingestionActor = new IngestionActor({
      dbPath: options.dbPath,
      logger,
      publish: (event, data) => broadcast(event, data),
    });
  } else if (options.dbPath) {
    logger("debug", "ingestion_worker_unavailable_in_source_runtime");
  }
  if (!backgroundIngestionEnabled) {
    logger("info", "ingestion_selected_source_only");
    return;
  }

  logger("info", "ingestion_starting", { watch_paths: WATCH_CONFIGS.map((c) => c.base) });

  lastUnnamedEventReconcileAt = 0;
  conversationWatch = watchConversationRoots({
    log: logger,
    onFile: (filePath) => debouncedIngest(filePath),
    onUnnamedEvent: (base) => requestWatchFallbackReconcile(base, "event_without_path"),
    onDegraded: (base, reason) => requestWatchFallbackReconcile(base, reason),
  });

  // Run initial reconciliation to pick up files that already exist
  scheduleReconcile(true);

  // Periodic reconciliation
  reconcileTimer = setInterval(() => {
    scheduleReconcile();
  }, RECONCILE_INTERVAL_MS);
  if (typeof reconcileTimer === "object" && "unref" in reconcileTimer) {
    reconcileTimer.unref();
  }
}

export function stopIngestion(): void {
  void stopIngestionGracefully().catch((error) => {
    logger("warn", "ingestion_stop_error", { error: String(error) });
  });
}

export async function stopIngestionGracefully(): Promise<void> {
  logger("info", "ingestion_stopping");
  ingestionActive = false;
  ingestionRunToken++;
  const closingWatch = conversationWatch?.close() ?? Promise.resolve();
  conversationWatch = null;

  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  for (const timer of watcherRetryTimers.values()) clearTimeout(timer);
  watcherRetryTimers.clear();
  watcherRetryAttempted.clear();
  queuedIngestPaths.clear();
  ingestDrainRunning = false;
  reconciling = false;
  reconcileRequiredAfterBackpressure = false;
  const actor = ingestionActor;
  ingestionActor = null;
  const pendingDrain = ingestDrainPromise;
  const pendingReconcile = reconcilePromise;
  await Promise.allSettled([closingWatch]);
  await actor?.close();
  await Promise.allSettled([pendingDrain, pendingReconcile].filter((pending): pending is Promise<void> => Boolean(pending)));
  requestedReparseFlights.clear();
  activeActorPathFlights.clear();
  requestedReparseFailures.clear();
}

/** Manually trigger re-ingestion of all known sources. */
export async function triggerFullIngest(): Promise<{ processed: number; errors: number }> {
  if (!backgroundIngestionEnabled) {
    throw new Error("full conversation ingestion is disabled for this instance");
  }
  if (ingestionActor) {
    return ingestionActor.fullIngest();
  }
  return triggerFullIngestForWorker();
}

export async function triggerFullIngestForWorker(): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  for (const config of WATCH_CONFIGS) {
    if (!fs.existsSync(config.base)) continue;
    for await (const filePath of walkFiles(config.base, config.glob)) {
      try {
        await ingestFile(filePath, { forceFull: true, withinPass: true });
        processed++;
      } catch (error) {
        if (isSqliteBusy(error)) throw error;
        errors++;
        logger("warn", "ingestion_manual_error", {
          file: filePath,
          error: String(error),
        });
      }
    }
  }

  logger("info", "ingestion_full_pass", { processed, errors });
  return { processed, errors };
}

export interface TargetedIngestInput {
  sessionRef?: string | null;
  transcriptPath?: string | null;
  now?: number;
}

export interface TargetedIngestResult {
  ok: boolean;
  status: "ingested" | "rate_limited" | "no_target" | "unsupported";
  transcript_path: string | null;
  session_ref: string | null;
}

export async function triggerTargetedIngest(input: TargetedIngestInput): Promise<TargetedIngestResult> {
  const sessionRef = normalizeTargetRef(input.sessionRef);
  const transcriptPath = normalizeTargetPath(input.transcriptPath) ?? await findTranscriptPathForSession(sessionRef);
  if (!transcriptPath) {
    return { ok: true, status: "no_target", transcript_path: null, session_ref: sessionRef };
  }

  if (!isWorkflowIngestArtifactPath(transcriptPath) && !getParserForFile(transcriptPath)) {
    logger("debug", "ingestion_targeted_unsupported", { file: transcriptPath, session_ref: sessionRef });
    return { ok: true, status: "unsupported", transcript_path: transcriptPath, session_ref: sessionRef };
  }

  const now = input.now ?? Date.now();
  const key = `${sessionRef ?? ""}\u0000${transcriptPath}`;
  const last = targetedIngestLastRun.get(key) ?? 0;
  if (now - last < TARGETED_INGEST_MIN_INTERVAL_MS) {
    return { ok: true, status: "rate_limited", transcript_path: transcriptPath, session_ref: sessionRef };
  }
  targetedIngestLastRun.set(key, now);

  const pendingTimer = debounceTimers.get(transcriptPath);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    debounceTimers.delete(transcriptPath);
  }
  queuedIngestPaths.delete(transcriptPath);

  if (ingestionActor) {
    await (activeActorPathFlights.get(transcriptPath)
      ?? trackActorPathFlight([transcriptPath], ingestionActor.ingest([transcriptPath])));
  } else {
    await ingestFile(transcriptPath);
  }
  clearHookNotificationAttention({ sessionRef, transcriptPath });
  return { ok: true, status: "ingested", transcript_path: transcriptPath, session_ref: sessionRef };
}

/** Authoritative exact-path ingestion for bounded read freshness barriers. */
export async function triggerExactPathIngest(transcriptPath: string): Promise<TargetedIngestResult> {
  const normalized = normalizeTargetPath(transcriptPath);
  if (!normalized || isWorkflowIngestArtifactPath(normalized) || !getParserForFile(normalized)) {
    return { ok: true, status: "unsupported", transcript_path: normalized, session_ref: null };
  }
  const pendingTimer = debounceTimers.get(normalized);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    debounceTimers.delete(normalized);
  }
  queuedIngestPaths.delete(normalized);
  if (ingestionActor) await (activeActorPathFlights.get(normalized)
    ?? trackActorPathFlight([normalized], ingestExactSelectedPath(ingestionActor, normalized)));
  else await ingestFile(normalized, { bypassSameMtimeUnchanged: true, strictParseErrors: true });
  clearHookNotificationAttention({ sessionRef: null, transcriptPath: normalized });
  return { ok: true, status: "ingested", transcript_path: normalized, session_ref: null };
}

const requestedReparseFlights = new Map<string, Promise<void>>();
const activeActorPathFlights = new Map<string, Promise<void>>();
const watcherRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const watcherRetryAttempted = new Set<string>();
const requestedReparseFailures = new Map<string, { at: number; error: string }>();
const REQUESTED_REPARSE_RETRY_MS = 30_000;

function trackActorPathFlight(paths: readonly string[], flight: Promise<void>): Promise<void> {
  for (const filePath of paths) activeActorPathFlights.set(filePath, flight);
  void flight.then(
    () => { for (const filePath of paths) if (activeActorPathFlights.get(filePath) === flight) activeActorPathFlights.delete(filePath); },
    () => { for (const filePath of paths) if (activeActorPathFlights.get(filePath) === flight) activeActorPathFlights.delete(filePath); },
  );
  return flight;
}

async function pathNeedsFollowupAfterActor(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    const indexed = getDb().prepare(`
      SELECT state.byte_offset, state.tail_hash, c.source_mtime
        FROM conversation_ingest_state state
        JOIN conversations c ON c.source_path = state.file_path
       WHERE state.file_path = ?
       LIMIT 1
    `).get(filePath) as {
      byte_offset: number; tail_hash: string; source_mtime: number;
    } | undefined;
    return !indexed || indexed.byte_offset !== stat.size
      || Math.abs(indexed.source_mtime - stat.mtimeMs) >= 1
      || indexed.tail_hash !== await hashFileTailAt(filePath, indexed.byte_offset);
  } catch {
    return true;
  }
}

export function selectedConversationSourceEpochIsCurrent(db: Db, sourceId: string): boolean {
  const source = db.prepare(`
    SELECT parser_format, parser_version, normalization_version, redaction_epoch
      FROM conversation_sources WHERE id = ?
  `).get(sourceId) as {
    parser_format: string; parser_version: string; normalization_version: string; redaction_epoch: number;
  } | undefined;
  return Boolean(source
    && source.parser_format === CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat
    && source.parser_version === CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion
    && source.normalization_version === CURRENT_CONVERSATION_SOURCE_EPOCHS.normalizationVersion
    && source.redaction_epoch === CURRENT_CONVERSATION_SOURCE_EPOCHS.redactionEpoch);
}

/** Use the same exact-path ingest request for selected reads and watcher work. */
export async function ingestExactSelectedPath(
  actor: Pick<IngestionActor, "ingest">,
  transcriptPath: string,
  onSourceChangeRetry?: (attempt: number) => void,
): Promise<void> {
  const maxRetries = 2;
  let retries = 0;
  for (;;) {
    try {
      await actor.ingest([transcriptPath], false, true, true);
      return;
    } catch (error) {
      if (!(error instanceof ConversationSourceChangedError) || retries >= maxRetries) throw error;
      retries += 1;
      onSourceChangeRetry?.(retries);
    }
  }
}

function notifySelectedReparseFailure(conversationId: string): void {
  const row = getDb().prepare(`SELECT block_count FROM conversations WHERE id = ?`)
    .get(conversationId) as { block_count: number } | undefined;
  eventPublisher(DOMAIN_EVENTS.CONVERSATION_UPDATED, { id: conversationId, block_count: row?.block_count ?? 0 });
}

/** Queue one selected provider source without parsing on the HTTP request thread. */
export function scheduleExactPathReparse(transcriptPath: string, sourceId: string, conversationId: string): boolean {
  const normalized = normalizeTargetPath(transcriptPath);
  const actor = ingestionActor;
  if (!ingestionActive || !actor || !normalized || !getParserForFile(normalized)) return false;
  if (requestedReparseFlights.has(normalized)) return true;
  const recentFailure = requestedReparseFailures.get(normalized);
  if (recentFailure && Date.now() - recentFailure.at < REQUESTED_REPARSE_RETRY_MS) {
    throw new Error(`Selected-source reparse failed; retry after 30 seconds: ${recentFailure.error}`);
  }
  requestedReparseFailures.delete(normalized);
  const pendingTimer = debounceTimers.get(normalized);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    debounceTimers.delete(normalized);
  }
  queuedIngestPaths.delete(normalized);
  const actorFlight = activeActorPathFlights.get(normalized)
    ?? trackActorPathFlight([normalized], ingestExactSelectedPath(actor, normalized));
  const flight = actorFlight
    .then(() => {
      if (!selectedConversationSourceEpochIsCurrent(getDb(), sourceId)) {
        throw new Error("Selected source did not reach the current parser version");
      }
    })
    .catch((error) => {
      if (!ingestionActive) return;
      requestedReparseFlights.delete(normalized);
      requestedReparseFailures.set(normalized, { at: Date.now(), error: String(error) });
      logger("warn", "ingestion_requested_reparse_failed", { file: normalized, error: String(error) });
      try { notifySelectedReparseFailure(conversationId); }
      catch (notificationError) {
        logger("warn", "ingestion_requested_reparse_notification_failed", {
          conversation_id: conversationId,
          error: String(notificationError),
        });
      }
    })
    .finally(() => {
      if (requestedReparseFlights.get(normalized) === flight) requestedReparseFlights.delete(normalized);
    });
  requestedReparseFlights.set(normalized, flight);
  return true;
}

export function suppressAcpIngestForSession(source: string, sessionId: string): void {
  if (!source.trim() || !sessionId.trim()) {
    return;
  }
  acpSuppressedSessions.set(acpSuppressionKey(source, sessionId), Date.now() + ACP_SUPPRESSION_TTL_MS);
}

// --- Internal ---

function normalizeTargetRef(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 256) : null;
}

function normalizeTargetPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

async function findTranscriptPathForSession(sessionRef: string | null): Promise<string | null> {
  if (!sessionRef) {
    return null;
  }
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT source, source_path, cwd
      FROM conversations
      WHERE session_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(sessionRef) as { source: string; source_path: string | null; cwd: string | null } | undefined;
    const indexed = normalizeTargetPath(row?.source_path ?? null);
    if (indexed) return indexed;
    if (row?.source === "claude_code" && row.cwd) {
      const encodedProject = row.cwd.replace(/[^A-Za-z0-9]/g, "-");
      const candidate = path.join(os.homedir(), ".claude", "projects", encodedProject, `${sessionRef}.jsonl`);
      return fs.existsSync(candidate) ? candidate : null;
    }
    if (row?.source === "codex") {
      const codexRoot = path.resolve(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"));
      let stateDb: SqliteDatabase | null = null;
      try {
        stateDb = new SqliteDatabase(path.join(codexRoot, "state_5.sqlite"), { readonly: true, fileMustExist: true });
        const exact = stateDb.prepare("SELECT id, rollout_path FROM threads WHERE id = ?").get(sessionRef) as
          | { id: string; rollout_path: string }
          | undefined;
        const candidate = normalizeTargetPath(exact?.rollout_path);
        const location = candidate ? locateCodexRollout(candidate) : null;
        if (!exact || exact.id !== sessionRef || !candidate || path.resolve(location?.codexRoot ?? "") !== codexRoot || !fs.existsSync(candidate)) return null;
        return await loadCodexNativeSessionId(candidate) === sessionRef ? candidate : null;
      } finally {
        stateDb?.close();
      }
    }
    return null;
  } catch {
    return null;
  }
}

function debouncedIngest(filePath: string): void {
  const runToken = ingestionRunToken;
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  // A new filesystem event is a new opportunity after the one-shot retry.
  watcherRetryAttempted.delete(filePath);
  const pendingRetry = watcherRetryTimers.get(filePath);
  if (pendingRetry) clearTimeout(pendingRetry);
  watcherRetryTimers.delete(filePath);
  const existing = debounceTimers.get(filePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    if (!isCurrentIngestionRun(runToken)) {
      debounceTimers.delete(filePath);
      return;
    }
    debounceTimers.delete(filePath);
    enqueueIngest(filePath, runToken);
  }, DEBOUNCE_MS);

  debounceTimers.set(filePath, timer);
}

function enqueueIngest(filePath: string, runToken = ingestionRunToken): void {
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  const result = queuedIngestPaths.add(filePath);
  if (!result.added) {
    return;
  }
  if (result.replacedPath) {
    reconcileRequiredAfterBackpressure = true;
    logger("warn", "ingestion_dirty_backpressure", {
      max_paths: MAX_DIRTY_INGEST_PATHS,
      replaced_path: result.replacedPath,
    });
  }
  if (!ingestDrainRunning) {
    const drain = drainIngestQueue(runToken).finally(() => {
      if (ingestDrainPromise === drain) ingestDrainPromise = null;
    });
    ingestDrainPromise = drain;
    void drain;
  }
}

function scheduleWatcherRetry(filePath: string, runToken: number): void {
  if (watcherRetryAttempted.has(filePath) || !isCurrentIngestionRun(runToken)) return;
  watcherRetryAttempted.add(filePath);
  const timer = setTimeout(() => {
    watcherRetryTimers.delete(filePath);
    enqueueIngest(filePath, runToken);
  }, REQUESTED_REPARSE_RETRY_MS);
  watcherRetryTimers.set(filePath, timer);
}

async function drainIngestQueue(runToken: number): Promise<void> {
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  ingestDrainRunning = true;
  try {
    while (isCurrentIngestionRun(runToken) && queuedIngestPaths.size > 0) {
      const paths = queuedIngestPaths.take(DIRTY_INGEST_BATCH_SIZE);
      try {
        const actor = ingestionActor;
        if (actor) {
          const alreadyRunning = paths.filter((filePath) => activeActorPathFlights.has(filePath));
          const ready = paths.filter((filePath) => !activeActorPathFlights.has(filePath));
          // A watcher event arriving during exact work must be checked after
          // that work, so a genuinely newer append is not lost.
          for (const filePath of alreadyRunning) {
            const active = activeActorPathFlights.get(filePath);
            if (active) void active.then(
              async () => {
                if (isCurrentIngestionRun(runToken) && await pathNeedsFollowupAfterActor(filePath)) {
                  enqueueIngest(filePath, runToken);
                }
              },
              () => scheduleWatcherRetry(filePath, runToken),
            );
          }
          // Each path needs its own outcome. A failed sibling must not reject
          // the selected source's exact freshness barrier.
          const settled = await Promise.allSettled(ready.map((filePath) =>
            trackActorPathFlight([filePath], actor.ingest([filePath]))));
          settled.forEach((result, index) => {
            const filePath = ready[index];
            if (result.status === "fulfilled") {
              watcherRetryAttempted.delete(filePath);
              return;
            }
            logger("warn", "ingestion_debounced_error", { files: [filePath], error: String(result.reason) });
            // A consumed watcher event gets one bounded retry. Repeated parse
            // failures then wait for a new event or the safety reconciliation.
            scheduleWatcherRetry(filePath, runToken);
          });
        } else {
          await ingestBatchForWorker(paths);
        }
      } catch (error) {
        if (!isCurrentIngestionRun(runToken)) {
          break;
        }
        logger("warn", "ingestion_debounced_error", {
          files: paths,
          error: String(error),
        });
      }
      if (!isCurrentIngestionRun(runToken)) {
        break;
      }
      const delayMs = backgroundBackoffMs();
      if (delayMs > 0) {
        logger("debug", "ingestion_background_yield", { delay_ms: delayMs, queued: queuedIngestPaths.size });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (isCurrentIngestionRun(runToken) && reconcileRequiredAfterBackpressure) {
      reconcileRequiredAfterBackpressure = false;
      scheduleReconcile();
    }
  } finally {
    if (runToken === ingestionRunToken) {
      ingestDrainRunning = false;
      if (queuedIngestPaths.size > 0 && isCurrentIngestionRun(runToken)) {
        const drain = drainIngestQueue(runToken).finally(() => {
          if (ingestDrainPromise === drain) ingestDrainPromise = null;
        });
        ingestDrainPromise = drain;
        void drain;
      }
    }
  }
}

export async function ingestBatchForWorker(
  paths: readonly string[],
  forceFull = false,
  bypassSameMtimeUnchanged = false,
  strictParseErrors = false,
): Promise<void> {
  const failures: unknown[] = [];
  for (const filePath of paths) {
    try {
      await ingestFile(filePath, { forceFull, bypassSameMtimeUnchanged, strictParseErrors });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `Failed to ingest ${failures.length} source(s)`);
}

export interface ProjectedConversationTitleConvergenceRow {
  id: string;
  title_before: string;
  title_after: string;
  source_mtime_before: number;
  source_mtime_after: number;
  block_count_before: number;
  block_count_after: number;
}

export interface ProjectedConversationTitleConvergenceResult {
  scanned: number;
  eligible: number;
  updated: number;
  skipped_missing_source: number;
  skipped_not_at_indexed_extent: number;
  rows: ProjectedConversationTitleConvergenceRow[];
}

/**
 * Converge provider-owned Claude titles in a newly projected database copy.
 *
 * Reject-mode previews deliberately do not start background ingestion. The
 * projection step therefore calls this against its still-private copy before
 * accepting that copy or its manifest. Eligibility is narrow: the source must
 * exist, its append checkpoint must cover the exact complete file, and the
 * persisted conversation mtime must be stale. `ingestFile` remains the single
 * parser, precedence, masking, durable-source, and metadata persistence path.
 */
export async function convergeProjectedConversationTitlesForWorker(
  db: Db = getDb(),
): Promise<ProjectedConversationTitleConvergenceResult> {
  const candidates = db.prepare(`
    SELECT
      c.id,
      c.source_path,
      c.title,
      c.source_mtime,
      c.block_count,
      state.byte_offset,
      state.partial_line
    FROM conversations c
    LEFT JOIN conversation_ingest_state state ON state.file_path = c.source_path
    WHERE c.source = 'claude_code'
    ORDER BY c.id
  `).all() as Array<{
    id: string;
    source_path: string;
    title: string;
    source_mtime: number;
    block_count: number;
    byte_offset: number | null;
    partial_line: string | null;
  }>;
  const result: ProjectedConversationTitleConvergenceResult = {
    scanned: candidates.length,
    eligible: 0,
    updated: 0,
    skipped_missing_source: 0,
    skipped_not_at_indexed_extent: 0,
    rows: [],
  };

  for (const candidate of candidates) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(candidate.source_path);
    } catch {
      result.skipped_missing_source += 1;
      continue;
    }
    if (
      candidate.byte_offset !== stat.size
      || (candidate.partial_line ?? "") !== ""
      || Math.abs(candidate.source_mtime - stat.mtimeMs) < 100
    ) {
      result.skipped_not_at_indexed_extent += 1;
      continue;
    }

    result.eligible += 1;
    await ingestFile(candidate.source_path);
    const after = db.prepare(`
      SELECT title, source_mtime, block_count
      FROM conversations
      WHERE id = ?
    `).get(candidate.id) as {
      title: string;
      source_mtime: number;
      block_count: number;
    } | undefined;
    if (!after) {
      throw new Error(`Projected conversation disappeared during title convergence: ${candidate.id}`);
    }
    if (Math.abs(after.source_mtime - stat.mtimeMs) >= 100) {
      throw new Error(
        `Projected conversation title convergence did not reach source metadata: ${candidate.id}`,
      );
    }
    if (after.block_count !== candidate.block_count) {
      throw new Error(
        `Projected conversation title convergence changed block count: ${candidate.id}`,
      );
    }
    if (
      after.title === candidate.title
      && after.source_mtime === candidate.source_mtime
      && after.block_count === candidate.block_count
    ) {
      continue;
    }
    result.updated += 1;
    result.rows.push({
      id: candidate.id,
      title_before: candidate.title,
      title_after: after.title,
      source_mtime_before: candidate.source_mtime,
      source_mtime_after: after.source_mtime,
      block_count_before: candidate.block_count,
      block_count_after: after.block_count,
    });
  }
  return result;
}

export function configureIngestionWorker(
  log: Logger,
  publish: (event: MandibleEventType, data: unknown) => void,
): void {
  logger = log;
  eventPublisher = publish;
  ingestionActive = true;
  ingestionRunToken += 1;
}

function isCurrentIngestionRun(runToken: number): boolean {
  return ingestionActive && runToken === ingestionRunToken;
}

function makeWatchFileMatcher(baseDir: string, glob: string): (filePath: string) => boolean {
  const pattern = globToMatcher(glob);
  return (filePath: string) => {
    const relative = path.relative(baseDir, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return false;
    }
    return pattern(relative.split(path.sep).join("/"));
  };
}

export function isAcpIngestSuppressed(source: string, sessionId: string, now = Date.now()): boolean {
  const key = acpSuppressionKey(source, sessionId);
  const expiresAt = acpSuppressedSessions.get(key);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= now) {
    acpSuppressedSessions.delete(key);
    return false;
  }
  return true;
}

export async function triggerReconcileForTest(
  options: {
    watchConfigs?: Array<{ base: string; glob: string }>;
    log?: Logger;
  } = {},
): Promise<void> {
  const previousActive = ingestionActive;
  const previousLogger = logger;
  const runToken = ++ingestionRunToken;
  ingestionActive = true;
  if (options.log) {
    logger = options.log;
  }
  try {
    await reconcile(runToken, {
      ingestChanged: (filePath) => ingestFile(filePath),
      watchConfigs: options.watchConfigs,
      startupPasses: true,
    });
  } finally {
    ingestionActive = previousActive;
    logger = previousLogger;
    ingestionRunToken++;
  }
}

function acpSuppressionKey(source: string, sessionId: string): string {
  return `${source.trim().toLowerCase()}:${sessionId.trim()}`;
}

async function hashFileTailAt(filePath: string, offset: number): Promise<string> {
  if (offset <= 0) {
    return "";
  }
  const length = Math.min(INGEST_TAIL_HASH_BYTES, offset);
  const buffer = Buffer.alloc(length);
  const handle = await fs.promises.open(filePath, "r");
  try {
    await handle.read(buffer, 0, length, offset - length);
  } finally {
    await handle.close();
  }
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

type RangeReadHandle = Pick<fs.promises.FileHandle, "read" | "close">;

interface RangeReadOptions {
  chunkBytes?: number;
  openFile?: (filePath: string) => Promise<RangeReadHandle>;
}

/**
 * Consume an exact byte range without making a native read or allocation the
 * size of the logical range. The explicit-position loop advances by bytesRead,
 * including after short reads; only a zero-byte read is EOF.
 *
 * Exported as a narrow test seam so sparse ranges beyond INT32_MAX can exercise
 * real FileHandle reads without scanning gigabytes.
 */
export async function consumeFileRangeForTest(
  filePath: string,
  start: number,
  end: number,
  consume: (chunk: Buffer, position: number) => void | Promise<void>,
  options: RangeReadOptions = {},
): Promise<number> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) {
    throw new RangeError("file range offsets must be non-negative safe integers");
  }
  if (end <= start) return 0;
  const chunkBytes = options.chunkBytes ?? INGEST_RANGE_READ_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > INGEST_RANGE_READ_CHUNK_BYTES) {
    throw new RangeError(`file read chunks must be between 1 and ${INGEST_RANGE_READ_CHUNK_BYTES} bytes`);
  }
  const handle = await (options.openFile ?? ((target) => fs.promises.open(target, "r")))(filePath);
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, end - start));
  let position = start;
  try {
    while (position < end) {
      const length = Math.min(buffer.length, end - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
        throw new Error(`invalid bytesRead ${bytesRead} for requested length ${length}`);
      }
      await consume(buffer.subarray(0, bytesRead), position);
      position += bytesRead;
    }
    return position - start;
  } finally {
    await handle.close();
  }
}

export async function readUtf8FileRangeForTest(
  filePath: string,
  start: number,
  end: number,
  options: RangeReadOptions = {},
): Promise<string> {
  const decoder = new StringDecoder("utf8");
  const decoded: string[] = [];
  await consumeFileRangeForTest(filePath, start, end, (chunk) => {
    const text = decoder.write(chunk);
    if (text) decoded.push(text);
  }, options);
  const final = decoder.end();
  if (final) decoded.push(final);
  return decoded.join("");
}

async function readFileRange(filePath: string, start: number, end: number): Promise<string> {
  return readUtf8FileRangeForTest(filePath, start, end);
}

async function readTrailingPartialLine(filePath: string, size: number): Promise<string> {
  if (size <= 0) {
    return "";
  }
  const length = Math.min(64 * 1024, size);
  const tail = await readFileRange(filePath, size - length, size);
  if (tail.endsWith("\n") || tail.endsWith("\r")) {
    return "";
  }
  const lastLf = tail.lastIndexOf("\n");
  const trailing = lastLf >= 0 ? tail.slice(lastLf + 1) : tail;
  if (!trailing.trim()) {
    return "";
  }
  try {
    JSON.parse(trailing);
    return "";
  } catch {
    return trailing;
  }
}

export async function countCompleteLines(filePath: string): Promise<number> {
  let count = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    for (const byte of chunk as Buffer) {
      if (byte === 0x0a) count += 1;
    }
  }
  return count;
}

function getAppendState(db: ReturnType<typeof getDb>, filePath: string): IngestAppendState | null {
  const row = db.prepare(`
    SELECT
      file_path,
      byte_offset,
      line_count,
      tail_hash,
      partial_line,
      empty_source_mtime,
      empty_source_size
    FROM conversation_ingest_state
    WHERE file_path = ?
  `).get(filePath) as IngestAppendState | undefined;
  return row ?? null;
}

function deleteAppendState(db: ReturnType<typeof getDb>, filePath: string): void {
  db.prepare("DELETE FROM conversation_ingest_state WHERE file_path = ?").run(filePath);
}

/**
 * Re-point an ingested conversation at the same file in its new location.
 *
 * `codex archive` / `codex unarchive` rename a rollout between
 * `~/.codex/sessions/**` and `~/.codex/archived_sessions/**`. The bytes and the
 * conversation identity is unchanged, but the path may have historical rows
 * for other identities. The caller proves provider/session identity first, so
 * only that exact row and source alias follow the move.
 *
 * Bug: c927726 — archiving a Codex thread silently deleted its conversation
 * and every block from SQLite on the next reconcile.
 */
function repointConversationSource(
  db: ReturnType<typeof getDb>,
  fromPath: string,
  toPath: string,
  conversationId: string,
  sourceId: string | null,
): boolean {
  const original = db.prepare(
    "SELECT id FROM conversations WHERE id = ? AND source_path = ?",
  ).get(conversationId, fromPath);
  if (!original) return false;

  const repoint = db.transaction(() => {
    db.prepare(`
      UPDATE conversations
      SET source_path = ?, updated_at = datetime('now')
      WHERE id = ? AND source_path = ?
    `).run(toPath, conversationId, fromPath);
    // Path-keyed append state cannot prove which historical row owned it.
    // Discard it here; the parsed relocation candidate gets a fresh checkpoint.
    db.prepare("DELETE FROM conversation_ingest_state WHERE file_path = ?").run(fromPath);
  });
  repoint();
  if (sourceId) {
    new ConversationSourceStore(db).recordRelocation(fromPath, toPath, sourceId);
  }
  return true;
}

/**
 * If a missing source file is a Codex rollout that was archived or unarchived,
 * follow the move and return its new path. Returns null when the file is really
 * gone (or is not a Codex rollout), leaving normal cleanup to the caller.
 */
async function relocateMovedCodexSource(
  db: ReturnType<typeof getDb>,
  filePath: string,
): Promise<string | null> {
  if (!isCodexRolloutPath(filePath)) return null;
  if (fs.existsSync(filePath)) return null;
  for (const candidate of codexRelocationCandidates(filePath)) {
    if (!fs.existsSync(candidate)) continue;
    const parser = getParserForFile(candidate);
    if (!parser || parser.source !== "codex") continue;
    let nativeSessionId: string | null;
    let parsed: ParseResult | null;
    try {
      nativeSessionId = await loadCodexNativeSessionId(candidate);
      parsed = await parser.parse(candidate);
    } catch (error) {
      logger("warn", "ingestion_relocation_probe_failed", {
        from: filePath,
        candidate,
        error: String(error),
      });
      continue;
    }
    if (!parsed || !nativeSessionId || parsed.conversation.session_id !== nativeSessionId) continue;
    const match = db.prepare(`
      SELECT c.id,
             (SELECT cs.id FROM conversation_sources cs
               WHERE cs.conversation_id = c.id AND cs.provider = ?
               ORDER BY cs.updated_at DESC LIMIT 1) AS source_id
        FROM conversations c
       WHERE c.source_path = ? AND c.source = ? AND c.session_id = ?
       ORDER BY CASE WHEN EXISTS (
         SELECT 1
           FROM conversation_sources cs
           JOIN conversation_source_aliases alias ON alias.source_id = cs.id
          WHERE cs.conversation_id = c.id
            AND alias.path = ? AND alias.availability = 'available'
       ) THEN 0 ELSE 1 END,
       c.updated_at DESC, c.id
       LIMIT 1
    `).get(
      parsed.conversation.source,
      filePath,
      parsed.conversation.source,
      nativeSessionId,
      filePath,
    ) as { id: string; source_id: string | null } | undefined;
    if (!match) {
      logger("info", "ingestion_relocation_identity_mismatch", {
        from: filePath,
        candidate,
        candidate_source: parsed.conversation.source,
        candidate_session_id: nativeSessionId,
      });
      continue;
    }
    if (!repointConversationSource(db, filePath, candidate, match.id, match.source_id)) continue;
    const stat = await fs.promises.stat(candidate);
    await refreshAppendState(db, candidate, stat, await countCompleteLines(candidate));
    // A bulk archive moves many rollouts at once. The durable source alias is
    // the record of each move; reconcile summarizes its relocations per pass.
    logger("debug", "ingestion_source_relocated", {
      from: filePath,
      to: candidate,
      conversation_id: match.id,
      session_id: nativeSessionId,
    });
    return candidate;
  }
  return null;
}

async function removeConversationForMissingSource(
  db: ReturnType<typeof getDb>,
  filePath: string,
): Promise<boolean> {
  if (await relocateMovedCodexSource(db, filePath)) {
    return true;
  }
  // Source loss is a tombstone transition, never a conversation deletion.
  // Legacy normalized bodies, annotations, relationships, and aliases remain
  // available for the explicit dual-reader fallback.
  new ConversationSourceStore(db).recordUnavailable(filePath);
  const remove = db.transaction(() => {
    deleteAppendState(db, filePath);
    db.prepare("DELETE FROM workflow_ingest_state WHERE file_path = ?").run(filePath);
  });
  remove();
  // A same-shaped archive path can hold an unrelated rollout. It is not a
  // relocation, but watcher-driven ingestion still needs to index it on its
  // own identity instead of waiting for the next broad reconcile.
  for (const candidate of codexRelocationCandidates(filePath)) {
    if (!fs.existsSync(candidate)) continue;
    await ingestFile(candidate);
  }
  return false;
}

interface ConversationMetadata {
  starred: number;
  tags: string;
  notes: string | null;
}

function preservedConversationMetadata(
  db: ReturnType<typeof getDb>,
  conversationId: string,
): ConversationMetadata {
  const row = db.prepare(`
    SELECT starred, tags, notes
      FROM conversations
     WHERE id = ?
  `).get(conversationId) as ConversationMetadata | undefined;
  return row ?? { starred: 0, tags: "[]", notes: null };
}

function writeAppendState(
  db: ReturnType<typeof getDb>,
  state: IngestAppendState,
): void {
  db.prepare(`
    INSERT INTO conversation_ingest_state (
      file_path, byte_offset, line_count, tail_hash, partial_line, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      byte_offset = excluded.byte_offset,
      line_count = excluded.line_count,
      tail_hash = excluded.tail_hash,
      partial_line = excluded.partial_line,
      empty_source_mtime = NULL,
      empty_source_size = NULL,
      updated_at = excluded.updated_at
  `).run(
    state.file_path,
    state.byte_offset,
    state.line_count,
    state.tail_hash,
    state.partial_line,
    Date.now(),
  );
}

function writeEmptyIngestState(
  db: ReturnType<typeof getDb>,
  filePath: string,
  stat: fs.Stats,
): void {
  db.prepare(`
    INSERT INTO conversation_ingest_state (
      file_path,
      byte_offset,
      line_count,
      tail_hash,
      partial_line,
      updated_at,
      empty_source_mtime,
      empty_source_size
    ) VALUES (?, ?, 0, '', '', ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      byte_offset = excluded.byte_offset,
      line_count = 0,
      tail_hash = '',
      partial_line = '',
      updated_at = excluded.updated_at,
      empty_source_mtime = excluded.empty_source_mtime,
      empty_source_size = excluded.empty_source_size
  `).run(filePath, stat.size, Date.now(), stat.mtimeMs, stat.size);
}

function clearEmptyIngestState(db: ReturnType<typeof getDb>, filePath: string): void {
  db.prepare(`
    UPDATE conversation_ingest_state
    SET empty_source_mtime = NULL,
        empty_source_size = NULL,
        updated_at = ?
    WHERE file_path = ?
  `).run(Date.now(), filePath);
}

function matchesEmptyIngestState(state: IngestAppendState | null, stat: fs.Stats): boolean {
  return state?.empty_source_mtime === stat.mtimeMs
    && state.empty_source_size === stat.size;
}

function isWorkflowIngestArtifactPath(filePath: string): boolean {
  return isClaudeWorkflowSummaryPath(filePath) || isClaudeWorkflowJournalPath(filePath);
}

function getWorkflowIngestState(
  db: ReturnType<typeof getDb>,
  filePath: string,
): WorkflowIngestState | null {
  const row = db.prepare(`
    SELECT file_path, source_mtime, summary_path, workflow_id
    FROM workflow_ingest_state
    WHERE file_path = ?
  `).get(filePath) as WorkflowIngestState | undefined;
  return row ?? null;
}

function writeWorkflowIngestState(
  db: ReturnType<typeof getDb>,
  state: WorkflowIngestState,
): void {
  db.prepare(`
    INSERT INTO workflow_ingest_state (
      file_path, source_mtime, summary_path, workflow_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      source_mtime = excluded.source_mtime,
      summary_path = excluded.summary_path,
      workflow_id = excluded.workflow_id,
      updated_at = excluded.updated_at
  `).run(
    state.file_path,
    state.source_mtime,
    state.summary_path,
    state.workflow_id,
    Date.now(),
  );
}

function deleteWorkflowIngestState(db: ReturnType<typeof getDb>, filePath: string): void {
  db.prepare("DELETE FROM workflow_ingest_state WHERE file_path = ?").run(filePath);
}

async function refreshAppendState(
  db: ReturnType<typeof getDb>,
  filePath: string,
  stat: fs.Stats,
  lineCount: number,
  partialLine?: string,
  tailHash?: string,
  byteOffset = stat.size,
): Promise<void> {
  writeAppendState(db, {
    file_path: filePath,
    byte_offset: byteOffset,
    line_count: lineCount,
    tail_hash: tailHash ?? await hashFileTailAt(filePath, byteOffset),
    partial_line: partialLine ?? await readTrailingPartialLine(filePath, byteOffset),
    empty_source_mtime: null,
    empty_source_size: null,
  });
}

async function refreshAppendStateFromParse(
  db: ReturnType<typeof getDb>,
  filePath: string,
  stat: fs.Stats,
  result: ParseResult,
): Promise<void> {
  const snapshot = result.sourceSnapshot;
  await refreshAppendState(
    db,
    filePath,
    stat,
    snapshot?.completeLineCount ?? await countCompleteLines(filePath),
    snapshot ? "" : undefined,
    snapshot?.tailHash,
    snapshot?.byteLength ?? stat.size,
  );
}

async function readAppend(
  filePath: string,
  stat: fs.Stats,
  state: IngestAppendState | null,
): Promise<AppendReadResult> {
  if (!state) {
    return { kind: "fallback", reason: "missing_append_state" };
  }
  if (state.byte_offset > stat.size) {
    return { kind: "fallback", reason: "file_truncated" };
  }
  const currentTailHash = await hashFileTailAt(filePath, state.byte_offset);
  if (currentTailHash !== state.tail_hash) {
    return { kind: "fallback", reason: "tail_hash_mismatch" };
  }
  const partialLineBytes = Buffer.byteLength(state.partial_line, "utf8");
  if (partialLineBytes > 0) {
    if (partialLineBytes > state.byte_offset) {
      return { kind: "fallback", reason: "partial_line_outside_checkpoint" };
    }
    const persistedPartialLine = await readFileRange(
      filePath,
      state.byte_offset - partialLineBytes,
      state.byte_offset,
    );
    if (persistedPartialLine !== state.partial_line) {
      return { kind: "fallback", reason: "partial_line_changed" };
    }
  }
  const appendedBytes = stat.size - state.byte_offset;
  if (appendedBytes <= 0) {
    return {
      kind: "buffered",
      appendedBytes: 0,
      nextPartialLine: state.partial_line,
      tailHash: currentTailHash,
      byteOffset: state.byte_offset,
      hasMore: false,
    };
  }

  let readEnd = Math.min(stat.size, state.byte_offset + MAX_BUFFERED_APPEND_BYTES);
  let appended = await readFileRange(filePath, state.byte_offset, readEnd);
  if (readEnd < stat.size) {
    let newline = appended.lastIndexOf("\n");
    if (newline < 0) {
      readEnd = Math.min(stat.size, state.byte_offset + MAX_BUFFERED_APPEND_RECORD_BYTES);
      appended = await readFileRange(filePath, state.byte_offset, readEnd);
      newline = appended.lastIndexOf("\n");
      if (newline < 0 && readEnd < stat.size) {
        return { kind: "blocked", reason: "append_record_exceeds_buffer_limit" };
      }
    }
    if (newline >= 0) {
      appended = appended.slice(0, newline + 1);
      readEnd = state.byte_offset + Buffer.byteLength(appended, "utf8");
    }
  }

  const combined = `${state.partial_line}${appended}`;
  if (Buffer.byteLength(appended, "utf8") !== readEnd - state.byte_offset) {
    return { kind: "fallback", reason: "append_range_extent_mismatch" };
  }
  const endedWithLineBreak = combined.endsWith("\n") || combined.endsWith("\r");
  const parts = combined.split(/\r?\n/);
  const completeLines = endedWithLineBreak ? parts.slice(0, -1) : parts.slice(0, -1);
  const nextPartialLine = endedWithLineBreak ? "" : parts.at(-1) ?? "";
  const rawLines = completeLines.filter((line) => line.trim().length > 0);
  const tailHash = await hashFileTailAt(filePath, readEnd);
  const hasMore = readEnd < stat.size;
  if (rawLines.length === 0) {
    return {
      kind: "buffered",
      appendedBytes: readEnd - state.byte_offset,
      nextPartialLine,
      tailHash,
      byteOffset: readEnd,
      hasMore,
    };
  }
  return {
    kind: "append",
    raw: `${rawLines.join("\n")}\n`,
    completeLineCount: completeLines.length,
    appendedBytes: readEnd - state.byte_offset,
    nextPartialLine,
      sourceHash: `append:${readEnd}:${tailHash}`,
      tailHash,
      byteOffset: readEnd,
      sourceSnapshot: {
        kind: "append",
        byteLength: readEnd,
        completeLineCount: state.line_count + completeLines.length,
        tailHash,
        filesystemDevice: String(stat.dev),
        filesystemInode: String(stat.ino),
        appendRanges: [{
          byteStart: state.byte_offset,
          byteEnd: readEnd,
          contentHash: crypto.createHash("sha256").update(Buffer.from(appended, "utf8")).digest("hex"),
        }],
      },
      hasMore,
  };
}

/** Exercise the production append-range decision without constructing ledger state. */
export async function readAppendForTest(
  filePath: string,
  state: Pick<IngestAppendState, "byte_offset" | "line_count" | "tail_hash" | "partial_line">,
): Promise<AppendReadResult> {
  return readAppend(filePath, await fs.promises.stat(filePath), {
    file_path: filePath,
    empty_source_mtime: null,
    empty_source_size: null,
    ...state,
  });
}

/** Apply a batch's lineage and report a lineage gap the batch created. */
function applyIngestedLineage(
  db: ReturnType<typeof getDb>,
  conversation: ParseResult["conversation"] & { id: string },
  result: ParseResult,
): void {
  const gap = linkIngestedConversation(db, conversation, result);
  if (gap) {
    const severity = lineageGapSeverity(gap);
    logger(severity === "gap" ? "warn" : "info", "conversation_lineage_gap", {
      conversation_id: conversation.id,
      source: conversation.source,
      session_id: conversation.session_id,
      kind: gap,
      severity,
    });
  }
}

function mergeAppendConversationMetadata(
  result: ParseResult,
  existing: ExistingConversationRow,
): ParseResult {
  return {
    conversation: {
      ...result.conversation,
      // Provider-authored title metadata is authoritative even when it arrives
      // in the incremental tail; derived prompt/index titles are not.
      title: result.providerTitle ?? existing.title,
      summary: existing.summary,
      started_at: existing.started_at,
      session_id: existing.session_id || result.conversation.session_id,
      project_path: existing.project_path ?? result.conversation.project_path,
      cwd: existing.cwd ?? result.conversation.cwd,
      branch: existing.branch ?? result.conversation.branch,
      model: result.conversation.model ?? existing.model,
      cli_version: result.conversation.cli_version ?? existing.cli_version,
    },
    parent: result.parent,
    opening: result.opening,
    createdByAgent: result.createdByAgent,
    blocks: result.blocks,
    ...(result.providerTitle ? { providerTitle: result.providerTitle } : {}),
    ...(result.providerTitleSource ? { providerTitleSource: result.providerTitleSource } : {}),
  };
}

function incrementalParseAnomaly(
  result: ParseResult,
  baseBlockCount: number,
  newBlockCount: number,
): string | null {
  for (const block of result.blocks) {
    if (block.position < baseBlockCount || block.position >= baseBlockCount + newBlockCount) {
      return "position_out_of_range";
    }
    if (
      block.type === "tool_result"
      && block.parent_id == null
      && typeof block.metadata.tool_id === "string"
      && block.metadata.tool_id.trim()
    ) {
      return "tool_result_parent_missing";
    }
  }
  return null;
}

function resolveIncrementalToolParents(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  result: ParseResult,
): void {
  const structureCache = getConversationStructureCache(db);
  const priorToolCall = db.prepare(`
    SELECT position
      FROM conversation_structural_blocks
     WHERE conversation_id = ?
       AND status = 'current'
       AND type = 'tool_use'
       AND provider_key LIKE ? ESCAPE '\\'
     ORDER BY position DESC
     LIMIT 1
  `);
  for (const block of result.blocks) {
    const toolId = block.metadata.tool_id;
    if (block.type !== "tool_result" || block.parent_id != null || !toolId?.trim()) continue;
    const cachedPosition = structureCache.findToolPosition(conversationId, toolId);
    if (cachedPosition !== null) {
      block.parent_id = String(cachedPosition);
      continue;
    }
    const escapedToolId = toolId.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const parent = priorToolCall.get(
      conversationId,
      `tool:${escapedToolId}:tool_use:%`,
    ) as { position: number } | undefined;
    if (parent) block.parent_id = String(parent.position);
  }
}

function insertedBlockPayload(
  conversationId: string,
  block: Omit<ConversationBlock, "id" | "conversation_id">,
): Omit<ConversationBlock, "metadata"> & { metadata_json: string } {
  const id = conversationBlockId({
    conversation_id: conversationId,
    type: block.type,
    timestamp: block.timestamp,
    content: block.content,
    position: block.position,
  });
  return {
    id,
    conversation_id: conversationId,
    type: block.type,
    role: block.role,
    content: block.content,
    position: block.position,
    timestamp: block.timestamp,
    parent_id: block.parent_id,
    metadata_json: JSON.stringify(block.metadata),
    dag_uuid: block.dag_uuid ?? null,
    dag_parent_uuid: block.dag_parent_uuid ?? null,
  };
}

/**
 * Mask live credential plaintext in one derived conversation field.
 *
 * Titles and summaries are cut from transcript text, so a PAT pasted into a
 * first user message — or into a Codex thread name — reaches the conversations
 * row and the `conversation:updated` SSE payload through them. Every write of a
 * derived field has to go through this, not just the ones on the main ingest
 * path: the unchanged-mtime title sync and the identical-source-hash update
 * both write and broadcast the same kind of text and were doing it in the clear
 * (issue b3e4a09, re-review finding 1).
 *
 * Fail-closed, matching the scanner's own contract: if verification is
 * unavailable the token-shaped spans are masked unverified rather than written
 * through, because this string is about to be persisted and pushed to every
 * connected client.
 */
function maskDerivedConversationText(
  db: ReturnType<typeof getDb>,
  value: string,
  context: { file: string; stage: string },
): string {
  try {
    return maskActiveCredentialsInText(db, value).text;
  } catch (error) {
    const masked = maskUnverifiedCandidates(value);
    logger("error", "credential_leak_scan_failed", {
      file: context.file,
      error: String(error),
      stage: context.stage,
      unverified_spans: masked.replacements,
    });
    return masked.text;
  }
}

async function syncCodexIndexedTitle(
  filePath: string,
  existing: {
    id: string;
    session_id: string;
    title: string;
    block_count: number;
  },
): Promise<boolean> {
  if (!existing.session_id) {
    return false;
  }
  const db = getDb();
  const indexed = (await loadCodexSessionIndexTitle(filePath, existing.session_id))
    ?.slice(0, 100)
    .trim();
  return indexed ? persistExactCodexTitle(db, {
    conversationId: existing.id,
    filePath,
    currentTitle: existing.title,
    blockCount: existing.block_count,
    title: indexed,
    stage: "codex_title_sync",
  }) : false;
}

/** Persist one exact provider title through the derived-field masking/SSE boundary. */
export function persistExactCodexTitle(
  db: Db,
  input: {
    conversationId: string;
    filePath: string;
    currentTitle: string;
    blockCount: number;
    title: string;
    stage?: string;
  },
): boolean {
  const indexed = input.title.slice(0, 100).trim();
  // Masked before the comparison, not after: the stored title is already
  // masked, so comparing the raw index title against it would report a
  // difference on every pass and rewrite the row with the plaintext.
  const title = indexed
    ? maskDerivedConversationText(db, indexed, { file: input.filePath, stage: input.stage ?? "codex_title_sync" })
    : indexed;
  if (!title || title === input.currentTitle) {
    return false;
  }

  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, input.conversationId);
  eventPublisher(DOMAIN_EVENTS.CONVERSATION_UPDATED, {
    id: input.conversationId,
    source: "codex",
    title,
    block_count: input.blockCount,
  });
  logger("info", "ingestion_title_synced", {
    file: input.filePath,
    id: input.conversationId,
    source: "codex",
  });
  return true;
}

async function syncCodexIndexedTitlesForKnownRows(db: ReturnType<typeof getDb>): Promise<void> {
  const rows = db.prepare(`
    SELECT id, source_path, session_id, title, block_count
    FROM conversations
    WHERE source = 'codex' AND session_id IS NOT NULL AND session_id != ''
  `).all() as Array<{
    id: string;
    source_path: string;
    session_id: string;
    title: string;
    block_count: number;
  }>;
  if (rows.length === 0) {
    return;
  }

  const rowsByIndex = new Map<string, typeof rows>();
  for (const row of rows) {
    const indexPath = getCodexSessionIndexPath(row.source_path);
    if (!indexPath) continue;
    const bucket = rowsByIndex.get(indexPath);
    if (bucket) {
      bucket.push(row);
    } else {
      rowsByIndex.set(indexPath, [row]);
    }
  }

  for (const [indexPath, indexRows] of rowsByIndex) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(indexPath);
    } catch {
      continue;
    }
    if (codexSessionIndexSyncMtimes.get(indexPath) === stat.mtimeMs) {
      continue;
    }
    for (const row of indexRows) {
      await syncCodexIndexedTitle(row.source_path, row);
    }
    codexSessionIndexSyncMtimes.set(indexPath, stat.mtimeMs);
  }
}

async function syncGeminiProjectIdentityForKnownRows(db: ReturnType<typeof getDb>): Promise<void> {
  const rows = db.prepare(`
    SELECT id, source_path, project_path, cwd, title, block_count
    FROM conversations
    WHERE source = 'gemini'
  `).all() as Array<{
    id: string;
    source_path: string;
    project_path: string | null;
    cwd: string | null;
    title: string;
    block_count: number;
  }>;

  const identityCache = new Map<string, Awaited<ReturnType<typeof inferGeminiProjectIdentity>>>();
  for (const row of rows) {
    const projectHash = row.project_path && /^[a-f0-9]{64}$/i.test(row.project_path)
      ? row.project_path
      : null;
    const projectDir = path.dirname(path.dirname(row.source_path));
    const cacheKey = `${projectDir}\0${projectHash ?? ""}`;
    let identity = identityCache.get(cacheKey);
    if (!identity) {
      identity = await inferGeminiProjectIdentity(row.source_path, projectHash);
      identityCache.set(cacheKey, identity);
    }
    if (identity.projectPath === row.project_path && identity.cwd === row.cwd) {
      continue;
    }
    db.prepare(`
      UPDATE conversations SET
        project_path = ?,
        cwd = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(identity.projectPath, identity.cwd, row.id);
    eventPublisher(DOMAIN_EVENTS.CONVERSATION_UPDATED, {
      id: row.id,
      source: "gemini",
      title: row.title,
      block_count: row.block_count,
    });
    logger("info", "ingestion_gemini_project_synced", {
      file: row.source_path,
      id: row.id,
      project_path: identity.projectPath,
    });
  }
}

type IngestFileOptions = {
  forceFull?: boolean;
  fallbackReason?: string;
  bypassSameMtimeUnchanged?: boolean;
  strictParseErrors?: boolean;
  /** Part of a pass that logs its own summary; per-file completion logs at debug. */
  withinPass?: boolean;
};

async function ingestFile(filePath: string, options: IngestFileOptions = {}): Promise<void> {
  let passOptions = options;
  const pendingAppendProof: PendingAppendProof = {
    filesystemDevice: null,
    filesystemInode: null,
    ranges: [],
  };
  while (await ingestFilePass(filePath, passOptions, pendingAppendProof)) {
    passOptions = { bypassSameMtimeUnchanged: true, strictParseErrors: options.strictParseErrors, withinPass: options.withinPass };
  }
}

async function ingestFilePass(
  filePath: string,
  options: IngestFileOptions,
  pendingAppendProof: PendingAppendProof,
): Promise<boolean | undefined> {
  const ingestStartedAt = Date.now();
  if (isWorkflowIngestArtifactPath(filePath)) {
    await ingestWorkflowArtifact(filePath, { force: options.forceFull === true });
    return;
  }

  const parser = getParserForFile(filePath);
  if (!parser) {
    logger("debug", "ingestion_no_parser", { file: filePath });
    return;
  }

  // Check if file still exists
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    logger("debug", "ingestion_file_gone", { file: filePath });
    try {
      await removeConversationForMissingSource(getDb(), filePath);
    } catch {
      // Best effort cleanup only.
    }
    return;
  }

  // Check if we already have this version
  const db = getDb();
  let existingRows = db.prepare(`
    SELECT
      c.id,
      c.source_hash,
      c.source_mtime,
      c.source,
      c.session_id,
      c.title,
      c.summary,
      c.started_at,
      c.ended_at,
      c.block_count,
      c.project_path,
      c.cwd,
      c.branch,
      c.model,
      c.cli_version,
      EXISTS (
        SELECT 1
          FROM conversation_sources source
         WHERE source.conversation_id = c.id
           AND source.availability = 'missing'
           AND source.unavailable_reason = 'source path reused by a distinct conversation identity'
           AND NOT EXISTS (
             SELECT 1 FROM conversation_source_aliases alias
              WHERE alias.source_id = source.id
           )
      ) AS distinct_identity_projection_detached,
      COALESCE((
        SELECT COUNT(*) FROM conversation_blocks b WHERE b.conversation_id = c.id
      ), 0) AS actual_count
    FROM conversations c
    WHERE c.source_path = ?
    ORDER BY CASE WHEN c.id = (
      SELECT cs.conversation_id
        FROM conversation_source_aliases alias
        JOIN conversation_sources cs ON cs.id = alias.source_id
       WHERE alias.path = c.source_path AND alias.availability = 'available'
       LIMIT 1
    ) THEN 0 ELSE 1 END,
    actual_count DESC, c.updated_at DESC
  `).all(filePath) as ExistingConversationRow[];
  let existing: ExistingConversationRow | undefined = existingRows[0];

  const appendState = getAppendState(db, filePath);
  // The empty-source cache is only safe before a path has an identity. Once a
  // conversation exists, even identical mtime/size metadata can describe a
  // replacement, so native identity parsing must remain authoritative.
  if (!options.forceFull && !existing && matchesEmptyIngestState(appendState, stat)) {
    return;
  }
  if (appendState?.empty_source_mtime !== null && appendState?.empty_source_mtime !== undefined) {
    clearEmptyIngestState(db, filePath);
  }

  let alreadyIngestedCount = 0;
  let structureCacheNeedsRebuild = false;
  let sourceEpochNeedsRebuild = false;
  let appendCheckpointNeedsFullParse = false;
  if (existing) {
    const actualCount = existing.actual_count ?? 0;
    const expectedCount = existing.block_count ?? 0;
    alreadyIngestedCount = Math.max(actualCount, expectedCount);
    const currentSource = db.prepare(`
      SELECT source.current_version_id, source.parser_format, source.parser_version,
             source.normalization_version, source.redaction_epoch,
             version.byte_length AS source_byte_length
        FROM conversation_sources source
        JOIN conversation_source_versions version
          ON version.id = source.current_version_id AND version.source_id = source.id
       WHERE source.conversation_id = ? AND source.current_version_id IS NOT NULL
       ORDER BY CASE source.availability WHEN 'available' THEN 0 ELSE 1 END, source.updated_at DESC
       LIMIT 1
    `).get(existing.id) as {
      current_version_id: string;
      parser_format: string;
      parser_version: string;
      normalization_version: string;
      redaction_epoch: number;
      source_byte_length: number;
    } | undefined;
    sourceEpochNeedsRebuild = !currentSource || (
      currentSource.parser_format !== CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat
      || currentSource.parser_version !== CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion
      || currentSource.normalization_version !== CURRENT_CONVERSATION_SOURCE_EPOCHS.normalizationVersion
      || currentSource.redaction_epoch !== CURRENT_CONVERSATION_SOURCE_EPOCHS.redactionEpoch
    );
    const pendingRangesContiguous = pendingAppendProof.ranges.every((range, index) =>
      index === 0 || range.byteStart === pendingAppendProof.ranges[index - 1].byteEnd,
    );
    appendCheckpointNeedsFullParse = Boolean(currentSource && (
      pendingAppendProof.ranges.length > 0
        ? !appendState
          || pendingAppendProof.filesystemDevice !== String(stat.dev)
          || pendingAppendProof.filesystemInode !== String(stat.ino)
          || pendingAppendProof.ranges[0].byteStart !== currentSource.source_byte_length
          || pendingAppendProof.ranges.at(-1)?.byteEnd !== appendState.byte_offset
          || !pendingRangesContiguous
        : appendState && appendState.byte_offset !== currentSource.source_byte_length
    ));
    if (appendCheckpointNeedsFullParse && currentSource) {
      logger("warn", "ingestion_append_fallback", {
        file: filePath,
        reason: "append_checkpoint_source_extent_mismatch",
        append_byte_offset: appendState?.byte_offset,
        source_byte_length: currentSource.source_byte_length,
        pending_append_ranges: pendingAppendProof.ranges.length,
      });
    }
    const sparseComplete = Boolean(currentSource
      && getConversationStructureCache(db).hasCompleteConversation(
        existing.id,
        currentSource.current_version_id,
        expectedCount,
      ));
    structureCacheNeedsRebuild = expectedCount > 0 && actualCount === 0 && !sparseComplete;
    if (structureCacheNeedsRebuild) {
      logger("warn", "ingestion_count_mismatch", {
        file: filePath,
        conversation_id: existing.id,
        expected_count: expectedCount,
        actual_count: actualCount,
        sparse_cache_complete: false,
      });
    }
  }

  let ingestMode: IngestMode = "full";
  let appendInfo: {
    completeLineCount: number;
    appendedBytes: number;
    nextPartialLine: string;
    tailHash: string;
    byteOffset: number;
    hasMore: boolean;
  } | null = null;
  const sameMtimeAsExisting = Boolean(
    existing && Math.abs(existing.source_mtime - stat.mtimeMs) < 100,
  );
  // Recursive filesystem watchers can emit redundant events while roots are
  // attached.  When the indexed extent and its tail are unchanged, a Codex
  // source is already current.  Probe its bounded native identity so a rare
  // same-size replacement is still detected, but do not fully parse thousands
  // of unchanged rollouts merely because their mtime is coarse.
  let sameMtimeNativeCodexSessionId: string | null | undefined;
  if (
    !options.forceFull
    && !options.bypassSameMtimeUnchanged
    && !structureCacheNeedsRebuild
    && !sourceEpochNeedsRebuild
    && !appendCheckpointNeedsFullParse
    && sameMtimeAsExisting
    && parser.source === "codex"
    && appendState
    && appendState.byte_offset === stat.size
    && await hashFileTailAt(filePath, appendState.byte_offset) === appendState.tail_hash
  ) {
    sameMtimeNativeCodexSessionId = await loadCodexNativeSessionId(filePath);
    if (sameMtimeNativeCodexSessionId !== null) {
      const identityOwner = existingRows.find((row) =>
        row.source === parser.source && row.session_id === sameMtimeNativeCodexSessionId
      );
      const repaired = reconcileDuplicateConversationPathOwnership(
        db,
        filePath,
        parser.source,
        sameMtimeNativeCodexSessionId,
        identityOwner?.id,
      );
      if (repaired.size > 0) {
        existingRows = existingRows.filter((row) => !repaired.has(row.id));
        existing = existingRows[0];
      }
    }
    if (
      sameMtimeNativeCodexSessionId === null
      || existingRows.some((row) => row.session_id === sameMtimeNativeCodexSessionId)
    ) {
      const titleOwner = sameMtimeNativeCodexSessionId === null
        ? existing
        : existingRows.find((row) => row.session_id === sameMtimeNativeCodexSessionId);
      if (titleOwner) {
        await syncCodexIndexedTitle(filePath, titleOwner);
      }
      logDuplicateConversationRows(
        filePath,
        existingRows,
        parser.source,
        sameMtimeNativeCodexSessionId ?? undefined,
      );
      logger("debug", "ingestion_same_mtime_unchanged", { file: filePath });
      return;
    }
  }
  // Same-mtime writes are common on coarse filesystems and can still replace
  // or truncate a path. They must parse the complete provider identity before
  // any unchanged/append shortcut is considered.
  let forceFullReingest = options.forceFull === true
    || structureCacheNeedsRebuild
    || sourceEpochNeedsRebuild
    || appendCheckpointNeedsFullParse
    || (sameMtimeAsExisting && appendState?.byte_offset === stat.size);

  // Parse the file
  let result: ParseResult | null;
  try {
    if (
      sameMtimeAsExisting
      && parser.source === "codex"
      && sameMtimeNativeCodexSessionId === undefined
    ) {
      sameMtimeNativeCodexSessionId = await loadCodexNativeSessionId(filePath);
    }
    if (
      !forceFullReingest
      && existing
      && alreadyIngestedCount > 0
      && parser.parseIncremental
      && (parser.source !== "gemini" || filePath.endsWith(".jsonl"))
    ) {
      const append = await readAppend(filePath, stat, appendState);
      if (append.kind === "append") {
        result = await parser.parseIncremental({
          filePath,
          raw: append.raw,
          baseBlockCount: alreadyIngestedCount,
          baseRecordCount: appendState?.line_count ?? 0,
          sourceHash: append.sourceHash,
          sourceMtime: stat.mtimeMs,
        });
        // A generated ai-title in the tail cannot prove that no stronger
        // custom-title appeared earlier in the transcript. Only cross that
        // provenance boundary when the generated value would change storage:
        // consult one full parse for title authority, then retain the bounded
        // tail parse for block ingestion.
        if (
          result?.providerTitleSource === "ai-title"
          && result.providerTitle !== existing.title
        ) {
          const fullTitleResult = await parser.parse(filePath);
          if (!fullTitleResult?.providerTitle) {
            logger("warn", "ingestion_append_fallback", {
              file: filePath,
              reason: "provider_title_history_unavailable",
              appended_bytes: append.appendedBytes,
            });
            forceFullReingest = true;
            result = fullTitleResult;
          } else {
            result = {
              ...result,
              conversation: {
                ...result.conversation,
                title: fullTitleResult.providerTitle,
              },
              providerTitle: fullTitleResult.providerTitle,
              providerTitleSource: fullTitleResult.providerTitleSource,
            };
          }
        }
        if (!result) {
          await refreshAppendState(
            db,
            filePath,
            stat,
            (appendState?.line_count ?? alreadyIngestedCount) + append.completeLineCount,
            append.nextPartialLine,
            append.tailHash,
            append.byteOffset,
          );
          logger("debug", "ingestion_append_metadata_only", {
            file: filePath,
            appended_bytes: append.appendedBytes,
          });
          return append.hasMore;
        } else {
          resolveIncrementalToolParents(db, existing.id, result);
          const anomaly = incrementalParseAnomaly(result, alreadyIngestedCount, result.blocks.length);
          if (anomaly) {
            logger("warn", "ingestion_append_fallback", {
              file: filePath,
              reason: anomaly,
              appended_bytes: append.appendedBytes,
            });
            forceFullReingest = true;
            result = await parser.parse(filePath);
          } else if (!forceFullReingest) {
            const sourceSnapshot: AppendParserSourceSnapshot = {
              ...append.sourceSnapshot,
              appendRanges: [...pendingAppendProof.ranges, ...append.sourceSnapshot.appendRanges],
            };
            if (pendingAppendProof.ranges.length === 0) {
              pendingAppendProof.filesystemDevice = append.sourceSnapshot.filesystemDevice;
              pendingAppendProof.filesystemInode = append.sourceSnapshot.filesystemInode;
            }
            pendingAppendProof.ranges.push(...append.sourceSnapshot.appendRanges);
            result = {
              ...mergeAppendConversationMetadata(result, existing),
              sourceSnapshot,
            };
            ingestMode = "append";
            appendInfo = {
              completeLineCount: append.completeLineCount,
              appendedBytes: append.appendedBytes,
              nextPartialLine: append.nextPartialLine,
              tailHash: append.tailHash,
              byteOffset: append.byteOffset,
              hasMore: append.hasMore,
            };
          }
        }
      } else if (append.kind === "buffered") {
        // An append checkpoint can already cover the whole file even though the
        // conversation row still carries metadata derived by an older parser.
        // This happens when a previous ingestion version consumed provider
        // metadata it did not understand: the checkpoint advances, but the
        // persisted title and source mtime do not. A later reconcile observes
        // the stale mtime, reaches EOF, and used to return here forever without
        // invoking the repaired parser.
        //
        // No newly buffered bytes means there is no partial append to preserve.
        // Parse the complete source once so provider-owned metadata can converge;
        // the normal metadata-only update below retains the existing blocks.
        if (append.appendedBytes === 0 && existing.source_mtime !== stat.mtimeMs) {
          logger("debug", "ingestion_append_fallback", {
            file: filePath,
            reason: "stale_metadata_at_indexed_extent",
          });
          result = await parser.parse(filePath);
        } else {
          await refreshAppendState(
            db,
            filePath,
            stat,
            appendState?.line_count ?? alreadyIngestedCount,
            append.nextPartialLine,
            append.tailHash,
            append.byteOffset,
          );
          logger("debug", "ingestion_append_buffered", {
            file: filePath,
            appended_bytes: append.appendedBytes,
          });
          return append.hasMore;
        }
      } else if (append.kind === "blocked") {
        logger("warn", "ingestion_append_blocked", {
          file: filePath,
          reason: append.reason,
        });
        return false;
      } else {
        logger("debug", "ingestion_append_fallback", {
          file: filePath,
          reason: append.reason,
        });
        forceFullReingest = true;
        result = await parser.parse(filePath);
      }
    } else {
      result = await parser.parse(filePath);
    }
  } catch (error) {
    logDuplicateConversationRows(filePath, existingRows);
    logger("warn", "ingestion_parse_error", {
      file: filePath,
      source: parser.source,
      error: String(error),
    });
    if (options.strictParseErrors) throw error;
    return;
  }

  if (
    result?.conversation.session_id
    && isAcpIngestSuppressed(result.conversation.source, result.conversation.session_id)
  ) {
    logger("debug", "ingestion_skip_acp_originated_session", {
      file: filePath,
      source: result.conversation.source,
      session_id: result.conversation.session_id,
    });
    return;
  }

  if (
    result
    && sameMtimeAsExisting
    && parser.source === "codex"
    && (!sameMtimeNativeCodexSessionId
      || result.conversation.session_id !== sameMtimeNativeCodexSessionId)
  ) {
    new ConversationSourceStore(db).recordUnavailable(
      filePath,
      "same-mtime source lacked an exact native session identity",
    );
    logger("warn", "ingestion_same_mtime_identity_unverified", { file: filePath });
    return;
  }

  // Skip empty sessions (parser returned null = no meaningful content)
  // Bug: d51fbc8 — empty system sessions were creating "Untitled" entries
  const isProviderTitleOnlyAppend = Boolean(
    result
    && existing
    && ingestMode === "append"
    && result.blocks.length === 0
    && result.providerTitle,
  );
  if (!result || (result.blocks.length === 0 && !isProviderTitleOnlyAppend)) {
    logDuplicateConversationRows(filePath, existingRows);
    logger("debug", "ingestion_skip_empty", { file: filePath, source: parser.source });
    // An empty parse is not evidence that a previously ingested identity ceased
    // to exist. Providers can expose a zero-byte or partially rewritten file
    // while replacing it. Preserve every normalized body and durable source
    // record, and mark the provider source unavailable so readers use fallback.
    if (existing) {
      new ConversationSourceStore(db).recordUnavailable(
        filePath,
        "source parsed as empty or temporarily truncated",
      );
      logger("warn", "ingestion_source_temporarily_unavailable", {
        file: filePath,
        conversation_ids: existingRows.map((row) => row.id),
      });
    }
    writeEmptyIngestState(db, filePath, stat);
    return;
  }

  const isSidechain = result.conversation.is_sidechain;
  const spawnIdentities = isSidechain ? [] : db.prepare(`SELECT spawn.id
      FROM conversation_spawn_requests spawn
      JOIN conversations shell ON shell.id = spawn.id
     WHERE spawn.schema_version = 'mandible-conversation-spawn-request@3'
       AND spawn.provider = ?
       AND (spawn.provider_session_id = ? OR shell.session_id = ?)
       AND shell.is_sidechain = 0 AND shell.parent_conversation_id IS NULL AND shell.agent_id IS NULL`)
    .all(result.conversation.source, result.conversation.session_id, result.conversation.session_id) as { id: string }[];
  const canonicalSpawnIds = [...new Set(spawnIdentities.map((row) => resolveConversationId(db, row.id)))];
  if (canonicalSpawnIds.length > 1) throw new Error(`Ambiguous creation identity for native session ${result.conversation.session_id}`);
  const spawnIdentity = canonicalSpawnIds[0] ? { id: canonicalSpawnIds[0] } : undefined;
  if (spawnIdentity) {
    const bound = db.prepare("SELECT * FROM conversations WHERE id = ?")
      .get(spawnIdentity.id) as typeof existing;
    if (bound) {
      existing = bound;
      if (!existingRows.some((row) => row.id === bound.id)) existingRows.push(bound);
    } else if (existing && existing.id !== spawnIdentity.id) {
      logger("warn", "ingestion_spawn_identity_conflict", {
        file: filePath,
        provider_session_id: result.conversation.session_id,
        spawn_id: spawnIdentity.id,
        existing_conversation_id: existing.id,
      });
      return;
    }
  }

  const repairedDuplicateIds = reconcileDuplicateConversationPathOwnership(
    db,
    filePath,
    result.conversation.source,
    result.conversation.session_id,
    existingRows.find((row) =>
      row.source === result.conversation.source
      && row.session_id === result.conversation.session_id
    )?.id,
  );
  if (repairedDuplicateIds.size > 0) {
    existingRows = existingRows.filter((row) => !repairedDuplicateIds.has(row.id));
    existing = spawnIdentity ? existingRows.find((row) => row.id === spawnIdentity.id) : existingRows[0];
  }
  logDuplicateConversationRows(
    filePath,
    existingRows,
    result.conversation.source,
    result.conversation.session_id,
  );

  // A path is only an alias. If it has been reused for a different native
  // session, preserve the old conversation and create (or update) the row that
  // matches the parsed provider identity. Never choose an identity merely
  // because it currently occupies this path.
  if (
    existing
    && (existing.source !== result.conversation.source
      || existing.session_id !== result.conversation.session_id)
  ) {
    new ConversationSourceStore(db).recordUnavailable(
      filePath,
      "source path reused by a distinct conversation identity",
    );
    const identityMatch = existingRows.find((row) =>
      row.source === result.conversation.source
      && row.session_id === result.conversation.session_id
    );
    existing = identityMatch;
    ingestMode = "full";
    forceFullReingest = true;
    if (existing) {
      const actualCount = existing.actual_count ?? 0;
      alreadyIngestedCount = Math.max(actualCount, existing.block_count ?? 0);
    } else {
      alreadyIngestedCount = 0;
    }
    logger("info", "ingestion_source_path_reused", {
      file: filePath,
      parsed_session_id: result.conversation.session_id,
      preserved_conversation_ids: existingRows
        .filter((row) => row.id !== existing?.id)
        .map((row) => row.id),
      matched_conversation_id: existing?.id ?? null,
    });
  }

  const agentId = result.conversation.agent_id;

  // Check hash — if same content, just update mtime
  if (existing && existing.source_hash === result.conversation.source_hash) {
    // Issue b3e4a09, re-review finding 1: identical parsed bytes still rewrite
    // and broadcast the derived title and summary here, so this path needs the
    // same masking as the main one below. A source touched without a byte
    // change (or re-parsed after the credential became known) otherwise puts
    // the plaintext back on the conversations row and on the SSE payload.
    result.conversation.title = maskDerivedConversationText(
      db,
      result.conversation.title,
      { file: filePath, stage: "unchanged_source_hash" },
    );
    if (result.conversation.summary !== null && result.conversation.summary !== undefined) {
      result.conversation.summary = maskDerivedConversationText(
        db,
        result.conversation.summary,
        { file: filePath, stage: "unchanged_source_hash" },
      );
    }
    db.prepare(`
      UPDATE conversations SET
        source_mtime = ?,
        title = ?,
        summary = ?,
        ended_at = ?,
        block_count = ?,
        model = ?,
        cli_version = ?,
        is_sidechain = MAX(is_sidechain, ?),
        agent_id = COALESCE(?, agent_id),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      stat.mtimeMs,
      result.conversation.title,
      result.conversation.summary,
      result.conversation.ended_at,
      result.conversation.block_count,
      result.conversation.model,
      result.conversation.cli_version,
      isSidechain ? 1 : 0,
      agentId,
      existing.id,
    );
    applyIngestedLineage(db, { ...result.conversation, id: existing.id }, result);
    await refreshAppendStateFromParse(db, filePath, stat, result);
    await recordDurableConversationSource(db, existing.id, result, filePath, "replace", result.blocks, options.strictParseErrors);
    // The selected Chat reacts to this event by reading its source-backed
    // window. Publish only after the locator map and disposable cache have
    // converged; publishing before recordDurableConversationSource let the
    // refetch race the re-index and remain pending with no later event.
    eventPublisher(DOMAIN_EVENTS.CONVERSATION_UPDATED, {
      id: existing.id,
      source: result.conversation.source,
      title: result.conversation.title,
      block_count: result.conversation.block_count,
    });
    if (isClaudeWorkflowTranscriptPath(filePath)) {
      await ingestWorkflowArtifact(filePath);
    }
    return;
  }

  // Determine if this is new or updated
  const isNew = !existing;
  const conversationId = existing?.id ?? spawnIdentity?.id ?? randomUUID();

  // Bug: 212ed66 — hard guard: never insert conversations with 0 blocks
  if (result.blocks.length === 0 && !isProviderTitleOnlyAppend) {
    logger("warn", "ingestion_zero_block_guard", {
      file: filePath,
      source: result.conversation.source,
      hash: result.conversation.source_hash,
    });
    return;
  }

  // Bug: 871765b — Delta ingestion: for existing conversations, only insert
  // blocks that haven't been ingested yet. JSONL files are append-only, so if
  // the new parse has at least as many blocks as already in the DB, we can
  // skip re-compressing and re-inserting the already-persisted blocks.
  // Fall back to full re-ingest if block count shrank (truncation/modification).
  const isDeltaAppend = ingestMode === "append"
    || (!forceFullReingest && !isNew && result.blocks.length >= alreadyIngestedCount && alreadyIngestedCount > 0);
  const newBlocks = ingestMode === "append"
    ? result.blocks
    : isDeltaAppend
      ? result.blocks.slice(alreadyIngestedCount)
      : result.blocks;

  if (isDeltaAppend && newBlocks.length === 0) {
    // Hash changed but no new blocks — metadata-only change (title, timestamps, etc.)
    // Update conversation metadata and return.
    //
    // Issue b3e4a09: this early return still writes derived text, so it needs
    // the same masking as the main path below — a token pasted into the first
    // user message reaches the conversations row through here too.
    result.conversation.title = maskDerivedConversationText(
      db,
      result.conversation.title,
      { file: filePath, stage: "metadata_only_update" },
    );
    if (result.conversation.summary !== null && result.conversation.summary !== undefined) {
      result.conversation.summary = maskDerivedConversationText(
        db,
        result.conversation.summary,
        { file: filePath, stage: "metadata_only_update" },
      );
    }
    db.prepare(`
      UPDATE conversations SET
        source_hash = ?, source_mtime = ?,
        title = ?, summary = ?, ended_at = ?,
        block_count = ?, model = ?, cli_version = ?,
        is_sidechain = MAX(is_sidechain, ?),
        agent_id = COALESCE(?, agent_id),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      result.conversation.source_hash,
      result.conversation.source_mtime,
      result.conversation.title,
      result.conversation.summary,
      result.conversation.ended_at,
      result.conversation.block_count,
      result.conversation.model,
      result.conversation.cli_version,
      isSidechain ? 1 : 0,
      agentId,
      conversationId,
    );
    applyIngestedLineage(db, { ...result.conversation, id: conversationId }, result);
    await refreshAppendState(
      db,
      filePath,
      stat,
      ingestMode === "append"
        ? (appendState?.line_count ?? alreadyIngestedCount) + (appendInfo?.completeLineCount ?? 0)
        : result.sourceSnapshot?.completeLineCount ?? await countCompleteLines(filePath),
      appendInfo?.nextPartialLine ?? (result.sourceSnapshot ? "" : undefined),
      appendInfo?.tailHash ?? result.sourceSnapshot?.tailHash,
      appendInfo?.byteOffset ?? result.sourceSnapshot?.byteLength ?? stat.size,
    );
    if (!appendInfo?.hasMore) {
      await recordDurableConversationSource(
        db,
        conversationId,
        result,
        filePath,
        isDeltaAppend ? "append" : "replace",
        newBlocks,
        options.strictParseErrors,
      );
    }
    if (isProviderTitleOnlyAppend) {
      eventPublisher(DOMAIN_EVENTS.CONVERSATION_UPDATED, {
        id: conversationId,
        source: result.conversation.source,
        title: result.conversation.title,
        block_count: result.conversation.block_count,
      });
    }
    if (isClaudeWorkflowTranscriptPath(filePath)) {
      await ingestWorkflowArtifact(filePath);
    }
    return appendInfo?.hasMore ?? false;
  }

  // Issues 71a287e / b3e4a09 — detect leaked Mandible credentials and mask them
  // before anything about these blocks is persisted, compressed, hashed into a
  // block id, or broadcast over SSE. The index must never hold a working token;
  // the source transcript is not modified and stays the only copy of the
  // original. Masking is a pure function of the credential id, so a re-ingest of
  // the same file against the same credential table reproduces identical block
  // content and identical block ids.
  //
  // Masking covers block.metadata as well as block.content: the parsers copy
  // tool arguments and short tool results into metadata (tool_input,
  // tool_output), and that object is serialized into metadata_json below and
  // into the append SSE payload further down, so content-only masking left the
  // plaintext in both (review finding 1).
  //
  // This runs before persistence rather than after (where the scan-only call
  // used to live): a rolled-back insert can now leave an alert whose block never
  // landed, which is the safe direction — the leak is real in the source file
  // either way. The matched token still never leaves the scanner.
  try {
    // Derived metadata first: the title is cut from the first user message, so a
    // token pasted there would otherwise survive in the conversations row and be
    // quoted into the leak alert. Masking it here also means the alert payload
    // built below carries the masked title.
    const maskedTitle = maskActiveCredentialsInText(db, result.conversation.title);
    result.conversation.title = maskedTitle.text;
    const maskedSummary = maskActiveCredentialsInText(db, result.conversation.summary);
    if (result.conversation.summary !== null && result.conversation.summary !== undefined) {
      result.conversation.summary = maskedSummary.text;
    }

    const redaction = redactCredentialLeaksInBlocks(
      db,
      newBlocks,
      {
        conversation_id: conversationId,
        conversation_title: result.conversation.title,
        session_id: result.conversation.session_id,
        source: result.conversation.source,
        branch: result.conversation.branch,
      },
    );
    const metadataSpans = maskedTitle.replacements + maskedSummary.replacements;
    const unverifiedSpans = redaction.unverified_spans
      + maskedTitle.unverified_replacements
      + maskedSummary.unverified_replacements;
    if (redaction.redacted_spans > 0 || metadataSpans > 0 || unverifiedSpans > 0) {
      logger("warn", "credential_leak_redacted_at_ingest", {
        file: filePath,
        conversation: conversationId,
        redacted_blocks: redaction.redacted_blocks,
        redacted_spans: redaction.redacted_spans,
        redacted_metadata_spans: metadataSpans,
        // Fail-closed masking: spans the scan could not verify (budget exhausted
        // or verification unavailable) are masked rather than stored.
        unverified_spans: unverifiedSpans,
        verification_failed: redaction.verification_failed
          || maskedTitle.verification_failed
          || maskedSummary.verification_failed,
        alert_failures: redaction.alert_failures,
      });
    }
    for (const leak of redaction.detections) {
      if (!leak.new_event) continue;
      logger("warn", "credential_leak_detected", {
        conversation: conversationId,
        credential_id: leak.credential.credential_id,
        session_scoped: leak.credential.session_scoped,
        auto_revoked: leak.revoked,
      });
    }
  } catch (error) {
    // The scanner already fails closed internally, so reaching here means
    // something upstream of it broke. Persisting the parsed text as-is would
    // still be the one outcome that must never happen, so every token-shaped
    // span goes in masked and unverified (review finding 3).
    const masked = maskAllCandidatesInBlocks(newBlocks);
    const maskedTitle = maskUnverifiedCandidates(result.conversation.title ?? "");
    if (maskedTitle.replacements > 0) result.conversation.title = maskedTitle.text;
    const maskedSummary = maskUnverifiedCandidates(result.conversation.summary ?? "");
    if (maskedSummary.replacements > 0) result.conversation.summary = maskedSummary.text;
    logger("error", "credential_leak_scan_failed", {
      file: filePath,
      error: String(error),
      masked_blocks: masked.blocks,
      unverified_spans: masked.spans + maskedTitle.replacements + maskedSummary.replacements,
    });
  }

  // Pre-compress outside the transaction in bounded batches. Compressed bytes
  // are staged on disk so full re-ingests do not retain every output Buffer.
  const compressedContents = await stageCompressedBlockContents(
    newBlocks.map((block) => block.content),
  );

  // Atomic upsert: for full re-ingest, delete old data and re-insert;
  // for delta append, insert only new blocks and update conversation metadata.
  const upsert = db.transaction(() => {
    if (!isDeltaAppend) {
      const metadata = preservedConversationMetadata(db, conversationId);
      // Full re-ingest path: delete existing rows and re-insert from scratch
      if (!isNew) {
        db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = ?")
          .run(conversationId);
      }

      // Insert conversation
      db.prepare(`
        INSERT INTO conversations (
          id, source, source_path, source_hash, source_mtime,
          title, summary, started_at, ended_at, block_count,
          session_id, project_path, cwd, branch, model, cli_version,
          starred, tags, notes, is_sidechain, agent_id,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          datetime('now'), datetime('now')
        )
        ON CONFLICT(id) DO UPDATE SET
          source = excluded.source, source_path = excluded.source_path,
          source_hash = excluded.source_hash, source_mtime = excluded.source_mtime,
          title = excluded.title, summary = excluded.summary,
          started_at = excluded.started_at, ended_at = excluded.ended_at,
          block_count = excluded.block_count, session_id = excluded.session_id,
          project_path = excluded.project_path, cwd = excluded.cwd,
          branch = excluded.branch, model = excluded.model, cli_version = excluded.cli_version,
          starred = excluded.starred, tags = excluded.tags, notes = excluded.notes,
          is_sidechain = MAX(conversations.is_sidechain, excluded.is_sidechain),
          agent_id = COALESCE(excluded.agent_id, conversations.agent_id),
          updated_at = excluded.updated_at
      `).run(
        conversationId,
        result.conversation.source,
        result.conversation.source_path,
        result.conversation.source_hash,
        result.conversation.source_mtime,
        result.conversation.title,
        result.conversation.summary,
        result.conversation.started_at,
        result.conversation.ended_at,
        result.conversation.block_count,
        result.conversation.session_id,
        result.conversation.project_path,
        result.conversation.cwd,
        result.conversation.branch,
        result.conversation.model,
        result.conversation.cli_version,
        metadata.starred,
        metadata.tags,
        metadata.notes,
        isSidechain ? 1 : 0,
        agentId,
      );
    } else {
      // Delta append path: update conversation metadata only, no block deletion
      db.prepare(`
        UPDATE conversations SET
          source_hash = ?, source_mtime = ?,
          title = ?, summary = ?, ended_at = ?,
          block_count = ?, model = ?, cli_version = ?,
          is_sidechain = MAX(is_sidechain, ?),
          agent_id = COALESCE(?, agent_id),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        result.conversation.source_hash,
        result.conversation.source_mtime,
        result.conversation.title,
        result.conversation.summary,
        result.conversation.ended_at,
        result.conversation.block_count,
        result.conversation.model,
        result.conversation.cli_version,
        isSidechain ? 1 : 0,
        agentId,
        conversationId,
      );
    }

    // Insert blocks — content is gzip-compressed as BLOB (Bug: e5a945d)
    // In delta mode, newBlocks contains only the newly appended blocks.
    // compressedContents was staged async above, outside this transaction.
    const insertBlock = db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, position,
        timestamp, parent_id, metadata_json, compressed,
        dag_uuid, dag_parent_uuid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    for (let i = 0; i < newBlocks.length; i++) {
      const block = newBlocks[i];
      // Bug: 7b47c6c — include block.position in hash to prevent collisions.
      // Many blocks share the same type + timestamp + content prefix (e.g. multiple
      // empty tool_result blocks). Without position, the hash is identical for all of
      // them → UNIQUE constraint fails → entire transaction rolls back → file stuck
      // in perpetual re-ingest loop. Position is stable: it's the block's index within
      // the conversation and never changes for already-ingested blocks.
      const blockHash = conversationBlockId({
        conversation_id: conversationId,
        type: block.type,
        timestamp: block.timestamp,
        content: block.content,
        position: block.position,
      });

      insertBlock.run(
        blockHash,
        conversationId,
        block.type,
        block.role,
        compressedContents.read(i),
        block.position,
        block.timestamp,
        block.parent_id,
        JSON.stringify(block.metadata),
        block.dag_uuid ?? null,
        block.dag_parent_uuid ?? null,
      );
    }
  });

  try {
    upsert();
  } catch (error) {
    const errStr = String(error);
    // Bug: 7b47c6c — UNIQUE constraint on conversation_blocks.id indicates stale blocks
    // in the DB with the same hash IDs (from a prior ingest cycle where the conversation
    // row was deleted but blocks were not cleaned up due to FK being disabled).
    // Recovery: force-delete all blocks for this conversation, then retry as full re-ingest.
    if (errStr.includes("UNIQUE constraint failed: conversation_blocks.id")) {
      if (ingestMode === "append") {
        deleteAppendState(db, filePath);
        logger("warn", "ingestion_append_fallback", {
          file: filePath,
          reason: "append_unique_conflict",
        });
        await ingestFile(filePath, {
          forceFull: true,
          fallbackReason: "append_unique_conflict",
          strictParseErrors: options.strictParseErrors,
        });
        return;
      }
      try {
        // Recovery re-inserts every block of this fresh parse, including the
        // ones the masking pass above skipped as already indexed. Mask the full
        // set first — the mask is idempotent, so this is a no-op for blocks
        // already handled, and it stops recovery from reintroducing plaintext
        // an earlier ingest had masked (issue b3e4a09).
        try {
          redactCredentialLeaksInBlocks(db, result.blocks, {
            conversation_id: conversationId,
            conversation_title: result.conversation.title,
            session_id: result.conversation.session_id,
            source: result.conversation.source,
            branch: result.conversation.branch,
          });
        } catch (maskError) {
          const masked = maskAllCandidatesInBlocks(result.blocks);
          logger("error", "credential_leak_scan_failed", {
            file: filePath,
            error: String(maskError),
            stage: "unique_recovery",
            unverified_spans: masked.spans,
          });
        }
        // Re-stage every block for the clean recovery transaction.
        const recoveryCompressedContents = await stageCompressedBlockContents(
          result.blocks.map((block) => block.content),
        );
        // Ids for the recovery insert are assigned over the whole parse at once
        // so two blocks that derive the same id get different rows instead of
        // failing the transaction a second time (issue b3e4a09, third-pass
        // finding 3). `conversationBlockId` concatenates its inputs unframed,
        // so content "payload1" at position 2 and content "payload" at position
        // 12 hash identical bytes without any hash collision; the plain
        // derivation therefore has no fixed point for such a conversation and
        // recovery used to rethrow the same UNIQUE failure and leave the file
        // unindexed forever. The first block in position order still keeps the
        // plain id, so no existing block is renumbered by this.
        const recoveryBlockIds = assignConversationBlockIds(
          result.blocks.map((block) => ({
            conversation_id: conversationId,
            type: block.type,
            timestamp: block.timestamp,
            content: block.content,
            position: block.position,
          })),
        );
        try {
          const recoveryUpsert = db.transaction(() => {
            const metadata = preservedConversationMetadata(db, conversationId);
            // Also purge any blocks still attached to this conversation id
            // (orphaned rows from a prior failed transaction that the
            // FK-disabled DB did not cascade). Scoped to this conversation —
            // the previous form deleted every row whose id matched one of the
            // incoming ids regardless of which conversation it belonged to, so
            // a block id collision across conversations silently destroyed an
            // unrelated conversation's block (issue b3e4a09, re-review finding
            // 2). The orphans this is aimed at always carry this conversation
            // id, because the id being re-derived hashes it.
            db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = ?")
              .run(conversationId);
            // A row of some *other* conversation holding one of the incoming
            // ids can only be a truncated-hash collision. Recovery refuses to
            // delete it: the insert below fails loudly instead of quietly
            // taking data that does not belong to this file.
            const foreign = foreignBlockIdHolders(db, conversationId, recoveryBlockIds);
            if (foreign.length > 0) {
              logger("error", "ingestion_block_id_collision_foreign", {
                file: filePath,
                conversation_id: conversationId,
                colliding_ids: foreign.length,
                other_conversations: [...new Set(foreign.map((row) => row.conversation_id))],
              });
            }
            // Re-insert conversation
            db.prepare(`
              INSERT INTO conversations (
                id, source, source_path, source_hash, source_mtime,
                title, summary, started_at, ended_at, block_count,
                session_id, project_path, cwd, branch, model, cli_version,
                starred, tags, notes, is_sidechain, agent_id,
                created_at, updated_at
              ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                datetime('now'), datetime('now')
              )
              ON CONFLICT(id) DO UPDATE SET
                source = excluded.source, source_path = excluded.source_path,
                source_hash = excluded.source_hash, source_mtime = excluded.source_mtime,
                title = excluded.title, summary = excluded.summary,
                started_at = excluded.started_at, ended_at = excluded.ended_at,
                block_count = excluded.block_count, session_id = excluded.session_id,
                project_path = excluded.project_path, cwd = excluded.cwd,
                branch = excluded.branch, model = excluded.model, cli_version = excluded.cli_version,
                starred = excluded.starred, tags = excluded.tags, notes = excluded.notes,
                is_sidechain = MAX(conversations.is_sidechain, excluded.is_sidechain),
                agent_id = COALESCE(excluded.agent_id, conversations.agent_id),
                updated_at = excluded.updated_at
            `).run(
              conversationId,
              result.conversation.source,
              result.conversation.source_path,
              result.conversation.source_hash,
              result.conversation.source_mtime,
              result.conversation.title,
              result.conversation.summary,
              result.conversation.started_at,
              result.conversation.ended_at,
              result.conversation.block_count,
              result.conversation.session_id,
              result.conversation.project_path,
              result.conversation.cwd,
              result.conversation.branch,
              result.conversation.model,
              result.conversation.cli_version,
              metadata.starred,
              metadata.tags,
              metadata.notes,
              isSidechain ? 1 : 0,
              agentId,
            );
            // Re-insert all blocks using staged compressed buffers.
            const insertBlock2 = db.prepare(`
              INSERT INTO conversation_blocks (
                id, conversation_id, type, role, content, position,
                timestamp, parent_id, metadata_json, compressed,
                dag_uuid, dag_parent_uuid
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            `);
            for (let i = 0; i < result.blocks.length; i++) {
              const block = result.blocks[i];
              insertBlock2.run(
                recoveryBlockIds[i], conversationId, block.type, block.role,
                recoveryCompressedContents.read(i), block.position,
                block.timestamp, block.parent_id, JSON.stringify(block.metadata),
                block.dag_uuid ?? null, block.dag_parent_uuid ?? null,
              );
            }
          });
          recoveryUpsert();
          logger("info", "ingestion_unique_recovery_succeeded", {
            file: filePath,
            blocks: result.blocks.length,
          });
        } finally {
          await recoveryCompressedContents.dispose();
        }
      } catch (recoveryError) {
        if (isSqliteBusy(recoveryError)) throw recoveryError;
        logger("warn", "ingestion_db_error", {
          file: filePath,
          error: errStr,
          recovery_error: String(recoveryError),
        });
        return;
      }
    } else {
      if (isSqliteBusy(error)) throw error;
      logger("warn", "ingestion_db_error", {
        file: filePath,
        error: errStr,
      });
      return;
    }
  } finally {
    await compressedContents.dispose();
  }

  await refreshAppendState(
    db,
    filePath,
    stat,
    ingestMode === "append"
      ? (appendState?.line_count ?? alreadyIngestedCount) + (appendInfo?.completeLineCount ?? 0)
      : result.sourceSnapshot?.completeLineCount ?? await countCompleteLines(filePath),
    appendInfo?.nextPartialLine ?? (result.sourceSnapshot ? "" : undefined),
    appendInfo?.tailHash ?? result.sourceSnapshot?.tailHash,
    appendInfo?.byteOffset ?? result.sourceSnapshot?.byteLength ?? stat.size,
  );
  if (!appendInfo?.hasMore) {
    await recordDurableConversationSource(
      db,
      conversationId,
      result,
      filePath,
      isDeltaAppend ? "append" : "replace",
      newBlocks,
      options.strictParseErrors,
    );
  }

  // Bug: e01653d — update last_active on the matching session so the
  // Sessions tab shows real user activity time rather than updated_at.
  // The JSONL mtime is a reliable proxy for "last message written".
  if (result.conversation.session_id) {
    const activeAt = new Date(stat.mtimeMs).toISOString();
    db.prepare(
      `UPDATE sessions SET last_active = ?
       WHERE id = ? AND (last_active IS NULL OR last_active < ?)`
    ).run(activeAt, result.conversation.session_id, activeAt);
  }

  applyIngestedLineage(db, { ...result.conversation, id: conversationId }, result);

  // Broadcast SSE event
  const eventType = isNew ? "conversation:new" : "conversation:updated";
  const insertedBlocks = newBlocks.map((block) => insertedBlockPayload(conversationId, block));
  eventPublisher(eventType, {
    id: conversationId,
    source: result.conversation.source,
    title: result.conversation.title,
    block_count: result.conversation.block_count,
    append: !isNew && isDeltaAppend && insertedBlocks.length > 0
      ? {
          blocks: insertedBlocks,
          from_position: insertedBlocks[0]?.position ?? alreadyIngestedCount,
        }
      : undefined,
  });
  if (isClaudeWorkflowTranscriptPath(filePath)) {
    await ingestWorkflowArtifact(filePath);
  }

  logger(options.withinPass ? "debug" : "info", "ingestion_complete", {
    file: filePath,
    source: result.conversation.source,
    blocks: newBlocks.length,
    total_blocks: result.conversation.block_count,
    delta: isDeltaAppend,
    ingest_mode: ingestMode,
    appended_bytes: appendInfo?.appendedBytes ?? null,
    append_to_ingest_latency_ms: Math.max(0, Date.now() - stat.mtimeMs),
    ingest_duration_ms: Date.now() - ingestStartedAt,
    fallback_reason: options.fallbackReason ?? null,
    event: eventType,
  });
  return appendInfo?.hasMore ?? false;
}

function unindexedConversationBlocksForCache(
  db: ReturnType<typeof getDb>,
  conversationId: string,
): Array<Pick<ConversationBlock, "type" | "position" | "parent_id" | "metadata">> {
  const rows = db.prepare(`
    SELECT block.type, block.position, block.parent_id, block.metadata_json
      FROM conversation_blocks block
     WHERE block.conversation_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM conversation_structural_blocks structural
          WHERE structural.conversation_id = block.conversation_id
            AND structural.position = block.position
            AND structural.status = 'current'
       )
     ORDER BY block.position
  `).all(conversationId) as Array<{
    type: ConversationBlock["type"];
    position: number;
    parent_id: string | null;
    metadata_json: string | null;
  }>;
  return rows.map((row) => ({
    type: row.type,
    position: row.position,
    parent_id: row.parent_id,
    metadata: parseJsonObjectStrict(
      row.metadata_json,
      "conversation block metadata_json",
    ) as ConversationBlock["metadata"],
  }));
}

async function recordDurableConversationSource(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  result: ParseResult,
  filePath: string,
  structuralMode: "replace" | "append",
  blocks: readonly Omit<ConversationBlock, "id" | "conversation_id">[],
  strict = false,
): Promise<void> {
  try {
    const usePersistedAppendBlocks = structuralMode === "append" && result.sourceSnapshot?.kind === "append";
    const cacheBlocks = usePersistedAppendBlocks
      ? unindexedConversationBlocksForCache(db, conversationId)
      : blocks;
    const legacyIds = usePersistedAppendBlocks ? [] : assignConversationBlockIds(
      blocks.map((block) => ({
        conversation_id: conversationId,
        type: block.type,
        timestamp: block.timestamp,
        content: block.content,
        position: block.position,
      })),
    );
    const store = new ConversationSourceStore(db);
    await store.recordConversation({
      conversationId,
      provider: result.conversation.source,
      nativeSessionId: result.conversation.session_id,
      filePath,
      expectedContentHash: result.conversation.source_hash,
      sourceSnapshot: result.sourceSnapshot,
      structuralMode,
      ...(usePersistedAppendBlocks
        ? {}
        : { blocks: blocks.map((block, index) => ({ ...block, legacyId: legacyIds[index] })) }),
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });
    const promotion = await store.promoteNativeConversationPayload(conversationId);
    if (!promotion.promoted
        && promotion.reason !== "no legacy payload is available for promotion") {
      logger("warn", "conversation_source_projection_mismatch", {
        file: filePath,
        conversation_id: conversationId,
        reason: promotion.reason,
      });
    }
    if (promotion.promoted || promotion.reason === "no legacy payload is available for promotion") {
      const cache = getConversationStructureCache(db);
      const currentToolPositions = new Map<string, number>();
      for (const block of cacheBlocks) {
        const toolId = block.metadata.tool_id;
        if (block.type === "tool_use" && typeof toolId === "string" && toolId) {
          currentToolPositions.set(toolId, block.position);
        }
      }
      const parentPositions = new Map(cacheBlocks.map((block) => {
        const explicit = block.parent_id !== null && /^\d+$/.test(block.parent_id)
          ? Number(block.parent_id)
          : null;
        const toolId = block.metadata.tool_id;
        const linked = block.type === "tool_result" && typeof toolId === "string" && toolId
          ? currentToolPositions.get(toolId) ?? cache.findToolPosition(conversationId, toolId)
          : null;
        return [block.position, explicit ?? linked ?? null] as const;
      }));
      const captured = cache.captureDenseRows(
        db,
        conversationId,
        structuralMode,
        parentPositions,
        currentToolPositions,
      );
      if (captured.sourceVersionId
          && captured.cached === result.conversation.block_count) {
        db.transaction(() => {
          db.prepare("DELETE FROM conversation_structural_blocks WHERE conversation_id = ?")
            .run(conversationId);
          db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = ?")
            .run(conversationId);
          db.prepare(`DELETE FROM conversation_normalization_checkpoints
            WHERE NOT EXISTS (
              SELECT 1 FROM conversation_structural_blocks block
               WHERE block.normalization_checkpoint_id = conversation_normalization_checkpoints.id
            )`).run();
        }).immediate();
        logger("debug", "conversation_structure_cached", {
          file: filePath,
          conversation_id: conversationId,
          captured_blocks: captured.captured,
          cached_blocks: captured.cached,
          dense_rows_retained: 0,
        });
      } else {
        logger("warn", "conversation_structure_cache_incomplete", {
          file: filePath,
          conversation_id: conversationId,
          expected_blocks: result.conversation.block_count,
          captured_blocks: captured.captured,
          cached_blocks: captured.cached,
        });
      }
    }
  } catch (error) {
    // Promotion happens only after the exact snapshot succeeds. A failed
    // snapshot therefore leaves newly inserted payload rows intact; a
    // previously promoted conversation keeps its existing verified structure.
    logger("warn", "conversation_source_snapshot_failed", {
      file: filePath,
      conversation_id: conversationId,
      error: String(error),
    });
    if (strict) throw error;
  }
}

/**
 * Rows outside `conversationId` that already hold one of these block ids.
 *
 * Block ids hash the conversation id and the block position, and
 * `conversation_blocks` carries UNIQUE(conversation_id, position), so a
 * foreign holder is only possible through a truncated-hash collision. This
 * exists so that case is reported rather than resolved by deletion.
 *
 * Queried in chunks: a long conversation can carry more blocks than SQLite
 * allows bound parameters in one statement.
 */
function foreignBlockIdHolders(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  ids: readonly string[],
): Array<{ id: string; conversation_id: string }> {
  const found: Array<{ id: string; conversation_id: string }> = [];
  const chunkSize = 400;
  for (let start = 0; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, conversation_id FROM conversation_blocks
         WHERE conversation_id != ? AND id IN (${placeholders})`,
      )
      .all(conversationId, ...chunk) as Array<{ id: string; conversation_id: string }>;
    found.push(...rows);
  }
  return found;
}



async function ingestWorkflowArtifact(
  filePath: string,
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    const db = getDb();
    const summaryPath = workflowSummaryPathForArtifact(filePath);
    if (!summaryPath) return;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      deleteWorkflowIngestState(db, filePath);
      logger("debug", "workflow_ingestion_file_gone", { file: filePath });
      return;
    }

    const existing = getWorkflowIngestState(db, filePath);
    if (!options.force && existing && Math.abs(existing.source_mtime - stat.mtimeMs) < 100) {
      return;
    }

    const workflow = await ingestClaudeWorkflowArtifact(db, filePath);
    if (!workflow) return;
    writeWorkflowIngestState(db, {
      file_path: filePath,
      source_mtime: stat.mtimeMs,
      summary_path: summaryPath,
      workflow_id: workflow.id,
    });
    eventPublisher(DOMAIN_EVENTS.WORKFLOW_UPDATED, {
      id: workflow.id,
      session_id: workflow.session_id,
      provider_run_id: workflow.provider_run_id,
      status: workflow.status,
      completed_workers: workflow.completed_workers,
      total_workers: workflow.total_workers,
    });
    logger("info", "workflow_ingestion_complete", {
      file: filePath,
      workflow_id: workflow.id,
      provider_run_id: workflow.provider_run_id,
      status: workflow.status,
    });
  } catch (error) {
    if (isSqliteBusy(error)) throw error;
    logger("warn", "workflow_ingestion_error", {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let reconciling = false;
let reconcilePromise: Promise<void> | null = null;

type ReconcileOptions = {
  ingestChanged?: (filePath: string) => void | Promise<void>;
  watchConfigs?: Array<{ base: string; glob: string }>;
  startupPasses?: boolean;
  cooperate?: () => Promise<void>;
};

function scheduleReconcile(startupPasses = false): void {
  const runToken = ingestionRunToken;
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  if (reconciling) return;
  reconciling = true;
  const operation = ingestionActor
    ? ingestionActor.reconcile(startupPasses)
    : reconcile(runToken, { startupPasses });
  const scheduled = operation
    .catch((error) => {
      if (isCurrentIngestionRun(runToken)) {
        logger("warn", "ingestion_reconcile_error", { error: String(error) });
      }
    })
    .finally(() => {
      if (runToken === ingestionRunToken) {
        reconciling = false;
      }
      if (reconcilePromise === scheduled) reconcilePromise = null;
    });
  reconcilePromise = scheduled;
  void scheduled;
}

async function reconcile(runToken: number, options: ReconcileOptions = {}): Promise<void> {
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  const db = getDb();
  const ingestChanged = options.ingestChanged ?? ((filePath: string) => debouncedIngest(filePath));

  if (options.startupPasses) {
    repairLegacyOrphanConversations(db);
  }

  await syncCodexIndexedTitlesForKnownRows(db);
  await syncGeminiProjectIdentityForKnownRows(db);

  const knownPaths = new Set<string>();
  const scannedBases: string[] = [];

  // Get all known source_paths from DB
  const rows = db
    .prepare("SELECT source_path, source_mtime, source, session_id FROM conversations")
    .all() as Array<{
      source_path: string;
      source_mtime: number;
      source: string;
      session_id: string;
    }>;
  const dbPaths = new Map<string, number>();
  const conversationPaths = new Set<string>();
  const codexSessionIds = new Map<string, Set<string>>();
  for (const row of rows) {
    dbPaths.set(row.source_path, row.source_mtime);
    conversationPaths.add(row.source_path);
    if (row.source === "codex") {
      const ids = codexSessionIds.get(row.source_path) ?? new Set<string>();
      ids.add(row.session_id);
      codexSessionIds.set(row.source_path, ids);
    }
  }

  // Follow `codex archive` / `codex unarchive` relocations before scanning, so
  // the moved rollout is recognized as the conversation it already is instead
  // of being ingested as a new row and then deleted as a missing source.
  // Bug: c927726.
  let relocatedCount = 0;
  let changedCount = 0;
  for (const [sourcePath, sourceMtime] of Array.from(dbPaths)) {
    const relocated = await relocateMovedCodexSource(db, sourcePath);
    if (!relocated) continue;
    relocatedCount += 1;
    const remaining = db.prepare(
      "SELECT MAX(source_mtime) AS source_mtime FROM conversations WHERE source_path = ?",
    ).get(sourcePath) as { source_mtime: number | null };
    if (remaining.source_mtime === null) {
      dbPaths.delete(sourcePath);
      conversationPaths.delete(sourcePath);
    } else {
      dbPaths.set(sourcePath, remaining.source_mtime);
    }
    dbPaths.set(relocated, sourceMtime);
    conversationPaths.add(relocated);
    const relocatedIds = codexSessionIds.get(sourcePath);
    if (relocatedIds) {
      codexSessionIds.delete(sourcePath);
      codexSessionIds.set(relocated, relocatedIds);
    }
  }

  const workflowRows = db
    .prepare("SELECT file_path, source_mtime FROM workflow_ingest_state")
    .all() as Array<{ file_path: string; source_mtime: number }>;
  const workflowPaths = new Map<string, number>();
  for (const row of workflowRows) {
    workflowPaths.set(row.file_path, row.source_mtime);
    dbPaths.set(row.file_path, row.source_mtime);
  }
  const appendRows = db
    .prepare(`
      SELECT file_path, byte_offset, tail_hash, empty_source_mtime, empty_source_size
      FROM conversation_ingest_state
    `)
    .all() as Array<{
      file_path: string;
      byte_offset: number;
      tail_hash: string;
      empty_source_mtime: number | null;
      empty_source_size: number | null;
    }>;
  const appendPaths = new Set(appendRows.map((row) => row.file_path));
  const appendStates = new Map(appendRows.map((row) => [row.file_path, row] as const));
  const emptyPaths = new Map(
    appendRows
      .filter((row) => row.empty_source_mtime !== null && row.empty_source_size !== null)
      .map((row) => [row.file_path, row] as const),
  );

  // Scan filesystem using async generator — yields to the event loop every 50
  // directory entries so the HTTP server stays responsive during startup scans.
  // Bug: 737df04 — findFiles() used readdirSync recursively, blocking the event
  // loop for the entire scan before any yielding could occur.
  let scannedEntries = 0;
  for (const config of options.watchConfigs ?? WATCH_CONFIGS) {
    if (!isCurrentIngestionRun(runToken)) {
      return;
    }
    if (!fs.existsSync(config.base)) continue;
    scannedBases.push(config.base);
    for await (const filePath of walkFiles(config.base, config.glob)) {
      if (options.cooperate && scannedEntries++ % 32 === 0) {
        await options.cooperate();
      }
      if (!isCurrentIngestionRun(runToken)) {
        return;
      }
      knownPaths.add(filePath);

      // Check if file needs ingestion
      try {
        const stat = await fs.promises.stat(filePath);
        const dbMtime = dbPaths.get(filePath);
        const emptyState = emptyPaths.get(filePath);

        if (
          !conversationPaths.has(filePath)
          && emptyState?.empty_source_mtime === stat.mtimeMs
          && emptyState.empty_source_size === stat.size
        ) {
          continue;
        }
        const knownConversation = conversationPaths.has(filePath);
        const mtimeChanged = dbMtime === undefined || Math.abs(dbMtime - stat.mtimeMs) >= 100;
        let needsIngest = !knownConversation || mtimeChanged;
        if (knownConversation && !mtimeChanged) {
          const appendState = appendStates.get(filePath);
          if (appendState && appendState.byte_offset !== stat.size) {
            needsIngest = true;
          } else if (
            appendState
            && appendState.tail_hash
            && await hashFileTailAt(filePath, appendState.byte_offset) !== appendState.tail_hash
          ) {
            needsIngest = true;
          } else {
            const indexedCodexIds = codexSessionIds.get(filePath);
            if (indexedCodexIds) {
              const nativeSessionId = await loadCodexNativeSessionId(filePath);
              needsIngest = nativeSessionId !== null && !indexedCodexIds.has(nativeSessionId);
            }
          }
        }
        if (needsIngest) {
          // New or modified file — queue for ingestion
          await ingestChanged(filePath);
          changedCount += 1;
        }
      } catch {
        // File inaccessible — skip
      }
    }
  }

  const missingPaths = Array.from(dbPaths.keys()).filter((sourcePath) =>
    scannedBases.some((base) => sourcePath === base || sourcePath.startsWith(`${base}${path.sep}`)) &&
    !knownPaths.has(sourcePath)
  );
  if (missingPaths.length > 0) {
    // A rollout archived while this reconcile was scanning is a move, not a
    // deletion; relocate it before recording missing-source tombstones.
    let unavailableCount = 0;
    for (const sourcePath of missingPaths) {
      if (await removeConversationForMissingSource(db, sourcePath)) relocatedCount += 1;
      else unavailableCount += 1;
    }
    if (unavailableCount > 0) {
      logger("info", "ingestion_sources_unavailable", { count: unavailableCount });
    }
  }
  if (relocatedCount > 0) {
    logger("info", "ingestion_sources_relocated", { count: relocatedCount });
  }
  if (changedCount > 0) {
    logger("info", "ingestion_reconcile_changed", { count: changedCount });
  }

  const missingWorkflowPaths = Array.from(workflowPaths.keys()).filter((sourcePath) =>
    scannedBases.some((base) => sourcePath === base || sourcePath.startsWith(`${base}${path.sep}`)) &&
    !knownPaths.has(sourcePath)
  );
  if (missingWorkflowPaths.length > 0) {
    const deleteState = db.prepare("DELETE FROM workflow_ingest_state WHERE file_path = ?");
    const cleanupMissingWorkflow = db.transaction(() => {
      for (const sourcePath of missingWorkflowPaths) {
        deleteState.run(sourcePath);
      }
    });
    cleanupMissingWorkflow();
  }

  const missingAppendPaths = Array.from(appendPaths).filter((sourcePath) =>
    scannedBases.some((base) => sourcePath === base || sourcePath.startsWith(`${base}${path.sep}`)) &&
    !knownPaths.has(sourcePath)
  );
  if (missingAppendPaths.length > 0) {
    const deleteState = db.prepare("DELETE FROM conversation_ingest_state WHERE file_path = ?");
    const cleanupMissingAppend = db.transaction(() => {
      for (const sourcePath of missingAppendPaths) {
        deleteState.run(sourcePath);
      }
    });
    cleanupMissingAppend();
  }

  // After relocations are followed, so moved rollouts are read where they are.
  if (options.startupPasses && isCurrentIngestionRun(runToken)) {
    const backfill = await backfillConversationLineageOnce(db);
    if (backfill) logger("info", "conversation_lineage_backfill", { ...backfill });
  }
}

export async function reconcileForWorker(
  startupPasses = false,
  cooperate?: () => Promise<void>,
): Promise<void> {
  const runToken = ingestionRunToken;
  await reconcile(runToken, {
    startupPasses,
    ingestChanged: (filePath) => ingestFile(filePath, { withinPass: true }),
    cooperate,
  });
}

interface DuplicateConversationPathRow {
  conversation_id: string;
  source: string;
  session_id: string;
  source_path: string;
  owner_conversation_id: string;
  owner_source: string;
  owner_session_id: string;
}

/**
 * Converge the legacy conversations.source_path projection on the row that
 * ingestion deterministically selected for a freshly proven provider identity.
 *
 * Migration v140 deliberately made aliases unique by path, but pre-v140
 * databases could already contain several conversation rows for one path. The
 * migration preserved every row and used INSERT OR IGNORE for aliases, leaving
 * the non-owner rows with a misleading legacy projection. Provider session ids
 * alone are not unique conversation identities, so the caller must prove the
 * file's native identity and both rows must carry matching source-backed
 * provider/native records. This repair never merges or deletes conversations.
 * It only follows another proven available alias for the non-owner, or assigns
 * a deterministic non-file locator and leaves its normalized blocks available
 * as the safe fallback.
 */
function reconcileDuplicateConversationPathOwnership(
  db: ReturnType<typeof getDb>,
  filePath: string,
  provider: string,
  nativeSessionId: string,
  ownerConversationId?: string,
): Set<string> {
  if (!ownerConversationId) return new Set<string>();
  const duplicates = db.prepare(`
    SELECT
      duplicate.id AS conversation_id,
      duplicate.source,
      duplicate.session_id,
      duplicate.source_path,
      owner.id AS owner_conversation_id,
      owner.source AS owner_source,
      owner.session_id AS owner_session_id
    FROM conversations owner
    JOIN conversation_sources owner_source
      ON owner_source.conversation_id = owner.id
     AND owner_source.provider = owner.source
     AND owner_source.native_session_id = owner.session_id
    JOIN conversations duplicate
      ON duplicate.source_path = owner.source_path
     AND duplicate.id != owner.id
    JOIN conversation_sources duplicate_source
      ON duplicate_source.conversation_id = duplicate.id
     AND duplicate_source.provider = duplicate.source
     AND duplicate_source.native_session_id = duplicate.session_id
     AND duplicate_source.provider = ?
     AND duplicate_source.native_session_id = ?
    WHERE owner.id = ?
      AND owner.source_path = ?
      AND owner_source.provider = ?
      AND owner_source.native_session_id = ?
    ORDER BY duplicate.source_path, duplicate.id
  `).all(
    provider,
    nativeSessionId,
    ownerConversationId,
    filePath,
    provider,
    nativeSessionId,
  ) as DuplicateConversationPathRow[];
  if (duplicates.length === 0) return new Set<string>();

  const availableAlias = db.prepare(`
    SELECT alias.path
      FROM conversation_sources source
      JOIN conversation_source_aliases alias ON alias.source_id = source.id
     WHERE source.conversation_id = ?
       AND alias.availability = 'available'
       AND alias.path != ?
       AND NOT EXISTS (
         SELECT 1 FROM conversations other
          WHERE other.source_path = alias.path
            AND other.id != ?
       )
     ORDER BY alias.last_seen_at DESC, alias.id
     LIMIT 1
  `);
  const updateConversationPath = db.prepare(
    "UPDATE conversations SET source_path = ? WHERE id = ? AND source_path = ?",
  );
  const markSourcesMissing = db.prepare(`
    UPDATE conversation_sources
       SET availability = 'missing',
           unavailable_reason = 'legacy source path projection detached; no available alias',
           updated_at = ?
     WHERE conversation_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM conversation_source_aliases alias
          WHERE alias.source_id = conversation_sources.id
            AND alias.availability = 'available'
       )
  `);
  const markVersionsMissing = db.prepare(`
    UPDATE conversation_source_versions
       SET availability = 'missing'
     WHERE id IN (
       SELECT current_version_id FROM conversation_sources
        WHERE conversation_id = ?
          AND availability = 'missing'
     )
  `);

  let repaired = 0;
  let sameNativeIdentity = 0;
  const repairedIds = new Set<string>();
  const repair = db.transaction(() => {
    for (const duplicate of duplicates) {
      const alias = availableAlias.get(
        duplicate.conversation_id,
        duplicate.source_path,
        duplicate.conversation_id,
      ) as { path: string } | undefined;
      const preservedPath = alias?.path
        ?? `mandible-preserved://conversation/${encodeURIComponent(duplicate.conversation_id)}`;
      const updated = updateConversationPath.run(
        preservedPath,
        duplicate.conversation_id,
        duplicate.source_path,
      );
      if (updated.changes !== 1) continue;
      repaired += 1;
      repairedIds.add(duplicate.conversation_id);
      sameNativeIdentity += 1;
      if (!alias) {
        markSourcesMissing.run(Date.now(), duplicate.conversation_id);
        markVersionsMissing.run(duplicate.conversation_id);
      }
    }
  });
  repair();

  if (repaired > 0) {
    logger("info", "ingestion_duplicate_path_ownership_reconciled", {
      repaired,
      same_native_identity: sameNativeIdentity,
      conversations_preserved: repaired,
    });
  }
  return repairedIds;
}

function logDuplicateConversationRows(
  filePath: string,
  rows: ExistingConversationRow[],
  provider?: string,
  nativeSessionId?: string,
): void {
  const actionableRows = rows.filter((row) => !row.distinct_identity_projection_detached);
  const duplicateRows = provider && nativeSessionId
    ? actionableRows.filter((row) => row.source === provider && row.session_id === nativeSessionId)
    : actionableRows;
  const chosen = duplicateRows[0];
  if (duplicateRows.length <= 1 || !chosen) return;
  logger("warn", "ingestion_duplicate_conversation_rows", {
    file: filePath,
    rows: duplicateRows.length,
    chosen_conversation_id: chosen.id,
  });
}

/**
 * One-time audit for databases produced before conversation/block ownership
 * was maintained transactionally. A blockless legacy row can still carry
 * relationships, annotations, or source history, so ingestion records the
 * observation but never treats absence of normalized blocks as deletion proof.
 */
function repairLegacyOrphanConversations(db: ReturnType<typeof getDb>): void {
  const marker = db.prepare("SELECT value FROM meta WHERE key = ?")
    .get("ingestion_orphan_repair_v1") as { value: string } | undefined;
  if (marker) return;

  const repair = db.transaction(() => {
    const orphanRows = db.prepare(`
      SELECT c.id
      FROM conversations c
      WHERE c.starred = 0 AND c.tags = '[]' AND c.notes IS NULL
        AND (c.block_count = 0 OR NOT EXISTS (
          SELECT 1 FROM conversation_blocks b
          WHERE b.conversation_id = c.id
          LIMIT 1
        ))
        AND NOT EXISTS (
          SELECT 1 FROM conversation_sources source
           WHERE source.conversation_id = c.id
        )
    `).all() as Array<{ id: string }>;
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run("ingestion_orphan_repair_v1", String(Date.now()));
    return orphanRows.length;
  });
  const observed = repair();
  if (observed > 0) {
    logger("info", "ingestion_legacy_orphan_audit", { observed, removed: 0 });
  }
}

/** Walk files matching a glob pattern using an async generator.
 *  Yields event-loop turns every 50 directory entries so the HTTP server
 *  stays responsive during large scans (Bug: 737df04). */
async function* walkFiles(baseDir: string, glob: string): AsyncGenerator<string> {
  const pattern = globToMatcher(glob);
  let entryCount = 0;

  async function* walkDir(dir: string): AsyncGenerator<string> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      entryCount++;
      if (entryCount % 50 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (entry.isDirectory()) {
        yield* walkDir(fullPath);
      } else if (entry.isFile()) {
        const relative = path.relative(baseDir, fullPath);
        if (pattern(relative)) {
          yield fullPath;
        }
      }
    }
  }

  yield* walkDir(baseDir);
}

/** Convert a simple glob pattern to a matcher function.
 *  Supports: ** (any path), * (any segment chars), literal chars. */
function globToMatcher(glob: string): (filePath: string) => boolean {
  // Convert glob to regex
  const parts = glob.split("/");
  let regexStr = "^";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (part === "**") {
      // `**/` matches any number of leading directories, including none, so a
      // flat root such as ~/.codex/archived_sessions is covered by the same
      // `**/*.jsonl` glob as the date-nested ~/.codex/sessions tree.
      regexStr += isLast ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    // Escape regex special chars, convert * to [^/]*
    regexStr += part
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
    if (!isLast) regexStr += "/";
  }
  regexStr += "$";
  const regex = new RegExp(regexStr);
  return (filePath: string) => regex.test(filePath);
}
