// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from 'agentation';
import { INTERFACE_NOTE_ERRORS, type InterfaceNote, type InterfaceNoteInput } from '../src/interface-notes/contract';

/** A daemon holding notes with the refusals of INTERFACE_NOTE_ERRORS; `down` makes every call fail. */
const daemon = vi.hoisted(() => ({
  notes: new Map<string, InterfaceNote>(),
  down: false,
  writes: [] as string[],
}));

vi.mock('../ui/src/client-auth-token', () => ({
  browserSessionFetch: async (input: string, init: RequestInit = {}): Promise<Response> => {
    const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
    const refuse = (code: keyof typeof INTERFACE_NOTE_ERRORS) => reply(INTERFACE_NOTE_ERRORS[code], { error: code });
    if (daemon.down) return reply(503, { error: 'unavailable' });
    const url = new URL(input, 'http://mandible.test');
    const method = init.method ?? 'GET';
    const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    if (method !== 'GET') daemon.writes.push(`${method} ${id}`);
    if (method === 'GET') {
      const issue = url.searchParams.get('issue');
      return reply(200, { notes: [...daemon.notes.values()].filter((note) => (
        issue ? note.owner.kind === 'comment' && note.owner.issue_id === issue : note.owner.kind === 'unfiled'
      )) });
    }
    if (method === 'POST') {
      const input = JSON.parse(String(init.body)) as InterfaceNoteInput;
      if (daemon.notes.has(input.id)) return refuse('note_exists');
      const note: InterfaceNote = { ...input, owner: { kind: 'unfiled' }, created_at: Date.now(), updated_at: Date.now() };
      daemon.notes.set(input.id, note);
      return reply(201, note);
    }
    const note = daemon.notes.get(id);
    if (!note) return refuse('note_not_found');
    if (method === 'PATCH') {
      const updated = { ...note, text: (JSON.parse(String(init.body)) as { text: string }).text };
      daemon.notes.set(id, updated);
      return reply(200, updated);
    }
    if (note.owner.kind !== 'unfiled') return refuse('note_filed');
    daemon.notes.delete(id);
    return reply(204);
  },
}));

const DAY = 24 * 60 * 60 * 1000;
const origin = window.location.origin;

function annotation(id: string, comment: string, extra: Partial<Annotation> = {}): Annotation {
  return { id, x: 10, y: 20, comment, element: 'button', elementPath: 'main > button', timestamp: Date.now(), url: window.location.href, ...extra };
}

function daemonNote(id: string, text: string, path: string, owner: InterfaceNote['owner'], createdAt = Date.now()): InterfaceNote {
  return {
    id, text, owner, created_at: createdAt, updated_at: createdAt,
    target: { url: `${origin}${path}`, rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 800, height: 600 } },
    pin: { ...annotation(id, text, { url: `${origin}${path}` }), timestamp: createdAt },
  };
}

const filedOn = (issue: string): InterfaceNote['owner'] => ({ kind: 'comment', issue_id: issue, comment_id: `${issue}-c1` });

async function load() {
  const store = await import('../ui/src/annotation/interfaceNotesStore');
  const agentation = await import('agentation');
  /** What the toolbar reads when it mounts on, or navigates to, a page. */
  const toolbarPins = (path: string) => agentation.loadAnnotations(path).map((pin) => [pin.id, pin.comment]);
  return { store, toolbarPins };
}

