// Client authentication (umbrella 8e2e8b2 / issue 708dc4c).
//
// Local client authentication for the dashboard, Tauri, agents, and file-RPC:
// per-user bearer tokens hashed at rest, a compat/strict mode gate wired at the
// HTTP + file-RPC boundary, an unattributed-write telemetry ratchet, a
// filesystem-anchored operator bootstrap token, and a browser handshake route.
// State lives in wave-1 tables (api_token credentials), the existing `settings`
// KV table (mode only), filesystem secrets (pepper, bootstrap token), and
// in-memory telemetry — no new migration.

export { ClientAuthenticator, type ClientAuthenticatorOptions } from "./authenticator.js";
export {
  ClientAuthzError,
  isOperator,
  requireIdentity,
  requireOperator,
  requireSelfOrOperator,
} from "./authz.js";
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
  bootstrapTokenFilePath,
  defaultClientAuthDir,
  loadOrCreatePepper,
  writeBootstrapTokenFile,
} from "./secret-store.js";
export {
  ClientAuthTelemetry,
  type ClientAuthTelemetrySnapshot,
  type UnattributedWriteContext,
} from "./telemetry.js";
