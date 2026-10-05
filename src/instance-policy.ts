import fs from "node:fs";
import path from "node:path";
import type {
  InstanceInfo,
  InstanceRole,
} from "./types.js";
import {
  effectsForInstance,
  type Effect,
} from "./security/effect-policy.js";
import { getMandibleConfigPath, getMandibleHomePath } from "./platform-paths.js";
import { PRODUCTION_ORIGIN } from "./canonical-origin.js";

export function resolveInstanceInfo(options: {
  env?: NodeJS.ProcessEnv;
  dbPath?: string | null;
  dbPathSource?: string | null;
  sourceDbPath?: string | null;
  sourceDbPathSource?: string | null;
} = {}): InstanceInfo {
  const env = options.env ?? process.env;
  const role = normalizeRole(env.MANDIBLE_INSTANCE_ROLE);
  const dbPath = options.dbPath ?? env.MANDIBLE_DB ?? null;
  const dbPathSource = options.dbPathSource
    ?? env.MANDIBLE_INSTANCE_DB_PATH_SOURCE
    ?? (options.dbPath ? "start_options" : env.MANDIBLE_DB ? "env" : "default");
  const sourceDbPath = options.sourceDbPath ?? env.MANDIBLE_INSTANCE_SOURCE_DB ?? null;
  const sourceDbPathSource = options.sourceDbPathSource
    ?? (options.sourceDbPath ? "start_options" : env.MANDIBLE_INSTANCE_SOURCE_DB ? "env" : null);
  const resolvedDbPath = dbPath ? path.resolve(dbPath) : null;
  const resolvedSourceDbPath = sourceDbPath ? path.resolve(sourceDbPath) : null;
  const resolvedPreviewRoot = env.MANDIBLE_PREVIEW_ROOT
    ? path.resolve(env.MANDIBLE_PREVIEW_ROOT)
    : null;
  const resolvedArtifactRoot = env.MANDIBLE_ARTIFACT_DIR
    ? path.resolve(env.MANDIBLE_ARTIFACT_DIR)
    : null;
  const resolvedSourceArtifactRoot = env.MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR
    ? path.resolve(env.MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR)
    : null;
  const configuredUserPreferencesRoot = env.MANDIBLE_USER_PREFERENCES_DIR?.trim() ?? "";
  if (configuredUserPreferencesRoot && !path.isAbsolute(configuredUserPreferencesRoot)) {
    throw new Error("MANDIBLE_USER_PREFERENCES_DIR must be an absolute path.");
  }
  const userPreferencesRoot = configuredUserPreferencesRoot
    ? path.resolve(configuredUserPreferencesRoot)
    : getMandibleHomePath("settings", "users");
  const instanceId = env.MANDIBLE_INSTANCE_ID?.trim()
    || (role === "main" ? "production" : "");
  const installationId = resolveInstallationId(env);
  const publicOrigin = exactOrigin(
    env.MANDIBLE_PUBLIC_ORIGIN
      || (role === "main" ? PRODUCTION_ORIGIN : ""),
  );
  const backendGeneration = env.MANDIBLE_BACKEND_GENERATION?.trim()
    || (role === "main" ? "production" : "");
  if (!instanceId || !publicOrigin || !backendGeneration) {
    throw new Error("Preview startup requires an exact instance id, public origin, and backend generation.");
  }
  if (role === "preview" && (
    !hasIsolatedDatabaseCopy(resolvedDbPath, resolvedSourceDbPath)
    || !isPathWithinRoot(resolvedDbPath, resolvedPreviewRoot)
    || isPathAtOrWithinRoot(resolvedSourceDbPath, resolvedPreviewRoot)
  )) {
    throw new Error("Preview startup requires an isolated copied database beneath its registered root.");
  }
  if (role === "preview" && (
    !configuredUserPreferencesRoot
    || !isPathWithinRoot(userPreferencesRoot, resolvedPreviewRoot)
  )) {
    throw new Error("Preview startup requires an isolated user-preferences directory beneath its registered root.");
  }
  const writableRoots = parseWritableRoots(env.MANDIBLE_WRITABLE_ROOTS, resolvedPreviewRoot, role);
  if (role === "preview" && writableRoots.some((root) => !isPathAtOrWithinRoot(root, resolvedPreviewRoot))) {
    throw new Error("Preview writable roots must remain beneath the registered preview root.");
  }
  const allowedEffects = parseAllowedEffects(env.MANDIBLE_ALLOWED_EFFECTS, role);

  return {
    role,
    instance_id: instanceId,
    installation_id: installationId,
    public_origin: publicOrigin,
    backend_generation: backendGeneration,
    allowed_effects: allowedEffects,
    writable_roots: writableRoots,
    preview_root: resolvedPreviewRoot,
    user_preferences_root: userPreferencesRoot,
    artifact_root: resolvedArtifactRoot,
    source_artifact_root: resolvedSourceArtifactRoot,
    db_path: resolvedDbPath,
    db_path_source: dbPathSource,
    source_db_path: resolvedSourceDbPath,
    source_db_path_source: sourceDbPathSource,
  };
}

