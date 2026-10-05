import { ClientAuthzError, requireIdentity } from "../client-auth/authz.js";
import { USER_SETTING_EVENTS } from "../contracts.js";
import { getDb, type Db } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { broadcast } from "../sse.js";
import {
  parseUserSettingKey,
  normalizeUserSettingValue,
  readUserSetting,
  writeUserSetting,
} from "../user-settings.js";
import { readBody, sendJson } from "./http.js";

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  throw error;
}

function settingKey(req: RequestLike, res: ResponseLike) {
  const key = parseUserSettingKey(req.params.key ?? "");
  if (!key) {
    sendJson(res, 404, { error: "User setting not found", code: "user_setting_not_found" });
    return null;
  }
  return key;
}

export function registerUserSettingsRoutes(server: RouteRegistrar, db: Db = getDb()): void {
  server.get("/api/user-settings/:key", (req, res) => {
    try {
      const identity = requireIdentity(req);
      const key = settingKey(req, res);
      if (!key) return;
      sendJson(res, 200, readUserSetting(db, identity.user_id, key));
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "get:/api/user-settings/:key", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.put("/api/user-settings/:key", (req, res) => {
    try {
      const identity = requireIdentity(req);
      const key = settingKey(req, res);
      if (!key) return;
      const body = readBody<{ value?: unknown }>(req);
      if (typeof body.value !== "string") {
        sendJson(res, 400, { error: "Missing or invalid value (must be string)" });
        return;
      }
      const value = normalizeUserSettingValue(key, body.value);
      if (value === null) {
        sendJson(res, 400, { error: "Invalid value for user setting", code: "invalid_user_setting_value" });
        return;
      }
      const snapshot = writeUserSetting(db, identity.user_id, key, value);
      broadcast(USER_SETTING_EVENTS.updated, {
        version: 1,
        key: snapshot.key,
        revision: snapshot.revision,
      });
      sendJson(res, 200, snapshot);
    } catch (error) {
      handleError(res, error);
    }
  }, { operation: { id: "put:/api/user-settings/:key", effects: ["preferences:instance"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
}
