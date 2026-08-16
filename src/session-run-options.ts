import type { BackendType } from "./agentic-backend.js";

export type SessionRunOptionValue = string | number | boolean | string[] | null;
export type SessionRunOptionKind = "select" | "multi_select" | "boolean" | "integer" | "number" | "text";

export interface SessionRunOptionChoice {
  value: string | number | boolean;
  label: string;
  description?: string;
}

export type SessionRunOptionDiscovery =
  | { kind: "static"; allowedValues: readonly SessionRunOptionChoice[] | null }
  | {
      kind: "provider";
      protocol: "acp_session_config" | "sdk_supported_models";
      providerOptionId: string;
      fallbackAllowedValues: readonly SessionRunOptionChoice[] | null;
    }
  | {
      kind: "static_then_provider";
      protocol: "acp_session_config" | "sdk_supported_models";
      providerOptionId: string;
      staticAllowedValues: readonly SessionRunOptionChoice[];
    };

export type SessionRunOptionSupport =
  | { status: "supported"; owner: "backend" | "provider"; effectiveFrom: "immediate" | "next_prompt" }
  | { status: "unsupported"; reason: string };

export interface SessionRunOptionDeclaration {
  id: string;
  label: string;
  description?: string;
  category: string;
  kind: SessionRunOptionKind;
  nullable: boolean;
  discovery: SessionRunOptionDiscovery;
  support: SessionRunOptionSupport;
  applyOrder: number;
  applyAfter?: readonly string[];
  legacyRequestKeys?: readonly string[];
}

export interface RuntimeDiscoveredOptionPolicy {
  source: "acp_session_config";
  managedCategories: readonly string[];
  managedKinds: readonly Extract<SessionRunOptionKind, "select" | "boolean">[];
  undeclaredOptions: "read_only";
}

export interface BackendRunOptionDeclaration {
  backendType: BackendType;
  command: string;
  options: readonly SessionRunOptionDeclaration[];
  runtimeDiscoveredOptions?: RuntimeDiscoveredOptionPolicy;
}

export type SessionRunOptionAvailability = "available" | "awaiting_provider" | "unavailable";
export type SessionRunOptionEnforcement =
  | { status: "unsupported"; reason: string }
  | {
      status: "awaiting_provider" | "pending" | "enforced" | "indeterminate";
      owner: "backend" | "provider";
      effectiveFrom: "immediate" | "next_prompt";
      detail?: string;
    };

export interface SessionRunOptionState {
  id: string;
  label: string;
  description?: string;
  category: string;
  kind: SessionRunOptionKind;
  nullable: boolean;
  source: "backend" | "provider" | "composed";
  availability: SessionRunOptionAvailability;
  currentValue: SessionRunOptionValue;
  allowedValues: readonly SessionRunOptionChoice[] | null;
  enforcement: SessionRunOptionEnforcement;
}

export interface SessionRunOptionsSnapshot {
  backendType: BackendType;
  command: string;
  phase: "declared" | "discovering" | "configuring" | "ready" | "blocked";
  revision: number;
  options: readonly SessionRunOptionState[];
}

export interface SessionRunOptionsPatch { values: Record<string, SessionRunOptionValue> }
export interface AppliedSessionRunOption {
  id: string;
  requestedValue: SessionRunOptionValue;
  currentValue: SessionRunOptionValue;
  effectiveFrom: "immediate" | "next_prompt";
  status: "enforced";
}
export interface SessionRunOptionsUpdateResult {
  applied: readonly AppliedSessionRunOption[];
  snapshot: SessionRunOptionsSnapshot;
}

export type SessionRunOptionErrorCode =
  | "unsupported_option"
  | "unavailable_value"
  | "provider_rejected"
  | "provider_timeout"
  | "provider_disagreement"
  | "state_indeterminate";

export class SessionRunOptionError extends Error {
  constructor(
    readonly code: SessionRunOptionErrorCode,
    readonly optionId: string,
    readonly backend: { type: BackendType; command: string },
    readonly details: {
      requestKey?: string;
      requestedValue?: SessionRunOptionValue;
      currentValue?: SessionRunOptionValue;
      allowedValues?: readonly SessionRunOptionChoice[];
      applied?: readonly AppliedSessionRunOption[];
      snapshot?: SessionRunOptionsSnapshot;
      providerMessage?: string;
    } = {},
  ) {
    super(`${code}: ${optionId} on ${backend.type}/${backend.command}`);
  }
}

