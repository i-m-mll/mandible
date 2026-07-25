// Client-authentication routes (issue 708dc4c):
//   POST /api/client-auth/handshake   dashboard acquires an ephemeral operator token
//   GET  /api/client-auth/status      current mode + unattributed-write telemetry (read)
//   GET  /api/client-auth/whoami      effective client identity for this request (read)
//   PUT  /api/client-auth/mode        set mode (operator only, both directions)
//   POST /api/users/:ref/tokens       mint an api_token (self or operator)
//   GET  /api/users/:ref/tokens       list a user's api_token credentials (self or operator)
//
// Token revocation reuses the guarded credential-revoke route in routes/users.ts.
// All management routes require an authenticated identity regardless of mode —
// they administer authentication itself (finding 2). Bootstrappability comes
// from the filesystem bootstrap token and the CLI's fragment-only dashboard
// enrollment link; the handshake itself always requires the operator.

import { getDb } from "../db.js";
import type { ClientAuthenticator } from "../client-auth/authenticator.js";
import {
  ClientAuthzError,
  requireOperator,
  requireSelfOrOperator,
} from "../client-auth/authz.js";
import { getClientAuthMode, setClientAuthMode } from "../client-auth/mode.js";
import {
  getOperator,
  getUserById,
  listCredentials,
  resolveUserOrThrow,
  UserRegistryError,
} from "../users/store.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { sendJson } from "./http.js";

function bodyRecord(req: RequestLike): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof UserRegistryError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
    sendJson(res, status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

export function registerClientAuthRoutes(
  router: RouteRegistrar,
  authenticator: ClientAuthenticator,
): void {
  // Dashboard session renewal. This endpoint never upgrades an anonymous or
  // unrelated identity: an already-authenticated operator is required in both
  // compat and strict mode. The resulting bounded, expiring session survives a
  // daemon restart through a protected fingerprint and is rotated on every
  // successful boot or bounded post-expiry recovery.
  router.post("/api/client-auth/handshake", (req, res) => {
    try {
      const db = getDb();
      const identity = requireOperator(db, req);
      const operator = getOperator(db);
      if (!operator) {
        sendJson(res, 409, {
          error: "operator_not_configured",
          code: "operator_not_configured",
          hint: "Run `mandible user setup` to create the local operator first.",
        });
        return;
      }
      const session = authenticator.issueDashboardToken(identity);
      sendJson(res, 200, {
        ...session,
        user: { id: operator.id, slug: operator.slug },
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  // Current client-auth mode and the unattributed-write ratchet (read).
  router.get("/api/client-auth/status", (_req, res) => {
    try {
      sendJson(res, 200, {
        mode: getClientAuthMode(getDb()),
        telemetry: authenticator.telemetrySnapshot(),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  // Issue 499c148 — the cheap self-check. A session that carries the wrong
  // bearer (e.g. an inherited operator token in an agent shell) previously had
  // no way to notice before the auth-request gate refused it. This reports the
  // identity the daemon actually resolves for the calling request. It is a read
  // of the caller's own request context and reveals nothing another route would
  // not, so it stays usable while anonymous: an unauthenticated caller gets
  // `authenticated: false` rather than a 401, which is itself the answer.
  router.get("/api/client-auth/whoami", (req, res) => {
    try {
      const db = getDb();
      const mode = getClientAuthMode(db);
      const identity = req.client_identity ?? null;
      if (!identity) {
        sendJson(res, 200, {
          authenticated: false,
          mode,
          user: null,
          evidence_method: null,
          source: null,
          credential: null,
        });
        return;
      }
      const user = getUserById(db, identity.user_id);
      // The credential label is the operator-facing name of the presented
      // api_token ("mll-cli"), which is what makes a wrong-token diagnosis
      // actionable. Ephemeral identities have no persisted credential row.
      const credential = identity.credential_id
        ? listCredentials(db, identity.user_id, { includeRevoked: true }).find(
            (row) => row.id === identity.credential_id,
          ) ?? null
        : null;
      sendJson(res, 200, {
        authenticated: true,
        mode,
        user: user
          ? {
              id: user.id,
              slug: user.slug,
              kind: user.kind,
              display_name: user.display_name,
            }
          : { id: identity.user_id, slug: identity.slug, kind: null, display_name: null },
        evidence_method: identity.method,
        source: identity.source,
        credential: credential
          ? {
              id: credential.id,
              type: credential.type,
              label: credential.label,
              status: credential.status,
            }
          : null,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  // Set client-auth mode. Requires an authenticated OPERATOR in BOTH directions:
  // compat->strict proves provisioning works before lockout is possible;
  // strict->compat prevents an anonymous downgrade.
  router.put("/api/client-auth/mode", (req, res) => {
    try {
      requireOperator(getDb(), req);
      const body = bodyRecord(req);
      const mode = optionalString(body, "mode");
      if (!mode) throw new UserRegistryError("invalid", "mode is required.");
      const applied = setClientAuthMode(getDb(), mode);
      sendJson(res, 200, { mode: applied });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow", countUnattributed: false });

  // Mint a bearer token for a user. Self-service, or operator for another user.
  // The raw token is returned exactly once and never persisted.
  router.post("/api/users/:ref/tokens", (req, res) => {
    try {
      const db = getDb();
      const target = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, target.id);
      const body = bodyRecord(req);
      const minted = authenticator.mintApiToken(target.id, {
        label: optionalString(body, "label") ?? null,
      });
      sendJson(res, 201, {
        token: minted.token,
        credential: minted.credential,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow", countUnattributed: false });

  // List a user's api_token credentials (metadata only — never the raw token).
  router.get("/api/users/:ref/tokens", (req, res) => {
    try {
      const db = getDb();
      const target = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, target.id);
      const query = req.query ?? {};
      const includeRevoked = query.all === "1" || query.all === "true";
      const tokens = listCredentials(db, target.id, { includeRevoked }).filter(
        (credential) => credential.type === "api_token",
      );
      sendJson(res, 200, { tokens });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });
}
