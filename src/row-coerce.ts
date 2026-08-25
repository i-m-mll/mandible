export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function parseJsonOr<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Read a JSON object column into a plain record.
 *
 * Anything that is not a JSON object — a non-string input, an empty or blank
 * string, invalid JSON, an array, or a scalar — yields an empty record, so a
 * caller can always read properties off the result. Callers that need to tell
 * "absent" from "present but empty" must check the column themselves; this
 * helper deliberately does not distinguish them.
 */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
