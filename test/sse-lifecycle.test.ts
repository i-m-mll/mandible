import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SseManager, broadcastSpaceEvent, setSseManager } from "../src/sse.js";
import { SPACE_EVENTS } from "../src/spaces/events.js";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  writeResult = true;
  writes: string[] = [];

  writeHead(): void {}

  write(payload: string): boolean {
    this.writes.push(payload);
    return this.writeResult;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function makeRequest(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function makeResponse(): FakeResponse & ServerResponse {
  return new FakeResponse() as FakeResponse & ServerResponse;
}

describe("SseManager lifecycle", () => {
  it("removes close listeners when a client disconnects", () => {
    const manager = new SseManager();
    const req = makeRequest();
    const res = makeResponse();

    manager.addClient(req, res, []);
    expect(manager.count()).toBe(1);
    expect(req.listenerCount("close")).toBe(1);
    expect(res.listenerCount("close")).toBe(1);

    req.emit("close");

    expect(manager.count()).toBe(0);
    expect(req.listenerCount("close")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    expect(res.destroyed).toBe(true);
  });

  it("drops over-buffered clients on broadcast", () => {
    const manager = new SseManager();
    const req = makeRequest();
    const res = makeResponse();

    manager.addClient(req, res, []);
    res.writeResult = false;
    res.writableLength = 2 * 1024 * 1024;

    manager.broadcast({
      type: "test:event",
      data: { ok: true },
      timestamp: new Date().toISOString(),
    });

    expect(manager.count()).toBe(0);
    expect(res.destroyed).toBe(true);
  });
});

describe("broadcastSpaceEvent", () => {
  afterEach(() => {
    setSseManager(null as unknown as SseManager);
  });

  function parsePayloads(res: FakeResponse): SSEEnvelope[] {
    return res.writes
      .filter((p) => p.startsWith("data: "))
      .map((p) => JSON.parse(p.slice("data: ".length).trim()) as SSEEnvelope);
  }

  it("broadcasts a frozen space:* event to a subscribed client through broadcast()", () => {
    const manager = new SseManager();
    setSseManager(manager);
    const req = makeRequest();
    const res = makeResponse();
    manager.addClient(req, res, ["space:"]);

    broadcastSpaceEvent(SPACE_EVENTS.SPACE_CREATED, { space_id: "spc-1" });

    const events = parsePayloads(res);
    const created = events.find((e) => e.type === SPACE_EVENTS.SPACE_CREATED);
    expect(created).toBeDefined();
    expect(created?.data).toEqual({ space_id: "spc-1" });
    expect(typeof created?.timestamp).toBe("string");
  });

  it("delivers space events under the matching space: topic filter and not others", () => {
    const manager = new SseManager();
    setSseManager(manager);

    const spaceReq = makeRequest();
    const spaceRes = makeResponse();
    manager.addClient(spaceReq, spaceRes, ["space:"]);

    const authReq = makeRequest();
    const authRes = makeResponse();
    manager.addClient(authReq, authRes, ["auth:"]);

    broadcastSpaceEvent(SPACE_EVENTS.SPACE_OCCURRENCE_MOVED, { space_id: "spc-2" });

    expect(parsePayloads(spaceRes).some((e) => e.type === SPACE_EVENTS.SPACE_OCCURRENCE_MOVED)).toBe(true);
    expect(parsePayloads(authRes).some((e) => e.type === SPACE_EVENTS.SPACE_OCCURRENCE_MOVED)).toBe(false);
  });

  it("ignores ad-hoc strings that are not in the frozen space:* enum", () => {
    const manager = new SseManager();
    setSseManager(manager);
    const req = makeRequest();
    const res = makeResponse();
    manager.addClient(req, res, ["space:"]);

    // Bypass the type system the way a stray runtime caller might.
    broadcastSpaceEvent("space:not:registered" as never, { space_id: "spc-3" });

    expect(parsePayloads(res).some((e) => e.type === "space:not:registered")).toBe(false);
  });

  it("is a no-op when no SseManager is installed", () => {
    setSseManager(null as unknown as SseManager);
    expect(() => broadcastSpaceEvent(SPACE_EVENTS.SPACE_DELETED, { space_id: "spc-4" })).not.toThrow();
  });
});

interface SSEEnvelope {
  type: string;
  data?: unknown;
  timestamp?: string;
}
