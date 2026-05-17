import { createHash } from "node:crypto";

export function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJson(value));
}

export function hashGitBugPayload(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}