export interface ProviderRunOption {
  id: string;
  label: string;
  description?: string;
  category: string;
  kind: Extract<SessionRunOptionKind, "select" | "boolean">;
  currentValue: SessionRunOptionValue;
  allowedValues: readonly SessionRunOptionChoice[] | null;
}

function staticChoices(discovery: SessionRunOptionDiscovery): readonly SessionRunOptionChoice[] | null {
  if (discovery.kind === "static") return discovery.allowedValues;
  if (discovery.kind === "static_then_provider") return discovery.staticAllowedValues;
  return discovery.fallbackAllowedValues;
}

export function declaredRunOptionsSnapshot(
  declaration: BackendRunOptionDeclaration,
  phase: SessionRunOptionsSnapshot["phase"] = "declared",
  revision = 0,
): SessionRunOptionsSnapshot {
  return {
    backendType: declaration.backendType,
    command: declaration.command,
    phase,
    revision,
    options: declaration.options.map((option) => {
      const providerOwned = option.discovery.kind !== "static";
      return {
        id: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        category: option.category,
        kind: option.kind,
        nullable: option.nullable,
        source: "backend" as const,
        availability: providerOwned ? "awaiting_provider" as const : "available" as const,
        currentValue: null,
        allowedValues: staticChoices(option.discovery),
        enforcement: option.support.status === "unsupported"
          ? { status: "unsupported" as const, reason: option.support.reason }
          : providerOwned
            ? {
                status: "awaiting_provider" as const,
                owner: option.support.owner,
                effectiveFrom: option.support.effectiveFrom,
              }
            : {
                status: "enforced" as const,
                owner: option.support.owner,
                effectiveFrom: option.support.effectiveFrom,
              },
      };
    }),
  };
}

export function composeRunOptions(
  declaration: BackendRunOptionDeclaration,
  providerOptions: readonly ProviderRunOption[],
  options: { phase?: SessionRunOptionsSnapshot["phase"]; revision?: number } = {},
): SessionRunOptionsSnapshot {
  const runtime = new Map(providerOptions.map((option) => [option.id, option]));
  const composed: SessionRunOptionState[] = declaration.options.map((declared) => {
    const providerId = declared.discovery.kind === "static" ? null : declared.discovery.providerOptionId;
    const provider = providerId ? runtime.get(providerId) : undefined;
    if (providerId) runtime.delete(providerId);
    if (!provider && providerId) {
      const base = declaredRunOptionsSnapshot({ ...declaration, options: [declared] }).options[0];
      return { ...base, availability: "unavailable", enforcement: declared.support.status === "unsupported"
        ? { status: "unsupported", reason: declared.support.reason }
        : {
            status: "awaiting_provider",
            owner: declared.support.owner,
            effectiveFrom: declared.support.effectiveFrom,
            detail: "Provider did not advertise this option",
          } };
    }
    if (!provider) return declaredRunOptionsSnapshot({ ...declaration, options: [declared] }).options[0];
    return {
      id: declared.id,
      label: provider.label,
      ...(provider.description ? { description: provider.description } : {}),
      category: provider.category,
      kind: provider.kind,
      nullable: declared.nullable,
      source: "composed",
      availability: "available",
      currentValue: provider.currentValue,
      allowedValues: provider.allowedValues,
      enforcement: declared.support.status === "unsupported"
        ? { status: "unsupported", reason: declared.support.reason }
        : {
            status: "enforced",
            owner: declared.support.owner,
            effectiveFrom: declared.support.effectiveFrom,
          },
    };
  });

  const policy = declaration.runtimeDiscoveredOptions;
  for (const provider of runtime.values()) {
    const managed = Boolean(policy
      && policy.managedCategories.includes(provider.category)
      && policy.managedKinds.includes(provider.kind));
    composed.push({
      ...provider,
      nullable: provider.currentValue === null,
      source: "provider",
      availability: "available",
      enforcement: managed
        ? { status: "enforced", owner: "provider", effectiveFrom: "immediate" }
        : { status: "unsupported", reason: "Provider option is read-only until the backend declares support" },
    });
  }
  return {
    backendType: declaration.backendType,
    command: declaration.command,
    phase: options.phase ?? "ready",
    revision: options.revision ?? 1,
    options: composed,
  };
}

