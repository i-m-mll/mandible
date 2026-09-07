export type ProviderStartupFailureCode =
  | "provider_startup_timeout"
  | "provider_startup_failed"
  | "provider_startup_interrupted"
  | "provider_exited_before_ready"
  | "client_aborted";

export interface ProviderStartupProvenance {
  backend_type: "sdk" | "acp";
  provider: string;
  implementation: {
    kind: "package" | "executable";
    name: string;
    version: string | null;
    entrypoint: string;
    launcher: string;
  };
}

export class ProviderStartupError extends Error {
  constructor(
    readonly code: ProviderStartupFailureCode,
    message: string,
    readonly phase: "configuration" | "readiness",
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ProviderStartupError";
  }
}

export function normalizeProviderStartupError(
  error: unknown,
  phase: ProviderStartupError["phase"] = "readiness",
): ProviderStartupError {
  if (error instanceof ProviderStartupError) return error;
  return new ProviderStartupError(
    "provider_startup_failed",
    "The provider failed before its native conversation was ready.",
    phase,
  );
}
