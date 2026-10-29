import { AUTH_REQUEST_TYPES } from "../contracts.js";
/**
 * Auth hooks CRUD routes.
 * Bug: 4afab83
 *
 * Issue 27241e6 — registering a hook is registering a command that Mandible
 * will execute unsupervised on the operator's machine after a protected merge.
 * Reading the registry is ordinary state; mutating it is an authority grant, so
 * create/update/delete require an authenticated client that holds the
 * `change_settings` global capability. Authentication alone is not
 * authorization: strict mode proves *who* is calling, and this gate decides
 * whether that caller may widen what the daemon executes.
 */

import { AuthHookManager } from "../auth-hooks.js";
import { globalCapabilityRoute } from "../permissions/routes.js";
import type { RouteRegistrar } from "../server.js";
import type { AuthHookInput, AuthRequestType } from "../types.js";
import { readBody } from "./http.js";

// Issue 72b00f8 — custody-transfer requests complete in process and run no hooks.
const HOOKABLE_AUTH_TYPES: readonly AuthRequestType[] = AUTH_REQUEST_TYPES.filter((type) => type !== "custody-transfer");

export function registerAuthHookRoutes(app: RouteRegistrar, manager?: AuthHookManager): AuthHookManager {
  const hookManager = manager ?? new AuthHookManager();

  // List all hooks
  app.get("/api/auth/hooks", (_req, res) => {
    const hooks = hookManager.list();
    res.json({ hooks });
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/auth/hooks", effects: ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Get a single hook
  app.get("/api/auth/hooks/:id", (req, res) => {
    const hook = hookManager.get(req.params.id);
    if (!hook) {
      res.status(404).json({ error: "Hook not found." });
      return;
    }
    res.json(hook);
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/auth/hooks/:id", effects: ["auth:protected"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // Create a new hook — capability-fenced (issue 27241e6).
  app.post("/api/auth/hooks", globalCapabilityRoute("change_settings", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    const parsed = parseHookInput(body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const hook = hookManager.create(parsed.input);
    res.status(201).json(hook);
  }), { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/auth/hooks", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  // Update an existing hook — capability-fenced (issue 27241e6). Update is as
  // powerful as create: it can rewrite the command bytes of an already-trusted
  // hook, so it carries the same requirement.
  app.put("/api/auth/hooks/:id", globalCapabilityRoute("change_settings", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    const fields = parseHookUpdateFields(body);

    const updated = hookManager.update(req.params.id, fields);
    if (!updated) {
      res.status(404).json({ error: "Hook not found." });
      return;
    }
    res.json(updated);
  }), { localCliCredential: {"mode":"omit"}, operation: { id: "put:/api/auth/hooks/:id", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  // Delete a hook (built-in hooks cannot be deleted) — capability-fenced.
  // Deleting a required hook removes a convergence guarantee, so it is a
  // settings-authority change too, not a cleanup convenience.
  app.delete("/api/auth/hooks/:id", globalCapabilityRoute("change_settings", (req, res) => {
    try {
      const deleted = hookManager.delete(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Hook not found." });
        return;
      }
      res.json({ deleted: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("built-in")) {
        res.status(403).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Unexpected error." });
    }
  }), { localCliCredential: {"mode":"omit"}, operation: { id: "delete:/api/auth/hooks/:id", effects: ["auth:protected"], requestSchema: null, reportingCategory: "auth" }, fileRpc: "deny" });

  return hookManager;
}

function parseHookInput(body: Record<string, unknown>): { ok: true; input: AuthHookInput } | { ok: false; error: string } {
  if (typeof body.repo_pattern !== "string" || !body.repo_pattern.trim()) {
    return { ok: false, error: "repo_pattern is required (string)" };
  }
  if (typeof body.command !== "string" || !body.command.trim()) {
    return { ok: false, error: "command is required (string)" };
  }
  if (typeof body.label !== "string") {
    return { ok: false, error: "label is required (string)" };
  }

  const authType = typeof body.auth_type === "string" && HOOKABLE_AUTH_TYPES.includes(body.auth_type as AuthRequestType)
    ? (body.auth_type as AuthRequestType)
    : null;
  if (!authType) {
    return { ok: false, error: `auth_type is required — must be one of: ${HOOKABLE_AUTH_TYPES.join(", ")}` };
  }

  return {
    ok: true,
    input: {
      repo_pattern: body.repo_pattern as string,
      auth_type: authType,
      command: body.command as string,
      label: body.label as string,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      position: typeof body.position === "number" && Number.isFinite(body.position) ? body.position : undefined,
      required: typeof body.required === "boolean" ? body.required : undefined,
    },
  };
}

function parseHookUpdateFields(body: Record<string, unknown>): Partial<AuthHookInput> & { enabled?: boolean } {
  const fields: Partial<AuthHookInput> & { enabled?: boolean } = {};

  if (typeof body.repo_pattern === "string") fields.repo_pattern = body.repo_pattern;
  if (typeof body.auth_type === "string" && HOOKABLE_AUTH_TYPES.includes(body.auth_type as AuthRequestType)) {
    fields.auth_type = body.auth_type as AuthRequestType;
  }
  if (typeof body.command === "string") fields.command = body.command;
  if (typeof body.label === "string") fields.label = body.label;
  if (typeof body.enabled === "boolean") fields.enabled = body.enabled;
  if (typeof body.position === "number" && Number.isFinite(body.position)) fields.position = body.position;
  if (typeof body.required === "boolean") fields.required = body.required;

  return fields;
}
