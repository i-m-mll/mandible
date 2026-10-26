import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeAmbientProviderIdentity } from "./ambient-provider-identity.js";

/** Claimed native provenance only. Never authentication or approval authority. */
export interface RequestOrigin {
  readonly provider: string;
  readonly provider_session_id: string;
}

const origins = new AsyncLocalStorage<RequestOrigin | null>();

export function requestOriginForRequest(request: { ambient_identity?: unknown }): RequestOrigin | null {
  const identity = normalizeAmbientProviderIdentity(request.ambient_identity);
  return identity ? Object.freeze(identity) : null;
}

export function currentRequestOrigin(): RequestOrigin | null {
  return origins.getStore() ?? null;
}

/** Deferred tasks capture their initiating origin and explicitly restore it here. */
export function withRequestOrigin<T>(origin: RequestOrigin | null, action: () => T): T {
  const normalized = normalizeAmbientProviderIdentity(origin);
  return origins.run(normalized ? Object.freeze(normalized) : null, action);
}

export function requestOriginJson(): string | null {
  const origin = currentRequestOrigin();
  return origin ? JSON.stringify(origin) : null;
}

/** Always replace caller metadata: a payload cannot supply its own origin. */
export function withRequestOriginMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const { request_origin: _claimed, ...rest } = metadata;
  return { ...rest, request_origin: currentRequestOrigin() };
}
