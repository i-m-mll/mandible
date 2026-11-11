import { useEffect, useState } from 'preact/hooks';
import { getStorageKey, loadAnnotations, type Annotation } from 'agentation';
import {
  INTERFACE_NOTE_CHANGED_EVENT,
  interfaceNotePagePath,
  type InterfaceNote,
  type InterfaceNoteInput,
  type InterfaceNotePin,
} from '../../../src/interface-notes/contract';
import { servedBackendGeneration } from '../boot-instance';
import { readPersistedViewState, writePersistedViewState } from '../hooks/usePersistedViewState';
import { acquireSharedSse } from '../sse-shared';
import { agentationAttachment, agentationText } from './agentationAdapter';
import {
  createInterfaceNote,
  deleteUnfiledInterfaceNote,
  interfaceNoteWriteSettled,
  InterfaceNotesApiError,
  listIssueInterfaceNotes,
  listUnfiledInterfaceNotes,
  updateInterfaceNoteText,
} from './interfaceNotesApi';

/**
 * The browser's one authority for interface notes. The daemon holds every note;
 * Agentation's per-page local storage is a cache this store fills. Every toolbar
 * action is recorded here synchronously as a pending daemon write, so the cache
 * the store writes always agrees with what the toolbar shows, and the toolbar is
 * remounted only when the daemon's view of the current page differs from it.
 */

export type InterfaceNotesSnapshot = {
  ready: boolean;
  unfiled: InterfaceNote[];
  loadedIssue: { id: string; notes: InterfaceNote[] } | null;
  pendingWrites: number;
  epoch: number;
};

export type ReconcileResult = { ok: true } | { ok: false; error: string };

type PendingWrite =
  | { kind: 'create'; input: InterfaceNoteInput; at: number }
  | { kind: 'update'; text: string }
  | { kind: 'delete' };

type LoadedIssue = { id: string; dismissed: string[] };

/** Pins of one page as the toolbar holds them: note id to comment. */
type PageView = Map<string, string>;

const LOADED_KEY = 'mandible.agentation.loadedIssue:v1';
const PENDING_KEY = 'mandible.agentation.pending:v1';
const MIGRATED_KEY = 'mandible.agentation.migrated:v1';
const CACHE_PREFIX = getStorageKey('');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isPin = (value: unknown): value is InterfaceNotePin =>
  isRecord(value) && typeof value.id === 'string' && typeof value.comment === 'string';

function normalizeLoaded(value: unknown): LoadedIssue | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  return { id: value.id, dismissed: Array.isArray(value.dismissed) ? value.dismissed.filter((id): id is string => typeof id === 'string') : [] };
}

function normalizeWrite(value: unknown): PendingWrite | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'delete') return { kind: 'delete' };
  if (value.kind === 'update' && typeof value.text === 'string') return { kind: 'update', text: value.text };
  const input = value.input;
  if (value.kind === 'create' && typeof value.at === 'number' && isRecord(input)
      && typeof input.id === 'string' && typeof input.text === 'string' && isRecord(input.target) && isPin(input.pin)) {
    return { kind: 'create', at: value.at, input: input as unknown as InterfaceNoteInput };
  }
  return null;
}

function normalizePending(value: unknown): Array<[string, PendingWrite]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
    const write = normalizeWrite(entry[1]);
    return write ? [[entry[0], write] as [string, PendingWrite]] : [];
  });
}

let daemonUnfiled: InterfaceNote[] = [];
let daemonLoaded: { id: string; notes: InterfaceNote[] } | null = null;
let loaded: LoadedIssue | null = readPersistedViewState(LOADED_KEY, normalizeLoaded, null);
const pending = new Map<string, PendingWrite>(readPersistedViewState(PENDING_KEY, normalizePending, []));
/** Writes that have been tried and failed; restored writes failed in an earlier page. */
const failed = new Set<string>(pending.keys());
/** Notes this browser has filed. A filed note never becomes unfiled again, so a later toolbar delete of one is skipped. */
const filed = new Set<string>();
let view: Map<string, PageView> | null = null;
let ready = false;
let epoch = 0;
let snapshot: InterfaceNotesSnapshot = buildSnapshot();
const listeners = new Set<() => void>();

