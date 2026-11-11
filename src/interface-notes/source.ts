import http from "node:http";
import { DOMAIN_EVENTS, parseDomainEvent } from "../contracts.js";
import { productionLocalApiSocketPath } from "../local-api-socket.js";
import { keepsNotesInSource } from "../security/operation-policy.js";
import type { InstanceInfo } from "../types.js";
import type { InterfaceNoteChangedPayload } from "./contract.js";
import type { InterfaceNoteResult } from "./store.js";

/**
 * Where an instance keeps interface notes. A preview copied from the live ledger
 * keeps them in the instance it was copied from, reached over that instance's
 * local socket as the operator; every other instance keeps them in its own ledger.
 */
export type InterfaceNotesHome =
  | { kind: "local" }
  | { kind: "source"; socketPath: string };

export function interfaceNotesHome(instance: Pick<InstanceInfo, "role" | "allowed_effects">, env: NodeJS.ProcessEnv = process.env): InterfaceNotesHome {
  return keepsNotesInSource(instance)
    ? { kind: "source", socketPath: productionLocalApiSocketPath(env) }
    : { kind: "local" };
}

export type SourceResponse = { status: number; body: string };

const FORWARD_TIMEOUT_MS = 15_000;
const RELAY_RECONNECT_MS = 1_000;

/**
 * Send one interface-notes request to the source instance unchanged. The request
 * carries no agent markers, so the source attributes it to its operator; callers
 * must have established that the requester is the operator.
 */
export function forwardToSource(socketPath: string, method: string, url: string, body: unknown): Promise<InterfaceNoteResult<SourceResponse>> {
  const payload = body === undefined || body === null ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const request = http.request({
      socketPath, method, path: url, timeout: FORWARD_TIMEOUT_MS,
      headers: payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ ok: true, value: { status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") } }));
      response.on("error", (error) => resolve(unavailable(error)));
    });
    request.on("timeout", () => request.destroy(new Error("source instance did not answer")));
    request.on("error", (error) => resolve(unavailable(error)));
    request.end(payload ?? undefined);
  });
}

function unavailable(error: Error): InterfaceNoteResult<SourceResponse> {
  return { ok: false, error: { code: "source_unavailable", message: error.message } };
}

/**
 * Re-emit the source instance's `interface_note:changed` events in this instance,
 * so a preview's toolbar follows changes made anywhere. Each (re)connection emits
 * one event with no ids, since changes made while disconnected were not seen.
 * Returns the disposer.
 */
export function relaySourceNoteEvents(
  socketPath: string,
  emit: (payload: InterfaceNoteChangedPayload) => void,
  log: (event: string, detail: Record<string, unknown>) => void,
): () => void {
  let stopped = false;
  let request: http.ClientRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const reconnect = () => {
    request = null;
    if (!stopped && timer === null) timer = setTimeout(() => { timer = null; connect(); }, RELAY_RECONNECT_MS);
  };
  const connect = () => {
    const current = http.request({
      socketPath, method: "POST", path: `/api/events/subscribe?topic=${encodeURIComponent(DOMAIN_EVENTS.INTERFACE_NOTE_CHANGED)}`,
    }, (response) => {
      if (response.statusCode !== 200) {
        log("interface_notes_relay_refused", { status: response.statusCode });
        response.resume();
        response.on("end", reconnect);
        return;
      }
      emit({ ids: [], issue_id: null });
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data) relayFrame(data, emit, log);
        }
      });
      response.on("end", reconnect);
      response.on("error", reconnect);
    });
    current.on("error", reconnect);
    current.end();
    request = current;
  };

  connect();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    request?.destroy();
  };
}

function relayFrame(data: string, emit: (payload: InterfaceNoteChangedPayload) => void, log: (event: string, detail: Record<string, unknown>) => void): void {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    log("interface_notes_relay_malformed", { data: data.slice(0, 200) });
    return;
  }
  const parsed = parseDomainEvent(value);
  if (!parsed.ok) {
    log("interface_notes_relay_malformed", { error: parsed.error });
    return;
  }
  if (parsed.value.type === DOMAIN_EVENTS.INTERFACE_NOTE_CHANGED) emit(parsed.value.data as InterfaceNoteChangedPayload);
}
