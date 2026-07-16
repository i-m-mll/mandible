/**
 * Auth hooks CRUD routes.
 * Bug: 4afab83
 */

import { AuthHookManager } from "../auth-hooks.js";
import type { RouteRegistrar } from "../server.js";
import type { AuthHookInput, AuthRequestType } from "../types.js";
import { readBody } from "./http.js";

const VALID_AUTH_TYPES: AuthRequestType[] = [
  "merge", "commit", "force-push", "branch-delete", "config-change", "preset-promote", "data-delete"
];

export function registerAuthHookRoutes(app: RouteRegistrar, manager?: AuthHookManager): AuthHookManager {
  const hookManager = manager ?? new AuthHookManager();

  // List all hooks
  app.get("/api/auth/hooks", (_req, res) => {
    const hooks = hookManager.list();
    res.json({ hooks });
  }, { fileRpc: "deny" });

  // Get a single hook
  app.get("/api/auth/hooks/:id", (req, res) => {
    const hook = hookManager.get(req.params.id);
    if (!hook) {
      res.status(404).json({ error: "Hook not found." });
      return;
    }
    res.json(hook);
  }, { fileRpc: "deny" });

  // Create a new hook
  app.post("/api/auth/hooks", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    const parsed = parseHookInput(body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const hook = hookManager.create(parsed.input);
    res.status(201).json(hook);
  }, { fileRpc: "deny" });

  // Update an existing hook
  app.put("/api/auth/hooks/:id", (req, res) => {
    const body = readBody<Record<string, unknown>>(req);
    const fields = parseHookUpdateFields(body);

    const updated = hookManager.update(req.params.id, fields);
    if (!updated) {
      res.status(404).json({ error: "Hook not found." });
      return;
    }
    res.json(updated);
  }, { fileRpc: "deny" });

  // Delete a hook (built-in hooks cannot be deleted)
  app.delete("/api/auth/hooks/:id", (req, res) => {
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
  }, { fileRpc: "deny" });

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

  const authType = typeof body.auth_type === "string" && VALID_AUTH_TYPES.includes(body.auth_type as AuthRequestType)
    ? (body.auth_type as AuthRequestType)
    : null;
  if (!authType) {
    return { ok: false, error: `auth_type is required — must be one of: ${VALID_AUTH_TYPES.join(", ")}` };
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
    },
  };
}

function parseHookUpdateFields(body: Record<string, unknown>): Partial<AuthHookInput> & { enabled?: boolean } {
  const fields: Partial<AuthHookInput> & { enabled?: boolean } = {};

  if (typeof body.repo_pattern === "string") fields.repo_pattern = body.repo_pattern;
  if (typeof body.auth_type === "string" && VALID_AUTH_TYPES.includes(body.auth_type as AuthRequestType)) {
    fields.auth_type = body.auth_type as AuthRequestType;
  }
  if (typeof body.command === "string") fields.command = body.command;
  if (typeof body.label === "string") fields.label = body.label;
  if (typeof body.enabled === "boolean") fields.enabled = body.enabled;
  if (typeof body.position === "number" && Number.isFinite(body.position)) fields.position = body.position;

  return fields;
}
