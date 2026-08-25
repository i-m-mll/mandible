// Client-authentication routes (issue 708dc4c):
//   POST /api/client-auth/handshake   dashboard acquires an ephemeral operator token
//   POST /api/client-auth/session-token  exchange an agent PAT for a session-scoped token
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
import type { ResponseLike, RouteRegistrar } from "../server.js";
import { bodyRecord, sendJson } from "./http.js";
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

  // Issue 0b989d1 — exchange a long-lived agent PAT for a session-scoped
  // ephemeral token. `cli/wrap.sh` calls this at launch so the credential that
  // actually enters an agent's environment (and therefore its transcript) dies
  // when that one session ends, instead of being a shared PAT whose leak forces
  // a rotation across every live agent.
  //
  // The exchange NARROWS an identity, it never establishes one: the caller must
  // already authenticate with a durable api_token, and the minted token resolves
  // to that same user. Requiring api_token specifically (not merely "some
  // authenticated identity") stops an exchanged token — or a dashboard/bootstrap
  // ephemeral — from being re-exchanged into a fresh, differently-scoped
  // credential with a renewed TTL.
  router.post("/api/client-auth/session-token", (req, res) => {
    try {
      const db = getDb();
      const identity = req.client_identity ?? null;
      if (!identity) {
        sendJson(res, 401, {
          error: "Session-token exchange requires an authenticated client.",
          code: "authentication_required",
        });
        return;
      }
      if (identity.method !== "api_token") {
        sendJson(res, 403, {
          error: "Session-token exchange requires a durable api_token credential.",
          code: "exchange_requires_api_token",
        });
        return;
      }
      const sessionId = (optionalString(bodyRecord(req), "session_id") ?? "").trim();
      if (!sessionId) {
        throw new UserRegistryError("invalid", "session_id is required.");
      }
      const user = getUserById(db, identity.user_id);
      if (!user || user.status !== "active") {
        sendJson(res, 403, {
          error: "Session-token exchange requires an active user.",
          code: "inactive_user",
        });
        return;
      }
      const existingSession = db.prepare(
        "SELECT status, ended_at, owner_user_id FROM sessions WHERE id = ?",
      ).get(sessionId) as {
        status: string;
        ended_at: string | null;
        owner_user_id: string | null;
      } | undefined;
      if (
        existingSession
        && (
          existingSession.status !== "active"
          || existingSession.ended_at !== null
          || existingSession.owner_user_id !== user.id
        )
      ) {
        sendJson(res, 403, {
          error: "Session-token exchange requires the caller's own active session.",
          code: "session_exchange_forbidden",
        });
        return;
      }
      const minted = authenticator.issueSessionScopedToken(
        { user_id: user.id, slug: user.slug },
        sessionId,
      );
      // The raw token is returned exactly once and is never persisted or logged.
      sendJson(res, 201, {
        token: minted.token,
        expires_at: minted.expires_at,
        session_id: sessionId,
        user: { id: user.id, slug: user.slug },
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

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
          ephemeral_purpose: null,
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
        // Distinguishes a dashboard handshake from the operator bootstrap proof
        // or a per-agent file-RPC capability; null for api_token identities.
        ephemeral_purpose: identity.ephemeral_purpose ?? null,
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
