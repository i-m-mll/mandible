import {
  AuthAutoApproveManager,
  type AuthApprovalContext,
  type DelegatedSigningStatus,
  type SetupDelegatedSigningOptions,
} from "./auth-auto-approve.js";

/**
 * Single-purpose custody boundary for the runtime-only delegated signer.
 * Durable clearance code receives an opaque approval context and never learns
 * how YubiKey decryption, ssh-agent lifetime, or local key files are managed.
 */
export class DelegatedSigningResource {
  constructor(private readonly signer: AuthAutoApproveManager) {}

  status(): DelegatedSigningStatus {
    return this.signer.getDelegatedSigningStatus();
  }

  setup(options: SetupDelegatedSigningOptions = {}): Promise<DelegatedSigningStatus> {
    return this.signer.setupDelegatedSigning(options);
  }

  issueFresh(ttlSeconds: number): Promise<AuthApprovalContext> {
    return this.signer.freshPresenceChallenge(ttlSeconds);
  }

  release(context: AuthApprovalContext): Promise<void> {
    return this.signer.releaseApprovalContext(context);
  }

  async remove(): Promise<DelegatedSigningStatus> {
    await this.signer.removeDelegatedSigning();
    return this.status();
  }
}

export type { AuthApprovalContext, DelegatedSigningStatus, SetupDelegatedSigningOptions };
