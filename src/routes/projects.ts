import { getDb } from "../db.js";
import {
  addOrUpdateCheckout,
  addProject,
  auditRegistry,
  listProjects,
  ProjectRegistryError,
  repairRegistry,
  resolveProjectRef,
  suggestProjectRefs,
  updateProject,
  type AddOrUpdateProjectInput,
} from "../ledger/project-registry.js";
import type { LedgerNamespacePolicy } from "../ledger/types.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import { bodyRecord, sendJson } from "./http.js";
import { requireOperator } from "../client-auth/authz.js";
import { projectAccessSettings, setProjectRestricted } from "../permissions/store.js";


function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  return value;
}

function parseNamespacePolicy(value: unknown): LedgerNamespacePolicy | undefined {
  if (value === "remote" || value === "upstream" || value === "local") return value;
  return undefined;
}

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ProjectRegistryError) {
    const status = error.code === "not_found" ? 404 : 400;
    sendJson(res, status, { error: error.message, code: error.code, ...(error.detail ?? {}) });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

function projectUpdateInput(body: Record<string, unknown>): AddOrUpdateProjectInput {
  const input: AddOrUpdateProjectInput = {};
  if ("project_key" in body || "key" in body) {
    input.project_key = optionalString(body, "project_key") ?? optionalString(body, "key");
  }
  if ("display_name" in body || "display" in body) {
    input.display_name = optionalString(body, "display_name") ?? optionalString(body, "display");
  }
  if ("remote_identity" in body || "remote" in body) {
    input.remote_identity = optionalString(body, "remote_identity") ?? optionalString(body, "remote") ?? null;
  }
  if ("upstream_identity" in body || "upstream" in body) {
    input.upstream_identity =
      optionalString(body, "upstream_identity") ?? optionalString(body, "upstream") ?? null;
  }
  if ("namespace_policy" in body || "namespace" in body) {
    input.namespace_policy =
      parseNamespacePolicy(body.namespace_policy) ?? parseNamespacePolicy(body.namespace);
  }
  return input;
}

export function registerProjectRoutes(router: RouteRegistrar): void {
  // Literal subpaths must register before /api/projects/:ref so they are not
  // shadowed by the param route.
  router.get("/api/projects/audit", (_req, res) => {
    try {
      sendJson(res, 200, { audit: auditRegistry(getDb()) });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/projects/audit", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/projects/repair", (req, res) => {
    try {
      const body = bodyRecord(req);
      const apply = body.apply === true;
      const force = body.force === true;
      let merge: { source: string; target: string } | undefined;
      const mergeRaw = body.merge;
      if (mergeRaw && typeof mergeRaw === "object" && !Array.isArray(mergeRaw)) {
        const m = mergeRaw as Record<string, unknown>;
        const source = typeof m.source === "string" ? m.source : "";
        const target = typeof m.target === "string" ? m.target : "";
        if (source && target) merge = { source, target };
      }
      const report = repairRegistry(getDb(), { apply, force, merge });
      sendJson(res, 200, { report });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/projects/repair", effects: ["ledger:write"], requestSchema: null, reportingCategory: "projects" }, fileRpc: "allow" });

  // PATCH a checkout by root (registered under /checkouts to avoid the :ref
  // param route shadowing it).
  router.post("/api/projects/checkouts", (req, res) => {
    try {
      const body = bodyRecord(req);
      const projectRef = optionalString(body, "project") ?? optionalString(body, "project_ref");
      const root = optionalString(body, "root");
      if (!projectRef) throw new ProjectRegistryError("project is required", "missing_project");
      if (!root) throw new ProjectRegistryError("root is required", "missing_root");
      const result = addOrUpdateCheckout(getDb(), projectRef, {
        root,
        work_repo_id: optionalString(body, "work_repo_id") ?? null,
        name: optionalString(body, "name"),
        default_branch: optionalString(body, "default_branch"),
        remote_url: optionalString(body, "remote_url") ?? null,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/projects/checkouts", effects: ["ledger:write"], requestSchema: null, reportingCategory: "projects" }, fileRpc: "allow" });

  router.get("/api/projects/:ref/access", (req, res) => {
    try {
      sendJson(res, 200, projectAccessSettings(getDb(), req.params.ref));
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/projects/:ref/access", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.patch("/api/projects/:ref/access", (req, res) => {
    try {
      const db = getDb();
      requireOperator(db, req);
      const body = bodyRecord(req);
      if (typeof body.restricted !== "boolean") {
        throw new ProjectRegistryError("restricted must be a boolean", "invalid_restricted");
      }
      setProjectRestricted(db, req.params.ref, body.restricted);
      sendJson(res, 200, projectAccessSettings(db, req.params.ref));
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "patch:/api/projects/:ref/access", effects: ["ledger:write"], requestSchema: null, reportingCategory: "projects" }, fileRpc: "allow" });

  router.get("/api/projects", (_req, res) => {
    try {
      sendJson(res, 200, { projects: listProjects(getDb()) });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/projects", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.post("/api/projects", (req, res) => {
    try {
      const body = bodyRecord(req);
      const project = addProject(getDb(), projectUpdateInput(body));
      sendJson(res, 201, { project });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/projects", effects: ["ledger:write"], requestSchema: null, reportingCategory: "projects" }, fileRpc: "allow" });

  router.get("/api/projects/:ref", (req, res) => {
    try {
      const resolved = resolveProjectRef(getDb(), req.params.ref);
      if ((!resolved.ok && resolved.reason === "ambiguous")) {
        sendJson(res, 409, {
          error: `ambiguous project ref: ${req.params.ref}`,
          candidates: resolved.candidates ?? [],
        });
        return;
      }
      if (!resolved.ok) {
        sendJson(res, 404, {
          error: `project not found: ${req.params.ref}`,
          suggestions: suggestProjectRefs(getDb(), req.params.ref),
        });
        return;
      }
      sendJson(res, 200, { project: resolved.project, matched_by: resolved.matched_by });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/projects/:ref", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  router.patch("/api/projects/:ref", (req, res) => {
    try {
      const project = updateProject(getDb(), req.params.ref, projectUpdateInput(bodyRecord(req)));
      sendJson(res, 200, { project });
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "patch:/api/projects/:ref", effects: ["ledger:write"], requestSchema: null, reportingCategory: "projects" }, fileRpc: "allow" });

  router.post("/api/projects/:ref/checkouts", (req, res) => {
    try {
      const body = bodyRecord(req);
      const root = optionalString(body, "root");
      if (!root) throw new ProjectRegistryError("root is required", "missing_root");
      const result = addOrUpdateCheckout(getDb(), req.params.ref, {
        root,
        work_repo_id: optionalString(body, "work_repo_id") ?? null,
        name: optionalString(body, "name"),
        default_branch: optionalString(body, "default_branch"),
        remote_url: optionalString(body, "remote_url") ?? null,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/projects/:ref/checkouts", effects: ["ledger:write"], requestSchema: null, reportingCategory: "projects" }, fileRpc: "allow" });
}
