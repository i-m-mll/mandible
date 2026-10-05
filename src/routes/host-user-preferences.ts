import { ClientAuthzError, requireIdentity } from "../client-auth/authz.js";
import {
  HostUserPreferencesError,
  HostUserPreferencesRevisionConflict,
  HostUserPreferencesStore,
  normalizeAppTheme,
  normalizeChatShownProjects,
  normalizeSidebarOrderPreferenceValue,
} from "../host-user-preferences.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import { bodyRecord, sendJson } from "./http.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof HostUserPreferencesRevisionConflict) {
    sendJson(res, 409, {
      error: error.message,
      code: "preference_revision_conflict",
      expected_revision: error.expectedRevision,
      current: error.current,
    });
    return;
  }
  if (error instanceof HostUserPreferencesError) {
    sendJson(res, error.code === "invalid_user_id" ? 400 : 500, {
      error: error.message,
      code: `host_preferences_${error.code}`,
    });
    return;
  }
  throw error;
}

export function registerHostUserPreferencesRoutes(
  server: RouteRegistrar,
  store = new HostUserPreferencesStore(),
): void {
  server.get("/api/host-preferences/chat-shown-projects", async (req, res) => {
    try {
      const identity = requireIdentity(req);
      sendJson(res, 200, await store.readChatShownProjects(identity.user_id));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/host-preferences/chat-shown-projects", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  // A host preference is user-owned UI intent, not an operational/ledger
  // mutation. The route deliberately remains available on reject-mode previews.
  server.put("/api/host-preferences/chat-shown-projects", async (req, res) => {
    try {
      const identity = requireIdentity(req);
      const body = bodyRecord(req);
      const value = normalizeChatShownProjects(body.value);
      if (!Number.isSafeInteger(body.expected_revision) || (body.expected_revision as number) < 0) {
        sendJson(res, 400, { error: "Missing or invalid expected_revision", code: "invalid_preference_revision" });
        return;
      }
      if (value === null) {
        sendJson(res, 400, { error: "Invalid shown project selection", code: "invalid_chat_shown_projects" });
        return;
      }
      sendJson(res, 200, await store.writeChatShownProjects(
        identity.user_id,
        body.expected_revision as number,
        value,
      ));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "put:/api/host-preferences/chat-shown-projects", effects: ["preferences:instance"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/host-preferences/sidebar-order", async (req, res) => {
    try {
      const identity = requireIdentity(req);
      sendJson(res, 200, await store.readSidebarOrder(identity.user_id));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/host-preferences/sidebar-order", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.put("/api/host-preferences/sidebar-order", async (req, res) => {
    try {
      const identity = requireIdentity(req);
      const body = bodyRecord(req);
      const value = normalizeSidebarOrderPreferenceValue(body.value);
      if (!Number.isSafeInteger(body.expected_revision) || (body.expected_revision as number) < 0) {
        sendJson(res, 400, { error: "Missing or invalid expected_revision", code: "invalid_preference_revision" });
        return;
      }
      if (value === null) {
        sendJson(res, 400, { error: "Invalid sidebar order", code: "invalid_sidebar_order" });
        return;
      }
      sendJson(res, 200, await store.writeSidebarOrder(
        identity.user_id,
        body.expected_revision as number,
        value,
      ));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "put:/api/host-preferences/sidebar-order", effects: ["preferences:instance"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/host-preferences/app-theme", async (req, res) => {
    try {
      const identity = requireIdentity(req);
      sendJson(res, 200, await store.readAppTheme(identity.user_id));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/host-preferences/app-theme", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.put("/api/host-preferences/app-theme", async (req, res) => {
    try {
      const identity = requireIdentity(req);
      const body = bodyRecord(req);
      const value = normalizeAppTheme(body.value);
      if (!Number.isSafeInteger(body.expected_revision) || (body.expected_revision as number) < 0) {
        sendJson(res, 400, { error: "Missing or invalid expected_revision", code: "invalid_preference_revision" });
        return;
      }
      if (value === null) {
        sendJson(res, 400, { error: "Invalid app theme", code: "invalid_app_theme" });
        return;
      }
      sendJson(res, 200, await store.writeAppTheme(identity.user_id, body.expected_revision as number, value));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "put:/api/host-preferences/app-theme", effects: ["preferences:instance"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
}
