// Issue 708dc4c / finding 4 — client-auth settings are not managed through the
// generic settings API. Reads are hidden and writes/reads of a specific key 403.
const PROTECTED_SETTING_KEYS = new Set([
  "client_auth",
  "console_operator_session_id",
  "console_pinned_sessions",
  "user.operator_id",
]);

export function isProtectedIdentitySettingKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return PROTECTED_SETTING_KEYS.has(normalized) || normalized.startsWith("client_auth.");
}