function resolveInstallationId(env: NodeJS.ProcessEnv): string {
  const explicit = env.MANDIBLE_INSTALLATION_ID?.trim();
  if (explicit) return explicit;
  if (env !== process.env) return "test-installation";
  const authorityPath = getMandibleConfigPath("client-auth", "authority-id");
  if (!fs.existsSync(authorityPath)) {
    throw new Error("Local installation authority is missing; run `npm run local-front-door -- initialize` first.");
  }
  const value = fs.readFileSync(authorityPath, "utf8").trim();
  if (!value) throw new Error("Local installation authority is empty.");
  return value;
}

function isPathWithinRoot(candidate: string | null, root: string | null): boolean {
  if (candidate === null || root === null) return false;
  try {
    const canonicalCandidate = fs.realpathSync.native(candidate);
    const canonicalRoot = fs.realpathSync.native(root);
    const relative = path.relative(canonicalRoot, canonicalCandidate);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function isPathAtOrWithinRoot(candidate: string | null, root: string | null): boolean {
  if (candidate === null || root === null) return false;
  try {
    const relative = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(candidate));
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export function allowsOperationalMutations(instance: InstanceInfo): boolean {
  return instance.allowed_effects.includes("maintenance:shared");
}

function hasIsolatedDatabaseCopy(dbPath: string | null, sourceDbPath: string | null): boolean {
  if (dbPath === null || sourceDbPath === null) return false;
  try {
    const canonicalDbPath = fs.realpathSync.native(dbPath);
    const canonicalSourceDbPath = fs.realpathSync.native(sourceDbPath);
    if (canonicalDbPath === canonicalSourceDbPath) return false;

    const dbIdentity = fs.statSync(canonicalDbPath, { bigint: true });
    const sourceIdentity = fs.statSync(canonicalSourceDbPath, { bigint: true });
    if (!dbIdentity.isFile() || !sourceIdentity.isFile()) return false;
    return dbIdentity.dev !== sourceIdentity.dev || dbIdentity.ino !== sourceIdentity.ino;
  } catch {
    return false;
  }
}

function normalizeRole(value: string | undefined): InstanceRole {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "preview" || normalized === "dev" || normalized === "test") {
    return normalized;
  }
  return "main";
}

function exactOrigin(value: string): string {
  if (!value) return "";
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash || !parsed.port) {
    throw new Error(`Invalid registered HTTPS origin: ${value}`);
  }
  return parsed.origin;
}

function parseWritableRoots(raw: string | undefined, previewRoot: string | null, role: InstanceRole): string[] {
  if (raw?.trim()) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !path.isAbsolute(value))) {
      throw new Error("MANDIBLE_WRITABLE_ROOTS must be a JSON array of absolute paths.");
    }
    return parsed.map((value) => path.resolve(value));
  }
  return role === "preview" && previewRoot ? [previewRoot] : [];
}

function parseAllowedEffects(raw: string | undefined, role: InstanceRole): readonly Effect[] {
  const defaults = effectsForInstance(role);
  if (!raw?.trim()) return defaults;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => !defaults.includes(value as Effect))) {
    throw new Error("MANDIBLE_ALLOWED_EFFECTS exceeds the role's effect ceiling.");
  }
  return [...new Set(parsed as Effect[])];
}
