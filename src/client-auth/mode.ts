// Client-authentication mode resolution (compat | strict).
//
// Compat mode (the default) is the deprecation-safe rollout: unauthenticated
// loopback clients keep working and every unattributed mutation is counted by
// the telemetry ratchet. Strict mode is opt-in via the `client_auth.mode`
// setting and rejects anonymous mutations while leaving reads open in phase 1.
//
// The mode lives in the existing `settings` KV table — no schema change.

import type { Db } from "../db.js";
import { setSetting } from "./settings-kv.js";

export type ClientAuthMode = "compat" | "strict";

export const CLIENT_AUTH_MODE_KEY = "client_auth.mode";
export const DEFAULT_CLIENT_AUTH_MODE: ClientAuthMode = "strict";

export function getClientAuthMode(_db: Db): ClientAuthMode {
  return "strict";
}

export function setClientAuthMode(
  db: Db,
  mode: string,
  now: number = Date.now(),
): ClientAuthMode {
  if (mode !== "strict") {
    throw new Error("Client authentication is always strict after the local-session cutover.");
  }
  setSetting(db, CLIENT_AUTH_MODE_KEY, "strict", now);
  return "strict";
}
