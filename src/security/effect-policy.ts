import fs from "node:fs";
import path from "node:path";
import type { InstanceInfo } from "../types.js";

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
] as const;

export type Effect = (typeof EFFECTS)[number];

export const PRODUCTION_EFFECTS: readonly Effect[] = EFFECTS;
export const STANDARD_PREVIEW_EFFECTS: readonly Effect[] = [
  "ledger:read",
  "ledger:write",
  "files:preview",
];

export type Operation = {
  id: string;
  effects: readonly Effect[];
};

const READ_OPERATION: Operation = { id: "ledger.read", effects: ["ledger:read"] };
const LOCAL_WRITE_OPERATION: Operation = { id: "ledger.write", effects: ["ledger:write"] };

const EXACT_OPERATIONS = new Map<string, Operation>([
  ["GET /api/health", { id: "health.read", effects: [] }],
  ["GET /api/instance", { id: "instance.read", effects: [] }],
  ["GET /api/client-auth/whoami", { id: "session.inspect", effects: [] }],
  ["POST /api/users/setup", { id: "installation.setup", effects: [] }],
  ["POST /api/auth/check", READ_OPERATION],
  ["POST /api/timeline/project", READ_OPERATION],
  ["POST /api/events/subscribe", READ_OPERATION],
  ["POST /api/briefing-destination-routes/plan", READ_OPERATION],
  ["POST /api/client-auth/pairing/start", { id: "session.pairing.start", effects: [] }],
  ["POST /api/client-auth/pairing/complete", { id: "session.pairing.complete", effects: [] }],
  ["POST /api/client-auth/renew", { id: "session.renew", effects: [] }],
  ["POST /api/client-auth/logout", { id: "session.logout", effects: [] }],
  ["POST /api/client-auth/logout-everywhere", { id: "session.logout_everywhere", effects: [] }],
  ["GET /api/client-auth/forward-auth", { id: "session.forward_auth", effects: [] }],
  ["PUT /api/host-preferences/chat-shown-projects", { id: "preferences.shared", effects: ["maintenance:shared"] }],
  ["PUT /api/host-preferences/app-theme", { id: "preferences.shared", effects: ["maintenance:shared"] }],
]);

const RESTRICTED_PREFIXES: ReadonlyArray<[string, Operation]> = [
  ["/api/auth", { id: "auth.protected", effects: ["auth:protected"] }],
  ["/api/users", { id: "auth.credentials", effects: ["auth:credentials"] }],
  ["/api/client-auth", { id: "auth.credentials", effects: ["auth:credentials"] }],
  ["/api/admin", { id: "admin", effects: ["auth:protected", "maintenance:shared"] }],
  ["/api/console", { id: "console.process", effects: ["process:external"] }],
  ["/api/agent-dispatch", { id: "agent.dispatch", effects: ["process:external"] }],
  ["/api/conversation-spawns", { id: "provider.send", effects: ["provider:send"] }],
  ["/api/reminders", { id: "delivery.background", effects: ["delivery:background"] }],
  ["/api/webhooks", { id: "network.publish", effects: ["network:publish"] }],
  ["/api/runtime", { id: "runtime.files", effects: ["files:production", "process:external"] }],
  ["/api/backup", { id: "backup.production", effects: ["files:production"] }],
  ["/api/settings/instructions", { id: "instructions.install", effects: ["files:production"] }],
];

export function operationForRequest(method: string, pathname: string): Operation | null {
  const normalizedMethod = method.toUpperCase();
  const exact = EXACT_OPERATIONS.get(`${normalizedMethod} ${pathname}`);
  if (exact) return exact;
  if (!pathname.startsWith("/api/")) return null;
  if (normalizedMethod === "POST"
      && /^\/api\/conversations\/[^/]+\/control\/(submit|stop)$/.test(pathname)) {
    return { id: "provider.send", effects: ["provider:send"] };
  }
  for (const [prefix, operation] of RESTRICTED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return operation;
  }
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") return READ_OPERATION;
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(normalizedMethod)) return null;
  return LOCAL_WRITE_OPERATION;
}

export function authorizeEffects(
  instance: InstanceInfo,
  identity: { effect_ceiling: readonly Effect[] } | null,
  operation: Operation | null,
): { allowed: true } | { allowed: false; code: string; missing: Effect[] } {
  if (!operation) return { allowed: false, code: "unknown_operation", missing: [] };
  if (operation.effects.length === 0) return { allowed: true };
  if (!identity) return { allowed: false, code: "authentication_required", missing: [...operation.effects] };
  const sessionEffects = new Set(identity.effect_ceiling);
  const instanceEffects = new Set(instance.allowed_effects);
  const missing = operation.effects.filter(
    (effect) => !sessionEffects.has(effect) || !instanceEffects.has(effect),
  );
  return missing.length === 0
    ? { allowed: true }
    : { allowed: false, code: "effect_forbidden", missing };
}

export function effectsForInstance(role: InstanceInfo["role"]): readonly Effect[] {
  return role === "preview" ? STANDARD_PREVIEW_EFFECTS : PRODUCTION_EFFECTS;
}

export function validatePreviewWritableRoots(instance: InstanceInfo): void {
  if (instance.role !== "preview") return;
  if (!instance.preview_root || !instance.db_path || !instance.source_db_path) {
    throw new Error("Preview registration is missing its custody roots.");
  }
  const previewRoot = canonicalDirectory(instance.preview_root);
  const database = canonicalFile(instance.db_path);
  const source = canonicalFile(instance.source_db_path);
  if (sameFile(database, source) || !inside(previewRoot, database)) {
    throw new Error("Preview database is not an isolated file beneath its registered root.");
  }
  for (const root of instance.writable_roots) {
    const canonical = canonicalDirectory(root);
    if (canonical !== previewRoot && !inside(previewRoot, canonical)) {
      throw new Error(`Preview writable root escapes registered custody: ${root}`);
    }
  }
}

function canonicalDirectory(value: string): string {
  const canonical = fs.realpathSync.native(value);
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`Expected a directory: ${value}`);
  return canonical;
}

function canonicalFile(value: string): string {
  const canonical = fs.realpathSync.native(value);
  if (!fs.statSync(canonical).isFile()) throw new Error(`Expected a file: ${value}`);
  return canonical;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sameFile(left: string, right: string): boolean {
  const a = fs.statSync(left, { bigint: true });
  const b = fs.statSync(right, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
}