let chain: Promise<unknown> = Promise.resolve();
let queuedReconcile: Promise<ReconcileResult> | null = null;
let queuedFlush = false;

function overlay(notes: readonly InterfaceNote[]): InterfaceNote[] {
  return notes.flatMap((note) => {
    const write = pending.get(note.id);
    if (write?.kind === 'delete') return [];
    if (write?.kind === 'update' || write?.kind === 'create') {
      const text = write.kind === 'update' ? write.text : write.input.text;
      return [{ ...note, text }];
    }
    return [note];
  });
}

function unfiledNotes(): InterfaceNote[] {
  const held = new Set(daemonUnfiled.map((note) => note.id));
  const loadedIds = new Set(daemonLoaded?.notes.map((note) => note.id));
  const created = [...pending].flatMap(([id, write]): InterfaceNote[] => (
    write.kind === 'create' && !held.has(id) && !loadedIds.has(id) && !filed.has(id)
      ? [{ ...write.input, owner: { kind: 'unfiled' }, created_at: write.at, updated_at: write.at }]
      : []
  ));
  return [...overlay(daemonUnfiled), ...created].sort((a, b) => a.created_at - b.created_at);
}

function buildSnapshot(): InterfaceNotesSnapshot {
  return {
    ready,
    unfiled: unfiledNotes(),
    loadedIssue: daemonLoaded ? { id: daemonLoaded.id, notes: overlay(daemonLoaded.notes) } : null,
    pendingWrites: [...failed].filter((id) => pending.has(id)).length,
    epoch,
  };
}

function emit(): void {
  snapshot = buildSnapshot();
  listeners.forEach((listener) => listener());
}

function persistPending(): boolean {
  return writePersistedViewState(PENDING_KEY, [...pending]);
}

function persistLoaded(): void {
  writePersistedViewState(LOADED_KEY, loaded);
}

function cachedPageKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(CACHE_PREFIX)) keys.push(key);
  }
  return keys;
}

function readCache(): Map<string, Annotation[]> {
  return new Map(cachedPageKeys().map((key) => {
    const path = key.slice(CACHE_PREFIX.length);
    return [path, loadAnnotations<Annotation>(path).filter(isPin)];
  }));
}

function viewOf(cache: Map<string, Array<{ id: string; comment: string }>>): Map<string, PageView> {
  return new Map([...cache].map(([path, pins]) => [path, new Map(pins.map((pin) => [pin.id, pin.comment]))]));
}

function currentView(): Map<string, PageView> {
  view ??= viewOf(readCache());
  return view;
}

function samePage(a: PageView | undefined, b: PageView | undefined): boolean {
  const left = a ?? new Map<string, string>();
  const right = b ?? new Map<string, string>();
  return left.size === right.size && [...left].every(([id, comment]) => right.get(id) === comment);
}

function cachePin(note: InterfaceNote): InterfaceNotePin {
  const { timestamp: _timestamp, ...pin } = note.pin;
  return { ...pin, comment: note.text };
}

function desiredCache(): Map<string, InterfaceNotePin[]> {
  const dismissed = new Set(loaded?.dismissed);
  const shown = [
    ...unfiledNotes(),
    ...(daemonLoaded ? overlay(daemonLoaded.notes).filter((note) => !dismissed.has(note.id)) : []),
  ].sort((a, b) => a.created_at - b.created_at);
  const pages = new Map<string, InterfaceNotePin[]>();
  for (const note of shown) {
    const path = interfaceNotePagePath(note);
    pages.set(path, [...(pages.get(path) ?? []), cachePin(note)]);
  }
  return pages;
}

/** Writes every page's cache and returns whether the current page's pins differ from what the toolbar shows. */
function writeCache(): boolean {
  const desired = desiredCache();
  const next = viewOf(desired);
  const path = window.location.pathname;
  const changed = !samePage(currentView().get(path), next.get(path));
  for (const key of cachedPageKeys()) {
    if (!desired.has(key.slice(CACHE_PREFIX.length))) window.localStorage.removeItem(key);
  }
  for (const [page, pins] of desired) window.localStorage.setItem(getStorageKey(page), JSON.stringify(pins));
  view = next;
  return changed;
}

