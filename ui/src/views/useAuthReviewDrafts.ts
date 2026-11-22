import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  REVIEW_EDIT_MAX_BYTES, type RequestReviewDraft, type ReviewDraftMutation, type ReviewDraftStamp,
} from '../../../src/feedback/request-draft-types';
import type { DiffFilePair } from '../../../src/contracts';
import { getAuthReview, isApiErrorStatus, mutateAuthReviewDraft, type AuthReviewProjection } from '../api';
import { DocumentDraftControl, type DocumentRevision } from '../components/markdown/draft';

type Entry = {
  path: string;
  head: string;
  control: DocumentDraftControl;
  editing?: boolean;
  externalVersion: number;
  timer?: ReturnType<typeof setTimeout>;
  error?: string;
  acting?: boolean;
};

export type AuthReviewFileDraft = {
  path: string;
  source: string;
  editing: boolean;
  edited: boolean;
  writable: boolean;
  externalVersion: number;
  mergeConflict: RequestReviewDraft['conflict'];
  writeConflict: boolean;
  error?: string;
  busy: boolean;
  toggle: () => void;
  change: (text: string) => void;
  resolve: () => void;
  revert: () => void;
  keepLocal: () => void;
  acceptRemote: () => void;
};

class ReviewDraftSession {
  rows = new Map<string, RequestReviewDraft>();
  entries = new Map<string, Entry>();
  projection: AuthReviewProjection | null = null;
  available = false;

  constructor(private id: string, private render: () => void) {}

  private revision(entry: Entry): DocumentRevision {
    const row = this.rows.get(entry.path);
    return { source: row?.text ?? entry.head, generation: row?.generation ?? 0 };
  }

  private observe(rows: RequestReviewDraft[]) {
    for (const row of rows) {
      if (row.generation < (this.rows.get(row.path)?.generation ?? 0)) continue;
      this.rows.set(row.path, row);
    }
  }

  receive(projection: AuthReviewProjection | null, available: boolean) {
    this.projection = projection;
    this.available = available;
    if (projection) this.observe(projection.drafts);
    for (const entry of this.entries.values()) {
      const text = entry.control.source;
      entry.control.observe(this.revision(entry));
      if (text !== entry.control.source) entry.externalVersion += 1;
    }
  }

  private async write(entry: Entry, base: DocumentRevision, mutation: ReviewDraftMutation) {
    const projection = this.projection;
    if (!projection) throw new Error('Review revision unavailable.');
    try {
      const row = await mutateAuthReviewDraft(this.id, projection, entry.path, base.generation, mutation);
      this.observe([row]);
      return { kind: 'saved' as const, document: { source: row.text ?? entry.head, generation: row.generation } };
    } catch (error) {
      if (isApiErrorStatus(error, 409)) {
        const current = await getAuthReview(this.id);
        if (current.round.id === projection.round.id) {
          this.observe(current.drafts);
          const document = this.revision(entry);
          if (document.generation > base.generation) return { kind: 'conflict' as const, document };
        }
      }
      throw error;
    }
  }

