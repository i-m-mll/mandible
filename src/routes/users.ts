import { getDb } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import {
  addBinding,
  addCredential,
  createUser,
  getOperator,
  listBindings,
  listCredentials,
  listUsers,
  removeBinding,
  resolveUserOrThrow,
  revokeCredential,
  setupOperator,
  updateUser,
  UserRegistryError,
} from "../users/store.js";
import type {
  BindingType,
  UserKind,
  UserStatus,
} from "../users/types.js";
import { ClientAuthzError, requireSelfOrOperator } from "../client-auth/authz.js";
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

function optionalMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = body.metadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof UserRegistryError) {
    const status =
      error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
    sendJson(res, status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

function userView(db: ReturnType<typeof getDb>, ref: string) {
  const user = resolveUserOrThrow(db, ref);
  return {
    ...user,
    credentials: listCredentials(db, user.id, { includeRevoked: true }),
    bindings: listBindings(db, user.id),
  };
}

export function registerUserRoutes(router: RouteRegistrar): void {
  // Literal subpaths must register before /api/users/:ref so the param route
  // does not shadow them.

  router.get("/api/users/operator", (_req, res) => {
    try {
      const operator = getOperator(getDb());
      sendJson(res, 200, { operator: operator ?? null });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/users/setup", (req, res) => {
    try {
      const body = bodyRecord(req);
      const user = setupOperator(getDb(), {
        slug: optionalString(body, "slug"),
        display_name: optionalString(body, "display_name"),
        email: "email" in body ? (optionalString(body, "email") ?? null) : undefined,
        metadata: optionalMetadata(body),
      });
      sendJson(res, 200, { user });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/users/credentials/:id/revoke", (req, res) => {
    try {
      // Issue 708dc4c / finding 2 — revoking a credential (incl. api_tokens) is
      // an authentication-administration action: require the credential's owner
      // or the operator. Resolve the owner before revoking so authorization is
      // checked against the real credential, not a caller-supplied user ref.
      const db = getDb();
      const owner = db
        .prepare("SELECT user_id FROM user_credentials WHERE id = ?")
        .get(req.params.id) as { user_id: string } | undefined;
      if (!owner) {
        throw new UserRegistryError("not_found", `No credential '${req.params.id}'.`);
      }
      requireSelfOrOperator(db, req, owner.user_id);
      const credential = revokeCredential(db, req.params.id);
      sendJson(res, 200, { credential });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.delete("/api/users/bindings/:id", (req, res) => {
    try {
      removeBinding(getDb(), req.params.id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.get("/api/users", (req, res) => {
    try {
      const query = req.query ?? {};
      const users = listUsers(getDb(), {
        kind: (query.kind || undefined) as UserKind | undefined,
        status: (query.status || undefined) as UserStatus | undefined,
      });
      sendJson(res, 200, { users });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/users", (req, res) => {
    try {
      const body = bodyRecord(req);
      const slug = optionalString(body, "slug");
      const kind = optionalString(body, "kind");
      const display = optionalString(body, "display_name");
      if (!slug) throw new UserRegistryError("invalid", "slug is required.");
      if (!kind) throw new UserRegistryError("invalid", "kind is required.");
      if (!display) throw new UserRegistryError("invalid", "display_name is required.");
      const user = createUser(getDb(), {
        slug,
        kind: kind as UserKind,
        display_name: display,
        email: "email" in body ? (optionalString(body, "email") ?? null) : null,
        status: (optionalString(body, "status") as UserStatus | undefined) ?? undefined,
        metadata: optionalMetadata(body),
      });
      sendJson(res, 201, { user });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.get("/api/users/:ref/credentials", (req, res) => {
    try {
      const query = req.query ?? {};
      const includeRevoked = query.all === "1" || query.all === "true";
      const credentials = listCredentials(getDb(), req.params.ref, { includeRevoked });
      sendJson(res, 200, { credentials });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/users/:ref/credentials", (req, res) => {
    try {
      const body = bodyRecord(req);
      const type = optionalString(body, "type");
      const fingerprint = optionalString(body, "fingerprint");
      if (!type) throw new UserRegistryError("invalid", "type is required.");
      if (!fingerprint) throw new UserRegistryError("invalid", "fingerprint is required.");
      const credential = addCredential(getDb(), req.params.ref, {
        type,
        fingerprint,
        public_material: "public_material" in body
          ? (optionalString(body, "public_material") ?? null)
          : null,
        label: optionalString(body, "label") ?? null,
        metadata: optionalMetadata(body),
      });
      sendJson(res, 201, { credential });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.get("/api/users/:ref/bindings", (req, res) => {
    try {
      sendJson(res, 200, { bindings: listBindings(getDb(), req.params.ref) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.post("/api/users/:ref/bindings", (req, res) => {
    try {
      const body = bodyRecord(req);
      const bindingType = optionalString(body, "binding_type");
      const value = optionalString(body, "value");
      if (!bindingType) throw new UserRegistryError("invalid", "binding_type is required.");
      if (!value) throw new UserRegistryError("invalid", "value is required.");
      const binding = addBinding(getDb(), req.params.ref, {
        binding_type: bindingType as BindingType,
        value,
        scope: "scope" in body ? (optionalString(body, "scope") ?? null) : null,
      });
      sendJson(res, 201, { binding });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.get("/api/users/:ref", (req, res) => {
    try {
      sendJson(res, 200, { user: userView(getDb(), req.params.ref) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  router.patch("/api/users/:ref", (req, res) => {
    try {
      const body = bodyRecord(req);
      const user = updateUser(getDb(), req.params.ref, {
        display_name: optionalString(body, "display_name"),
        email: "email" in body ? (optionalString(body, "email") ?? null) : undefined,
        status: optionalString(body, "status") as UserStatus | undefined,
        metadata: optionalMetadata(body),
      });
      sendJson(res, 200, { user });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });
}
