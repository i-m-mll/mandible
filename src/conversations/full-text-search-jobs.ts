import { createHash, randomUUID } from "node:crypto";
import { readSnapshot } from "../ledger-reads/snapshot.js";
import { readConversationSourceGenerations } from "./source-generation.js";
import { ConversationSourceStore } from "./source-store.js";
import { ConversationSourceReader } from "./source-reader.js";
import type { Db } from "../db.js";
import { getConversationSearchCache, SourceBackedConversationSearchSourceAdapter, type ConversationSearchMatch } from "./search-cache.js";
import { readConversationSourceReadiness } from "./source-readiness.js";
import { FULL_TEXT_SEARCH_OBSERVER_LEASE_MS, FULL_TEXT_SEARCH_RETRY_MS, type FullTextSearchCoverage, type FullTextSearchPending, type FullTextSearchReason, type FullTextSearchResponse, type FullTextSearchTerminal } from "./full-text-search-contract.js";
export type SearchQuery = Record<string, string | undefined>;
export type SearchRoute = "conversation_list" | "conversation_sidebar" | "conversation_search";
export class SearchSnapshotProjectionError extends Error {
  constructor(readonly reason: "query_mismatch" | "source_changed") { super(reason); }
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
export function fullTextQueryKey(route: string, query: SearchQuery): string {
  const normalizedQuery: SearchQuery = { ...query };
  const booleanFields = new Set(["full_text", "starred", "exclude_subagents", "group", "title"]);
  for (const field of booleanFields)
    if (normalizedQuery[field] !== undefined)
      normalizedQuery[field] = normalizedQuery[field] === "true" || normalizedQuery[field] === "1" ? "true" : "false";
  if (route === "conversation_search") {
    normalizedQuery.q = (query.q || query.query || "").trim().toLowerCase();
    normalizedQuery.source = query.source || query.provider;
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
function terminal(searchId: string, reason: FullTextSearchReason, coverage: FullTextSearchCoverage, state: FullTextSearchTerminal["state"] = "incomplete"): FullTextSearchTerminal {
  return { state, search_id: searchId, reason, coverage: { ...coverage, complete: false } };
}
interface Pin {
  id: string;
  version: string;
  authority?: string;
  observed?: string;
  blockCount?: number;
  model?: string | null;
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
  private fail(job: Job, reason: FullTextSearchReason, state?: FullTextSearchTerminal["state"]): void {
    if (job.terminal)
      return;
    job.terminal = terminal(job.id, reason, job.coverage, state);
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
      return this.response(terminal(query.search_id, "snapshot_expired", { eligible: 0, prepared: 0, scanned: 0, matched: 0, failed: 0, complete: false }, "expired"));
    if (!job) {
      const id = query.search_id || randomUUID();
      const queued = [...this.jobs.values()].filter(candidate => !candidate.complete && !candidate.terminal).length;
      if (queued >= 9)
        return this.response(terminal(id, "admission_full", { eligible: 0, prepared: 0, scanned: 0, matched: 0, failed: 0, complete: false }));
      const observer = query.observer_token || randomUUID();
      job = { id, key, pending: pendingSearch(id, observer), coverage: { eligible: 0, prepared: 0, scanned: 0, matched: 0, failed: 0, complete: false }, observers: new Map(), controller: new AbortController(), pins: [], matches: [], redaction: "", complete: false, accessed: Date.now(), bytes: 0, prepare, metrics: { preparation_ms: 0, scan_ms: 0, projection_ms: 0, paging_ms: 0, source_verification_ms: 0,snapshot_pin_bytes:0 } };
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
    if (!(await this.validate(job, new Set())))
      return this.response(job.terminal!);
    const pagingStarted = performance.now();
    let result: unknown;
    try {
      result = await job.plan!.render(job.matches, query, job.id);
    }
    catch (error) {
      const reason = error instanceof SearchSnapshotProjectionError ? error.reason : "source_changed";
      if (reason === "source_changed") {
        this.fail(job, reason, "superseded");
        return this.response(job.terminal!);
      }
      return this.response(terminal(job.id, reason, job.coverage, "superseded"));
    }
    const rendered = renderedConversationIds(result);
    if (!(await this.validate(job, rendered)))
      return this.response(job.terminal!);
    job.metrics.paging_ms += performance.now() - pagingStarted;
    return this.response({ ...result as object, search_metrics: { ...job.metrics,snapshot_metadata_bytes:job.bytes }, state: "complete", search_id: job.id, snapshot_id: job.id, coverage: { ...job.coverage, complete: true } });
  }
  private response(body: FullTextSearchResponse<Record<string, unknown>>): {
    status: number;
    json: string;
  } {
    return { status: body.state === "pending" ? 202 : body.state === "complete" ? 200 : 409, json: JSON.stringify(body) };
  }
  private async validate(job: Job, physicalIds?: ReadonlySet<string>): Promise<boolean> {
    if (job.terminal)
      return false;
    const versions = new Map(job.pins.map(pin => [pin.id, pin.version]));
    const metadata = () => readSnapshot(this.db, () => ({
      redaction: new SourceBackedConversationSearchSourceAdapter(this.db).redactionEpoch(),
      authorities:new ConversationSourceStore(this.db).searchSnapshotAuthorities(job.plan!.ids,versions),
      observed:readConversationSourceGenerations(this.db,job.plan!.ids),
      aliased: Boolean(this.db.prepare("SELECT 1 FROM conversation_identity_aliases WHERE alias_id IN (SELECT value FROM json_each(?)) LIMIT 1").get(JSON.stringify(job.plan!.ids))),
    }));
    const before = metadata();
    if (before.redaction !== job.redaction) {
      this.fail(job, "redaction_changed", "superseded");
      return false;
    }
    if (before.aliased || job.pins.some(pin => before.authorities.get(pin.id) !== pin.authority)) {
      this.fail(job, "source_changed", "superseded");
      return false;
    }
    const started = performance.now();
    for (let index = 0; index < job.pins.length; index++) {
      if (job.terminal)
        return false;
      const pin = job.pins[index];
      const current=before.observed.get(pin.id);
      if (!physicalIds || physicalIds.has(pin.id) || current !== pin.observed) {
        const proof = await this.reader.verifyVersion(pin.id, pin.version, job.controller.signal);
        if (job.terminal)
          return false;
        if (proof.status !== "source") {
          this.fail(job, proof.status === "unavailable" ? "source_unavailable" : "source_changed", "superseded");
          return false;
        }
      }
      if (index % 32 === 31)
        await yieldTurn();
    }
    if (job.terminal)
      return false;
    const after = metadata();
    if (after.redaction !== job.redaction) {
      this.fail(job, "redaction_changed", "superseded");
      return false;
    }
    if (after.aliased || job.pins.some(pin => {
      return after.authorities.get(pin.id)!==pin.authority||after.observed.get(pin.id)!==before.observed.get(pin.id);
    })) {
      this.fail(job, "source_changed", "superseded");
      return false;
    }
    for (const pin of job.pins)
      pin.observed = after.observed.get(pin.id);
    job.metrics.source_verification_ms += performance.now() - started;
    return !job.terminal;
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
        catch {
          if (!job.terminal)
            this.fail(job, "source_unavailable");
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
      let ready = readConversationSourceReadiness(this.db, id);
      if (ready.status === "repair_needed") {
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
        ready = readConversationSourceReadiness(this.db, id);
      }
      if (ready.status !== "ready" || !ready.sourceVersionId || !ready.sourcePath) {
        job.coverage.failed++;
        this.fail(job, "source_unavailable");
        return;
      }
      const pin = { id, version: ready.sourceVersionId };
      job.pins.push(pin);
      job.bytes += Buffer.byteLength(JSON.stringify(pin));
      if (!this.evict()) {
        this.fail(job, "metadata_limit");
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
        authorities:new ConversationSourceStore(this.db).searchSnapshotAuthorities(refreshed.ids),
        observed:readConversationSourceGenerations(this.db,refreshed.ids),
        normalization: this.db.prepare("SELECT id,block_count,model FROM conversations WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(refreshed.ids)) as Array<{
          id: string;
          block_count: number;
          model: string | null;
        }>,
        redaction: new SourceBackedConversationSearchSourceAdapter(this.db).redactionEpoch(),
      };
    });
    const prepared = new Map(job.pins.map(pin => [pin.id, pin]));
    if (snapshot.plan.ids.some(id => !prepared.has(id)) || snapshot.sources.some(source => source.status !== "ready" || !source.sourceVersionId)) {
      this.fail(job, "source_changed", "superseded");
      return;
    }
    plan = snapshot.plan;
    job.plan = plan;
    const normalization = new Map(snapshot.normalization.map(row => [row.id, row]));
    job.pins = snapshot.sources.map(source => ({ id: source.conversationId, version: source.sourceVersionId!, authority:snapshot.authorities.get(source.conversationId),observed:snapshot.observed.get(source.conversationId), blockCount: normalization.get(source.conversationId)!.block_count, model: normalization.get(source.conversationId)!.model }));
    for (const pin of job.pins)
      prepared.set(pin.id, pin);
    job.coverage.eligible = plan.ids.length;
    job.coverage.prepared = plan.ids.length;
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
    for (let index = 0; index < plan.ids.length; index += 4) {
      if (job.terminal)
        return;
      const ids = plan.ids.slice(index, index + 4);
      const results = await Promise.all(ids.map(id => cache.search({ conversationIds: [id], needle: plan.needle, blockType: plan.blockType, limit: 1, signal: job.controller.signal, expectedSourceVersions: { [id]: prepared.get(id)!.version }, expectedBlockCounts: { [id]: prepared.get(id)!.blockCount! }, expectedModels: { [id]: prepared.get(id)!.model ?? null } })));
      if (job.terminal)
        return;
      for (const result of results) {
        job.metrics.source_verification_ms += result.metrics.source_verification_ms;
        if (result.failures.length) {
          job.coverage.failed += result.failures.length;
          const changed = result.failures.some(failure => failure.status === "stale");
          this.fail(job, changed ? "source_changed" : "source_unavailable", changed ? "superseded" : "incomplete");
          return;
        }
        const facts = result.matches.map(({ snippet: _snippet, ...match }) => ({ ...match, source_version_id: prepared.get(match.conversation_id)!.version, source_block_count: prepared.get(match.conversation_id)!.blockCount!, source_model: prepared.get(match.conversation_id)!.model ?? null }));
        job.matches.push(...facts);
        job.bytes += Buffer.byteLength(JSON.stringify(facts));
      }
      job.coverage.scanned = job.pending.progress.scanned += ids.length;
      job.coverage.matched = job.pending.progress.matched = job.matches.length;
      if (!this.evict()) {
        this.fail(job, "metadata_limit");
        return;
      }
      this.publish(job);
      await yieldTurn();
    }
    if (!(await this.validate(job, new Set())))
      return;
    job.metrics.scan_ms = performance.now() - scanningStarted;
    job.complete = true;
    job.coverage.complete = true;
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