  private schedule(entry: Entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.flushEntry(entry).catch(() => undefined); }, 350);
  }

  private async flushEntry(entry: Entry) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    try {
      while (!entry.control.conflict && entry.control.dirty) {
        const saved = await entry.control.save(({ base, source }) => this.write(entry, base, { operation: 'save', text: source }));
        if (!saved) break;
      }
      if (entry.control.conflict) throw new Error('Review draft changed in another editor.');
      entry.error = undefined;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.render();
    }
  }

  async flush(): Promise<ReviewDraftStamp[]> {
    if ([...this.entries.values()].some(entry => entry.acting)) throw new Error('A review draft is being saved.');
    await Promise.all([...this.entries.values()].map(entry => this.flushEntry(entry)));
    return [...this.rows.values()].map(({ path, generation }) => ({ path, generation }));
  }

  finish() {
    for (const entry of this.entries.values()) {
      if (entry.timer) void this.flushEntry(entry).catch(() => undefined);
    }
  }

  private async act(entry: Entry, operation: 'revert' | 'resolve') {
    if (entry.acting || !this.available) return;
    entry.acting = true;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    this.render();
    try {
      if (entry.control.pending) await entry.control.pending;
      if (entry.control.conflict) throw new Error('Review draft changed in another editor.');
      const source = entry.control.source;
      const saved = await this.write(entry, entry.control.base, operation === 'revert' ? { operation } : { operation, text: source });
      if (saved.kind === 'conflict') {
        entry.control.observe(saved.document);
        throw new Error('Review draft changed in another editor.');
      }
      entry.control = new DocumentDraftControl(saved.document);
      if (source !== saved.document.source) entry.externalVersion += 1;
      entry.error = undefined;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    } finally {
      entry.acting = false;
      this.render();
    }
  }

  file(path: string, head: string): AuthReviewFileDraft {
    let entry = this.entries.get(path);
    if (!entry) {
      const row = this.rows.get(path);
      entry = { path, head, control: new DocumentDraftControl({ source: row?.text ?? head, generation: row?.generation ?? 0 }), externalVersion: 0 };
      this.entries.set(path, entry);
    }
    const state = entry;
    const row = this.rows.get(path);
    const edited = row?.text != null || state.control.dirty;
    const writable = this.available && !state.acting && row?.conflict !== 'detached';
    return {
      path, source: state.control.source, edited, writable, externalVersion: state.externalVersion,
      editing: (state.editing ?? row?.conflict === 'overlap') || !this.available && edited,
      mergeConflict: row?.conflict ?? null, writeConflict: state.control.conflict,
      error: state.error, busy: Boolean(state.acting),
      toggle: () => {
        state.editing = !(state.editing ?? row?.conflict === 'overlap');
        if (!state.editing) void this.flushEntry(state).catch(() => undefined);
        this.render();
      },
      change: (text: string) => {
        if (!writable) return;
        state.control.source = text;
        state.error = undefined;
        this.schedule(state);
        this.render();
      },
      resolve: () => { void this.act(state, 'resolve'); },
      revert: () => { void this.act(state, 'revert'); },
      keepLocal: () => {
        const source = state.control.source;
        state.control.acceptRemote();
        state.control.source = source;
        void this.flushEntry(state).catch(() => undefined);
      },
      acceptRemote: () => {
        state.control.acceptRemote();
        state.externalVersion += 1;
        state.error = undefined;
        this.render();
      },
    };
  }
}

function withinReviewLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= REVIEW_EDIT_MAX_BYTES;
}

export function useAuthReviewDrafts(id: string, review: AuthReviewProjection | null, available: boolean) {
  const [, redraw] = useState(0);
  const session = useMemo(() => new ReviewDraftSession(id, () => redraw(revision => revision + 1)), [id, review?.frozen_head]);
  const projection = review?.round.owner.auth_request_id === id ? review : null;
  session.receive(projection, available && Boolean(projection));
  useEffect(() => () => session.finish(), [session]);
  const forFile = (index: number, pair: Extract<DiffFilePair, { kind: 'text' }>) => {
    const eligible = projection?.editable_files.find(file => file.index === index);
    if (!eligible || !withinReviewLimit(pair.before.contents) || !withinReviewLimit(pair.after.contents)) return null;
    const row = session.rows.get(eligible.path);
    if (row?.conflict === 'detached' || !available && row?.text == null && !session.entries.has(eligible.path)) return null;
    return session.file(eligible.path, pair.after.contents);
  };
  return {
    forFile,
    fileStatus: (path: string | null) => {
      if (!path) return null;
      const row = session.rows.get(path);
      const control = session.entries.get(path)?.control;
      if (row?.conflict || control?.conflict) return 'conflict';
      return row?.text != null || control?.dirty ? 'draft' : null;
    },
    detached: [...session.rows.values()].filter(row => row.conflict === 'detached').map(row => session.file(row.path, '')),
    flush: () => session.flush(),
    hasEdits: [...session.rows.values()].some(row => row.text !== null) ||
      [...session.entries.values()].some(entry => entry.control.dirty),
    hasConflicts: [...session.rows.values()].some(row => row.conflict !== null) ||
      [...session.entries.values()].some(entry => entry.control.conflict),
  };
}
