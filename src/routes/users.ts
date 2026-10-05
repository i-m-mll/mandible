import { getDb } from "../db.js";
import { redactCredential } from "../credential-redaction.js";
import { PRODUCTION_EFFECTS } from "../security/effect-policy.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
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
  setupAgentUsers,
  updateUser,
  UserRegistryError,
} from "../users/store.js";
import type {
  BindingType,
  UserKind,
  UserStatus,
} from "../users/types.js";
import {
  ClientAuthzError,
  authorizeOperatorSetup,
  requireProtectedOperator as requireOperator,
  requireSelfOrOperator,
} from "../client-auth/authz.js";
import { bodyRecord, sendJson } from "./http.js";
import {
  addGrant,
  addGroup,
  addGroupMember,
  evaluateGlobalCapability,
  evaluateProjectAccess,
  GLOBAL_CAPABILITIES,
  listGrants,
  listGroupMembers,
  listGroups,
  projectAccessSettings,
  removeGrant,
  removeGroup,
  removeGroupMember,
  type PermissionSubjectType,
} from "../permissions/store.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import {
  discoverConfiguredPublicSigningKey,
  resolveOpenSshPublicKey,
} from "../signing-credential-audit.js";


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
  }, { operation: { id: "get:/api/users/operator", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.get("/api/users/operator/signing-key", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      const operator = getOperator(db);
      const credentials = operator
        ? listCredentials(db, operator.id).filter((credential) =>
            credential.type === "ssh_key" || credential.type === "delegated_ssh_key")
          .map(({ id, type, fingerprint, label }) => ({ id, type, fingerprint, label }))
        : [];
      const configured = discoverConfiguredPublicSigningKey();
      const registered = Boolean(configured.value && credentials.some((credential) =>
        credential.fingerprint === configured.value!.fingerprint));
      sendJson(res, 200, {
        audit: {
          status: !operator
            ? "no_operator"
            : !configured.configured_key
              ? "unconfigured"
              : !configured.value
                ? "unresolvable"
                : registered
                  ? "ok"
                  : "missing_credential",
          configured: Boolean(configured.configured_key),
          fingerprint: configured.value?.fingerprint ?? null,
          operator_slug: operator?.slug ?? null,
          reason: configured.reason,
          hint: configured.configured_key && configured.value && !registered
            ? "Register the configured public key."
            : null,
        },
        credentials,
        git_config_read: true,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/users/operator/signing-key", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:read"] : ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  router.post("/api/users/operator/signing-key", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      const operator = getOperator(db);
      if (!operator) throw new UserRegistryError("not_found", "The local operator is not set up.");
      const body = bodyRecord(req);
      const source = optionalString(body, "source");
      let resolved: ReturnType<typeof resolveOpenSshPublicKey>;
      if (source === "public_key") {
        const publicKey = optionalString(body, "public_key");
        if (!publicKey) throw new UserRegistryError("invalid", "Paste or upload an OpenSSH public key.");
        resolved = resolveOpenSshPublicKey(publicKey);
      } else if (source === "configured") {
        const configured = discoverConfiguredPublicSigningKey();
        if (!configured.configured_key) {
          throw new UserRegistryError("invalid", "Global Git user.signingkey is not configured. Paste or upload an OpenSSH public key instead.");
        }
        resolved = configured.value
          ? { ok: true, value: configured.value }
          : { ok: false, reason: configured.reason ?? "public_key_not_available_without_private_key_access" };
      } else {
        throw new UserRegistryError("invalid", "Choose an available OpenSSH public key source.");
      }
      if (!resolved.ok) {
        const message = resolved.reason === "expected_one_openssh_public_key_line"
          ? "Provide exactly one OpenSSH public-key line."
          : "The selected value is not a readable OpenSSH public key.";
        throw new UserRegistryError("invalid", message);
      }

      const existing = listCredentials(db, operator.id).find((credential) =>
        credential.fingerprint === resolved.value.fingerprint
        && (credential.type === "ssh_key" || credential.type === "delegated_ssh_key"));
      const credential = existing ?? addCredential(db, operator.id, {
        type: "ssh_key",
        fingerprint: resolved.value.fingerprint,
        public_material: resolved.value.material,
        label: source === "configured" ? "global git user.signingkey" : "Settings public-key import",
      });
      sendJson(res, existing ? 200 : 201, { credential, unchanged: Boolean(existing) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/users/operator/signing-key", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write"] : ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "deny" });

  router.post("/api/users/setup", (req, res) => {
    try {
      const db = getDb();
      // First-run setup is the explicit bootstrap path. Once an operator
      // exists, every identity/configuration update requires that operator's
      // authenticated token; generic settings can never reassign it.
      authorizeOperatorSetup(db, req);
      const body = bodyRecord(req);
      const setupAgents = body.setup_agents === true;
      const { user, agents } = db.transaction(() => {
        const user = setupOperator(db, {
          slug: optionalString(body, "slug"),
          display_name: optionalString(body, "display_name"),
          email: "email" in body ? (optionalString(body, "email") ?? null) : undefined,
          metadata: optionalMetadata(body),
        });
        return { user, agents: setupAgents ? setupAgentUsers(db) : [] };
      })();
      sendJson(res, 200, { user, agents });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/users/setup", effects: ({ instanceRole }) => instanceRole === "preview" ? ["auth:credentials"] : [], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

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
  }, { operation: { id: "post:/api/users/credentials/:id/revoke", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  // Issue b3e4a09 — retroactive credential redaction.
  //
  // Operator-only, like every other credential-administration route here: this
  // rewrites stored conversation text and, with patch_sources, the operator's
  // own transcript files. It deliberately accepts revoked credentials, because
  // the recommended remediation order is rotate (revoke) and then redact.
  //
  // The response carries counts and ids only. The matched plaintext is never
  // returned, logged, or echoed — the daemon holds the token pepper and does all
  // verification internally, which is also why this cannot be a client-side
  // command. fileRpc is "allow" for the same reason the sibling
  // /api/conversations/scan-credentials sweep is: the work is daemon-side in
  // every transport, and requireOperator — not the transport — is the gate that
  // keeps agents out.
  router.post("/api/users/credentials/:id/redact", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      const body = bodyRecord(req);
      sendJson(res, 200, redactCredential(db, req.params.id, {
        patchSources: body.patch_sources === true,
      }));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/users/credentials/:id/redact", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.delete("/api/users/bindings/:id", (req, res) => {
    try {
      const db = getDb();
      // Bindings decide which identity a spawned client receives. They are
      // operator-administered configuration, not self-service profile data.
      requireOperator(db, req);
      removeBinding(db, req.params.id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/users/bindings/:id", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.get("/api/users/groups", (_req, res) => {
    try {
      sendJson(res, 200, { groups: listGroups(getDb()) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/users/groups", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/users/groups", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      const body = bodyRecord(req);
      const slug = optionalString(body, "slug");
      if (!slug) throw new UserRegistryError("invalid", "slug is required.");
      sendJson(res, 201, {
        group: addGroup(db, { slug, display_name: optionalString(body, "display_name") }),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/users/groups", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.delete("/api/users/groups/:ref", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      removeGroup(db, req.params.ref);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/users/groups/:ref", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.get("/api/users/groups/:ref/members", (req, res) => {
    try {
      sendJson(res, 200, { members: listGroupMembers(getDb(), req.params.ref) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/users/groups/:ref/members", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/users/groups/:ref/members", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      const user = optionalString(bodyRecord(req), "user");
      if (!user) throw new UserRegistryError("invalid", "user is required.");
      addGroupMember(db, req.params.ref, user);
      sendJson(res, 200, { members: listGroupMembers(db, req.params.ref) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/users/groups/:ref/members", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.delete("/api/users/groups/:ref/members/:user", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      removeGroupMember(db, req.params.ref, req.params.user);
      sendJson(res, 200, { members: listGroupMembers(db, req.params.ref) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/users/groups/:ref/members/:user", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.get("/api/users/grants", (req, res) => {
    try {
      const resourceType = req.query.resource_type;
      sendJson(res, 200, {
        grants: listGrants(getDb(), {
          resource_type: resourceType === "project" || resourceType === "global"
            ? resourceType
            : undefined,
          resource_id: req.query.resource_id || undefined,
        }),
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/users/grants", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/users/grants", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      const body = bodyRecord(req);
      const subjectType = optionalString(body, "subject_type");
      const subject = optionalString(body, "subject");
      const resourceType = optionalString(body, "resource_type");
      const permission = optionalString(body, "permission");
      if (subjectType !== "user" && subjectType !== "group") {
        throw new UserRegistryError("invalid", "subject_type must be user or group.");
      }
      if (!subject || !permission || (resourceType !== "project" && resourceType !== "global")) {
        throw new UserRegistryError("invalid", "subject, resource_type, and permission are required.");
      }
      sendJson(res, 201, { grant: addGrant(db, {
        subject_type: subjectType as PermissionSubjectType,
        subject,
        resource_type: resourceType,
        resource: optionalString(body, "resource"),
        permission,
      }) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/users/grants", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.delete("/api/users/grants/:id", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      removeGrant(db, req.params.id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "delete:/api/users/grants/:id", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.get("/api/users/:ref/access", (req, res) => {
    try {
      const db = getDb();
      const user = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, user.id);
      const projectRef = req.query.project;
      const project = resolveProjectRef(db, projectRef ?? "");
      if (!project.ok || !project.project || project.ambiguous) {
        throw new UserRegistryError("not_found", `No project matches '${projectRef ?? ""}'.`);
      }
      const identity = {
        user_id: user.id,
        slug: user.slug,
        method: "api_token" as const,
        credential_id: null,
        source: "in_process" as const,
        effect_ceiling: PRODUCTION_EFFECTS,
      };
      const projectAccess = evaluateProjectAccess(db, {
        identity,
        project_id: project.project.id,
        required_role: "read",
      });
      const capabilities = Object.fromEntries(GLOBAL_CAPABILITIES.map((capability) => [
        capability,
        evaluateGlobalCapability(db, { identity, capability }).allowed,
      ]));
      sendJson(res, 200, {
        user,
        project: project.project,
        access: projectAccess,
        project_settings: projectAccessSettings(db, project.project.id),
        global_capabilities: capabilities,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/users/:ref/access", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

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
  }, { operation: { id: "get:/api/users", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/users", (req, res) => {
    try {
      requireOperator(getDb(), req);
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
  }, { operation: { id: "post:/api/users", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.get("/api/users/:ref/credentials", (req, res) => {
    try {
      const db = getDb();
      const target = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, target.id);
      const query = req.query ?? {};
      const includeRevoked = query.all === "1" || query.all === "true";
      const credentials = listCredentials(db, target.id, { includeRevoked });
      sendJson(res, 200, { credentials });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/users/:ref/credentials", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/users/:ref/credentials", (req, res) => {
    try {
      const db = getDb();
      const target = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, target.id);
      const body = bodyRecord(req);
      const type = optionalString(body, "type");
      const fingerprint = optionalString(body, "fingerprint");
      if (!type) throw new UserRegistryError("invalid", "type is required.");
      if (!fingerprint) throw new UserRegistryError("invalid", "fingerprint is required.");
      const credential = addCredential(db, target.id, {
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
  }, { operation: { id: "post:/api/users/:ref/credentials", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.get("/api/users/:ref/bindings", (req, res) => {
    try {
      sendJson(res, 200, { bindings: listBindings(getDb(), req.params.ref) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/users/:ref/bindings", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/users/:ref/bindings", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      const body = bodyRecord(req);
      const bindingType = optionalString(body, "binding_type");
      const value = optionalString(body, "value");
      if (!bindingType) throw new UserRegistryError("invalid", "binding_type is required.");
      if (!value) throw new UserRegistryError("invalid", "value is required.");
      const binding = addBinding(db, req.params.ref, {
        binding_type: bindingType as BindingType,
        value,
        scope: "scope" in body ? (optionalString(body, "scope") ?? null) : null,
      });
      sendJson(res, 201, { binding });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "post:/api/users/:ref/bindings", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });

  router.get("/api/users/:ref", (req, res) => {
    try {
      const db = getDb();
      const target = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, target.id);
      sendJson(res, 200, { user: userView(db, target.id) });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/users/:ref", effects: ["auth:credentials"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.patch("/api/users/:ref", (req, res) => {
    try {
      const db = getDb();
      const target = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, target.id);
      const body = bodyRecord(req);
      // Lifecycle status is an operator-owned credential boundary. In
      // particular, a retired account must never use one lingering client
      // identity to make itself active again.
      if ("status" in body) requireOperator(db, req);
      const user = updateUser(db, target.id, {
        display_name: optionalString(body, "display_name"),
        email: "email" in body ? (optionalString(body, "email") ?? null) : undefined,
        status: optionalString(body, "status") as UserStatus | undefined,
        metadata: optionalMetadata(body),
      });
      sendJson(res, 200, { user });
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "patch:/api/users/:ref", effects: ["auth:credentials"], requestSchema: null, reportingCategory: "api" }, fileRpc: "allow" });
}
