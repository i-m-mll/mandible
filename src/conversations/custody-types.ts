export type CustodyProvider = "claude_code" | "codex" | "gemini";

export type CustodyState =
  | "requested"
  | "capturing"
  | "verified"
  | "mirroring"
  | "sealed"
  | "error";

export type RestoreCapability = "supported" | "partial" | "unsupported";

export interface CustodySource {
  conversation_id: string;
  provider: CustodyProvider;
  session_id: string;
  source_path: string;
  native_identities?: string[];
}

export interface CustodyCaptureOptions {
  rewind?: boolean;
  seal?: boolean;
}

export interface CustodyDependency {
  source_path: string;
  archive_path: string;
  provider_relative_path: string;
  role: string;
  required: boolean;
}

export interface CustodyFileRecord {
  path: string;
  provider_relative_path: string;
  dependency_role: string;
  size: number;
  sha256: string;
  required: boolean;
}

export interface ProviderRestoreClaim {
  capability: RestoreCapability;
  adapter_version: string;
  limitations: string[];
}

export interface CustodyManifest {
  archive_format: "mandible-conversation-custody@1";
  provider: CustodyProvider;
  provider_adapter_version: string;
  canonical_conversation_id: string;
  native_identities: string[];
  source_version: string;
  custody_version: string;
  capture_consistency: "file-by-file-stable";
  captured_at: string;
  files: CustodyFileRecord[];
  restore: ProviderRestoreClaim;
}

export interface CustodyStatusRecord {
  conversation_id: string;
  state: CustodyState;
  active_version: string | null;
  updated_at: string;
  error: string | null;
  history: Array<{ state: CustodyState; at: string; detail?: string }>;
}

export interface CustodyCaptureResult {
  status: CustodyStatusRecord;
  manifest: CustodyManifest;
  version_path: string;
  reused: boolean;
}

export interface IntegrityResult {
  ok: boolean;
  checked: number;
  errors: string[];
  manifest: CustodyManifest;
}
