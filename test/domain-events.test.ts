import { describe, expect, it } from "vitest";
import { BRIEFING_EVENTS, DOMAIN_EVENTS, parseDomainEvent } from "../src/contracts.js";
import { SPACE_EVENTS } from "../src/spaces/events.js";

describe("domain event transport boundary", () => {
  it("accepts scoped mutation events with their routing identity", () => {
    for (const event of [
      { type: BRIEFING_EVENTS.groupCreated, data: { group_id: "group", extra: true } },
      { type: BRIEFING_EVENTS.bundleCreated, data: { bundle_id: "bundle" } },
      { type: BRIEFING_EVENTS.roundPublished, data: { briefing_id: "briefing", round_id: null } },
      { type: SPACE_EVENTS.SPACE_ITEM_ADDED, data: { space_id: "space", item_id: "item" } },
      { type: DOMAIN_EVENTS.CONVERSATION_UPDATED, data: { id: "conversation" } },
    ]) expect(parseDomainEvent(event)).toEqual({ ok: true, value: event });
  });

  it("rejects unknown names, incomplete envelopes, conflicting names, and invalid routing payloads", () => {
    for (const event of [null, "message", { type: "unknown", data: {} },
      { type: DOMAIN_EVENTS.HEARTBEAT },
      { type: DOMAIN_EVENTS.HEARTBEAT, data: { timestamp: "bad" } },
      { type: SPACE_EVENTS.SPACE_ITEM_ADDED, data: {} },
      { type: BRIEFING_EVENTS.groupCreated, data: { group_id: "" } },
      { type: DOMAIN_EVENTS.CONVERSATION_UPDATED, event: DOMAIN_EVENTS.CONVERSATION_NEW, data: { id: "id" } },
    ]) expect(parseDomainEvent(event).ok).toBe(false);
  });
});