describe('interface notes store', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/issues');
    daemon.notes.clear();
    daemon.down = false;
    daemon.writes = [];
  });

  it('shows every daemon note on its own page, including one older than seven days, and removes pages that have none', async () => {
    daemon.notes.set('old', daemonNote('old', 'Eight days old', '/settings', { kind: 'unfiled' }, Date.now() - 8 * DAY));
    daemon.notes.set('new', daemonNote('new', 'Fresh', '/issues', { kind: 'unfiled' }));
    window.localStorage.setItem('mandible.agentation.migrated:v1', 'true');
    window.localStorage.setItem('feedback-annotations-/timeline', JSON.stringify([annotation('stale', 'Deleted elsewhere')]));
    const { store, toolbarPins } = await load();

    expect(await store.reconcile()).toEqual({ ok: true });

    expect(toolbarPins('/settings')).toEqual([['old', 'Eight days old']]);
    expect(toolbarPins('/issues')).toEqual([['new', 'Fresh']]);
    expect(window.localStorage.getItem('feedback-annotations-/timeline')).toBeNull();
    expect(daemon.writes).toEqual([]);
    expect(store.getInterfaceNotesSnapshot().unfiled.map((note) => note.id)).toEqual(['old', 'new']);
  });

  it('uploads the notes already in the toolbar cache once', async () => {
    window.localStorage.setItem('feedback-annotations-/issues', JSON.stringify([annotation('legacy', 'Made before the daemon held notes')]));
    let { store } = await load();
    await store.reconcile();
    expect(daemon.notes.get('legacy')?.text).toBe('Made before the daemon held notes');

    daemon.notes.delete('legacy');
    vi.resetModules();
    ({ store } = await load());
    window.localStorage.setItem('feedback-annotations-/issues', JSON.stringify([annotation('legacy', 'Made before the daemon held notes')]));
    await store.reconcile();
    expect(daemon.notes.has('legacy')).toBe(false);
    expect(window.localStorage.getItem('feedback-annotations-/issues')).toBeNull();
  });

  it('keeps a write made while the daemon is unreachable in the toolbar and replays it in a later page', async () => {
    window.localStorage.setItem('mandible.agentation.migrated:v1', 'true');
    let { store, toolbarPins } = await load();
    await store.reconcile();
    daemon.down = true;
    store.recordAdd(annotation('offline', 'Made offline'));
    expect((await store.reconcile()).ok).toBe(false);
    expect(store.getInterfaceNotesSnapshot().pendingWrites).toBe(1);

    daemon.down = false;
    vi.resetModules();
    ({ store, toolbarPins } = await load());
    expect(store.getInterfaceNotesSnapshot().pendingWrites).toBe(1);
    expect(await store.reconcile()).toEqual({ ok: true });
    expect(daemon.notes.get('offline')?.text).toBe('Made offline');
    expect(store.getInterfaceNotesSnapshot().pendingWrites).toBe(0);
    expect(toolbarPins('/issues')).toEqual([['offline', 'Made offline']]);

    // A replay of a create the daemon already holds is done, not retried.
    store.recordAdd(annotation('offline', 'Made offline'));
    await store.reconcile();
    expect(store.getInterfaceNotesSnapshot().pendingWrites).toBe(0);
  });

  it('writes the toolbar’s edits and deletes to the daemon and remounts only for changes made elsewhere', async () => {
    window.localStorage.setItem('mandible.agentation.migrated:v1', 'true');
    const { store, toolbarPins } = await load();
    await store.reconcile();
    const epoch = store.getInterfaceNotesSnapshot().epoch;

    store.recordAdd(annotation('a', 'First'));
    store.recordAdd(annotation('b', 'Second'));
    store.recordUpdate(annotation('a', 'First, edited'));
    store.recordDelete(annotation('b', 'Second'));
    await store.reconcile();
    expect([...daemon.notes.values()].map((note) => [note.id, note.text])).toEqual([['a', 'First, edited']]);
    expect(store.getInterfaceNotesSnapshot().epoch).toBe(epoch);

    daemon.notes.set('elsewhere', daemonNote('elsewhere', 'From another browser', '/issues', { kind: 'unfiled' }));
    await store.reconcile();
    expect(store.getInterfaceNotesSnapshot().epoch).toBe(epoch + 1);
    expect(toolbarPins('/issues').map(([id]) => id)).toEqual(['a', 'elsewhere']);

    daemon.notes.set('a', { ...daemon.notes.get('a')!, owner: filedOn('i2') });
    store.recordDelete(annotation('a', 'First, edited'));
    await store.reconcile();
    expect(daemon.notes.get('a')?.owner).toEqual(filedOn('i2'));
  });

  it('shows a loaded issue’s pins, edits its notes, and leaves the issue unchanged on delete and Clear', async () => {
    window.localStorage.setItem('mandible.agentation.migrated:v1', 'true');
    daemon.notes.set('f1', daemonNote('f1', 'Filed one', '/settings', filedOn('i1')));
    daemon.notes.set('f2', daemonNote('f2', 'Filed two', '/settings', filedOn('i1')));
    const { store, toolbarPins } = await load();
    await store.setLoadedIssue('i1');
    expect(toolbarPins('/settings')).toEqual([['f1', 'Filed one'], ['f2', 'Filed two']]);

    window.history.replaceState(null, '', '/settings');
    store.recordUpdate(annotation('f1', 'Filed one, revised'));
    store.recordDelete(annotation('f2', 'Filed two'));
    await store.reconcile();
    store.recordClear([annotation('f1', 'Filed one, revised')]);
    await store.reconcile();

    expect(daemon.notes.get('f1')).toMatchObject({ text: 'Filed one, revised', owner: filedOn('i1') });
    expect(daemon.notes.get('f2')?.owner).toEqual(filedOn('i1'));
    expect(daemon.writes).toEqual(['PATCH f1']);
    expect(toolbarPins('/settings')).toEqual([]);

    vi.resetModules();
    const reloaded = await load();
    await reloaded.store.reconcile();
    expect(reloaded.store.getInterfaceNotesSnapshot().loadedIssue?.id).toBe('i1');
    await reloaded.store.setLoadedIssue('i1');
    expect(reloaded.toolbarPins('/settings').map(([id]) => id)).toEqual(['f1', 'f2']);
    await reloaded.store.setLoadedIssue(null);
    expect(window.localStorage.getItem('feedback-annotations-/settings')).toBeNull();
  });
});
