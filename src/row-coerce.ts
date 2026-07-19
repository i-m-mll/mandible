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
