// @vitest-environment jsdom
/**
 * The bridge is all that stands between an embedding page and the operator's
 * authority on Mandible's origin. Crafted messages reach no other window's answer,
 * no other origin's identity, no note it has not listed or made, no issue outside
 * its project's listing, and no page URL off the page's origin.
 */
import { expect, it, vi } from 'vitest';
import type { EmbedIdentity, InterfaceNote } from '../src/interface-notes/contract';
import { createBridge, type BridgeAccess, type BridgeDeps } from '../ui/src/annotation/bridge';
import { BRIDGE_MESSAGE } from '../ui/src/annotation/bridgeProtocol';
import type { InterfaceNotesTransport } from '../ui/src/annotation/notesTransport';

const PAGE = 'http://localhost:5173';
const IDENTITY: EmbedIdentity = { app: 'feedbax:web', project: { id: 'prj_feedbax', key: 'feedbax', name: 'feedbax' } };

function setup(access: BridgeAccess = { kind: 'granted', identity: IDENTITY }) {
  const sent: Array<{ message: Record<string, unknown>; origin: string }> = [];
  const parent: BridgeDeps['parent'] = { postMessage: (message, origin) => { sent.push({ message: message as Record<string, unknown>, origin }); } };
  const listed: InterfaceNote[] = [{ id: 'listed' } as InterfaceNote];
  const transport = {
    listUnfiled: vi.fn(async () => listed),
    create: vi.fn(async (input: { id: string }) => ({ id: input.id }) as InterfaceNote),
    updateText: vi.fn(async (id: string) => ({ id }) as InterfaceNote),
    deleteUnfiled: vi.fn(async () => undefined),
    file: vi.fn(async () => ({ issue_id: 'i', issue_short_id: 'i', comment_id: 'c', comment_ordinal: 1, filed: [] })),
    listIssuesWithNotes: vi.fn(async () => [{ project_key: 'feedbax', issues: [{ id: 'abc1234' }] }]),
  };
  const asked: string[] = [];
  const handle = createBridge({
    parent,
    access: async (origin) => { asked.push(origin); return access; },
    transport: () => transport as unknown as InterfaceNotesTransport,
    follow: () => undefined,
  });
  let id = 0;
  const post = (data: unknown, from: { source?: unknown; origin?: string } = {}) =>
    handle({ source: from.source ?? parent, origin: from.origin ?? PAGE, data });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const call = async (operation: string, ...args: unknown[]) => {
    const callId = (id += 1);
    post({ kind: BRIDGE_MESSAGE, type: 'call', id: callId, operation, args });
    await settle();
    return sent.find((entry) => entry.message.type === 'result' && entry.message.id === callId)?.message;
  };
  const hello = async (from?: { source?: unknown; origin?: string }) => {
    post({ kind: BRIDGE_MESSAGE, type: 'hello' }, from);
    await settle();
  };
  return { sent, transport, asked, post, call, hello };
}

const draft = (id: string, url: string) => ({ id, text: 't', pin: { id, comment: 't' }, target: { url, rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } } });

it('answers only the parent that said hello first, at its origin, and only with that origin’s identity', async () => {
  const bridge = setup();
  await bridge.hello({ source: {} });
  expect(bridge.asked).toEqual([]);
  await bridge.hello();
  await bridge.hello({ origin: 'http://localhost:9999' });
  expect(bridge.asked).toEqual([PAGE]);
  expect(bridge.sent.map((entry) => [entry.message.type, entry.origin])).toEqual([['identity', PAGE]]);
  expect(await bridge.call('listUnfiled')).toMatchObject({ ok: true });

  bridge.post({ kind: BRIDGE_MESSAGE, type: 'call', id: 99, operation: 'listUnfiled', args: [] }, { origin: 'http://localhost:9999' });
  bridge.post({ kind: BRIDGE_MESSAGE, type: 'call', id: 98, operation: 'listIssueNotes', args: ['any'] });
  bridge.post({ kind: BRIDGE_MESSAGE, type: 'call', id: 97, operation: 'subscribe', args: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(bridge.sent.filter((entry) => [97, 98, 99].includes(entry.message.id as number))).toEqual([]);
});

it('performs nothing for an origin the operator has not allowed, and says the request is pending', async () => {
  const bridge = setup({ kind: 'pending' });
  await bridge.hello();
  expect(bridge.sent[0]!.message).toMatchObject({ type: 'identity', identity: null, pending: true });
  expect(await bridge.call('listUnfiled')).toBeUndefined();
  expect(bridge.transport.listUnfiled).not.toHaveBeenCalled();
});

it('keeps notes on the page’s origin and touches only notes and issues it listed or made', async () => {
  const bridge = setup();
  await bridge.hello();

  expect(await bridge.call('create', draft('off', 'https://app.mandible.localhost:19420/issues'))).toMatchObject({ ok: false, error: { code: 'invalid_note' } });
  expect(await bridge.call('create', draft('bad', 'not a url'))).toMatchObject({ ok: false });
  expect(bridge.transport.create).not.toHaveBeenCalled();
  expect(await bridge.call('create', draft('made', `${PAGE}/studio`))).toMatchObject({ ok: true });

  expect(await bridge.call('updateText', 'someone-elses', 'x')).toMatchObject({ ok: false, error: { code: 'note_not_found' } });
  expect(await bridge.call('deleteUnfiled', { toString: () => 'listed' })).toMatchObject({ ok: false, error: { code: 'note_not_found' } });
  expect(await bridge.call('updateText', 'listed', 'x')).toMatchObject({ ok: true });
  expect(await bridge.call('deleteUnfiled', 'made')).toMatchObject({ ok: true });
  expect(bridge.transport.updateText.mock.calls.map(([id]) => id)).toEqual(['listed']);

  expect(await bridge.call('file', { note_ids: ['made'], destination: { issue: 'abc1234' } })).toMatchObject({ ok: false, error: { code: 'issue_not_found' } });
  await bridge.call('listIssuesWithNotes', 'mandible');
  expect(await bridge.call('file', { note_ids: ['made', 'someone-elses'], destination: { issue: 'feedbax/abc1234' } })).toMatchObject({ ok: true });
  expect(bridge.transport.file).toHaveBeenLastCalledWith({ note_ids: ['made'], destination: { issue: 'feedbax/abc1234' } });
});
