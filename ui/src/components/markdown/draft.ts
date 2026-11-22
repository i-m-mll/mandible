export type DocumentRevision = { source: string; generation: number };
export type DocumentDraft = { base: DocumentRevision; source: string };
export type DocumentSave = { kind: 'saved' | 'conflict'; document: DocumentRevision };

export class DocumentDraftControl {
  base: DocumentRevision;
  latest: DocumentRevision;
  source: string;
  pending: Promise<DocumentRevision | null> | null = null;

  constructor(saved: DocumentRevision, draft?: DocumentDraft) {
    this.base = draft?.base ?? saved;
    this.latest = saved;
    this.source = draft?.source ?? saved.source;
    this.observe(saved);
  }

  get dirty() { return this.source !== this.base.source || this.pending !== null; }
  get conflict() { return this.dirty && this.latest.generation > this.base.generation; }

  observe(document: DocumentRevision) {
    if (document.generation < this.latest.generation) return;
    const accept = !this.dirty || this.source === document.source;
    this.latest = document;
    if (accept) {
      this.base = document;
      this.source = document.source;
    }
  }

  acceptRemote() {
    this.base = this.latest;
    this.source = this.latest.source;
  }

  save(write: (draft: DocumentDraft) => Promise<DocumentSave>): Promise<DocumentRevision | null> {
    if (this.pending) return this.pending;
    if (this.conflict) return Promise.resolve(null);
    if (!this.dirty) return Promise.resolve(this.base);
    const attempted = { base: this.base, source: this.source };
    this.pending = Promise.resolve().then(() => write(attempted)).then(({ kind, document }) => {
      if (kind === 'saved' && document.generation >= this.base.generation) this.base = document;
      this.observe(document);
      return kind === 'saved' && this.latest.generation === document.generation ? document : null;
    }).finally(() => {
      this.pending = null;
      if (!this.dirty && this.latest.generation > this.base.generation) this.acceptRemote();
    });
    return this.pending;
  }
}
