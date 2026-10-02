import { getDb } from "../db.js";
import { ClientAuthzError, requireDurableIdentity } from "../client-auth/authz.js";
import type { RequestLike, RouteHandler } from "../server.js";
import {
  PermissionError,
  requireGlobalCapability,
  sendPermissionError,
  type GlobalCapability,
} from "./store.js";

/** HTTP and file-RPC boundary wrapper for one named global capability. */
export function globalCapabilityRoute(
  capability: GlobalCapability,
  handler: RouteHandler,
  options: { authenticated?: boolean } = {},
): RouteHandler {
  return (req, res) => {
    if (capability === "approve_auth" && req.client_identity?.method === "local_socket") {
      try {
        requireDurableIdentity(req);
      } catch (error) {
        if (error instanceof ClientAuthzError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    }
    if (options.authenticated && !req.client_identity) {
      res.status(401).json({
        error: "This endpoint requires an authenticated client token.",
        code: "authentication_required",
      });
      return;
    }
    try {
      requireGlobalCapability(getDb(), req, capability);
    } catch (error) {
      if (error instanceof PermissionError) {
        sendPermissionError(res, error);
        return;
      }
      throw error;
    }
    return handler(req, res);
  };
}

/** Narrow helper for tests and service code that constructs request-shaped identities. */
export function requestIdentity(req: RequestLike) {
  return req.client_identity ?? null;
}
