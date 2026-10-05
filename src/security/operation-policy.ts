import type { InstanceRole } from "../types.js";

export const EFFECTS = [
  "ledger:read",
  "ledger:write",
  "files:preview",
  "files:production",
  "auth:protected",
  "auth:credentials",
  "process:external",
  "provider:send",
  "network:publish",
  "delivery:background",
  "maintenance:shared",
  "preferences:instance",
] as const;

export type Effect = (typeof EFFECTS)[number];

export const PRODUCTION_EFFECTS: readonly Effect[] = EFFECTS;
export const STANDARD_PREVIEW_EFFECTS: readonly Effect[] = [
  "ledger:read",
  "ledger:write",
  "files:preview",
  "preferences:instance",
];

export type Operation = {
  id: string;
  effects: readonly Effect[];
};

const INLINE_ARTIFACT_BYTE_FIELDS = new Set([
  "content", "content_base64", "json", "custody_mode", "role", "media_type",
  "filename", "logical_name", "metadata", "reference",
]);
const INLINE_SNAPSHOT_BYTE_FIELDS = new Set([...INLINE_ARTIFACT_BYTE_FIELDS, "ref", "artifact_ref"]);

/** Exact request modes whose bytes and resulting managed custody stay in the active instance. */
export function isInlineManagedArtifactByteRequest(mode: "ingest" | "snapshot", body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const input = body as Record<string, unknown>;
  const allowedFields = mode === "snapshot"
    ? INLINE_SNAPSHOT_BYTE_FIELDS
    : INLINE_ARTIFACT_BYTE_FIELDS;
  if (Object.keys(input).some((key) => !allowedFields.has(key))) return false;
  if (input.custody_mode !== undefined && input.custody_mode !== "managed") return false;
  const byteFields = ["content", "content_base64", "json"].filter((key) => Object.hasOwn(input, key));
  if (byteFields.length !== 1) return false;
  const byteField = byteFields[0];
  return byteField === "json" || typeof input[byteField] === "string";
}

export interface OperationContext {
  instanceRole: InstanceRole;
  body: unknown;
  params: Readonly<Record<string, string>>;
}

export interface OperationDescriptor {
  id: string;
  effects: readonly Effect[] | ((context: OperationContext) => readonly Effect[]);
  requestSchema: import("zod").ZodType | null;
  reportingCategory: string | null;
}

export function resolveOperation(descriptor: OperationDescriptor, context: OperationContext): Operation {
  return {
    id: descriptor.id,
    effects: typeof descriptor.effects === "function" ? descriptor.effects(context) : descriptor.effects,
  };
}
