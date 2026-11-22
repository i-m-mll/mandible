import type { Db } from "../db.js";
import { captureSavedSpaceSource, getSpaceDocument } from "../spaces/document-store.js";
import {
  appendStandingNote, listStandingNotes, mutateStandingNote, type StandingNoteMutation,
} from "./standing-notes.js";
import { reviewRangeMatches } from "./review-ranges.js";
import type { ReviewRange, StandingNote, StandingSourceReference } from "./review-types.js";

export type SpaceReview = { generation: number; notes: StandingNote[] };

const spaceDocumentKey = (spaceId: string) => `space:${spaceId}`;

function reviewSource(spaceId: string, generation: number, source: string) {
  return { documentKey: spaceDocumentKey(spaceId), order: generation, source, rangeKind: 'text' as const };
}

export function readSpaceReview(db: Db, spaceId: string, actorUserId?: string): SpaceReview {
  return db.transaction(() => {
    const { source, generation } = getSpaceDocument(db, spaceId);
    const resolve = (reference: StandingSourceReference) => {
      if (reference.kind !== 'space_saved_source') return null;
      const saved = db.prepare(`SELECT content FROM space_document_history
        WHERE id=? AND space_id=? AND generation=? AND kind='saved-source'`)
        .get(reference.history_id, spaceId, reference.generation) as { content: string } | undefined;
      return saved ? { ...reviewSource(spaceId, reference.generation, saved.content), reference } : null;
    };
    return { generation, notes: listStandingNotes(db, reviewSource(spaceId, generation, source), resolve, actorUserId) };
  }).deferred();
}

export function addSpaceNote(db: Db, spaceId: string, actorUserId: string, generation: number, range: ReviewRange, body: string) {
  return db.transaction(() => {
    const current = getSpaceDocument(db, spaceId);
    if (current.generation !== generation) return { ok: false as const, reason: 'stale_document' };
    if (!reviewRangeMatches(current.source, range, 'text')) return { ok: false as const, reason: 'quote_mismatch' };
    const result = captureSavedSpaceSource(db, spaceId, generation);
    if (!result.ok) return { ok: false as const, reason: 'stale_document' };
    return appendStandingNote(db, {
      ...reviewSource(spaceId, generation, result.capture.content),
      reference: { kind: 'space_saved_source', history_id: result.capture.id, generation },
    }, actorUserId, range, body);
  })();
}

export function updateSpaceNote(db: Db, spaceId: string, actorUserId: string, noteId: string, mutation: StandingNoteMutation) {
  return mutateStandingNote(db, spaceDocumentKey(spaceId), actorUserId, noteId, mutation);
}
