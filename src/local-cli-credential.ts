export type LocalCliCredential =
  | { mode: "omit" | "durable" | "optional" | "managed-durable" }
  | { mode: "body-nonempty"; field: string };

export function isLocalCliCredential(value: unknown): value is LocalCliCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (policy.mode === "body-nonempty") {
    return Object.keys(policy).length === 2 && typeof policy.field === "string"
      && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(policy.field);
  }
  return Object.keys(policy).length === 1
    && ["omit", "durable", "optional", "managed-durable"].includes(policy.mode as string);
}