function noteInput(annotation: Annotation, pageUrl: string, revision: string | null): InterfaceNoteInput {
  const { target } = agentationAttachment(annotation, 1, pageUrl, { width: window.innerWidth, height: window.innerHeight });
  return { id: annotation.id, text: agentationText(annotation), target: revision ? { ...target, revision } : target, pin: annotation };
}

/** The notes in this browser's toolbar cache before the daemon held notes are uploaded once. */
function migrateOnce(): void {
  if (readPersistedViewState(MIGRATED_KEY, (value) => value === true, false)) return;
  for (const [path, annotations] of readCache()) {
    for (const annotation of annotations) {
      if (pending.has(annotation.id)) continue;
      const pageUrl = annotation.url || new URL(path, window.location.origin).href;
      pending.set(annotation.id, { kind: 'create', input: noteInput(annotation, pageUrl, null), at: annotation.timestamp || Date.now() });
    }
  }
  if (persistPending()) writePersistedViewState(MIGRATED_KEY, true);
}

type Outcome = 'done' | 'failed' | 'owner_changed';

async function send(id: string, write: PendingWrite): Promise<Outcome> {
  try {
    if (write.kind === 'create') {
      // The daemon's record replaces the pending create at once, so the note is not missing until the next reconciliation.
      const note = await createInterfaceNote(write.input);
      daemonUnfiled = [...daemonUnfiled.filter((held) => held.id !== id), note];
    }
    else if (write.kind === 'update') {
      const note = await updateInterfaceNoteText(id, write.text);
      if (note.owner.kind !== 'unfiled' && !isLoadedNote(id)) return 'owner_changed';
    } else await deleteUnfiledInterfaceNote(id);
    return 'done';
  } catch (error) {
    if (interfaceNoteWriteSettled(error)) {
      return error instanceof InterfaceNotesApiError && error.code === 'note_filed' ? 'owner_changed' : 'done';
    }
    console.error('Interface note write failed; it stays pending.', error);
    return 'failed';
  }
}

/** Sends every pending write; returns whether a response showed an owner this browser did not expect. */
async function flushPending(): Promise<boolean> {
  let ownerChanged = false;
  for (const id of [...pending.keys()]) {
    for (let write = pending.get(id); write; write = pending.get(id)) {
      const outcome = await send(id, write);
      if (outcome === 'failed') {
        failed.add(id);
        break;
      }
      ownerChanged ||= outcome === 'owner_changed';
      const latest = pending.get(id);
      if (latest === write) {
        pending.delete(id);
        failed.delete(id);
        persistPending();
        break;
      }
      // The toolbar changed the note while this write was in flight; the newer write is sent next.
      // An edit coalesced into a create that has now landed is an update.
      if (write.kind === 'create' && latest?.kind === 'create') pending.set(id, { kind: 'update', text: latest.input.text });
      persistPending();
    }
  }
  emit();
  return ownerChanged;
}

function scheduleFlush(): void {
  if (queuedFlush) return;
  queuedFlush = true;
  chain = chain.then(async () => {
    queuedFlush = false;
    if (await flushPending()) void reconcile();
  }).catch((error: unknown) => console.error('Interface notes write replay failed.', error));
}

