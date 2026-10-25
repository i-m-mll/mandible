import fs from "node:fs";
import path from "node:path";
import type { InstanceInfo } from "../types.js";
import {
  PRODUCTION_EFFECTS,
  STANDARD_PREVIEW_EFFECTS,
  type Effect,
  type Operation,
} from "./operation-policy.js";

export * from "./operation-policy.js";

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
  if (sameFile(database, source) || !inside(previewRoot, database) || inside(previewRoot, source)) {
    throw new Error("Preview database is not an isolated file beneath its registered root.");
  }
  for (const root of instance.writable_roots) {
    const canonical = canonicalDirectory(root);
    if (canonical !== previewRoot && !inside(previewRoot, canonical)) {
      throw new Error(`Preview writable root escapes registered custody: ${root}`);
    }
  }
  const configuredArtifactRoot = instance.artifact_root;
  if (!configuredArtifactRoot) {
    throw new Error("Preview startup requires an explicit private artifact root.");
  }
  const artifactRoot = canonicalDirectory(configuredArtifactRoot);
  if (!inside(previewRoot, artifactRoot)) {
    throw new Error("Preview artifact root escapes registered custody.");
  }
  const sourceArtifactRoot = instance.source_artifact_root;
  // A source installation that has never stored an artifact has no custody to alias.
  if (sourceArtifactRoot && fs.existsSync(sourceArtifactRoot)) {
    const sourceRoot = canonicalDirectory(sourceArtifactRoot);
    if (sameFile(artifactRoot, sourceRoot) || inside(previewRoot, sourceRoot)) {
      throw new Error("Preview artifact root aliases production or source custody.");
    }
  }
  if (!instance.user_preferences_root) {
    throw new Error("Preview startup requires an explicit user-preferences directory.");
  }
  const userPreferencesRoot = canonicalDirectory(instance.user_preferences_root);
  if (!inside(previewRoot, userPreferencesRoot)) {
    throw new Error("Preview user-preferences directory escapes registered custody.");
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
