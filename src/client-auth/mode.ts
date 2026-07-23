// Client-authentication mode resolution (compat | strict).
//
// Compat mode (the default) is the deprecation-safe rollout: unauthenticated
// loopback clients keep working and every unattributed mutation is counted by
// the telemetry ratchet. Strict mode is opt-in via the `client_auth.mode`
// setting and rejects anonymous mutations while leaving reads open in phase 1.
//
// The mode lives in the existing `settings` KV table — no schema change.

import type { Db } from "../db.js";
import { getSetting, setSetting } from "./settings-kv.js";

export type ClientAuthMode = "compat" | "strict";

export const CLIENT_AUTH_MODE_KEY = "client_auth.mode";
export const DEFAULT_CLIENT_AUTH_MODE: ClientAuthMode = "compat";

export function getClientAuthMode(db: Db): ClientAuthMode {
  return getSetting(db, CLIENT_AUTH_MODE_KEY) === "strict" ? "strict" : DEFAULT_CLIENT_AUTH_MODE;
}

export function setClientAuthMode(
  db: Db,
  mode: string,
  now: number = Date.now(),
): ClientAuthMode {
  if (mode !== "compat" && mode !== "strict") {
    throw new Error(`Invalid client-auth mode '${mode}'. Use 'compat' or 'strict'.`);
  }
  setSetting(db, CLIENT_AUTH_MODE_KEY, mode, now);
  return mode;
}
