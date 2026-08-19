import type { Db } from "./db.js";
import { USER_SETTING_KEYS, type UserSettingKey } from "./contracts.js";

export type UserSettingSnapshot = {
  version: 1;
  key: UserSettingKey;
  value: string | null;
  revision: number;
};

export function parseUserSettingKey(value: string): UserSettingKey | null {
  return value === USER_SETTING_KEYS.appRailOrder ? value : null;
}

export function readUserSetting(
  db: Db,
  userId: string,
  key: UserSettingKey,
): UserSettingSnapshot {
  const row = db.prepare(
    "SELECT value, revision FROM user_settings WHERE user_id = ? AND key = ?",
  ).get(userId, key) as { value: string; revision: number } | undefined;
  return {
    version: 1,
    key,
    value: row?.value ?? null,
    revision: row?.revision ?? 0,
  };
}

export function writeUserSetting(
  db: Db,
  userId: string,
  key: UserSettingKey,
  value: string,
  now = Date.now(),
): UserSettingSnapshot {
  const row = db.prepare(
    `INSERT INTO user_settings (user_id, key, value, revision, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       revision = user_settings.revision + 1,
       updated_at = excluded.updated_at
     RETURNING value, revision`,
  ).get(userId, key, value, now) as { value: string; revision: number };
  return { version: 1, key, value: row.value, revision: row.revision };
}
