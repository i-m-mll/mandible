// Explicit agent-token administration and intrinsic local OS-user identity.
import { getDb } from "../db.js";
import type { ClientAuthenticator } from "../client-auth/authenticator.js";
import { ClientAuthzError, requireSelfOrOperator } from "../client-auth/authz.js";
import { getUserById, listCredentials, resolveUserOrThrow, UserRegistryError } from "../users/store.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import { bodyRecord, sendJson } from "./http.js";

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
  } else if (error instanceof UserRegistryError) {
    sendJson(res, error.code === "not_found" ? 404 : 400, { error: error.message, code: error.code });
  } else {
    sendJson(res, 500, { error: "internal_error" });
  }
}

export function registerClientAuthRoutes(router: RouteRegistrar, authenticator: ClientAuthenticator): void {
  router.get("/api/client-auth/forward-auth", async (req, res) => {
    try {
      const identity = req.client_identity;
      const target = req.target_instance_id;
      if (!identity || identity.source !== "local_os_user" || !target) {
        sendJson(res, 401, { error: "preview_session_required" });
        return;
      }
      const context = await authenticator.signPreviewContext(identity, target);
      res.header?.("X-Mandible-Session-Context", context);
      res.status(204).empty?.();
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  // Report the exact request principal; explicit agent tokens remain distinct
  // from the intrinsic local OS-user browser identity.
  router.get("/api/client-auth/whoami", (req, res) => {
    try {
      const db = getDb();
      const identity = req.client_identity ?? null;
      if (!identity) {
        sendJson(res, 200, {
          authenticated: false,
          audience: authenticator.authorityId(),
          failure_reason: "unknown",
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
        audience: identity.audience ?? authenticator.instanceId(),
        session: authenticator.localAccessMetadata(identity),
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
        // Distinguishes bounded agent-session proofs from durable credentials.
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
