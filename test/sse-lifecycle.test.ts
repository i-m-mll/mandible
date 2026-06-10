import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { SseManager } from "../src/sse.js";

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
