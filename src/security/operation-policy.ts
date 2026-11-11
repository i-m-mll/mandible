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
  "notes:source",
] as const;

export type Effect = (typeof EFFECTS)[number];

export const PRODUCTION_EFFECTS: readonly Effect[] = EFFECTS;
/** `notes:source`: write interface notes to the instance this preview was copied from. */
export const STANDARD_PREVIEW_EFFECTS: readonly Effect[] = [
  "ledger:read",
  "ledger:write",
  "files:preview",
  "preferences:instance",
  "notes:source",
];

export type Operation = {
  id: string;
  effects: readonly Effect[];
  operatorPresence?: boolean;
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
  instanceEffects: readonly Effect[];
  body: unknown;
  params: Readonly<Record<string, string>>;
}

export interface OperationDescriptor {
  operatorPresence?: boolean;
  id: string;
  effects: readonly Effect[] | ((context: OperationContext) => readonly Effect[]);
  requestSchema: import("zod").ZodType | null;
  reportingCategory: string | null;
}

export function resolveOperation(descriptor: OperationDescriptor, context: OperationContext): Operation {
  const effects = typeof descriptor.effects === "function" ? descriptor.effects(context) : descriptor.effects;
  if (!Array.isArray(effects) || effects.some(effect => !EFFECTS.includes(effect))) {
    throw new Error(`Invalid effects from operation ${descriptor.id}`);
  }
  return { id: descriptor.id, effects, operatorPresence: descriptor.operatorPresence };
}

/** Whether an instance keeps interface notes in the instance it was copied from rather than in its own ledger. */
export function keepsNotesInSource(instance: { role: InstanceRole; allowed_effects: readonly Effect[] }): boolean {
  return instance.role === "preview" && instance.allowed_effects.includes("notes:source");
}

/** The effects of an interface-notes route: `local` where notes are kept in the own ledger. */
export function interfaceNoteEffects(context: OperationContext, local: "ledger:read" | "ledger:write"): readonly Effect[] {
  return keepsNotesInSource({ role: context.instanceRole, allowed_effects: context.instanceEffects }) ? ["notes:source"] : [local];
}
