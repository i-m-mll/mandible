import type { DocumentDraft } from '../../components/markdown/draft';
import type { MarkdownSourceRange } from '../../components/MarkdownDocument';

const draftPrefix = 'mandible.spaces.document';
const legacyPrefix = 'mandible.spaces.blockEditor';
const readJson = (storage: Storage, key: string): unknown => {
  const value = storage.getItem(key);
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return null; }
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class SpaceDocumentRecovery {
  readonly #local: Storage;
  readonly #session: Storage;
  readonly #key: string;
  readonly #legacyKey: string;
  readonly #previous: { id: string; draft: DocumentDraft } | undefined;
  #id: string | undefined;

  constructor(projectId: string, spaceId: string) {
    this.#local = localStorage;
    this.#session = sessionStorage;
    const scope = `${projectId || '_'}:${spaceId}`;
    this.#key = `${draftPrefix}:${scope}`;
    this.#legacyKey = `${legacyPrefix}:${scope}`;
    const id = this.#session.getItem(this.#key);
    if (!id) return;
    const value = record(readJson(this.#local, this.#draftKey(id)));
    const base = record(value.base);
    if (typeof value.source === 'string' && typeof base.source === 'string'
      && typeof base.generation === 'number' && Number.isSafeInteger(base.generation)) {
      this.#previous = { id, draft: { base: { source: base.source, generation: base.generation }, source: value.source } };
    }
  }

  get draft() { return this.#previous?.draft; }

  persist(draft: DocumentDraft) {
    const id = this.#id ??= crypto.randomUUID();
    this.#local.setItem(this.#draftKey(id), JSON.stringify(draft));
    this.#session.setItem(this.#key, id);
  }

  clearDraft(saved = false) {
    const previous = this.#previous?.id;
    const id = this.#id;
    const pointed = this.#session.getItem(this.#key);
    if (pointed === previous || pointed === id) this.#session.removeItem(this.#key);
    if (id) this.#local.removeItem(this.#draftKey(id));
    if (previous && saved) this.#local.removeItem(this.#draftKey(previous));
  }

  get position(): { range: MarkdownSourceRange | null; scroll: number; commentsOpen: boolean } {
    const { start, end, scroll, commentsOpen } = record(readJson(this.#session, this.#key + ':position'));
    return { range: typeof start === 'number' && typeof end === 'number' ? { start, end } : null,
      scroll: typeof scroll === 'number' && scroll >= 0 ? scroll : 0, commentsOpen: commentsOpen === true };
  }

  setPosition(range: MarkdownSourceRange, scroll: number, commentsOpen: boolean) {
    this.#session.setItem(this.#key + ':position', JSON.stringify({ start: range.start, end: range.end, scroll, commentsOpen }));
  }

  get legacy() {
    const state = record(readJson(this.#local, this.#legacyKey));
    const drafts = new Map(Object.entries(record(state.drafts)).flatMap(([id, value]) =>
      typeof value === 'string' ? [[id, value] as const] : []));
    return { editingId: typeof state.editingId === 'string' ? state.editingId : null, drafts };
  }

  finishLegacy(id: string, markdown: string) {
    const { editingId, drafts } = this.legacy;
    if (drafts.get(id) !== markdown) return;
    drafts.delete(id);
    if (drafts.size === 0) this.#local.removeItem(this.#legacyKey);
    else this.#local.setItem(this.#legacyKey, JSON.stringify({ editingId, drafts: Object.fromEntries(drafts) }));
  }

  #draftKey(id: string) { return `${this.#key}:draft:${id}`; }
}
