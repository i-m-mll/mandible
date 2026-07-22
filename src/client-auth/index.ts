// Client authentication (umbrella 8e2e8b2 / issue 708dc4c).
//
// Local client authentication for the dashboard, Tauri, agents, and file-RPC:
// per-user bearer tokens hashed at rest, a compat/strict mode gate wired at the
// HTTP + file-RPC boundary, an unattributed-write telemetry ratchet, and a
// dashboard bootstrap handshake. All state lives in wave-1 tables (api_token
// credentials) and the existing `settings` KV table plus in-memory telemetry —
// no new migration.

export { ClientAuthenticator } from "./authenticator.js";
export {
  CLIENT_AUTH_MODE_KEY,
  DEFAULT_CLIENT_AUTH_MODE,
  getClientAuthMode,
  setClientAuthMode,
  type ClientAuthMode,
} from "./mode.js";
export {
  API_TOKEN_PREFIX,
  fingerprintForToken,
  generateRawToken,
  mintApiToken,
  normalizeBearer,
  verifyApiToken,
  type MintedToken,
  type VerifiedToken,
} from "./tokens.js";
export {
  ClientAuthTelemetry,
  type ClientAuthTelemetrySnapshot,
  type UnattributedWriteContext,
} from "./telemetry.js";
