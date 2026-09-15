// Client authentication (umbrella 8e2e8b2 / issue 708dc4c).
//
// Local client authentication for native clients, agents, and file-RPC:
// per-user bearer tokens hashed at rest, an always-strict HTTP + file-RPC
// boundary, an unattributed-write telemetry ratchet, and a filesystem-anchored
// operator bootstrap token restricted to one-shot native enrollment. Browser
// sessions are owned separately by session-authority.ts and use cookies + CSRF.

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
