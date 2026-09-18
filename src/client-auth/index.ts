// Local OS-owned browser access and explicit bearer/capability tokens for agents.

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
  defaultClientAuthDir,
  loadOrCreatePepper,
} from "./secret-store.js";
export {
  ClientAuthTelemetry,
  type ClientAuthTelemetrySnapshot,
  type UnattributedWriteContext,
} from "./telemetry.js";