async function runReconcile(): Promise<ReconcileResult> {
  let result: ReconcileResult = { ok: true };
  try {
    migrateOnce();
    await flushPending();
    const issue = loaded?.id ?? null;
    const [unfiled, issueNotes] = await Promise.all([
      listUnfiledInterfaceNotes(),
      issue ? listIssueInterfaceNotes(issue) : Promise.resolve(null),
    ]);
    daemonUnfiled = unfiled.filter((note) => !filed.has(note.id));
    daemonLoaded = issue && issueNotes && loaded?.id === issue ? { id: issue, notes: issueNotes } : null;
    if (writeCache()) epoch += 1;
  } catch (error) {
    // The caches and pending writes are left as they were; the next reconciliation retries.
    console.error('Interface notes reconciliation failed.', error);
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  ready = true;
  emit();
  return result;
}

/** Fetches the daemon's notes, replays pending writes and refills the toolbar's cache. Concurrent requests share one queued run. */
export function reconcile(): Promise<ReconcileResult> {
  if (queuedReconcile) return queuedReconcile;
  const run = chain.then(() => {
    queuedReconcile = null;
    return runReconcile();
  });
  queuedReconcile = run;
  chain = run;
  return run;
}

function record(id: string, write: PendingWrite): void {
  pending.delete(id);
  pending.set(id, write);
  persistPending();
}

function pageViewHolding(id: string): PageView | undefined {
  return [...currentView().values()].find((page) => page.has(id));
}

function isLoadedNote(id: string): boolean {
  return Boolean(daemonLoaded?.notes.some((note) => note.id === id));
}

function dismiss(ids: readonly string[]): void {
  if (!loaded || !ids.length) return;
  loaded = { ...loaded, dismissed: [...new Set([...loaded.dismissed, ...ids])] };
  persistLoaded();
}

function removeFromToolbar(id: string): boolean {
  pageViewHolding(id)?.delete(id);
  if (isLoadedNote(id)) {
    dismiss([id]);
    return false;
  }
  if (filed.has(id)) return false;
  record(id, { kind: 'delete' });
  return true;
}

export function recordAdd(annotation: Annotation): void {
  const path = window.location.pathname;
  const pages = currentView();
  pages.set(path, new Map(pages.get(path)).set(annotation.id, annotation.comment));
  record(annotation.id, { kind: 'create', input: noteInput(annotation, window.location.href, servedBackendGeneration()), at: Date.now() });
  emit();
  scheduleFlush();
}

export function recordUpdate(annotation: Annotation): void {
  pageViewHolding(annotation.id)?.set(annotation.id, annotation.comment);
  const text = agentationText(annotation);
  const write = pending.get(annotation.id);
  if (write?.kind === 'create') record(annotation.id, { ...write, input: { ...write.input, text, pin: annotation } });
  else record(annotation.id, { kind: 'update', text });
  emit();
  scheduleFlush();
}

export function recordDelete(annotation: Annotation): void {
  removeFromToolbar(annotation.id);
  emit();
  scheduleFlush();
}

export function recordClear(annotations: Annotation[]): void {
  for (const annotation of annotations) removeFromToolbar(annotation.id);
  emit();
  scheduleFlush();
}

/** Called by the Send menu with the ids the daemon reports filed, before it reconciles. */
export function markFiled(ids: readonly string[]): void {
  for (const id of ids) filed.add(id);
  daemonUnfiled = daemonUnfiled.filter((note) => !filed.has(note.id));
  emit();
}

/** Loads one issue's notes as pins (replacing any loaded issue), or unloads with null. */
export function setLoadedIssue(issueId: string | null): Promise<ReconcileResult> {
  loaded = issueId ? { id: issueId, dismissed: [] } : null;
  persistLoaded();
  if (!loaded) daemonLoaded = null;
  emit();
  return reconcile();
}

export function getInterfaceNotesSnapshot(): InterfaceNotesSnapshot {
  return snapshot;
}

export function subscribeInterfaceNotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInterfaceNotes(): InterfaceNotesSnapshot {
  const [value, setValue] = useState(getInterfaceNotesSnapshot);
  useEffect(() => {
    setValue(getInterfaceNotesSnapshot());
    return subscribeInterfaceNotes(() => setValue(getInterfaceNotesSnapshot()));
  }, []);
  return value;
}

/** Runs the boot reconciliation and keeps the store reconciled with the daemon's events; returns the stop function. */
export function startInterfaceNotes(): () => void {
  const events = acquireSharedSse();
  events.on(INTERFACE_NOTE_CHANGED_EVENT, () => void reconcile());
  events.onState((state, meta) => {
    if (state === 'open' && meta.reconnected) void reconcile();
  });
  events.connect();
  void reconcile();
  return () => events.close();
}
