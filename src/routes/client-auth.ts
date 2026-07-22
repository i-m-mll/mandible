// Client-authentication routes (issue 708dc4c):
//   POST /api/users/:ref/tokens        mint an api_token (raw token returned once)
//   GET  /api/users/:ref/tokens        list a user's api_token credentials (no secrets)
//   GET  /api/client-auth/status       current mode + unattributed-write telemetry
//   PUT  /api/client-auth/mode         set mode (compat | strict)
//
// Token revocation reuses the existing credential-revoke route
// (POST /api/users/credentials/:id/revoke) since a token is an api_token
// credential. These routes only handle authentication material; authorization
// is out of scope for this lane.

import { getDb } from "../db.js";
import type { ClientAuthGate, RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { getClientAuthMode, setClientAuthMode } from "../client-auth/mode.js";
import { mintApiToken } from "../client-auth/tokens.js";
import { listCredentials, UserRegistryError } from "../users/store.js";
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
  gate?: ClientAuthGate,
): void {
  // Mint a bearer token for a user. The raw token is returned exactly once and
  // never persisted; only its peppered hash is stored as an api_token credential.
  router.post("/api/users/:ref/tokens", (req, res) => {
    try {
      const body = bodyRecord(req);
      const minted = mintApiToken(getDb(), req.params.ref, {
        label: optionalString(body, "label") ?? null,
      });
      sendJson(res, 201, {
        token: minted.token,
        credential: minted.credential,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  // List a user's api_token credentials (metadata only — never the raw token).
  router.get("/api/users/:ref/tokens", (req, res) => {
    try {
      const query = req.query ?? {};
      const includeRevoked = query.all === "1" || query.all === "true";
      const tokens = listCredentials(getDb(), req.params.ref, { includeRevoked }).filter(
        (credential) => credential.type === "api_token",
      );
      sendJson(res, 200, { tokens });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  // Current client-auth mode and the unattributed-write ratchet.
  router.get("/api/client-auth/status", (_req, res) => {
    try {
      sendJson(res, 200, {
        mode: getClientAuthMode(getDb()),
        telemetry: gate?.telemetrySnapshot ? gate.telemetrySnapshot() : null,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  // Set client-auth mode. Toggling to strict makes anonymous mutations rejected.
  router.put("/api/client-auth/mode", (req, res) => {
    try {
      const body = bodyRecord(req);
      const mode = optionalString(body, "mode");
      if (!mode) throw new UserRegistryError("invalid", "mode is required.");
      const applied = setClientAuthMode(getDb(), mode);
      sendJson(res, 200, { mode: applied });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });
}
