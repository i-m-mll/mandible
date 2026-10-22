import { establishTestClientAccess } from './helpers/local-client-access';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ConversationControlSnapshot } from "../ui/src/api.js";
import { submitConversationControl } from "../ui/src/api.js";
import { conversationControlPresentation } from "../ui/src/chat/conversationControl.js";

const base: ConversationControlSnapshot = {
  conversation_id: "conversation-1",
  provider: "codex",
  provider_session_id: "provider-1",
  provider_mode: "app-server-managed",
  provider_capabilities: {
    mode: "app-server-managed",
    resume_provider_session: true,
    resume_message_anchor: false,
    send: true,
    steer: true,
    queue: false,
    stop: true,
    remove: false,
    structured_deltas: true,
    lifecycle_callbacks: true,
    permission_callbacks: true,
    terminal_attach: false,
    logs: false,
    initial_message_acceptance: "provider-protocol",
  },
  revision: 1,
  ownership: { kind: "none", generation: 0 },
  controller: { kind: "stopped", at: 1 },
  turn: { kind: "none" },
  capability: { kind: "provider-session-resume", revision: 1, generation: 0, adapter_id: "codex", provider_session_id: "provider-1" },
  updated_at: 1,
};
const owned: ConversationControlSnapshot = {
  ...base,
  ownership: { kind: "mandible", generation: 1, controller_instance_id: "controller-1", adapter_id: "codex", provider_session_id: "provider-1", last_authoritative_signal: 1 },
  controller: { kind: "ready", since: 1 },
  capability: { kind: "live-send", revision: 1, generation: 1 },
};

beforeEach(establishTestClientAccess);
afterEach(() => vi.unstubAllGlobals());

describe("shared conversation control presentation", () => {
  it.each([
    [owned, "Send"],
    [{ ...owned, controller: { kind: "running", since: 1 }, turn: { kind: "running", turn_id: "turn-1", since: 1 }, capability: { kind: "live-steer", revision: 1, generation: 1 } } as ConversationControlSnapshot, "Steer now"],
    [{ ...owned, controller: { kind: "running", since: 1 }, turn: { kind: "running", turn_id: "turn-1", since: 1 }, capability: { kind: "owned-queue", revision: 1, generation: 1 } } as ConversationControlSnapshot, "Queue after this turn"],
    [base, "Resume"],
  ])("derives the one Chat and Console submit affordance", (snapshot, label) => {
    expect(conversationControlPresentation(snapshot).submitLabel).toBe(label);
  });

  it("keeps external ownership blocked", () => {
    const external: ConversationControlSnapshot = {
      ...base,
      ownership: { kind: "external", generation: 2, evidence: { kind: "registered-process", reference: "session-2" }, last_authoritative_signal: 2 },
      capability: { kind: "blocked-external", revision: 2, evidence_kind: "registered-process" },
    };
    expect(conversationControlPresentation(external)).toMatchObject({ sendable: false, blocker: { severity: "warning" } });
  });

  it("submits the exact operation selected by the server capability", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, value: { kind: "accepted", delivery_id: "delivery-1", turn_id: "turn-1", snapshot: owned } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }));

    await submitConversationControl({ ...owned, capability: { kind: "live-steer", revision: 1, generation: 1 } }, "steer");
    await submitConversationControl({ ...owned, capability: { kind: "owned-queue", revision: 1, generation: 1 } }, "queue");
    expect(requests.map((request) => request.operation)).toEqual(["steer", "queue"]);
  });

  it("binds composer runtime choices to the exact provider turn", async () => {
    let request: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, value: {
        kind: "accepted", delivery_id: "delivery-1", turn_id: "turn-1", snapshot: owned,
      } }), { status: 202, headers: { "content-type": "application/json" } });
    }));

    await submitConversationControl(base, "resume", undefined, {
      model: "gpt-5.6-sol", effort: "xhigh", permission_mode: "agent-full-access",
    });
    expect(request).toMatchObject({
      operation: "resume-provider-session",
      runtime_options: { model: "gpt-5.6-sol", effort: "xhigh", permission_mode: "agent-full-access" },
    });
  });

  it("returns the refreshed non-mutating snapshot on capability drift", async () => {
    const refreshed = { ...owned, revision: 2, capability: { kind: "live-steer", revision: 2, generation: 1 } as const };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { kind: "capability-drift", expected_revision: 1, actual_revision: 2 },
      snapshot: refreshed,
    }), { status: 409, headers: { "content-type": "application/json" } })));

    await expect(submitConversationControl(owned, "message")).rejects.toMatchObject({ snapshot: refreshed });
  });

  it("preserves a general HTTP rejection explanation instead of treating it as a control error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "instance_mutation_forbidden",
      message: "This preview can control only a Chat created and still owned by this preview.",
    }), { status: 403, headers: { "content-type": "application/json" } })));

    const result = submitConversationControl(owned, "message");
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      status: 403,
      code: "instance_mutation_forbidden",
      message: "This preview can control only a Chat created and still owned by this preview.",
    });
  });
});
