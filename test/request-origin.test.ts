import { describe, expect, it, vi } from "vitest";
import { Router } from "../src/server.js";
import { currentRequestOrigin, requestOriginForRequest, requestOriginJson, withRequestOrigin, withRequestOriginMetadata } from "../src/request-origin.js";
import { LedgerStore } from "../src/ledger/store.js";
import { createLedgerProject, migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { createUser } from "../src/users/store.js";
import { systemAction } from "../src/identity/resolver.js";

describe("request origin dispatch", () => {
  it("distinguishes an explicit origin envelope from legacy ambient capture and explicit unknown", () => {
    const ambient = { provider: "codex", provider_session_id: "executing-session" };
    const initiating = { provider: "claude", provider_session_id: "initiating-session" };
    expect(requestOriginForRequest({ ambient_identity: ambient })).toEqual(ambient);
    expect(requestOriginForRequest({ ambient_identity: ambient, request_origin: initiating })).toEqual(initiating);
    for (const request_origin of [null, undefined, "malformed", { provider: "invalid", provider_session_id: "claim" }]) {
      expect(requestOriginForRequest({ ambient_identity: ambient, request_origin })).toBeNull();
    }
  });

  it("records global mutations atomically and publishes recorded origin only after commit", () => {
    const db = migratedMemoryDb();
    try {
      const broadcast = vi.fn();
      const store = new LedgerStore(db, { broadcaster: broadcast });
      const user = createUser(db, { slug: 'origin-fixture', kind: 'agent', display_name: 'Before' });
      const initialEvents = db.prepare('SELECT count(*) AS n FROM ledger_events').get();
      const origin = { provider: 'claude', provider_session_id: 'native-global-author' };
      const input = { actor_type: 'system' as const, attribution: systemAction(), entity_type: 'user', entity_id: user.id,
        event_type: 'user.updated', project_id: null, notify: false, payload: { operation: 'update', changed_fields: ['display_name'] } };
      expect(() => withRequestOrigin(origin, () => db.transaction(() => {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Rolled back', user.id);
        store.recordEvent(input);
        throw new Error('abort mutation');
      })())).toThrow('abort mutation');
      expect(db.prepare('SELECT display_name FROM users WHERE id = ?').get(user.id)).toEqual({ display_name: 'Before' });
      expect(db.prepare('SELECT count(*) AS n FROM ledger_events').get()).toEqual(initialEvents);
      expect(broadcast).not.toHaveBeenCalled();
      const event = withRequestOrigin(origin, () => db.transaction(() => {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('After', user.id);
        const recorded = store.recordEvent(input);
        expect(() => store.notifyEvent(recorded)).toThrow('requires a committed transaction');
        return recorded;
      })());
      expect(broadcast).not.toHaveBeenCalled();
      store.notifyEvent(event);
      expect(broadcast).toHaveBeenCalledWith('ledger:event:created', expect.objectContaining({ request_origin: origin, entity_id: user.id }));
      expect(db.prepare('SELECT count(*) AS n FROM ledger_change_feed_state').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM ledger_change_log').get()).toEqual({ n: 0 });
      const project = createLedgerProject(db, process.cwd());
      const projectEvent = store.recordEvent({ ...input, project_id: project.project.id });
      expect(db.prepare('SELECT project_id FROM ledger_change_log WHERE event_id = ?').all(projectEvent.id)).toEqual([{ project_id: project.project.id }]);
    } finally { db.close(); }
  });

  it("isolates overlapping requests, clears absent origin, and restores serialized queued origin", async () => {
    const router = new Router();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let queued: string | null = null;
    router.post("/write/:id", async (req, res) => {
      if (req.params.id === "first") {
        queued = requestOriginJson();
        entered();
        await barrier;
      }
      res.json(withRequestOriginMetadata({ request_origin: { provider: "claude", provider_session_id: "forged-payload" } }));
    }, { localCliCredential: {"mode":"omit"}, operation: { id: "origin.write", effects: ["ledger:write"], reportingCategory: "ledger", requestSchema: null }, fileRpc: "allow" });
    const codex = { provider: "codex", provider_session_id: "first-native" };
    const claude = { provider: "claude", provider_session_id: "second-native" };
    const first = router.invoke({ method: "POST", url: "/write/first", ambient_identity: codex });
    await firstEntered;
    try {
      expect((await router.invoke({ method: "POST", url: "/write/second", ambient_identity: claude })).body)
        .toEqual({ request_origin: claude });
      expect((await withRequestOrigin(codex, () => router.invoke({ method: "POST", url: "/write/missing" }))).body)
        .toEqual({ request_origin: null });
      expect((await router.invoke({ method: "POST", url: "/write/invalid", ambient_identity: { provider: "unknown", provider_session_id: "invented" } })).body)
        .toEqual({ request_origin: null });
    } finally { release(); }
    expect((await first).body).toEqual({ request_origin: codex });
    expect(currentRequestOrigin()).toBeNull();
    expect(queued).not.toBeNull();
    expect(await withRequestOrigin(JSON.parse(queued!), async () => {
      await Promise.resolve();
      return currentRequestOrigin();
    })).toEqual(codex);
    expect(currentRequestOrigin()).toBeNull();
  });
});