export function sessionRunOptionValuesEqual(left: SessionRunOptionValue, right: SessionRunOptionValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

export function validateRunOptionsPatch(
  declaration: BackendRunOptionDeclaration,
  snapshot: SessionRunOptionsSnapshot,
  patch: SessionRunOptionsPatch,
): SessionRunOptionDeclaration[] {
  const declarations = new Map(declaration.options.map((option) => [option.id, option]));
  const states = new Map(snapshot.options.map((option) => [option.id, option]));
  const requested: SessionRunOptionDeclaration[] = [];
  for (const [id, value] of Object.entries(patch.values)) {
    const state = states.get(id);
    const declared = declarations.get(id) ?? (state && state.enforcement.status !== "unsupported" ? {
      id: state.id, label: state.label, description: state.description, category: state.category,
      kind: state.kind, nullable: state.nullable,
      discovery: { kind: "provider" as const, protocol: "acp_session_config" as const, providerOptionId: state.id, fallbackAllowedValues: null },
      support: { status: "supported" as const, owner: state.enforcement.owner, effectiveFrom: state.enforcement.effectiveFrom },
      applyOrder: 1_000,
    } : undefined);
    if (!declared || declared.support.status === "unsupported") {
      throw new SessionRunOptionError("unsupported_option", id, {
        type: declaration.backendType, command: declaration.command,
      }, { requestedValue: value, snapshot });
    }
    if (state?.availability === "unavailable") {
      throw new SessionRunOptionError("unavailable_value", id, {
        type: declaration.backendType, command: declaration.command,
      }, { requestedValue: value, allowedValues: state.allowedValues ?? undefined, snapshot });
    }
    if (value === null && !declared.nullable) {
      throw new SessionRunOptionError("unavailable_value", id, {
        type: declaration.backendType, command: declaration.command,
      }, { requestedValue: value, allowedValues: state?.allowedValues ?? undefined, snapshot });
    }
    const kindValid = value === null
      || (declared.kind === "select" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
      || (declared.kind === "multi_select" && Array.isArray(value) && value.every((entry) => typeof entry === "string"))
      || (declared.kind === "boolean" && typeof value === "boolean")
      || (declared.kind === "integer" && typeof value === "number" && Number.isInteger(value) && value > 0)
      || (declared.kind === "number" && typeof value === "number" && Number.isFinite(value) && value >= 0)
      || (declared.kind === "text" && typeof value === "string");
    if (!kindValid) {
      throw new SessionRunOptionError("unavailable_value", id, {
        type: declaration.backendType, command: declaration.command,
      }, { requestedValue: value, allowedValues: state?.allowedValues ?? undefined, snapshot });
    }
    if (value !== null && state?.allowedValues && !state.allowedValues.some((choice) => choice.value === value)) {
      throw new SessionRunOptionError("unavailable_value", id, {
        type: declaration.backendType, command: declaration.command,
      }, { requestedValue: value, allowedValues: state.allowedValues, snapshot });
    }
    requested.push(declared);
  }
  return requested.sort((left, right) => left.applyOrder - right.applyOrder);
}

export function normalizeLegacyRunOptions(
  declaration: BackendRunOptionDeclaration,
  canonical: Record<string, SessionRunOptionValue>,
  request: Record<string, unknown>,
): SessionRunOptionsPatch {
  const values = { ...canonical };
  for (const option of declaration.options) {
    for (const key of option.legacyRequestKeys ?? []) {
      if (request[key] === undefined) continue;
      const value = request[key] as SessionRunOptionValue;
      if (option.id in values && !sessionRunOptionValuesEqual(values[option.id], value)) {
        throw new Error(`conflicting_session_option:${option.id}:${key}`);
      }
      values[option.id] = value;
    }
  }
  return { values };
}
