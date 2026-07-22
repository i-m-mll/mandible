import type { Db } from "./db.js";
import { resolveSessionAttributionResult } from "./identity/resolver.js";
import type { Logger } from "./types.js";

export interface SessionOwnershipSignals {
  app_names?: ReadonlyArray<string | null | undefined>;
  provider_session_envs?: ReadonlyArray<string | null | undefined>;
  explicit_user_id?: string | null;
}

export interface SessionOwnershipContext {
  source: string;
  entity_id?: string | null;
}

const loggedMisses = new Set<string>();

/**
 * Resolve immutable session/work-unit ownership from explicit binding signals.
 * Multiple matching signals must converge on one user. Missing or conflicting
 * claims fail closed to NULL and emit at most one warning per distinct signal
 * set and registration source.
 */
export function resolveSessionOwnerUserId(
  db: Db,
  signals: SessionOwnershipSignals,
  logger: Logger,
  context: SessionOwnershipContext,
): string | null {
  if (signals.explicit_user_id) return signals.explicit_user_id;

  const appNames = [...new Set(
    (signals.app_names ?? [])
      .map((value) => value?.trim() ?? "")
      .filter(Boolean),
  )];
  const providerSessionEnvs = [...new Set(
    (signals.provider_session_envs ?? [])
      .map((value) => value?.trim() ?? "")
      .filter(Boolean),
  )];

  if (!hasBindingTables(db)) {
    logMiss(logger, context, "no_match", appNames, providerSessionEnvs);
    return null;
  }

  const userIds = new Set<string>();
  let conflict = false;
  for (const appName of appNames) {
    const result = resolveSessionAttributionResult(db, { app_name: appName });
    if (result.status === "conflict") conflict = true;
    if (result.status === "resolved") userIds.add(result.attribution.user_id);
  }
  for (const providerSessionEnv of providerSessionEnvs) {
    const result = resolveSessionAttributionResult(db, {
      provider_session_env: providerSessionEnv,
    });
    if (result.status === "conflict") conflict = true;
    if (result.status === "resolved") userIds.add(result.attribution.user_id);
  }

  if (conflict || userIds.size > 1) {
    logMiss(logger, context, "conflict", appNames, providerSessionEnvs);
    return null;
  }
  if (userIds.size === 0) {
    logMiss(logger, context, "no_match", appNames, providerSessionEnvs);
    return null;
  }
  return [...userIds][0];
}

function hasBindingTables(db: Db): boolean {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'user_bindings')",
  ).all() as Array<{ name: string }>;
  return rows.length === 2;
}

function logMiss(
  logger: Logger,
  context: SessionOwnershipContext,
  status: "no_match" | "conflict",
  appNames: readonly string[],
  providerSessionEnvs: readonly string[],
): void {
  const key = JSON.stringify([context.source, status, appNames, providerSessionEnvs]);
  if (loggedMisses.has(key)) return;
  loggedMisses.add(key);
  logger("warn", "session_owner_binding_unresolved", {
    source: context.source,
    status,
    app_names: appNames,
    provider_session_envs: providerSessionEnvs,
    entity_id: context.entity_id ?? null,
  });
}
