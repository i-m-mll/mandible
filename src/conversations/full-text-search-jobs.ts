import { createHash, randomUUID } from "node:crypto";
import { readSnapshot } from "../ledger-reads/snapshot.js";
import { ConversationSourceReader } from "./source-reader.js";
import type { SourceReadFailureKind } from "./source-types.js";
import type { Db } from "../db.js";
import { getConversationSearchCache, SourceBackedConversationSearchSourceAdapter, type ConversationSearchMatch } from "./search-cache.js";
import { readConversationSourceReadiness } from "./source-readiness.js";
import { FULL_TEXT_SEARCH_OBSERVER_LEASE_MS, FULL_TEXT_SEARCH_RETRY_MS, unsettledCoverage, type FullTextSearchCoverage, type FullTextSearchPending, type FullTextSearchReason, type FullTextSearchResponse, type FullTextSearchTerminal, type FullTextSearchUnreadReason } from "./full-text-search-contract.js";
export type SearchQuery = Record<string, string | undefined>;
export type SearchRoute = "conversation_list" | "conversation_sidebar" | "conversation_search";
export class SearchSnapshotProjectionError extends Error {
  constructor(readonly reason: "query_mismatch") { super(reason); }
}
/** Rendered matches whose sources can no longer be read; serving drops them and renders again. */
export class SearchSourcesLostError extends Error {
  constructor(readonly lost: ReadonlyMap<string, FullTextSearchUnreadReason>) { super("search sources lost"); }
}
export type SearchMatchFact = Omit<ConversationSearchMatch, "snippet"> & {
  source_version_id: string;
  source_block_count: number;
  source_model: string | null;
};
export interface SearchPlan {
  ids: string[];
  needle: string;
  blockType?: string | null;
  metadataBytes: number;
  /** Ends the scan once this many matches are held, for routes that need no exact total. */
  stopAfterMatches?: number;
  render(matches: readonly SearchMatchFact[], query: SearchQuery, searchId: string): Promise<unknown> | unknown;
}
export type SearchUpdate = FullTextSearchPending | FullTextSearchTerminal | {
  state: "complete";
  search_id: string;
};
export interface SearchJobRuntime {
  publish(update: SearchUpdate): void;
  repair(conversationId: string): Promise<void>;
}
const runtimes = new WeakMap<Db, SearchJobRuntime>();
export function configureSearchJobRuntime(db: Db, runtime: SearchJobRuntime): void { runtimes.set(db, runtime); }
export function isFullTextSearch(route: string, query: SearchQuery): route is SearchRoute {
  return route === "conversation_search"
    ? query.title !== "true" && query.title !== "1" && Boolean((query.q || query.query || "").trim())
    : (route === "conversation_sidebar" || route === "conversation_list")
      && (query.full_text === "true" || query.full_text === "1") && Boolean(query.search?.trim());
}
const PAGE_FIELDS = new Set(["search_id", "observer_token", "cancel", "limit", "page", "offset", "cursor", "group_key", "snapshot_id"]);
/** The matches a `conversation_search` page needs; the job scans no further than this. */
export function conversationSearchMatchLimit(query: SearchQuery): number {
  return Math.min(100, Math.max(1, parseInt(query.limit || "20", 10) || 20)) + Math.max(0, parseInt(query.offset || "0", 10) || 0);
}
export function fullTextQueryKey(route: string, query: SearchQuery): string {
  const normalizedQuery: SearchQuery = { ...query };
  const booleanFields = new Set(["full_text", "starred", "exclude_subagents", "group", "title"]);
  for (const field of booleanFields)
    if (normalizedQuery[field] !== undefined)
      normalizedQuery[field] = normalizedQuery[field] === "true" || normalizedQuery[field] === "1" ? "true" : "false";
  if (route === "conversation_search") {
    normalizedQuery.q = (query.q || query.query || "").trim().toLowerCase();
    normalizedQuery.source = query.source || query.provider;
    normalizedQuery.stop_after = String(conversationSearchMatchLimit(query));
    delete normalizedQuery.query;
    delete normalizedQuery.provider;
    delete normalizedQuery.title;
  }
  if (route === "conversation_sidebar") {
    normalizedQuery.lifecycle = query.lifecycle || "active";
    normalizedQuery.sort = query.sort === "block_count" ? "block_count" : "started_at";
    if (query.project_ids)
      normalizedQuery.project_ids = [...new Set(query.project_ids.split(",").map(id => id.trim()))].sort().join(",");
  }
  const normalized = Object.entries(normalizedQuery).filter(([key, value]) => !PAGE_FIELDS.has(key) && value !== undefined && value !== "")
    .map(([key, value]) => [key, ["search", "q"].includes(key) ? value!.trim().toLowerCase() : value])
    .sort(([left], [right]) => left!.localeCompare(right!));
  return createHash("sha256").update(JSON.stringify([route, normalized])).digest("base64url");
}
export function pendingSearch(searchId: string, observer: string): FullTextSearchPending {
  return { state: "pending", search_id: searchId, observer_token: observer, phase: "queued", progress: { eligible: 0, prepared: 0, scanned: 0, matched: 0 }, retry_after_ms: FULL_TEXT_SEARCH_RETRY_MS };
}
function terminal(searchId: string, reason: FullTextSearchReason, coverage: FullTextSearchCoverage, state: FullTextSearchTerminal["state"] = "incomplete", detail?: string): FullTextSearchTerminal {
  return { state, search_id: searchId, reason, ...(detail ? { detail } : {}), coverage: { ...coverage, complete: false } };
}
const MAX_UNREAD_EXAMPLES = 3;
function recordUnread(coverage: FullTextSearchCoverage, conversationId: string, reason: FullTextSearchUnreadReason): void {
  const entry = coverage.unread[reason] ??= { count: 0, examples: [] };
  entry.count++;
  if (entry.examples.length < MAX_UNREAD_EXAMPLES) entry.examples.push(conversationId);
  coverage.failed++;
}
export const UNREAD_FOR_FAILURE: Record<SourceReadFailureKind, FullTextSearchUnreadReason> = {
  cancelled: "source_changed",
  stale: "source_changed",
  unavailable: "source_unavailable",
  unsupported: "unsupported_representation",
  not_found: "conversation_not_found",
};
interface Pin {
  id: string;
  version: string;
  blockCount: number;
  model: string | null;
}
interface Job {
  id: string;
  key: string;
  pending: FullTextSearchPending;
  coverage: FullTextSearchCoverage;
  observers: Map<string, number>;
  controller: AbortController;
  plan?: SearchPlan;
  pins: Pin[];
  matches: SearchMatchFact[];
  redaction: string;
  terminal?: FullTextSearchTerminal;
  complete: boolean;
  accessed: number;
  bytes: number;
  prepare: () => SearchPlan;
  metrics: {
    preparation_ms: number;
    scan_ms: number;
    projection_ms: number;
    paging_ms: number;
    source_verification_ms: number;
    snapshot_pin_bytes:number;
  };
}
const MAX_METADATA = 32 * 1024 * 1024;
const SCAN_WINDOW = 256;
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function renderedConversationIds(value: unknown): Set<string> {
  const body = value as {
    conversations?: Array<{
      id: string;
    }>;
    results?: Array<{
      conversation: {
        id: string;
      };
    }>;
    groups?: Array<{
      conversations: Array<{
        id: string;
      }>;
    }>;
  };
  return new Set([
    ...body.conversations?.map(row => row.id) || [],
    ...body.results?.map(row => row.conversation.id) || [],
    ...body.groups?.flatMap(group => group.conversations.map(row => row.id)) || [],
  ]);
}
/** One active corpus, bounded queue and disposable immutable match snapshots. */
export class FullTextSearchJobs {
  private jobs = new Map<string, Job>();
  private active = false;
  private readonly reader: ConversationSourceReader;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private db: Db, private runtime: SearchJobRuntime) {
    this.reader = new ConversationSourceReader(db);
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  close(): void {
    clearInterval(this.timer);
    for (const job of this.jobs.values())
      this.fail(job, "cancelled");
    this.jobs.clear();
  }
  private publish(job: Job): void {
    this.runtime.publish(job.terminal ?? (job.complete ? { state: "complete", search_id: job.id } : { ...job.pending, progress: { ...job.pending.progress } }));
  }
  private fail(job: Job, reason: FullTextSearchReason, state?: FullTextSearchTerminal["state"], detail?: string): void {
    if (job.terminal)
      return;
    job.terminal = terminal(job.id, reason, job.coverage, state, detail);
    job.matches = [];
    job.plan = undefined;
    job.pins = [];
    job.bytes = 0;
    job.controller.abort();
    this.publish(job);
  }
  private sweep(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      for (const [token, expires] of job.observers)
        if (expires <= now)
          job.observers.delete(token);
      if (!job.complete && !job.terminal && job.observers.size === 0)
        this.fail(job, "observer_expired");
      if ((job.complete || job.terminal) && now - job.accessed > 300000)
        this.jobs.delete(job.id);
    }
  }
  private evict(bytes = 0): boolean {
    const complete = [...this.jobs.values()].filter(job => job.complete && !job.terminal).sort((a, b) => a.accessed - b.accessed);
    let total = [...this.jobs.values()].reduce((sum, job) => sum + job.bytes, 0);
    while (complete.length >= 4 || total + bytes > MAX_METADATA) {
      const victim = complete.shift();
      if (!victim)
        return false;
      total -= victim.bytes;
      this.jobs.delete(victim.id);
    }
    return true;
  }
  async request(route: SearchRoute, query: SearchQuery, prepare: () => SearchPlan, start = false): Promise<{
    status: number;
    json: string;
  }> {
    this.sweep();
    const key = fullTextQueryKey(route, query);
    let job = query.search_id ? this.jobs.get(query.search_id) : [...this.jobs.values()].find(candidate => candidate.key === key && !candidate.complete && !candidate.terminal);
    if (!job && query.search_id && !start)
      return this.response(terminal(query.search_id, "snapshot_expired", unsettledCoverage(), "expired"));
    if (!job) {
      const id = query.search_id || randomUUID();
      const queued = [...this.jobs.values()].filter(candidate => !candidate.complete && !candidate.terminal).length;
      if (queued >= 9)
        return this.response(terminal(id, "admission_full", unsettledCoverage()));
      const observer = query.observer_token || randomUUID();
      job = { id, key, pending: pendingSearch(id, observer), coverage: unsettledCoverage(), observers: new Map(), controller: new AbortController(), pins: [], matches: [], redaction: "", complete: false, accessed: Date.now(), bytes: 0, prepare, metrics: { preparation_ms: 0, scan_ms: 0, projection_ms: 0, paging_ms: 0, source_verification_ms: 0,snapshot_pin_bytes:0 } };
      if (this.jobs.size >= 128)
        for (const [oldId, item] of this.jobs)
          if (item.terminal) {
            this.jobs.delete(oldId);
            if (this.jobs.size < 128)
              break;
          }
      this.jobs.set(id, job);
      setImmediate(() => { void this.pump(); });
    }
    if (job.key !== key)
      return this.response(terminal(job.id, "query_mismatch", job.coverage, "superseded"));
    const observer = query.observer_token || randomUUID();
    if (query.cancel === "true") {
      job.observers.delete(observer);
      if (!job.complete && job.observers.size === 0)
        this.fail(job, "cancelled");
      return this.response(terminal(job.id, "cancelled", job.coverage));
    }
    if (!job.complete) {
      if (!job.observers.has(observer) && job.observers.size >= 128)
        return this.response(terminal(job.id, "admission_full", job.coverage));
      job.observers.set(observer, Date.now() + FULL_TEXT_SEARCH_OBSERVER_LEASE_MS);
    }
    job.accessed = Date.now();
    if (job.terminal)
      return this.response(job.terminal);
    if (!job.complete)
      return this.response({ ...job.pending, observer_token: observer });
    if (!this.redactionCurrent(job))
      return this.response(job.terminal!);
    const pagingStarted = performance.now();
    for (;;) {
      let result: unknown;
      let lost: ReadonlyMap<string, FullTextSearchUnreadReason>;
      try {
        result = await job.plan!.render(job.matches, query, job.id);
        lost = await this.proveRendered(job, renderedConversationIds(result));
      }
      catch (error) {
        if (error instanceof SearchSnapshotProjectionError)
          return this.response(terminal(job.id, error.reason, job.coverage, "superseded"));
        if (!(error instanceof SearchSourcesLostError))
          return this.response(terminal(job.id, "internal_error", job.coverage, "incomplete", error instanceof Error ? error.message : String(error)));
        lost = error.lost;
      }
      if (lost.size > 0) {
        this.forgetLost(job, lost);
        continue;
      }
      if (!this.redactionCurrent(job))
        return this.response(job.terminal!);
      job.metrics.paging_ms += performance.now() - pagingStarted;
      return this.response({ ...result as object, search_metrics: { ...job.metrics,snapshot_metadata_bytes:job.bytes }, state: "complete", search_id: job.id, snapshot_id: job.id, coverage: job.coverage });
    }
  }
  private response(body: FullTextSearchResponse<Record<string, unknown>>): {
    status: number;
    json: string;
  } {
    return { status: body.state === "pending" ? 202 : body.state === "complete" ? 200 : 409, json: JSON.stringify(body) };
  }
  private redactionCurrent(job: Job): boolean {
    if (job.terminal)
      return false;
    if (new SourceBackedConversationSearchSourceAdapter(this.db).redactionEpoch() === job.redaction)
      return true;
    this.fail(job, "redaction_changed", "superseded");
    return false;
  }
  /** Matches answer for their transcripts as scanned, so only what this page shows must still be readable. */
  private async proveRendered(job: Job, rendered: ReadonlySet<string>): Promise<ReadonlyMap<string, FullTextSearchUnreadReason>> {
    const lost = new Map<string, FullTextSearchUnreadReason>();
    const pins = job.pins.filter(pin => rendered.has(pin.id));
    if (pins.length === 0)
      return lost;
    const started = performance.now();
    const aliased = new Set((this.db.prepare("SELECT alias_id FROM conversation_identity_aliases WHERE alias_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(pins.map(pin => pin.id))) as Array<{ alias_id: string }>).map(row => row.alias_id));
    for (const pin of pins) {
      if (aliased.has(pin.id)) {
        lost.set(pin.id, "source_changed");
        continue;
      }
      const proof = await this.reader.verifyVersion(pin.id, pin.version, job.controller.signal);
      if (proof.status !== "source")
        lost.set(pin.id, UNREAD_FOR_FAILURE[proof.status]);
    }
    job.metrics.source_verification_ms += performance.now() - started;
    return lost;
  }
  private forgetLost(job: Job, lost: ReadonlyMap<string, FullTextSearchUnreadReason>): void {
    for (const [id, reason] of lost)
      recordUnread(job.coverage, id, reason);
    job.pins = job.pins.filter(pin => !lost.has(pin.id));
    job.matches = job.matches.filter(match => !lost.has(match.conversation_id));
    job.coverage.scanned -= lost.size;
    job.coverage.matched = job.matches.length;
    job.coverage.complete = false;
  }
  private async pump(): Promise<void> {
    if (this.active)
      return;
    this.active = true;
    try {
      for (;;) {
        const job = [...this.jobs.values()].find(candidate => !candidate.complete && !candidate.terminal);
        if (!job)
          break;
        try {
          await this.run(job);
        }
        catch (error) {
          this.fail(job, "internal_error", "incomplete", error instanceof Error ? error.message : String(error));
        }
      }
    }
    finally {
      this.active = false;
    }
  }
  private async run(job: Job): Promise<void> {
    job.pending.phase = "preparing";
    this.publish(job);
    await yieldTurn();
    if (job.terminal)
      return;
    const preparationStarted = performance.now();
    const projectionStarted = performance.now();
    let plan = job.prepare();
    job.metrics.projection_ms = performance.now() - projectionStarted;
    job.plan = plan;
    job.bytes = plan.metadataBytes;
    if (!this.evict()) {
      this.fail(job, "metadata_limit");
      return;
    }
    job.coverage.eligible = job.pending.progress.eligible = plan.ids.length;
    for (const id of plan.ids) {
      if (job.terminal)
        return;
      if (readConversationSourceReadiness(this.db, id).status === "repair_needed") {
        let stop!: () => void;
        const abort = new Promise<void>(resolve => { stop = resolve; job.controller.signal.addEventListener("abort", stop, { once: true }); });
        try {
          await Promise.race([this.runtime.repair(id), abort]);
        }
        finally {
          job.controller.signal.removeEventListener("abort", stop);
        }
        if (job.terminal)
          return;
      }
      job.coverage.prepared = ++job.pending.progress.prepared;
      if (job.pending.progress.prepared % 32 === 0) {
        this.publish(job);
        await yieldTurn();
      }
    }
    const snapshot = readSnapshot(this.db, () => {
      const refreshed = job.prepare();
      return {
        plan: refreshed,
        sources: refreshed.ids.map(id => readConversationSourceReadiness(this.db, id)),
        normalization: this.db.prepare("SELECT id,block_count,model FROM conversations WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(refreshed.ids)) as Array<{
          id: string;
          block_count: number;
          model: string | null;
        }>,
        redaction: new SourceBackedConversationSearchSourceAdapter(this.db).redactionEpoch(),
      };
    });
    plan = snapshot.plan;
    job.plan = plan;
    const normalization = new Map(snapshot.normalization.map(row => [row.id, row]));
    job.pins = [];
    for (const source of snapshot.sources) {
      if (source.status === "ready")
        job.pins.push({ id: source.conversationId, version: source.sourceVersionId!, blockCount: normalization.get(source.conversationId)!.block_count, model: normalization.get(source.conversationId)!.model });
      else
        recordUnread(job.coverage, source.conversationId, source.reason as FullTextSearchUnreadReason);
    }
    job.coverage.eligible = job.pending.progress.eligible = plan.ids.length;
    job.coverage.prepared = job.pending.progress.prepared = plan.ids.length;
    job.metrics.snapshot_pin_bytes=Buffer.byteLength(JSON.stringify(job.pins));
    job.bytes = plan.metadataBytes + job.metrics.snapshot_pin_bytes;
    job.prepare = () => { throw new Error("search plan already pinned"); };
    if (!this.evict()) {
      this.fail(job, "metadata_limit");
      return;
    }
    job.redaction = snapshot.redaction;
    job.metrics.preparation_ms = performance.now() - preparationStarted;
    const scanningStarted = performance.now();
    job.pending.phase = "scanning";
    this.publish(job);
    const cache = getConversationSearchCache(this.db);
    const pinned = job.pins;
    const stopAfter = plan.stopAfterMatches ?? Infinity;
    for (let index = 0; index < pinned.length && job.matches.length < stopAfter; index += SCAN_WINDOW) {
      if (job.terminal)
        return;
      const window = pinned.slice(index, index + SCAN_WINDOW);
      const result = await cache.search({
        conversationIds: window.map(pin => pin.id), needle: plan.needle, blockType: plan.blockType,
        limit: Math.min(window.length, stopAfter - job.matches.length), signal: job.controller.signal,
        expectedSourceVersions: Object.fromEntries(window.map(pin => [pin.id, pin.version])),
        expectedBlockCounts: Object.fromEntries(window.map(pin => [pin.id, pin.blockCount])),
        expectedModels: Object.fromEntries(window.map(pin => [pin.id, pin.model])),
      });
      if (job.terminal)
        return;
      job.metrics.source_verification_ms += result.metrics.source_verification_ms;
      if (result.failures.some(failure => failure.status === "cancelled")) {
        this.fail(job, "cancelled");
        return;
      }
      for (const failure of result.failures)
        recordUnread(job.coverage, failure.conversation_id, UNREAD_FOR_FAILURE[failure.status]);
      job.coverage.scanned = job.pending.progress.scanned += result.metrics.examined_conversations - result.failures.length;
      const pins = new Map(window.map(pin => [pin.id, pin]));
      const facts = result.matches.map(({ snippet: _snippet, ...match }) => {
        const pin = pins.get(match.conversation_id)!;
        return { ...match, source_version_id: pin.version, source_block_count: pin.blockCount, source_model: pin.model };
      });
      job.matches.push(...facts);
      job.bytes += Buffer.byteLength(JSON.stringify(facts));
      job.coverage.matched = job.pending.progress.matched = job.matches.length;
      if (!this.evict()) {
        this.fail(job, "metadata_limit");
        return;
      }
      this.publish(job);
      await yieldTurn();
    }
    if (!this.redactionCurrent(job))
      return;
    const matched = new Set(job.matches.map(match => match.conversation_id));
    job.pins = pinned.filter(pin => matched.has(pin.id));
    const pinBytes = Buffer.byteLength(JSON.stringify(job.pins));
    job.bytes += pinBytes - job.metrics.snapshot_pin_bytes;
    job.metrics.snapshot_pin_bytes = pinBytes;
    job.metrics.scan_ms = performance.now() - scanningStarted;
    if (job.matches.length >= stopAfter && job.coverage.scanned + job.coverage.failed < job.coverage.eligible)
      job.coverage.stopped = "match_limit";
    job.coverage.complete = job.coverage.failed === 0 && !job.coverage.stopped;
    job.complete = true;
    this.publish(job);
  }
}
const services = new WeakMap<Db, FullTextSearchJobs>();
export function getFullTextSearchJobs(db: Db): FullTextSearchJobs {
  let service = services.get(db);
  if (!service) {
    service = new FullTextSearchJobs(db, runtimes.get(db) ?? { publish() { }, async repair(id) { const { repairConversationSourceReadiness } = await import("../ingestion.js"); await repairConversationSourceReadiness(db, id); } });
    services.set(db, service);
  }
  return service;
}
