import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeAmbientProviderIdentity } from "./ambient-provider-identity.js";
import type { Db } from "./db.js";

/** Claimed native provenance only. Never authentication or approval authority. */
export interface RequestOrigin {
  readonly provider: string;
  readonly provider_session_id: string;
}

const origins = new AsyncLocalStorage<RequestOrigin | null>();

type ManagedIdentity = { app_name: string; session_id: string };
export type ManagedRequestOrigin = { status: "resolved"; origin: RequestOrigin } | { status: "unknown" | "conflict" };

export function requestOriginForRequest(
  request: { request_origin?: unknown; ambient_identity?: unknown; local_managed_identity?: ManagedIdentity | null },
  resolveManaged?: (identity: ManagedIdentity) => ManagedRequestOrigin,
): RequestOrigin | null {
  if (Object.hasOwn(request, "request_origin")) {
    const explicit = normalizeAmbientProviderIdentity(request.request_origin);
    return explicit ? Object.freeze(explicit) : null;
  }
  const identity = normalizeAmbientProviderIdentity(request.ambient_identity);
  const resolution = request.local_managed_identity && resolveManaged
    ? resolveManaged(request.local_managed_identity) : null;
  if (resolution?.status === "conflict") return null;
  const managed = resolution?.status === "resolved" ? resolution.origin : null;
  if (identity && managed && (identity.provider !== managed.provider || identity.provider_session_id !== managed.provider_session_id)) return null;
  if (managed) return Object.freeze(managed);
  return identity ? Object.freeze(identity) : null;
}

/** Only recorded exact native bindings qualify; local wrapper IDs never do. */
export function resolveManagedRequestOrigin(db: Db, managed: ManagedIdentity): ManagedRequestOrigin {
  const registered = db.prepare("SELECT app, conversation_id FROM sessions WHERE id = ?").get(managed.session_id) as
    { app: string; conversation_id: string | null } | undefined;
  if (registered && registered.app !== managed.app_name) return { status: "conflict" };
  const candidates = db.prepare(`SELECT command, provider_session_id FROM console_sessions
    WHERE id = ?1 OR mandible_session_id = ?1`).all(managed.session_id) as Array<{ command: string; provider_session_id: string | null }>;
  if (candidates.some(row => row.provider_session_id && row.command.split(/[\\/]/).pop()?.toLowerCase() !== managed.app_name)) {
    return { status: "conflict" };
  }
  const ids = new Set([registered?.conversation_id, ...candidates.map(row => row.provider_session_id)]
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0).map(id => id.trim()));
  if (ids.size > 1) return { status: "conflict" };
  const origin = ids.size === 1 ? normalizeAmbientProviderIdentity({ provider: managed.app_name, provider_session_id: [...ids][0] }) : null;
  return origin ? { status: "resolved", origin } : { status: "unknown" };
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

export function requestOriginFromMetadata(metadata: Record<string, unknown>): RequestOrigin | null {
  return normalizeAmbientProviderIdentity(metadata.request_origin);
}

/** Always replace caller metadata: a payload cannot supply its own origin. */
export function withRequestOriginMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const { request_origin: _claimed, ...rest } = metadata;
  return { ...rest, request_origin: currentRequestOrigin() };
}
