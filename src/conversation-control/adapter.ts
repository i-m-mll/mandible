import type {
  ConversationControlError,
  ConversationLifecycleEvent,
  ConversationOutboxItem,
  ConversationRuntimeOptions,
  ManagedPermissionRequest,
  ProviderAdapterCapabilities,
  ProviderAdapterEvent,
  ProviderRuntimeEvent,
  ProviderDeliveryReceipt,
  Result,
} from "./types.js";

export type ControllerAdapterCapabilities = ProviderAdapterCapabilities;

export type ControllerLease = {
  controller_instance_id: string;
  provider_session_id: string | null;
};

export type ControllerAcquisitionRequest =
  | { kind: "start"; conversation_id: string; generation: number; controller_instance_id: string; cwd: string; signal?: AbortSignal; runtime_options?: ConversationRuntimeOptions }
  | { kind: "resume-provider-session"; conversation_id: string; generation: number; controller_instance_id: string; provider_session_id: string; cwd?: string; signal?: AbortSignal; runtime_options?: ConversationRuntimeOptions }
  | { kind: "resume-message-anchor"; conversation_id: string; generation: number; controller_instance_id: string; provider_session_id: string; message_anchor: string; cwd?: string; signal?: AbortSignal; runtime_options?: ConversationRuntimeOptions };

export type AdapterProbe =
  | { kind: "owned"; controller_instance_id: string; provider_session_id: string | null; state: "ready" | "running" | "waiting" | "stopping" }
  | { kind: "released" }
  | { kind: "external"; evidence: "registered-channel" | "registered-process" | "provider-controller"; reference: string }
  | { kind: "unknown"; reason: "probe-ambiguous" | "provider-identity-changed" };

export interface ConversationControllerAdapter {
  readonly id: string;
  readonly provider: string;
  readonly capabilities: ControllerAdapterCapabilities;
  // A startup-failed result means the adapter retained no controller lease or process.
  acquire(input: ControllerAcquisitionRequest): Promise<Result<ControllerLease, ConversationControlError>>;
  deliver(item: ConversationOutboxItem): Promise<Result<ProviderDeliveryReceipt, ConversationControlError>>;
  probe(input: {
    conversation_id: string;
    provider_session_id: string | null;
    controller_instance_id: string;
    generation: number;
  }): Promise<Result<AdapterProbe, ConversationControlError>>;
  probeDelivery(input: ConversationOutboxItem): Promise<Result<"delivered" | "not-delivered" | "unknown", ConversationControlError>>;
  stop(input: {
    conversation_id: string;
    provider_session_id: string | null;
    controller_instance_id: string;
    generation: number;
  }): Promise<Result<void, ConversationControlError>>;
  interrupt?(input: { conversation_id: string; generation: number; turn_id?: string }): Promise<Result<void, ConversationControlError>>;
  modelChoices?(conversationId: string): Promise<Result<{ value: string; label: string }[], ConversationControlError>>;
  permissions?(conversationId: string): ManagedPermissionRequest[];
  decidePermission?(input: import("./types.js").ManagedRequestResponse): Promise<Result<void, ConversationControlError>>;
  subscribe(listener: (event: ConversationLifecycleEvent & { conversation_id: string; generation: number }) => Result<void, ConversationControlError>): () => void;
  subscribeProviderEvents(listener: (event: ProviderAdapterEvent) => void): () => void;
  subscribeRuntimeEvents?(listener: (event: ProviderRuntimeEvent) => void): () => void;
  close(): Promise<void>;
}

export class ConversationControllerRegistry {
  private readonly byProvider = new Map<string, ConversationControllerAdapter>();
  private readonly byId = new Map<string, ConversationControllerAdapter>();

  register(adapter: ConversationControllerAdapter): () => void {
    if (this.byProvider.has(adapter.provider) || this.byId.has(adapter.id)) {
      throw new Error(`Duplicate conversation controller adapter: ${adapter.id}/${adapter.provider}`);
    }
    this.byProvider.set(adapter.provider, adapter);
    this.byId.set(adapter.id, adapter);
    return () => {
      if (this.byProvider.get(adapter.provider) === adapter) this.byProvider.delete(adapter.provider);
      if (this.byId.get(adapter.id) === adapter) this.byId.delete(adapter.id);
    };
  }

  forProvider(provider: string): ConversationControllerAdapter | null {
    return this.byProvider.get(provider) ?? null;
  }

  byAdapterId(adapterId: string): ConversationControllerAdapter | null {
    return this.byId.get(adapterId) ?? null;
  }

  all(): readonly ConversationControllerAdapter[] {
    return [...this.byId.values()];
  }
}

export async function trapAdapterCall<T>(
  adapterId: string,
  call: () => Promise<Result<T, ConversationControlError>>,
): Promise<Result<T, ConversationControlError>> {
  try {
    return await call();
  } catch (thrown) {
    return {
      ok: false,
      error: {
        kind: "adapter-contract-violation",
        adapter_id: adapterId,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      },
    };
  }
}
