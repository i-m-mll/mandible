import type { ConversationControllerAdapter } from "./adapter.js";
import type { ConversationControlError, ConversationLifecycleEvent, ProviderAdapterEvent, Result } from "./types.js";

export type AdapterLifecycleEvent = ConversationLifecycleEvent & { conversation_id: string; generation: number };

export class AdapterLifecycle {
  private readonly listeners = new Set<(event: AdapterLifecycleEvent) => Result<void, ConversationControlError>>();

  subscribe(listener: (event: AdapterLifecycleEvent) => Result<void, ConversationControlError>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AdapterLifecycleEvent): Result<void, ConversationControlError> {
    for (const listener of this.listeners) { const result = listener(event); if (!result.ok) return result; }
    return { ok: true, value: undefined };
  }
}

export class AdapterProviderEvents {
  private readonly listeners = new Set<(event: ProviderAdapterEvent) => void>();

  subscribe(listener: (event: ProviderAdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ProviderAdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export type AdapterFailureOptions = {
  retryable?: boolean;
  message?: string;
};

export function adapterFailure(
  adapterId: string,
  code: string,
  thrown: unknown,
  options: AdapterFailureOptions = {},
): ConversationControlError {
  const raw = options.message ?? (thrown instanceof Error ? thrown.message : String(thrown));
  return {
    kind: "adapter-failure",
    adapter_id: adapterId,
    code,
    message: raw.slice(0, 1_000),
    retryable: options.retryable ?? false,
  };
}

export type AdapterConstructor = new () => ConversationControllerAdapter;
